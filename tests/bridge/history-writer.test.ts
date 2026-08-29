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
import type { HistoryPiece, PlacedInit } from '../../src/core/history/layout'
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
  const rows: Array<{ id: string; piece: HistoryPiece; inits: PlacedInit[] }> = []
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
    record: async (id, piece, inits, event) => {
      rows.push({ id, piece, inits })
      await overrides.record?.(id, piece, inits, event)
    },
    sweep: () => {
      sweeps.push(clock)
      overrides.sweep?.()
    },
    now: () => (overrides.now ? overrides.now() : clock),
  }

  return { io, written, rows, sweeps, tick: (ms: number) => (clock += ms) }
}

/** The merge key of the session everything in this set is about (§6.1). */
const KEY = 'https://site.example/watch|avc1|live'

const event = (start: number, bytes: number): ChunkStored => ({
  key: KEY,
  page: { url: 'https://site.example/watch', title: 'Clip', createdAt: 1, lastSeenAt: 2 },
  track: {
    representation: 'video:avc1:1920x1080',
    bufferId: 'sb-1',
    kinds: ['video'],
    info: { tracks: [] },
    initBytes: new Uint8Array(16).fill(9),
  },
  chunk: { start, end: start + 2, bytes: new Uint8Array(bytes).fill(1) },
})

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
    expect(rows[0]!.inits).toEqual([{ representation: 'video:avc1:1920x1080', at: 0, length: 16 }])
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
