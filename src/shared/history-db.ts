import { coveredWith, secondsOf, type Span } from '../core/history/index'
import type { HistoryPiece, HistoryTrack } from '../core/history/layout'

/**
 * The index of what is on disk: the one thing that knows it, and the only thing asked about it.
 *
 * In IndexedDB and not in chrome.storage.local, which is hard-limited to ten megabytes without
 * `unlimitedStorage` — measured, the tenth megabyte-sized value fails with
 * `Resource::kQuotaBytes quota exceeded` — while the index of a thousand sessions weighs 5.6 MB.
 * It would fit until it did not, and `QUOTA_BYTES` goes on reporting 10485760 whatever the real
 * limit is, so there would be nothing to check against either.
 *
 * Every transaction is `relaxed`: 0.33 ms against 2.41 for `strict`, and the rows survived a
 * SIGKILL of all ten processes of the browser. `strict` here would be a sevenfold price for
 * nothing.
 */
export const DB_NAME = 'tailcut-history'
export const DB_VERSION = 1

export const SESSIONS = 'sessions'
export const PIECES = 'pieces'
export const SNAPSHOTS = 'snapshots'
export const TOTALS = 'totals'

/** The one row of the totals store: the occupied volume, kept as a running sum. */
export const TOTALS_KEY = 'totals'

export interface HistorySessionRow {
  id: string
  /** What a second tab playing the same video uses to find this session. */
  key: string
  url: string
  title: string
  createdAt: number
  lastSeenAt: number
  /** The user asked to keep it, so eviction never takes it. */
  pinned: boolean
  /** When the user last took it into the editor — opened it or cut from it; 0 — never. */
  usedAt: number
  /** When the user deleted it; the sweeper takes the files. 0 — alive. */
  deletedAt: number
  bytes: number
  /**
   * Media time this session covers, joined: what makes `seconds` a length and not a sum.
   *
   * Kept on the row rather than worked out on reading, because reading happens in the popup and
   * the popup computes nothing. One entry per stretch of watching — a session watched
   * through is one — and a new entry only where the material really has a hole in it.
   */
  covered: Span[]
  /** Sum of `covered`, in media seconds: the length the popup shows. */
  seconds: number
  /** Largest player this was watched in, in CSS pixels; 0 — never measured. */
  widthPx: number
  sound: boolean
  tracks: HistoryTrack[]
}

export interface HistoryPieceRow extends HistoryPiece {
  sessionId: string
}

/** A snapshot file of the editor: a temporary of one editing, swept by age like everything else. */
export interface SnapshotRow {
  id: string
  capturedAt: number
  bytes: number
  title: string
}

export interface TotalsRow {
  id: string
  bytes: number
  /**
   * The ceiling this program is actually keeping to, when the browser has proved it cannot have
   * the one from the settings; 0 — nothing has refused us.
   *
   * The configured ceiling is ours to keep, but the quota is the browser's to give, and it is
   * allowed to refuse long before four gigabytes — the storage is best-effort and always was.
   * Without this, a refusal below our own ceiling is a writer that retries every thirty seconds
   * for ever while a sweeper finds nothing to free (`totals.bytes - ceilingBytes` is negative),
   * and nothing anywhere says a word to the user.
   */
  cappedBytes: number
  /** When storage last refused a write for being full; 0 means never. */
  fullAt: number
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

let open: Promise<IDBDatabase> | undefined

export function openHistoryDb(): Promise<IDBDatabase> {
  const opening: Promise<IDBDatabase> = (open ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SESSIONS)) {
        const sessions = db.createObjectStore(SESSIONS, { keyPath: 'id' })
        // Two tabs playing one video are one session, and the key is how the second of
        // them finds the first. Unique, so that a race between two frames ends in a refusal one
        // of them can read rather than in two directories for one video.
        sessions.createIndex('key', 'key', { unique: true })
        sessions.createIndex('lastSeenAt', 'lastSeenAt')
      }
      if (!db.objectStoreNames.contains(PIECES)) {
        const pieces = db.createObjectStore(PIECES, { keyPath: ['sessionId', 'file'] })
        pieces.createIndex('sessionId', 'sessionId')
      }
      if (!db.objectStoreNames.contains(SNAPSHOTS)) {
        db.createObjectStore(SNAPSHOTS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(TOTALS)) {
        db.createObjectStore(TOTALS, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // Somebody else wants the store at a version this context does not know, or wants it gone.
      // A connection left open blocks that for as long as the context holding it lives, and one
      // of the contexts is the service worker: it opens the index on every sweep and lives on
      // for minutes afterwards, so an upgrade or a delete would hang for the whole browser and
      // not for one page. Measured as a test that stopped finishing: the deleteDatabase in
      // tests/e2e/history-db.spec.ts waited out its thirty seconds the day the sweeper arrived.
      db.onversionchange = () => {
        db.close()
        // Only while this is still the connection everybody is handed: a newer one was opened by
        // whoever came after the upgrade, and it is not this handler's to drop.
        if (open === opening) open = undefined
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
  }).catch((cause) => {
    // A failed open must not be remembered as the answer for the life of the context: private
    // browsing, a corrupted store, a version from a newer build all pass, and the next call
    // deserves its own attempt.
    open = undefined
    throw cause
  }))

  return opening
}

function transaction(db: IDBDatabase, stores: string[], mode: IDBTransactionMode): IDBTransaction {
  // Relaxed durability everywhere: see the head of this file.
  return db.transaction(stores, mode, { durability: 'relaxed' })
}

/**
 * The identity of this session on disk, opened if it has none.
 *
 * By merge key, so that a reload, a second tab and a return to the same video a day later fill in
 * one session rather than breed three — the same rule the registry in the frame follows,
 * over the same key.
 */
export async function openSession(
  key: string,
  page: { url: string; title: string; createdAt: number; lastSeenAt: number },
): Promise<string> {
  const db = await openHistoryDb()
  const tx = transaction(db, [SESSIONS], 'readwrite')
  const sessions = tx.objectStore(SESSIONS)

  const existing = (await promised(sessions.index('key').get(key))) as
    | HistorySessionRow
    | undefined

  if (existing) {
    // A session the user deleted and then went back to watching is a session again: the row is
    // still here only because the sweeper has not come round yet.
    if (existing.deletedAt) {
      await promised(sessions.put({ ...existing, deletedAt: 0 }))
    }
    await finished(tx)
    return existing.id
  }

  const row: HistorySessionRow = {
    id: crypto.randomUUID(),
    key,
    url: page.url,
    title: page.title,
    createdAt: page.createdAt,
    lastSeenAt: page.lastSeenAt,
    pinned: false,
    usedAt: 0,
    deletedAt: 0,
    bytes: 0,
    covered: [],
    seconds: 0,
    widthPx: 0,
    sound: false,
    tracks: [],
  }
  await promised(sessions.add(row))
  await finished(tx)
  return row.id
}

/**
 * One landed piece written down: the row of the piece, the row of the session it belongs to and
 * the running total, in one transaction.
 *
 * One transaction because the three are one fact. Written apart, a crash between them leaves an
 * occupied volume that does not match the files, and the number the popup shows would drift by a
 * batch every time the browser stopped badly.
 */
export async function recordPiece(
  sessionId: string,
  piece: HistoryPiece,
  placed: readonly HistoryTrack[],
  event: { page: { url: string; title: string; lastSeenAt: number }; widthPx: number },
): Promise<void> {
  const db = await openHistoryDb()
  const tx = transaction(db, [SESSIONS, PIECES, TOTALS], 'readwrite')
  const sessions = tx.objectStore(SESSIONS)

  const session = (await promised(sessions.get(sessionId))) as HistorySessionRow | undefined
  if (!session) {
    // The session was swept while this batch was being written. The piece is an orphan and the
    // repair will take it; writing its row would resurrect half a session.
    tx.abort()
    return
  }

  // The first place an init landed in is the place the row keeps, and every later one is ignored.
  // Not because a repeat is impossible — `HistoryTrack.init` names the case where it is not, two
  // merge keys gathering at once and becoming one session, but because otherwise which of
  // the two the index names would be decided by the order they landed in. The spare copy sits
  // inside a piece that is material anyway, and nothing reads it.
  const tracks = [...session.tracks]
  for (const track of placed) {
    if (tracks.some((one) => one.representation === track.representation)) continue
    tracks.push(track)
  }

  // The length is the media time some material covers, joined — never a sum of the parts. See
  // coveredWith: one stretch arrives once per track, again on a switch of quality and again from
  // the second tab watching the same video, and a sum would call all of that more recording.
  const covered = coveredWith(session.covered ?? [], piece.parts)

  const next: HistorySessionRow = {
    ...session,
    tracks,
    url: session.url || event.page.url,
    title: session.title || event.page.title,
    lastSeenAt: Math.max(session.lastSeenAt, event.page.lastSeenAt),
    bytes: session.bytes + piece.bytes,
    // The largest player the video was ever watched in, across every tab and every day the
    // session was fed — the frame knows only its own, and a row that took the latest would
    // shrink back to a corner the moment somebody watched it in one.
    widthPx: Math.max(session.widthPx, event.widthPx),
    covered,
    seconds: secondsOf(covered),
    sound: session.sound || tracks.some((track) => track.kinds.includes('audio')),
  }

  const row: HistoryPieceRow = { ...piece, sessionId }
  await promised(sessions.put(next))
  await promised(tx.objectStore(PIECES).put(row))
  await addTotals(tx, piece.bytes)
  await finished(tx)
}

const NO_TOTALS: TotalsRow = { id: TOTALS_KEY, bytes: 0, cappedBytes: 0, fullAt: 0 }

/**
 * Moves the running total inside a transaction that is already open.
 *
 * Bytes and nothing else. A count of the sessions was kept here beside them and is gone: it was
 * added under a condition and taken away without one, so a session whose pieces had all been
 * evicted was counted twice and one deleted before its first piece landed subtracted a unit it
 * had never added. Nothing read it — neither the popup, which shows the volume, nor the
 * sweeper, which works off `bytes` — so what stood here was a number that could only be wrong.
 * The count of what is on disk is `listSessions().length`, worked out where it is wanted.
 */
async function addTotals(tx: IDBTransaction, bytes: number): Promise<void> {
  const store = tx.objectStore(TOTALS)
  const current = ((await promised(store.get(TOTALS_KEY))) as TotalsRow | undefined) ?? NO_TOTALS
  await promised(
    store.put({
      ...current,
      id: TOTALS_KEY,
      bytes: Math.max(0, current.bytes + bytes),
    }),
  )
}

export async function readTotals(): Promise<TotalsRow> {
  const db = await openHistoryDb()
  const tx = transaction(db, [TOTALS], 'readonly')
  const row = (await promised(tx.objectStore(TOTALS).get(TOTALS_KEY))) as TotalsRow | undefined
  return row ? { ...NO_TOTALS, ...row } : NO_TOTALS
}

/**
 * How much of what is occupied stays when the browser has refused to take more.
 *
 * A share of what we hold and not a fixed number of megabytes: a refusal says nothing about how
 * much room is missing, and taking a tenth of it both frees something at every size and cannot
 * empty the history in one go. Refused again, it takes a tenth of the remainder.
 */
export const QUOTA_RELIEF = 0.9

/**
 * Storage refused a write for being full: the effective ceiling comes down to below what is
 * occupied, so that the sweeper has something to free, and the interface gains a state to show.
 *
 * The alternative is what happens without it: the writer waits thirty seconds, tries again,
 * is refused again, and the sweeper it wakes finds nothing over a ceiling that was never
 * reached. Silently, for as long as the tab is open.
 */
export async function markStorageFull(now: number): Promise<void> {
  const db = await openHistoryDb()
  const tx = transaction(db, [TOTALS], 'readwrite')
  const store = tx.objectStore(TOTALS)
  const current = ((await promised(store.get(TOTALS_KEY))) as TotalsRow | undefined) ?? NO_TOTALS
  const capped = Math.floor(current.bytes * QUOTA_RELIEF)

  await promised(
    store.put({
      ...current,
      id: TOTALS_KEY,
      // Never upwards: two refusals in a row lower it twice.
      cappedBytes: current.cappedBytes > 0 ? Math.min(current.cappedBytes, capped) : capped,
      fullAt: now,
    }),
  )
  await finished(tx)
}

/**
 * Forgets that refusal.
 *
 * Two callers, and both of them for the same reason: the mark is a fact about a machine at a
 * moment, and the moment can pass. The repair at start-up forgets it because the user may have
 * swept the disk since, and one attempt per start of the browser is a cheap way to find out; the
 * settings-page wipe forgets it because there is nothing left on the disk for the browser to have
 * refused. If it is still full, the next batch says so within half a minute.
 */
export async function clearStorageFull(): Promise<void> {
  const db = await openHistoryDb()
  const tx = transaction(db, [TOTALS], 'readwrite')
  const store = tx.objectStore(TOTALS)
  const current = (await promised(store.get(TOTALS_KEY))) as TotalsRow | undefined
  if (!current) {
    tx.abort()
    return
  }
  await promised(store.put({ ...current, cappedBytes: 0, fullAt: 0 }))
  await finished(tx)
}

/**
 * The same session under another merge key.
 *
 * The key of a session changes while it is being recorded — a soft navigation moves it to the
 * address the page went to, the length the player states turns `live` into a number — and the row
 * has to move with it, or the second half of one video opens a row of its own and the popup shows
 * one recording twice. Nothing on the disk moves: the same identity, the same directory, the same
 * pieces.
 *
 * `false` when it could not be done, and the caller carries on writing into the row it has. The
 * key is unique, and the key it is moving to may already belong to a row another frame opened for
 * the same video; the pieces of a session live in the directory named by its identity, so folding
 * two rows into one would mean moving files, and the two rows stay two. Named as a limitation in
 * the closing section.
 */
export async function renameSession(
  id: string,
  key: string,
  page: { url: string; title: string },
): Promise<boolean> {
  const db = await openHistoryDb()
  const tx = transaction(db, [SESSIONS], 'readwrite')
  const sessions = tx.objectStore(SESSIONS)

  const row = (await promised(sessions.get(id))) as HistorySessionRow | undefined
  if (!row) {
    tx.abort()
    return false
  }

  const taken = await promised(sessions.index('key').getKey(key))
  if (taken !== undefined && taken !== id) {
    tx.abort()
    return false
  }

  // The address and the title come with it: a session that followed the page is a session at the
  // page's new address, and the popup names it by what it is now.
  await promised(
    sessions.put({ ...row, key, url: page.url || row.url, title: page.title || row.title }),
  )
  await finished(tx)
  return true
}

/** Updates facts learned after the media session was opened, addressed by its merge key. */
export async function describeSession(key: string, details: { title: string }): Promise<void> {
  const db = await openHistoryDb()
  const tx = transaction(db, [SESSIONS], 'readwrite')
  const sessions = tx.objectStore(SESSIONS)
  const row = (await promised(sessions.index('key').get(key))) as HistorySessionRow | undefined

  if (!row || !details.title) {
    tx.abort()
    return
  }

  await promised(sessions.put({ ...row, title: details.title }))
  await finished(tx)
}

/**
 * Sessions newest first, the deleted ones and the empty ones left out.
 *
 * `includeHidden` gives back every row there is, and exactly one caller passes it: the sweeper,
 * which is the only thing in the program that has to see what nobody else may. A deleted row is
 * what tells it which files to take once the undo period has expired, and an empty one is a
 * session whose first piece never landed — the repair reconciles those against the disk. Every
 * other reader wants the history as the user sees it, which is what the default is.
 */
export async function listSessions(
  limit = 50,
  includeHidden = false,
): Promise<HistorySessionRow[]> {
  const db = await openHistoryDb()
  const tx = transaction(db, [SESSIONS], 'readonly')
  const rows: HistorySessionRow[] = []

  await new Promise<void>((resolve, reject) => {
    const request = tx.objectStore(SESSIONS).index('lastSeenAt').openCursor(null, 'prev')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || rows.length >= limit) return resolve()
      const row = cursor.value as HistorySessionRow
      // A session with nothing in it yet is not a row of the history: it was opened by the first
      // batch and its first piece has not landed — or that piece never will, because the write
      // was refused. Listed, the popup would show a recording of nothing, and every count of the
      // sessions on disk would be off by whatever is being gathered right now.
      if (includeHidden || (!row.deletedAt && row.bytes > 0)) rows.push(row)
      cursor.continue()
    }
  })

  return rows
}

export async function sessionById(id: string): Promise<HistorySessionRow | undefined> {
  const db = await openHistoryDb()
  const tx = transaction(db, [SESSIONS], 'readonly')
  return (await promised(tx.objectStore(SESSIONS).get(id))) as HistorySessionRow | undefined
}

export async function piecesOf(id: string): Promise<HistoryPieceRow[]> {
  const db = await openHistoryDb()
  const tx = transaction(db, [PIECES], 'readonly')
  return (await promised(tx.objectStore(PIECES).index('sessionId').getAll(id))) as HistoryPieceRow[]
}

async function patch(id: string, edit: (row: HistorySessionRow) => HistorySessionRow): Promise<void> {
  const db = await openHistoryDb()
  const tx = transaction(db, [SESSIONS], 'readwrite')
  const store = tx.objectStore(SESSIONS)
  const row = (await promised(store.get(id))) as HistorySessionRow | undefined
  if (!row) {
    tx.abort()
    return
  }
  await promised(store.put(edit(row)))
  await finished(tx)
}

export const setPinned = (id: string, pinned: boolean) => patch(id, (row) => ({ ...row, pinned }))
export const setDeleted = (id: string, deletedAt: number) => patch(id, (row) => ({ ...row, deletedAt }))
export const setUsed = (id: string, usedAt: number) => patch(id, (row) => ({ ...row, usedAt }))

/** Takes the rows of a session out; the files are the sweeper's business. */
export async function dropSessionRows(id: string): Promise<void> {
  const db = await openHistoryDb()
  const tx = transaction(db, [SESSIONS, PIECES, TOTALS], 'readwrite')
  const sessions = tx.objectStore(SESSIONS)
  const row = (await promised(sessions.get(id))) as HistorySessionRow | undefined
  if (!row) {
    tx.abort()
    return
  }

  await promised(sessions.delete(id))
  const pieces = tx.objectStore(PIECES)
  for (const key of (await promised(pieces.index('sessionId').getAllKeys(id))) as IDBValidKey[]) {
    await promised(pieces.delete(key))
  }
  await addTotals(tx, -row.bytes)
  await finished(tx)
}

/** Takes named pieces out of a session when they fall outside the buffer length. */
export async function dropPieceRows(id: string, files: readonly string[]): Promise<number> {
  if (!files.length) return 0

  const db = await openHistoryDb()
  const tx = transaction(db, [SESSIONS, PIECES, TOTALS], 'readwrite')
  const pieces = tx.objectStore(PIECES)
  const sessions = tx.objectStore(SESSIONS)
  const session = (await promised(sessions.get(id))) as HistorySessionRow | undefined

  let freed = 0

  for (const file of files) {
    const row = (await promised(pieces.get([id, file]))) as HistoryPieceRow | undefined
    if (!row) continue
    freed += row.bytes
    await promised(pieces.delete([id, file]))
  }

  if (session) {
    // The length is rebuilt from what is left rather than reduced by what went: a stretch is
    // covered by any piece that holds it, and the same seconds are often in two of them.
    // Subtracting would shorten a session that lost nothing.
    const left = (await promised(pieces.index('sessionId').getAll(id))) as HistoryPieceRow[]
    let covered: Span[] = []
    for (const row of left) covered = coveredWith(covered, row.parts)

    await promised(
      sessions.put({
        ...session,
        bytes: Math.max(0, session.bytes - freed),
        covered,
        seconds: secondsOf(covered),
      }),
    )
  }
  await addTotals(tx, -freed)
  await finished(tx)
  return freed
}

export async function recordSnapshot(row: SnapshotRow): Promise<void> {
  const db = await openHistoryDb()
  const tx = transaction(db, [SNAPSHOTS, TOTALS], 'readwrite')
  await promised(tx.objectStore(SNAPSHOTS).put(row))
  await addTotals(tx, row.bytes)
  await finished(tx)
}

export async function listSnapshots(): Promise<SnapshotRow[]> {
  const db = await openHistoryDb()
  const tx = transaction(db, [SNAPSHOTS], 'readonly')
  return (await promised(tx.objectStore(SNAPSHOTS).getAll())) as SnapshotRow[]
}

export async function dropSnapshotRow(id: string): Promise<void> {
  const db = await openHistoryDb()
  const tx = transaction(db, [SNAPSHOTS, TOTALS], 'readwrite')
  const store = tx.objectStore(SNAPSHOTS)
  const row = (await promised(store.get(id))) as SnapshotRow | undefined
  if (!row) {
    tx.abort()
    return
  }
  await promised(store.delete(id))
  await addTotals(tx, -row.bytes)
  await finished(tx)
}
