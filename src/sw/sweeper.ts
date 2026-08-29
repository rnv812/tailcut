import { expiredBy, victimsFor, type Valued } from '../core/history/value'
import {
  clearStorageFull,
  dropPieceRows,
  dropSessionRows,
  dropSnapshotRow,
  listSessions,
  listSnapshots,
  piecesOf,
  readTotals,
  type HistoryPieceRow,
  type HistorySessionRow,
  type SnapshotRow,
  type TotalsRow,
} from '../shared/history-db'
import {
  listPieceFiles,
  listSessionIds,
  listSnapshotFiles,
  removePiece,
  removeSessionFiles,
  removeSnapshotFile,
  type PieceFile,
} from '../shared/history-opfs'
import { readSettings } from '../shared/settings-store'
import type { Settings } from '../shared/settings'

/**
 * The one place anything is deleted.
 *
 * In the service worker for two reasons. It is the only context of the extension that exists when
 * no tab is open, and the keeping and the ceiling must not depend on whether somebody is watching
 * a video right now. And deletion needs one owner: two contexts each removing by their own list
 * are two opinions about what is left.
 *
 * It writes nothing and could not: a service worker has no createSyncAccessHandle and no Worker
 * constructor at all. It has removeEntry, which is the whole of what sweeping does.
 */
export const SWEEP_ALARM = 'tc:sweep'

/**
 * How often the sweeper wakes.
 *
 * A minute is far more often than the keeping needs and exactly as often as the ceiling does: at
 * 6 Mbit/s a minute of recording is 45 MB, which is one per cent of the default ceiling. Chrome
 * gives a packed extension no less than 30 seconds anyway and silently raises anything shorter.
 */
export const SWEEP_PERIOD_MINUTES = 1

/**
 * How old a file with no row has to be before the repair calls it an orphan.
 *
 * A piece is written before its row (see the storage convention), so a file that has no row this
 * second may have one the next. A minute is three orders of magnitude more than that gap and
 * still far less than the time between two starts of a browser.
 */
export const ORPHAN_GRACE_MS = 60_000

/**
 * How long a deleted session stays on disk.
 *
 * §9.2 answers a deletion with an undo in a toast rather than with a confirmation dialogue, so
 * the deletion has to be undoable for as long as the toast can be on screen — and it has to
 * survive the popup being closed, because a user who deletes and closes has deleted. The row is
 * marked at once and hidden from every list; the files go when this has passed.
 */
export const DELETED_GRACE_MS = 30_000

export interface SweepReport {
  /** Bytes the rows said were freed. */
  freed: number
  sessions: number
  pieces: number
  snapshots: number
}

export interface RepairReport {
  /** Rows dropped because their file was missing or short. */
  rows: number
  /** Files removed because no row knew of them. */
  orphans: number
}

/**
 * The ceiling this pass keeps to: the user's, or the one the browser has proved we can have.
 *
 * The setting is a ceiling we impose on ourselves; the quota is the browser's to give, and it may
 * refuse long before four gigabytes — the storage is best-effort, and §7.4 says so. When it has
 * refused, the writer says `full`, the effective ceiling comes down to below what is occupied
 * (markStorageFull), and from then on this is the number the sweep works to. Without it a refusal
 * below our own ceiling is a sweep that finds nothing over it and a writer retrying for ever.
 */
export function ceilingFor(settings: Settings, totals: TotalsRow): number {
  return totals.cappedBytes > 0
    ? Math.min(settings.history.ceilingBytes, totals.cappedBytes)
    : settings.history.ceilingBytes
}

/** Everything the sweeper needs of the world; the real one is `liveIo()` below. */
export interface SweeperIo {
  settings(): Promise<Settings>
  sessions(): Promise<HistorySessionRow[]>
  pieces(id: string): Promise<HistoryPieceRow[]>
  snapshots(): Promise<SnapshotRow[]>
  totals(): Promise<TotalsRow>
  files(id: string): Promise<PieceFile[]>
  sessionIds(): Promise<string[]>
  snapshotFiles(): Promise<PieceFile[]>
  removePiece(id: string, file: string): Promise<boolean>
  removeSession(id: string): Promise<boolean>
  removeSnapshot(id: string): Promise<boolean>
  /** Forgets a refusal by the browser: only the repair calls it. See ceilingFor. */
  clearFull(): Promise<void>
  dropPieceRows(id: string, files: string[]): Promise<void>
  dropSessionRows(id: string): Promise<void>
  dropSnapshotRow(id: string): Promise<void>
  now(): number
}

const valued = (row: HistorySessionRow): Valued => ({
  id: row.id,
  pinned: row.pinned,
  usedAt: row.usedAt,
  lastSeenAt: row.lastSeenAt,
  seconds: row.seconds,
  sound: row.sound,
  widthPx: row.widthPx,
  bytes: row.bytes,
})

/**
 * Takes a whole session: the files first, the rows after.
 *
 * The order is the reverse of the writing order and for the same reason. A file that would not go
 * — somebody's handle is open on it for the millisecond it takes to write — leaves the rows
 * alone, and the next sweep tries again; the other way round would leave a row promising material
 * that is not there.
 */
async function takeSession(io: SweeperIo, id: string): Promise<boolean> {
  if (!(await io.removeSession(id))) return false
  await io.dropSessionRows(id)
  return true
}

/**
 * One pass: what the user deleted, what has outlived the keeping, what has fallen out of the
 * buffer window, and — only if the sum is still over the ceiling — the cheapest sessions whole.
 *
 * The order is from the uncontested to the debatable on purpose. The first three are decisions
 * somebody has already made (a deletion, a setting, a buffer length), and each of them lowers the
 * sum, so eviction by value usually finds nothing left to do.
 */
export async function sweep(io: SweeperIo): Promise<SweepReport> {
  const now = io.now()
  const settings = await io.settings()
  const report: SweepReport = { freed: 0, sessions: 0, pieces: 0, snapshots: 0 }

  const all = await io.sessions()
  const gone = new Set<string>()

  // 1. What the user deleted, once the undo of §9.2 is out of reach.
  for (const row of all) {
    if (!row.deletedAt || now - row.deletedAt < DELETED_GRACE_MS) continue
    if (await takeSession(io, row.id)) {
      gone.add(row.id)
      report.sessions += 1
      report.freed += row.bytes
    }
  }

  const alive = all.filter((row) => !gone.has(row.id) && !row.deletedAt)

  // 2. What has outlived the keeping (§7.4: seven days by default).
  for (const victim of expiredBy(alive.map(valued), now, settings.history.keepDays)) {
    if (await takeSession(io, victim.id)) {
      gone.add(victim.id)
      report.sessions += 1
      report.freed += victim.bytes
    }
  }

  // 3. The buffer length, over every session that is left (§7.3): what lies further back than the
  //    buffer reaches is no longer on offer, and the file holding it is dead.
  for (const row of alive) {
    if (gone.has(row.id)) continue

    const pieces = await io.pieces(row.id)
    if (!pieces.length) continue

    const newest = pieces.reduce((furthest, piece) => Math.max(furthest, piece.until), 0)
    const floor = newest - settings.recording.bufferSeconds
    const dead = pieces.filter((piece) => piece.until <= floor)
    if (!dead.length) continue

    const removed: string[] = []
    for (const piece of dead) {
      if (await io.removePiece(row.id, piece.file)) {
        removed.push(piece.file)
        report.freed += piece.bytes
      }
    }
    if (removed.length) {
      await io.dropPieceRows(row.id, removed)
      report.pieces += removed.length
    }
  }

  // 4. Snapshots: a snapshot is the temporary of one editing, and it is kept exactly as long as
  //    a session is. Nothing but age decides — a snapshot has no material of its own to weigh.
  const stale = now - settings.history.keepDays * 86_400_000
  for (const snapshot of await io.snapshots()) {
    if (snapshot.capturedAt >= stale) continue
    if (await io.removeSnapshot(snapshot.id)) {
      await io.dropSnapshotRow(snapshot.id)
      report.snapshots += 1
      report.freed += snapshot.bytes
    }
  }

  // 5. And only now, the ceiling. The sum is read again rather than worked out from the report:
  //    a frame has been writing all through this pass. The ceiling is read with it, because a
  //    refusal by the browser lowers it — see ceilingFor.
  const totals = await io.totals()
  const over = totals.bytes - ceilingFor(settings, totals)
  if (over > 0) {
    const left = (await io.sessions()).filter((row) => !gone.has(row.id) && !row.deletedAt)
    for (const victim of victimsFor(left.map(valued), now, over)) {
      if (await takeSession(io, victim.id)) {
        report.sessions += 1
        report.freed += victim.bytes
      }
    }
  }

  return report
}

/**
 * The one walk of OPFS this program makes: the index against the disk, at start-up.
 *
 * Everything else believes the index, which is why the index has to be true, and after a crash it
 * may not be. Two ways it can be wrong, and each has one answer. A row whose file is missing or
 * shorter than the row says is a batch the browser stopped in the middle of — the row goes. A
 * file no row knows of is a batch whose row never got written — the file goes, but only once it
 * is old enough that it cannot be one being written this second.
 *
 * `graceMs` is that "old enough", and it is an argument rather than the constant alone for one
 * reason: a test cannot wait a minute for an orphan to ripen, and must not reach into the user's
 * settings to shorten the wait. The end-to-end run makes an orphan and asks for a repair with no
 * grace at all (Task 13, шаг 4). Every caller in the program passes `ORPHAN_GRACE_MS` and says so
 * in the call, so that the delay is visible where the repair is asked for and not only here.
 */
export async function repair(io: SweeperIo, graceMs = ORPHAN_GRACE_MS): Promise<RepairReport> {
  const now = io.now()
  const report: RepairReport = { rows: 0, orphans: 0 }

  // A full disk is a fact about a machine at a moment, and the browser is started on a machine
  // whose disk the user may since have swept. The lowered ceiling is forgotten here and nowhere
  // else: if storage is still full, the next batch says so within half a minute, and the state
  // comes back with it.
  await io.clearFull()

  const sessions = await io.sessions()
  const known = new Set(sessions.map((row) => row.id))

  for (const session of sessions) {
    const files = new Map((await io.files(session.id)).map((file) => [file.name, file]))
    const pieces = await io.pieces(session.id)

    const broken: string[] = []
    for (const piece of pieces) {
      const file = files.get(piece.file)
      if (!file || file.size < piece.bytes) broken.push(piece.file)
      files.delete(piece.file)
    }
    if (broken.length) {
      await io.dropPieceRows(session.id, broken)
      report.rows += broken.length
    }

    // What is left in the map is on the disk and in no row.
    for (const [name, file] of files) {
      if (now - file.lastModified < graceMs) continue
      if (await io.removePiece(session.id, name)) report.orphans += 1
    }
  }

  // A directory of a session the index has never heard of: its rows went with a deletion that was
  // interrupted, or the store was cleared and the files were not.
  for (const id of await io.sessionIds()) {
    if (known.has(id)) continue
    if (await io.removeSession(id)) report.orphans += 1
  }

  // The same, for snapshots.
  const snapshots = new Set((await io.snapshots()).map((row) => row.id))
  for (const file of await io.snapshotFiles()) {
    const id = file.name.replace(/\.tcs$/, '')
    if (snapshots.has(id)) continue
    if (now - file.lastModified < graceMs) continue
    if (await io.removeSnapshot(id)) report.orphans += 1
  }

  return report
}

/** The sweeper bound to the real index and the real disk. */
export function liveIo(): SweeperIo {
  return {
    settings: () => readSettings(),
    // Everything, the deleted and the empty included: the sweeper is the one caller that has to
    // see those, and the popup is the one that must not.
    sessions: () => listSessions(Number.MAX_SAFE_INTEGER, true),
    pieces: (id) => piecesOf(id),
    snapshots: () => listSnapshots(),
    totals: () => readTotals(),
    files: (id) => listPieceFiles(id),
    sessionIds: () => listSessionIds(),
    snapshotFiles: () => listSnapshotFiles(),
    removePiece: (id, file) => removePiece(id, file),
    removeSession: (id) => removeSessionFiles(id),
    removeSnapshot: (id) => removeSnapshotFile(id),
    clearFull: () => clearStorageFull(),
    dropPieceRows: async (id, files) => void (await dropPieceRows(id, files)),
    dropSessionRows: (id) => dropSessionRows(id),
    dropSnapshotRow: (id) => dropSnapshotRow(id),
    now: () => Date.now(),
  }
}
