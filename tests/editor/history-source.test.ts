import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HistorySessionRow, HistoryPieceRow } from '../../src/shared/history-db'
import type { HistoryTrack } from '../../src/core/history/layout'

/**
 * The second door of the editor, with the index and the disk replaced and nothing else.
 *
 * `loadHistory` is the one place where three modules that cannot run in a runner meet — IndexedDB
 * for the rows, OPFS for the pieces and `chrome.runtime` for the producer line — and everything
 * between them and the answer is the real thing: the composition of the address space, the index
 * built out of the rows, the reader over it and the material read off that.
 */
let row: HistorySessionRow | undefined
let pieces: HistoryPieceRow[] = []
let indexRefuses = false
/** What `setUsed` was called with: opening a recording raises its eviction value. */
const stamped: Array<[string, number]> = []
/** Identifiers the history index was asked about: the `s` door has no business asking it any. */
const consulted: string[] = []

vi.mock('../../src/shared/history-db', () => ({
  sessionById: async (id: string) => {
    consulted.push(id)
    if (indexRefuses) throw new Error('the store would not open')
    return row?.id === id ? row : undefined
  },
  piecesOf: async (id: string) => {
    if (indexRefuses) throw new Error('the store would not open')
    return pieces.filter((piece) => piece.sessionId === id)
  },
  setUsed: async (id: string, at: number) => {
    stamped.push([id, at])
  },
}))

/** The pieces on disk, by path: what the composed address space reads through. */
const files: Record<string, Uint8Array> = {}

vi.mock('../../src/shared/history-opfs', () => ({
  readRangeIn: async (path: string, at: number, length: number) => {
    const file = files[path]
    if (!file) throw new Error(`no such piece: ${path}`)
    return file.subarray(at, at + length)
  },
}))

const { loadSnapshot } = await import('../../src/editor/source/snapshot')

const ID = '11111111-2222-4333-8444-555555555555'

const video: HistoryTrack = {
  representation: 'video:avc1:1920x1080',
  bufferId: 'sb-0',
  kinds: ['video'],
  info: {
    tracks: [
      { trackId: 1, kind: 'video', timescale: 90_000, codec: 'avc1', width: 1920, height: 1080 },
    ],
  },
  init: { file: 'aaaa-000000.tcm', at: 0, length: 4 },
}

const session = (over: Partial<HistorySessionRow> = {}): HistorySessionRow => ({
  id: ID,
  key: 'https://site.example/watch|avc1|live',
  url: 'https://site.example/watch',
  title: 'Clip — site.example',
  createdAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_060_000,
  pinned: false,
  usedAt: 0,
  deletedAt: 0,
  bytes: 14,
  covered: [{ start: 0, end: 4 }],
  seconds: 4,
  widthPx: 640,
  sound: false,
  tracks: [video],
  ...over,
})

/** Two pieces, so that the seam between them is inside the material and not at its edge. */
const written = (): HistoryPieceRow[] => [
  {
    sessionId: ID,
    file: 'aaaa-000000.tcm',
    bytes: 10,
    until: 2,
    writtenAt: 1_700_000_010_000,
    parts: [{ representation: video.representation, start: 0, end: 2, at: 4, length: 6 }],
  },
  {
    sessionId: ID,
    file: 'aaaa-000001.tcm',
    bytes: 4,
    until: 4,
    writtenAt: 1_700_000_020_000,
    parts: [{ representation: video.representation, start: 2, end: 4, at: 0, length: 4 }],
  },
]

beforeEach(() => {
  row = session()
  pieces = written()
  indexRefuses = false
  stamped.length = 0
  consulted.length = 0
  files[`history/${ID}/aaaa-000000.tcm`] = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  files[`history/${ID}/aaaa-000001.tcm`] = Uint8Array.from([10, 11, 12, 13])
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.1.0' }) } })
})

describe('loadSnapshot over the history', () => {
  it('opens a recording whose rows and pieces are both there', async () => {
    const loaded = await loadSnapshot(`?h=${ID}`)

    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.material.video).not.toBeNull()
    expect(loaded.material.duration).toBe(4)
    // The page the recording came from reaches the editor: clips are named after it.
    expect(loaded.reader.index.page.title).toBe('Clip — site.example')
  })

  it('reads the material out of the pieces, across the seam between two of them', async () => {
    // The whole of what this door is for. The two files are one address space — the second piece
    // begins where the first ended — and a `Located` written by the layout of one batch means
    // the same thing here as it does inside a snapshot file.
    const loaded = await loadSnapshot(`?h=${ID}`)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const track = loaded.reader.index.tracks[0]!
    expect([...(await loaded.reader.bytesOf(track.init))]).toEqual([0, 1, 2, 3])
    // Ten bytes of the first piece, then the second: the material of both, read as one run.
    expect([...(await loaded.reader.bytesOf({ at: 4, length: 10 }))]).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ])
  })

  it('says missing when the index knows of no such recording', async () => {
    row = undefined
    expect(await loadSnapshot(`?h=${ID}`)).toEqual({ ok: false, reason: 'missing' })
  })

  it('says missing when the recording was deleted', async () => {
    // Swept out under an address the user had open. The row is still there and the files may be
    // too, until the sweeper comes round; deleted is deleted all the same.
    row = session({ deletedAt: 1_700_000_090_000 })
    expect(await loadSnapshot(`?h=${ID}`)).toEqual({ ok: false, reason: 'missing' })
  })

  it('says missing when the index will not open at all', async () => {
    indexRefuses = true
    expect(await loadSnapshot(`?h=${ID}`)).toEqual({ ok: false, reason: 'missing' })
  })

  it('says empty when the rows are there and no piece is', async () => {
    pieces = []
    expect(await loadSnapshot(`?h=${ID}`)).toEqual({ ok: false, reason: 'empty' })
  })

  it('refuses an identifier the extension did not mint', async () => {
    // It goes from the address bar into a path, so a name with a dot in it is a directory upwards.
    expect(await loadSnapshot('?h=../../etc/passwd')).toEqual({ ok: false, reason: 'no-id' })
    expect(await loadSnapshot('?h=')).toEqual({ ok: false, reason: 'no-id' })
  })

  it('marks the recording as used, because opening it is the user choosing it', async () => {
    const before = Date.now()
    await loadSnapshot(`?h=${ID}`)

    expect(stamped).toHaveLength(1)
    expect(stamped[0]![0]).toBe(ID)
    expect(stamped[0]![1]).toBeGreaterThanOrEqual(before)
  })

  it('leaves the snapshot door where it was', async () => {
    // No `h` at all: the address of a frozen page, and it goes looking for a file rather than
    // for rows. A recording of the history is not what `s` names, and routing the two doors
    // through one would put an editor over the wrong material without saying so.
    expect(await loadSnapshot('?s=nonsense')).toEqual({ ok: false, reason: 'no-id' })
    expect(await loadSnapshot(`?s=${ID}`)).toEqual({ ok: false, reason: 'missing' })
    expect(consulted).toEqual([])
    expect(stamped).toEqual([])
  })
})
