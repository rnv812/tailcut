import { describe, it, expect } from 'vitest'
import { DEFAULTS } from '../../src/shared/settings'
import {
  DELETED_GRACE_MS,
  ORPHAN_GRACE_MS,
  ceilingFor,
  repair,
  sweep,
  type SweeperIo,
} from '../../src/sw/sweeper'
import type { HistoryPieceRow, HistorySessionRow, SnapshotRow } from '../../src/shared/history-db'

const NOW = 1_700_000_000_000
const DAY = 86_400_000

const row = (over: Partial<HistorySessionRow>): HistorySessionRow => ({
  id: 'a',
  key: 'k',
  url: 'https://site.example/watch',
  title: 'Clip',
  createdAt: NOW - DAY,
  lastSeenAt: NOW - 1_000,
  pinned: false,
  usedAt: 0,
  deletedAt: 0,
  bytes: 100_000_000,
  covered: [],
  seconds: 180,
  widthPx: 640,
  sound: true,
  tracks: [],
  ...over,
})

const piece = (over: Partial<HistoryPieceRow>): HistoryPieceRow => ({
  sessionId: 'a',
  file: 'aaaa-000000.tcm',
  bytes: 8_000_000,
  until: 10,
  writtenAt: NOW - 60_000,
  parts: [],
  ...over,
})

function fakeIo(state: {
  sessions?: HistorySessionRow[]
  pieces?: Record<string, HistoryPieceRow[]>
  files?: Record<string, Array<{ name: string; size: number; lastModified: number }>>
  dirs?: string[]
  snapshots?: SnapshotRow[]
  snapshotFiles?: Array<{ name: string; size: number; lastModified: number }>
  totals?: number
  /** The ceiling the browser has proved we can have; 0 — it has refused nothing. */
  cappedBytes?: number
  settings?: typeof DEFAULTS
}) {
  const removed: string[] = []
  const droppedRows: string[] = []
  const cleared: number[] = []

  const io: SweeperIo = {
    settings: async () => state.settings ?? DEFAULTS,
    sessions: async () => state.sessions ?? [],
    pieces: async (id) => state.pieces?.[id] ?? [],
    snapshots: async () => state.snapshots ?? [],
    totals: async () => ({
      id: 'totals',
      bytes: state.totals ?? 0,
      cappedBytes: state.cappedBytes ?? 0,
      fullAt: state.cappedBytes ? NOW - 1_000 : 0,
    }),
    files: async (id) => state.files?.[id] ?? [],
    sessionIds: async () => state.dirs ?? (state.sessions ?? []).map((one) => one.id),
    snapshotFiles: async () => state.snapshotFiles ?? [],
    removePiece: async (id, file) => (removed.push(`${id}/${file}`), true),
    removeSession: async (id) => (removed.push(`${id}/*`), true),
    removeSnapshot: async (id) => (removed.push(`snapshot/${id}`), true),
    dropPieceRows: async (id, files) => void droppedRows.push(...files.map((file) => `${id}/${file}`)),
    dropSessionRows: async (id) => void droppedRows.push(`${id}/*`),
    dropSnapshotRow: async (id) => void droppedRows.push(`snapshot/${id}`),
    clearFull: async () => void cleared.push(NOW),
    now: () => NOW,
  }

  return { io, removed, droppedRows, cleared }
}

describe('sweep', () => {
  it('takes what the user deleted, once the undo is out of reach', async () => {
    const fresh = fakeIo({ sessions: [row({ id: 'just-deleted', deletedAt: NOW - 1_000 })] })
    await sweep(fresh.io)
    expect(fresh.removed).toEqual([])

    const old = fakeIo({ sessions: [row({ id: 'gone', deletedAt: NOW - DELETED_GRACE_MS - 1 })] })
    await sweep(old.io)
    expect(old.removed).toEqual(['gone/*'])
    expect(old.droppedRows).toEqual(['gone/*'])
  })

  it('takes what has outlived the keeping, and never what is pinned', async () => {
    const { io, removed } = fakeIo({
      sessions: [
        row({ id: 'old', lastSeenAt: NOW - DAY * 8 }),
        row({ id: 'kept', pinned: true, lastSeenAt: NOW - DAY * 400 }),
      ],
    })
    await sweep(io)
    expect(removed).toEqual(['old/*'])
  })

  it('trims a session to the buffer length, piece by piece', async () => {
    // Three pieces, the buffer is 180 s and the newest material ends at 500: everything that ends
    // before 320 is out of the window and its file is dead.
    const { io, removed, droppedRows } = fakeIo({
      sessions: [row({ id: 'a' })],
      pieces: {
        a: [
          piece({ file: 'w-000000.tcm', until: 100 }),
          piece({ file: 'w-000001.tcm', until: 330 }),
          piece({ file: 'w-000002.tcm', until: 500 }),
        ],
      },
    })
    await sweep(io)
    expect(removed).toEqual(['a/w-000000.tcm'])
    expect(droppedRows).toEqual(['a/w-000000.tcm'])
  })

  it('keeps the row when the file would not go: the next sweep tries again', async () => {
    const { io, droppedRows } = fakeIo({
      sessions: [row({ id: 'a' })],
      pieces: { a: [piece({ file: 'w-000000.tcm', until: 10 }), piece({ file: 'w-000001.tcm', until: 400 })] },
    })
    io.removePiece = async () => false
    await sweep(io)
    // A row promising material that is not there would be worse than a file nobody reads.
    expect(droppedRows).toEqual([])
  })

  it('drops the cheapest sessions whole when the ceiling is exceeded', async () => {
    const { io, removed } = fakeIo({
      settings: { ...DEFAULTS, history: { ...DEFAULTS.history, ceilingBytes: 150_000_000 } },
      totals: 300_000_000,
      sessions: [
        row({ id: 'watched', seconds: 900, bytes: 100_000_000 }),
        row({ id: 'meagre', seconds: 8, sound: false, widthPx: 330, bytes: 100_000_000 }),
        row({ id: 'edited', usedAt: NOW - DAY, bytes: 100_000_000 }),
      ],
    })
    await sweep(io)
    // A hundred and fifty megabytes over: the cheapest alone does not cover it, so the second
    // cheapest goes with it — and the one the user took into the editor outranks both (§7.3).
    expect(removed).toEqual(['meagre/*', 'watched/*'])
  })

  it('frees room when the browser refused below our own ceiling', async () => {
    // The disk said no at 300 MB while the setting says four gigabytes. Without the lowered
    // ceiling `totals.bytes - ceilingBytes` is negative, this pass takes nothing, and the writer
    // is refused again in thirty seconds — for ever, and without a word anywhere.
    const { io, removed } = fakeIo({
      totals: 300_000_000,
      cappedBytes: 270_000_000,
      sessions: [
        row({ id: 'watched', seconds: 900, bytes: 100_000_000 }),
        row({ id: 'meagre', seconds: 8, sound: false, widthPx: 330, bytes: 100_000_000 }),
        row({ id: 'edited', usedAt: NOW - DAY, bytes: 100_000_000 }),
      ],
    })
    await sweep(io)
    expect(removed).toEqual(['meagre/*'])
  })

  it('takes snapshots by age too: a snapshot is a temporary of one editing', async () => {
    const { io, removed } = fakeIo({
      snapshots: [
        { id: 'fresh', capturedAt: NOW - DAY, bytes: 10, title: 'a' },
        { id: 'stale', capturedAt: NOW - DAY * 9, bytes: 10, title: 'b' },
      ],
    })
    await sweep(io)
    expect(removed).toEqual(['snapshot/stale'])
  })
})

describe('repair', () => {
  it('forgets that the disk was ever full: a browser starts on a machine that may have changed', async () => {
    const { io, cleared } = fakeIo({ cappedBytes: 270_000_000 })
    await repair(io)
    expect(cleared).toHaveLength(1)
  })

  it('drops a row whose file is not there, and one whose file came out short', async () => {
    const { io, droppedRows } = fakeIo({
      sessions: [row({ id: 'a' })],
      pieces: {
        a: [
          piece({ file: 'w-000000.tcm', bytes: 8_000_000 }),
          piece({ file: 'w-000001.tcm', bytes: 8_000_000 }),
          piece({ file: 'w-000002.tcm', bytes: 8_000_000 }),
        ],
      },
      files: {
        a: [
          { name: 'w-000000.tcm', size: 8_000_000, lastModified: NOW - DAY },
          // The browser stopped in the middle of this one: the file is there and short.
          { name: 'w-000001.tcm', size: 12, lastModified: NOW - DAY },
        ],
      },
    })

    await repair(io)
    expect(droppedRows.sort()).toEqual(['a/w-000001.tcm', 'a/w-000002.tcm'])
  })

  it('takes a file no row knows about, once it is too old to be one being written', async () => {
    const { io, removed } = fakeIo({
      sessions: [row({ id: 'a' })],
      pieces: { a: [] },
      files: {
        a: [
          { name: 'w-000000.tcm', size: 10, lastModified: NOW - ORPHAN_GRACE_MS - 1 },
          // Written seconds ago: its row is on its way, and taking it would be a race the
          // sweeper loses by deleting live material.
          { name: 'w-000001.tcm', size: 10, lastModified: NOW - 1_000 },
        ],
      },
    })

    await repair(io)
    expect(removed).toEqual(['a/w-000000.tcm'])
  })

  it('takes a file of any age when the caller gives it no grace', async () => {
    // The grace is an argument, and this is what having it buys: an end-to-end run makes an
    // orphan and repairs a second later (Task 13) instead of sleeping a minute or writing into
    // somebody's settings to avoid it.
    const { io, removed } = fakeIo({
      sessions: [row({ id: 'a' })],
      pieces: { a: [] },
      files: { a: [{ name: 'w-000001.tcm', size: 10, lastModified: NOW - 1_000 }] },
    })

    await repair(io, 0)
    expect(removed).toEqual(['a/w-000001.tcm'])
  })

  it('takes a directory no session row knows about', async () => {
    const { io, removed } = fakeIo({ sessions: [], dirs: ['orphan'] })
    await repair(io)
    expect(removed).toEqual(['orphan/*'])
  })
})

/**
 * The ceiling one pass keeps to, on its own.
 *
 * Read through the sweep in the two tests above; read directly here, because the third case has
 * no sweep to show it. A refusal by the browser lowers the ceiling only while it is the lower of
 * the two — a user who then sets the ceiling below what the browser allowed is still the one
 * being obeyed, and a `Math.max` here would quietly hand the setting back to the disk.
 */
describe('ceilingFor', () => {
  const totals = (over: { bytes?: number; cappedBytes?: number }) => ({
    id: 'totals',
    bytes: over.bytes ?? 0,
    cappedBytes: over.cappedBytes ?? 0,
    fullAt: over.cappedBytes ? NOW : 0,
  })

  it('is the setting while nothing has refused us', () => {
    expect(ceilingFor(DEFAULTS, totals({ bytes: 1_000 }))).toBe(DEFAULTS.history.ceilingBytes)
  })

  it('comes down to what the browser proved we can have', () => {
    expect(ceilingFor(DEFAULTS, totals({ bytes: 300_000_000, cappedBytes: 270_000_000 }))).toBe(
      270_000_000,
    )
  })

  it('never rises above the setting: the user keeps the lower of the two', () => {
    const settings = {
      ...DEFAULTS,
      history: { ...DEFAULTS.history, ceilingBytes: 256 * 1024 * 1024 },
    }
    expect(ceilingFor(settings, totals({ bytes: 300_000_000, cappedBytes: 2_000_000_000 }))).toBe(
      256 * 1024 * 1024,
    )
  })
})
