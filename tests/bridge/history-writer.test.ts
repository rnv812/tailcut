import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import {
  HISTORY_TAIL_MS,
  HistoryWriter,
  QUOTA_BACKOFF_MS,
  WRITE_TIMEOUT_MS,
  historyWorker,
  type HistoryIo,
} from '../../src/bridge/history-writer'
import { HISTORY_BATCH_BYTES } from '../../src/shared/history-files'
import type { HistoryPiece, HistoryTrack } from '../../src/core/history/layout'
import type { FromHistoryWorker, ToHistoryWorker } from '../../src/bridge/history-worker'
import type { ChunkStored } from '../../src/bridge/session-store'

/** One write the writer asked for, whatever came back of it. */
interface Written {
  path: string
  bytes: number
}

/**
 * The world outside the writer, written down as it is asked.
 *
 * An override decides what an answer is and nothing else: the recording happens first, in every
 * case. Overrides that replaced the whole method — which is what spreading them over the object
 * would do — would take the recording with them, and a test that makes the disk refuse would
 * lose the very thing it is about, namely how many times the writer asked and with what.
 */
function fakeIo(overrides: Partial<HistoryIo> = {}) {
  const written: Written[] = []
  const rows: Array<{
    id: string
    piece: HistoryPiece
    tracks: HistoryTrack[]
    /** The event the row was signed with: `Pending.sample`, as the writer chose it. */
    event: ChunkStored
  }> = []
  const renamed: Array<[string, string]> = []
  let clock = 1_700_000_000_000
  const sweeps: number[] = []

  const io: HistoryIo = {
    write: async (path, bytes) => {
      written.push({ path, bytes: bytes.byteLength })
      return (
        (await overrides.write?.(path, bytes)) ?? { type: 'written', id: 0, bytes: bytes.byteLength }
      )
    },
    open: async (event) => (overrides.open ? await overrides.open(event) : 'sess-1'),
    record: async (id, piece, tracks, event) => {
      rows.push({ id, piece, tracks, event })
      await overrides.record?.(id, piece, tracks, event)
    },
    liveWidth: (key) => overrides.liveWidth?.(key) ?? 0,
    rename: async (id, event) => {
      renamed.push([id, event.to])
    },
    sweep: () => {
      sweeps.push(clock)
      overrides.sweep?.()
    },
    now: () => (overrides.now ? overrides.now() : clock),
  }

  return { io, written, rows, renamed, sweeps, tick: (ms: number) => (clock += ms) }
}

/** The merge key of the session everything in this set is about (§6.1). */
const KEY = 'https://site.example/watch|avc1|live'

/** The picture of that session: the track everything here is written about. */
const VIDEO: ChunkStored['track'] = {
  representation: 'video:avc1:1920x1080',
  bufferId: 'sb-1',
  kinds: ['video'],
  info: { tracks: [{ trackId: 1, kind: 'video', timescale: 90_000, codec: 'avc1', width: 1920, height: 1080 }] },
  initBytes: new Uint8Array(16).fill(9),
}

/**
 * Its sound, in a buffer of its own — which is how MSE delivers sound, and the only reason the
 * facts of a track cannot be read off the chunk that happened to close the batch.
 */
const AUDIO: ChunkStored['track'] = {
  representation: 'audio:mp4a:0x0',
  bufferId: 'sb-2',
  kinds: ['audio'],
  info: { tracks: [{ trackId: 2, kind: 'audio', timescale: 48_000, codec: 'mp4a', width: 0, height: 0 }] },
  initBytes: new Uint8Array(24).fill(7),
}

const of = (track: ChunkStored['track'], start: number, bytes: number): ChunkStored => ({
  key: KEY,
  page: { url: 'https://site.example/watch', title: 'Clip', createdAt: 1, lastSeenAt: 2 },
  track,
  chunk: { start, end: start + 2, bytes: new Uint8Array(bytes).fill(1) },
  widthPx: 0,
})

const event = (start: number, bytes: number): ChunkStored => of(VIDEO, start, bytes)

/** The same chunk, cut at a moment when the player had already been measured (§7.3). */
const watched = (start: number, bytes: number, widthPx: number): ChunkStored => ({
  ...event(start, bytes),
  widthPx,
})

/** A track as the index remembers it, minus the place its init landed in. */
const facts = ({ initBytes: _bytes, ...track }: ChunkStored['track']) => track

/** Lets the writer's queue of promises drain: everything it does is chained onto one. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('HistoryWriter', () => {
  it('holds material back until the batch is full', async () => {
    const { io, written } = fakeIo()
    const writer = new HistoryWriter(io)

    writer.take(event(0, 1_000))
    writer.take(event(2, 1_000))
    await settle()
    expect(written).toHaveLength(0)

    writer.take(event(4, HISTORY_BATCH_BYTES))
    await settle()
    expect(written).toHaveLength(1)
    // The init travels in front of the first material of its track, once.
    expect(written[0]!.bytes).toBe(16 + 1_000 + 1_000 + HISTORY_BATCH_BYTES)
    expect(written[0]!.path).toMatch(/^history\/sess-1\/[0-9a-f]{8}-000000\.tcm$/)
  })

  it('writes the tail out on the timer when nothing more arrives', async () => {
    vi.useFakeTimers()
    try {
      const { io, written } = fakeIo()
      const writer = new HistoryWriter(io)

      writer.take(event(0, 1_000))
      await vi.advanceTimersByTimeAsync(HISTORY_TAIL_MS - 1)
      expect(written).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(2)
      expect(written).toHaveLength(1)
      expect(written[0]!.bytes).toBe(16 + 1_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes the index row after the file and never before it', async () => {
    const order: string[] = []
    const { io, rows } = fakeIo({
      write: async (_path, bytes) => {
        order.push('file')
        return { type: 'written', id: 0, bytes: bytes.byteLength }
      },
      record: async () => {
        order.push('row')
      },
    })
    const writer = new HistoryWriter(io)

    writer.take(event(0, HISTORY_BATCH_BYTES))
    await settle()

    expect(order).toEqual(['file', 'row'])
    expect(rows[0]!.piece.parts).toHaveLength(1)
    expect(rows[0]!.tracks).toEqual([
      { ...facts(VIDEO), init: { file: rows[0]!.piece.file, at: 0, length: 16 } },
    ])
  })

  it('describes every track of a batch by its own init, not by the chunk that closed it', async () => {
    const { io, rows } = fakeIo()
    const writer = new HistoryWriter(io)

    // Picture and sound of one video, inside one tail. That is the ordinary first batch of any
    // session — MSE gives a track a SourceBuffer apiece and a site opens both in the first second
    // — and it is the only place where one piece carries the init of more than one track.
    writer.take(of(VIDEO, 0, 1_000))
    writer.take(of(AUDIO, 0, HISTORY_BATCH_BYTES))
    await settle()

    // The row of a track says what that track is: its buffer, its kinds, the header its init
    // declared. Read off the batch instead — off `sample`, the freshest event in it — and the
    // picture of this session would be written down as sound, with the sound's timescale, and
    // the editor would read every video segment on the wrong clock.
    const file = rows[0]!.piece.file
    expect(rows[0]!.tracks).toEqual([
      { ...facts(VIDEO), init: { file, at: 0, length: 16 } },
      { ...facts(AUDIO), init: { file, at: 1_016, length: 24 } },
    ])
  })

  it('signs a piece with the player the frame is watching in now, not with the one its chunks knew', async () => {
    // A site that hands over its whole video in the first second has cut every chunk it will ever
    // cut before the watcher has measured anything: half a second is the earliest a player is
    // measured at, and these chunks are stamped with nothing. Asked again where the piece lands —
    // the latest moment there is — the frame knows the answer.
    const { io, rows } = fakeIo({ liveWidth: () => 1_280 })
    const writer = new HistoryWriter(io)

    writer.take(event(0, HISTORY_BATCH_BYTES))
    await settle()

    expect(rows[0]!.event.widthPx, 'the row went down under a width of nothing').toBe(1_280)
  })

  it('keeps the width its chunks carried when the frame has nothing left to say about them', async () => {
    // The other half of the same rule, and an ordinary case rather than a defensive one: the key
    // of a session moves while it is being recorded (§6.1), the batch gathered under the old one
    // lands after the move, and the event that signs the row keeps the key it was gathered under.
    // Nothing stands under that key any more, so the frame answers nothing — and what the chunks
    // were stamped with is the whole of what is known about the player. It is a real number: a
    // session re-keyed after a while of watching was measured long before it moved.
    const { io, rows } = fakeIo({ liveWidth: () => 0 })
    const writer = new HistoryWriter(io)

    writer.take(watched(0, HISTORY_BATCH_BYTES, 640))
    await settle()

    expect(rows[0]!.event.widthPx, 'the measurement went down with the key it was made under').toBe(640)
  })

  it('sends the init of a track once, and again if the batch carrying it was lost', async () => {
    let fail = true
    const { io, written } = fakeIo({
      write: async (_path, bytes) => {
        if (fail) {
          fail = false
          return { type: 'failed', id: 0, error: 'no', quota: false }
        }
        return { type: 'written', id: 0, bytes: bytes.byteLength }
      },
    })
    const writer = new HistoryWriter(io)

    writer.take(event(0, HISTORY_BATCH_BYTES))
    await settle()
    writer.take(event(2, HISTORY_BATCH_BYTES))
    await settle()
    writer.take(event(4, HISTORY_BATCH_BYTES))
    await settle()

    // First batch lost with its init in it, second brings the init again, third does not: an init
    // arrives once from the page and is never repeated, so a piece whose init never landed would
    // be material nothing can read.
    expect(written.map((one) => one.bytes)).toEqual([
      16 + HISTORY_BATCH_BYTES,
      16 + HISTORY_BATCH_BYTES,
      HISTORY_BATCH_BYTES,
    ])
  })

  it('sends the init once through a burst that leaves no pause between batches', async () => {
    const { io, written, rows } = fakeIo()
    const writer = new HistoryWriter(io)

    // Nothing is awaited between the two: both batches are cut in one turn, so the first is still
    // on the queue — its file unwritten, its row unrecorded — while the second is laid out. The
    // test above cannot see this because it waits, and the disk showed it plainly: 1658 bytes more
    // on disk than had been handed over, which is exactly two copies of the init of the fixture.
    writer.take(event(0, HISTORY_BATCH_BYTES))
    writer.take(event(2, HISTORY_BATCH_BYTES))
    await settle()

    expect(written.map((one) => one.bytes)).toEqual([16 + HISTORY_BATCH_BYTES, HISTORY_BATCH_BYTES])
    // And the writer offers the init to the index once, which is the half of that promise it can
    // keep: it never sends the same init down twice inside one key. The other half — what the
    // index does when a merge of two keys offers it a second place after all — belongs to
    // `recordPiece` and is tested there (`what a landed piece leaves in the index` in
    // tests/e2e/history-db.spec.ts).
    expect(rows.flatMap((row) => row.tracks)).toEqual([
      { ...facts(VIDEO), init: { file: rows[0]!.piece.file, at: 0, length: 16 } },
    ])
  })

  it('brings the init back when the batch carrying it was lost inside a burst', async () => {
    let fail = true
    const { io, written } = fakeIo({
      write: async (_path, bytes) => {
        if (fail) {
          fail = false
          return { type: 'failed', id: 0, error: 'no', quota: false }
        }
        return { type: 'written', id: 0, bytes: bytes.byteLength }
      },
    })
    const writer = new HistoryWriter(io)

    // The claim is given up when the batch holding it does not land, and this is the price of
    // making it at all: the second batch of the burst was cut while the first still looked like it
    // would land, so it goes down without an init in front of it and is unreadable until the third
    // brings one. The batch after the failure is where the init comes back.
    writer.take(event(0, HISTORY_BATCH_BYTES))
    writer.take(event(2, HISTORY_BATCH_BYTES))
    await settle()
    writer.take(event(4, HISTORY_BATCH_BYTES))
    await settle()

    expect(written.map((one) => one.bytes)).toEqual([
      16 + HISTORY_BATCH_BYTES,
      HISTORY_BATCH_BYTES,
      16 + HISTORY_BATCH_BYTES,
    ])
  })

  it('drops the batch when storage is full, asks for room, and waits before trying again', async () => {
    const { io, written, sweeps, tick } = fakeIo({
      write: async () => ({ type: 'failed', id: 0, error: 'QuotaExceededError', quota: true }),
    })
    const writer = new HistoryWriter(io)

    writer.take(event(0, HISTORY_BATCH_BYTES))
    await settle()
    expect(sweeps).toHaveLength(1)

    // Nothing is taken while the backoff stands: a quota refusal comes whole — there is no short
    // write — so retrying at once would only fill the log with the same failure.
    writer.take(event(2, HISTORY_BATCH_BYTES))
    await settle()
    expect(written).toHaveLength(1)

    tick(QUOTA_BACKOFF_MS + 1)
    writer.take(event(4, HISTORY_BATCH_BYTES))
    await settle()
    expect(written).toHaveLength(2)
  })

  it('drops what it was gathering when the history is switched off', async () => {
    vi.useFakeTimers()
    try {
      const { io, written } = fakeIo()
      const writer = new HistoryWriter(io)

      writer.take(event(0, 1_000))
      writer.setEnabled(false)
      await vi.advanceTimersByTimeAsync(HISTORY_TAIL_MS * 2)

      // The user said: nothing to the disk. Writing the batch that was already gathered would be
      // a file created after the switch was turned off.
      expect(written).toHaveLength(0)

      writer.take(event(2, 1_000))
      await vi.advanceTimersByTimeAsync(HISTORY_TAIL_MS * 2)
      expect(written).toHaveLength(0)

      writer.setEnabled(true)
      writer.take(event(4, 1_000))
      await vi.advanceTimersByTimeAsync(HISTORY_TAIL_MS * 2)
      // What was gathered while it was off is gone; what arrives after it is on goes down, with
      // the init in front of it — nothing of this track has reached the disk yet.
      expect(written).toHaveLength(1)
      expect(written[0]!.bytes).toBe(16 + 1_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends everything it has gathered when it is told the page is going, and only once', async () => {
    vi.useFakeTimers()
    try {
      const { io, written } = fakeIo()
      const writer = new HistoryWriter(io)

      writer.take(event(0, 1_000))
      expect(vi.getTimerCount()).toBe(1)

      writer.flushAll()
      // The tail timer went with the batch, and it went now rather than two seconds from now: a
      // frame lives for hours and this runs on every batch, so a timer abandoned by each of them
      // is a timer per batch outstanding for the life of the page.
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(0)
      expect(written.map((one) => one.bytes)).toEqual([16 + 1_000])

      await vi.advanceTimersByTimeAsync(HISTORY_TAIL_MS * 2)
      expect(written).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing to the index when it refuses to open the session', async () => {
    const { io, written, rows } = fakeIo({ open: async () => null })
    const writer = new HistoryWriter(io)

    writer.take(event(0, HISTORY_BATCH_BYTES))
    await settle()

    expect(written).toHaveLength(0)
    expect(rows).toHaveLength(0)
  })
})

describe('HistoryWriter.rekey', () => {
  // What the key becomes when the player states the length: the same address, `live` replaced by
  // the number (§6.1, and durationToken rounds it to whole seconds).
  const NEXT = 'https://site.example/watch|avc1|7'
  const moved = { from: KEY, to: NEXT, page: { url: 'https://site.example/watch', title: 'Clip' } }

  it('moves the row of a session to the key it is now known by', async () => {
    const { io, written, rows, renamed } = fakeIo()
    const writer = new HistoryWriter(io)

    writer.take(event(0, HISTORY_BATCH_BYTES))
    await settle()
    writer.rekey(moved)
    await settle()

    expect(renamed).toEqual([['sess-1', NEXT]])

    // What arrives under the new key goes into the same row and the same directory, and the init
    // of a track that is already on disk does not travel again.
    writer.take({ ...event(2, HISTORY_BATCH_BYTES), key: NEXT })
    await settle()
    expect(rows.map((row) => row.id)).toEqual(['sess-1', 'sess-1'])
    expect(written.map((one) => one.bytes)).toEqual([
      16 + HISTORY_BATCH_BYTES,
      HISTORY_BATCH_BYTES,
    ])
  })

  it('carries what it was gathering over, init and all, when nothing has landed yet', async () => {
    const { io, written, rows } = fakeIo()
    const writer = new HistoryWriter(io)

    writer.take(event(0, 1_000))
    writer.rekey(moved)
    writer.take({ ...event(2, HISTORY_BATCH_BYTES), key: NEXT })
    await settle()

    // One row, one file, both chunks in it, and the init in front of them: nothing had reached
    // the disk when the key changed, so there was nothing to leave behind.
    expect(rows).toHaveLength(1)
    expect(written[0]!.bytes).toBe(16 + 1_000 + HISTORY_BATCH_BYTES)
    expect(rows[0]!.piece.parts).toHaveLength(2)
  })

  it('leaves a merged session where it is, with what it holds', async () => {
    const ids: Record<string, string> = { [KEY]: 'sess-1', [NEXT]: 'sess-2' }
    const { io, written, rows, renamed } = fakeIo({ open: async (one) => ids[one.key] ?? 'sess-1' })
    const writer = new HistoryWriter(io)

    // Both keys have a row of their own: two sessions of one frame about to become one.
    writer.take(event(0, HISTORY_BATCH_BYTES))
    writer.take({ ...event(0, HISTORY_BATCH_BYTES), key: NEXT })
    await settle()

    writer.take(event(4, 1_000))
    writer.rekey(moved)
    await settle()

    // Nothing renamed — the survivor has a row — and the half-gathered batch went down under the
    // key it was gathered on, where the init that explains it is.
    expect(renamed).toEqual([])
    expect(rows.map((row) => row.id)).toEqual(['sess-1', 'sess-2', 'sess-1'])
    expect(written.at(-1)!.bytes).toBe(1_000)
  })

  it('waits for an identity a batch is still asking for, instead of deciding nothing was written', async () => {
    const { io, written, rows, renamed } = fakeIo()
    const writer = new HistoryWriter(io)

    // The batch is full, so it goes down on the spot — and the key changes while the index is
    // still being asked who this session is. No `settle` between the two lines, and that is the
    // whole test: the merge key of §6.1 changes when the player states the length, which is the
    // first second of playback, which is exactly when the first batch is in flight.
    writer.take(event(0, HISTORY_BATCH_BYTES))
    writer.rekey(moved)
    writer.take({ ...event(2, HISTORY_BATCH_BYTES), key: NEXT })
    await settle()

    // One session, renamed, and both batches in it. Read `opened` synchronously here and this is
    // two rows for one video: the identity stays behind under the old key and the second batch
    // opens another.
    expect(renamed).toEqual([['sess-1', NEXT]])
    expect(rows.map((row) => row.id)).toEqual(['sess-1', 'sess-1'])
    // And the init does not travel a second time. The claim on it is made where the batch is cut
    // rather than after it lands (see `carried`), so it was already standing when the key moved,
    // and it moved with it: the same identity, the same directory, one init on disk. The claim
    // is the very same set, so a first batch that failed to land would give it back under the new
    // key and the next batch would bring the init along.
    expect(written.map((one) => one.bytes)).toEqual([
      16 + HISTORY_BATCH_BYTES,
      HISTORY_BATCH_BYTES,
    ])
  })

  /** Most of a batch and not quite one: two of these are over the limit, one of them is not. */
  const NEARLY = HISTORY_BATCH_BYTES - 1_000

  it('gathers both halves into one batch when two keys that were both filling one become one', async () => {
    const { io, written, rows } = fakeIo()
    const writer = new HistoryWriter(io)

    // Neither key has written a byte, which is the ordinary way a merge happens: two sources of
    // one frame meet in `absorb` (SessionStore.bind) in the first second of playback, before any
    // batch has reached the disk. Each side is nearly a batch, so neither goes down on its own.
    writer.take(of(VIDEO, 0, NEARLY))
    writer.take({ ...of(AUDIO, 0, NEARLY), key: NEXT })
    await settle()
    expect(written).toHaveLength(0)

    writer.rekey(moved)
    await settle()

    // One file with both halves in it, and it went down on the spot: the merged batch counts what
    // both sides had gathered, so it is over the limit. Kept apart, this material would have sat
    // in memory until the tail timer fired on it.
    expect(written.map((one) => one.bytes)).toEqual([24 + NEARLY + 16 + NEARLY])
    expect(rows[0]!.piece.parts).toHaveLength(2)

    // And every track the merged batch carries an init for is described in the row, by its own
    // init. The facts of a track are put where its init is attached, and they have to travel with
    // it across the merge: what the surviving batch carries an init for, it must be able to
    // describe. Left behind, the sound of this session would be missing from the index while its
    // init sat in the file — or, read off `sample` instead, written down as a second picture.
    const file = rows[0]!.piece.file
    expect(rows[0]!.tracks).toEqual([
      { ...facts(AUDIO), init: { file, at: 0, length: 24 } },
      { ...facts(VIDEO), init: { file, at: 24 + NEARLY, length: 16 } },
    ])
  })

  it('signs the merged batch with the fresher of the two events, whichever side it came from', async () => {
    const seenAt = (one: ChunkStored, lastSeenAt: number): ChunkStored => ({
      ...one,
      page: { ...one.page, lastSeenAt },
    })

    // Two keys gathering side by side, and no order between them: the writer sees them as two
    // batches and nothing says which was filled last. `sample` is what the row of the session is
    // signed with — `openSession` dates a new row by it and `recordPiece` moves `lastSeenAt` to
    // it — so the merged batch has to carry the event that saw the page last.
    //
    // The session being folded in is not always the fresher one, and the registry's own set says
    // so: in `says so on a merge, when the session it moves to is already there`
    // (tests/core/session-store.test.ts) the material that arrived last went to the session that
    // survives, and the one that moves has been standing still since before it.
    for (const [older, fresher] of [
      [KEY, NEXT],
      [NEXT, KEY],
    ] as const) {
      const { io, rows } = fakeIo()
      const writer = new HistoryWriter(io)

      writer.take(seenAt({ ...of(VIDEO, 0, 1_000), key: older }, 5))
      writer.take(seenAt({ ...of(AUDIO, 0, 1_000), key: fresher }, 11))
      writer.rekey(moved)
      writer.flushAll()
      await settle()

      expect(rows).toHaveLength(1)
      expect(rows[0]!.event.page.lastSeenAt).toBe(11)
    }
  })
})

/**
 * A worker that does exactly what it is told and nothing on its own.
 *
 * Every answer in this set is given by hand, because the whole of what is tested here is what
 * happens when an answer does not come: a worker that dies, and a worker that stops speaking
 * without dying. Both were reached by real builds — the second is why WRITE_TIMEOUT_MS exists —
 * and neither can be provoked by a real worker on demand.
 */
class FakeWorker {
  static started: FakeWorker[] = []

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly sent: Array<{ request: ToHistoryWorker; transfer: readonly unknown[] }> = []
  terminated = false

  constructor(readonly url: string) {
    FakeWorker.started.push(this)
  }

  postMessage(request: ToHistoryWorker, transfer: readonly unknown[]): void {
    this.sent.push({ request, transfer })
  }

  terminate(): void {
    this.terminated = true
  }

  /** The worker speaks. */
  says(answer: FromHistoryWorker): void {
    this.onmessage?.({ data: answer } as MessageEvent)
  }

  /** The worker dies: a script that would not load, or a throw out of its top level. */
  dies(): void {
    this.onerror?.({ message: 'gone' })
  }
}

describe('historyWorker', () => {
  beforeEach(() => {
    FakeWorker.started = []
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://x/${path}` } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts one worker, and only once there is something to write', async () => {
    const write = historyWorker()
    // A frame that records nothing must not pay for a worker: 153 of the 154 frames measured on
    // the news page record nothing at all.
    expect(FakeWorker.started).toHaveLength(0)

    const first = new ArrayBuffer(8)
    const second = new ArrayBuffer(16)
    void write('history/a/aaaa-000000.tcm', first)
    void write('history/a/aaaa-000001.tcm', second)

    expect(FakeWorker.started).toHaveLength(1)
    const worker = FakeWorker.started[0]!
    expect(worker.url).toBe('chrome-extension://x/bridge/history-worker.js')
    expect(worker.sent.map((one) => one.request.id)).toEqual([1, 2])
    expect(worker.sent.map((one) => one.request.path)).toEqual([
      'history/a/aaaa-000000.tcm',
      'history/a/aaaa-000001.tcm',
    ])
    // Handed over and not copied: a batch is eight mebibytes, and a clone of it costs 7 ms of the
    // frame per batch for nothing.
    expect(worker.sent.map((one) => one.transfer)).toEqual([[first], [second]])
  })

  it('gives every write the answer that carries its own number', async () => {
    const write = historyWorker()
    const first = write('history/a/aaaa-000000.tcm', new ArrayBuffer(8))
    const second = write('history/a/aaaa-000001.tcm', new ArrayBuffer(16))
    const worker = FakeWorker.started[0]!

    // Out of order on purpose: the number is what tells them apart, not the order.
    worker.says({ type: 'written', id: 2, bytes: 16 })
    worker.says({ type: 'written', id: 1, bytes: 8 })

    expect(await first).toEqual({ type: 'written', id: 1, bytes: 8 })
    expect(await second).toEqual({ type: 'written', id: 2, bytes: 16 })
  })

  it('answers every write in flight when the worker dies, and starts another for the next one', async () => {
    const write = historyWorker()
    const first = write('history/a/aaaa-000000.tcm', new ArrayBuffer(8))
    const second = write('history/a/aaaa-000001.tcm', new ArrayBuffer(16))
    const worker = FakeWorker.started[0]!

    worker.dies()

    // Answered, both of them: the queue in the writer holds one batch at a time, so a write that
    // is never answered stops every later batch of every session for the life of the frame.
    expect(await first).toMatchObject({ type: 'failed', id: 1, quota: false })
    expect(await second).toMatchObject({ type: 'failed', id: 2, quota: false })
    expect(worker.terminated).toBe(true)

    void write('history/a/aaaa-000002.tcm', new ArrayBuffer(4))
    expect(FakeWorker.started).toHaveLength(2)
    expect(FakeWorker.started[1]!.sent[0]!.request.path).toBe('history/a/aaaa-000002.tcm')
  })

  it('gives up on a write the worker never answers, and lets a late word change nothing', async () => {
    vi.useFakeTimers()
    try {
      const write = historyWorker()
      const answer = write('history/a/aaaa-000000.tcm', new ArrayBuffer(8))
      const worker = FakeWorker.started[0]!

      // A worker killed under memory pressure says nothing and fires no onerror. Nothing else in
      // this program would ever answer this write.
      await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS - 1)
      let settled = false
      void answer.then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(2)
      expect(await answer).toMatchObject({ type: 'failed', id: 1, quota: false })

      // And the worker coming back to life afterwards resolves nothing a second time.
      worker.says({ type: 'written', id: 1, bytes: 8 })
      expect(await answer).toMatchObject({ type: 'failed', id: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets go of the timer of a write that was answered', async () => {
    vi.useFakeTimers()
    try {
      const write = historyWorker()
      const answer = write('history/a/aaaa-000000.tcm', new ArrayBuffer(8))
      FakeWorker.started[0]!.says({ type: 'written', id: 1, bytes: 8 })
      expect(await answer).toEqual({ type: 'written', id: 1, bytes: 8 })

      // Straight away, and not after the minute has passed — a timer that is still pending here
      // would go on to fire and be counted as gone by then. The frame lives for hours and writes
      // a batch every couple of seconds; a timer left behind by every one of them keeps the
      // answer of that write alive with it for a minute apiece.
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS * 2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
