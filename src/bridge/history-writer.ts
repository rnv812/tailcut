import { layoutBatch, type BatchItem, type HistoryPiece, type PlacedInit } from '../core/history/layout'
import { concatBytes } from '../core/iso/writer'
import { HISTORY_BATCH_BYTES, newWriterId, pieceName, piecePath } from '../shared/history-files'
import type { FromHistoryWorker, ToHistoryWorker } from './history-worker'
import type { ChunkStored } from './session-store'

/**
 * How long a batch waits for more material before going down as it is.
 *
 * This is the loss window of §7.5, named as a number: a crash takes at most this much material
 * with it. Two seconds and not two hundred milliseconds for a measured reason — Chrome throttles
 * the timers of a cross-origin frame that is out of the viewport to 1 Hz, and a 200 ms timer
 * would silently become a second. A two-second one arrives on time throttled or not.
 */
export const HISTORY_TAIL_MS = 2_000

/**
 * How long the writer keeps quiet after storage has refused it for being full.
 *
 * A quota refusal comes whole — `write()` either takes every byte or throws, there is no short
 * write — so there is nothing to retry until somebody has made room. The sweeper is asked at
 * once and runs on its own alarm; this is the wait for it to have happened.
 */
export const QUOTA_BACKOFF_MS = 30_000

/**
 * How long a batch may be in the worker before it is given up on.
 *
 * A minute against the 9.6 ms this size was measured at: it fires on a worker that has died
 * without a word, not on a slow disk. The snapshot has the same guard for the same reason
 * (`WRITE_TIMEOUT_MS` in src/bridge/snapshot-writer.ts) and the history needs it more — a snapshot
 * that hangs costs one click, a batch that hangs costs every batch after it.
 */
export const WRITE_TIMEOUT_MS = 60_000

/** Path of the worker inside the package; loaded by a document of the extension origin. */
const WORKER_PATH = 'bridge/history-worker.js'

/**
 * What the writer needs of the world outside it.
 *
 * A seam, and the reason the batching is testable at all: OPFS and IndexedDB exist in a browser
 * and nowhere else, while the rules worth testing — when a batch goes down, what happens to an
 * init whose batch was lost, what a full disk does — are rules about scheduling.
 */
export interface HistoryIo {
  write(path: string, bytes: ArrayBuffer): Promise<FromHistoryWorker>
  /** Identity of this session on disk; null — the index would not open one, so nothing is written. */
  open(event: ChunkStored): Promise<string | null>
  /** The row goes in after the file has landed, never before it (see the storage convention). */
  record(id: string, piece: HistoryPiece, inits: PlacedInit[], event: ChunkStored): Promise<void>
  /** Storage is full and somebody has to make room. */
  sweep(): void
  now(): number
}

type Timer = ReturnType<typeof setTimeout>

interface Pending {
  items: BatchItem[]
  bytes: number
  /** The freshest event of the batch: what the session row is signed with. */
  sample: ChunkStored
  /** Representations whose init is inside this batch already. */
  attached: Set<string>
  timer: Timer | undefined
}

/**
 * Gathers what the registry takes in and hands it to the worker in pieces.
 *
 * One per frame. It never blocks the path material arrives on: `take` is synchronous and does
 * arithmetic, and everything that awaits anything is chained onto a queue of one, so two batches
 * are never in flight at once and the pieces of a session land in the order they were gathered.
 */
export class HistoryWriter {
  private readonly writerId = newWriterId()
  private seq = 0
  private enabled = true
  private quietUntil = 0
  private pending = new Map<string, Pending>()
  /** Session key → its identity on disk, once the index has given one out. */
  private opened = new Map<string, string>()
  /**
   * Keys that have asked the index for an identity, answered or not.
   *
   * `opened` fills in on the queue, an await after the batch that needed it went down; this fills
   * in the moment that batch is queued. The difference is a few milliseconds and it matters to
   * exactly one caller — `rekey` (Task 4), which runs on an event and can land inside that await.
   */
  private claimed = new Set<string>()
  /** Session key → representations whose init segment is on disk already. */
  private landed = new Map<string, Set<string>>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly io: HistoryIo) {}

  /** Whether anything is written at all: the switch of §7.2, wired to the setting in Task 9. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return
    this.enabled = on
    // Switched off, what was gathered is dropped rather than written out. The user said nothing
    // to the disk; a file created after the switch would be exactly that. What is already on the
    // disk stays — the switch is about writing, not about erasing.
    if (!on) for (const key of [...this.pending.keys()]) this.drop(key)
  }

  take(event: ChunkStored): void {
    if (!this.enabled || this.io.now() < this.quietUntil) return

    const pending = this.pending.get(event.key) ?? {
      items: [],
      bytes: 0,
      sample: event,
      attached: new Set<string>(),
      timer: undefined,
    }
    pending.sample = event

    const representation = event.track.representation
    const item: BatchItem = { representation, chunk: event.chunk }

    // The init goes with the first material of its track that this writer sends down, and is
    // marked as landed only once the batch carrying it has actually landed: a site gives its init
    // segments out in the first second of playback and never repeats them, so an init lost with a
    // failed batch has to travel again with the next one or the material is unreadable for good.
    if (!this.landed.get(event.key)?.has(representation) && !pending.attached.has(representation)) {
      item.init = event.track.initBytes
      pending.attached.add(representation)
      pending.bytes += event.track.initBytes.byteLength
    }

    pending.items.push(item)
    pending.bytes += event.chunk.bytes.byteLength
    this.pending.set(event.key, pending)

    if (pending.bytes >= HISTORY_BATCH_BYTES) {
      this.flush(event.key)
      return
    }
    if (!pending.timer) {
      pending.timer = setTimeout(() => this.flush(event.key), HISTORY_TAIL_MS)
    }
  }

  /** Everything gathered, down now. For a caller that knows the page is going away. */
  flushAll(): void {
    for (const key of [...this.pending.keys()]) this.flush(key)
  }

  private drop(key: string): void {
    const pending = this.pending.get(key)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(key)
  }

  private flush(key: string): void {
    const pending = this.pending.get(key)
    if (!pending || !pending.items.length) return
    this.drop(key)

    const file = pieceName(this.writerId, this.seq++)
    const layout = layoutBatch(file, this.io.now(), pending.items)
    // The copy happens here, in one synchronous turn with the layout, and the buffer that comes
    // out of it is what gets transferred. The chunks are subarray views over the buffers the
    // appends arrived in, several chunks to a buffer; transferring those would neuter the live
    // session, and the next "Save all" would write a file of zeroes.
    const bytes = concatBytes(layout.parts)
    const sample = pending.sample

    // Said here, synchronously, and not inside the continuation below: from this line until the
    // identity lands in `opened` the index may be answering, and to anything reading `opened`
    // alone this key looks like a key that has never written a byte. `rekey` reads it (Task 4).
    this.claimed.add(key)

    this.queue = this.queue
      .then(async () => {
        const id = this.opened.get(key) ?? (await this.io.open(sample))
        if (!id) return
        this.opened.set(key, id)

        const answer = await this.io.write(piecePath(id, file), bytes.buffer as ArrayBuffer)
        if (answer.type !== 'written') {
          if (answer.quota) {
            this.quietUntil = this.io.now() + QUOTA_BACKOFF_MS
            this.io.sweep()
          }
          return
        }

        // The row after the file, never before it: a row is a promise that the bytes are there.
        await this.io.record(id, layout.piece, layout.inits, sample)

        const landed = this.landed.get(key) ?? new Set<string>()
        for (const init of layout.inits) landed.add(init.representation)
        this.landed.set(key, landed)
      })
      .catch(() => {
        // Nothing here may reject: this queue is the only thing chaining the batches, and a
        // rejection would leave every later batch of every session unwritten. What went wrong is
        // already answered as a `failed` message; anything else is a defect of ours, and dropping
        // one batch is the cheapest way to keep recording through it.
      })
  }
}

/**
 * The worker, started when there is something to write and kept for the life of the frame.
 *
 * One worker and one message per batch, with the answer matched by number. Started lazily,
 * because a frame that records nothing — 153 out of 154 on the news page measured — must not pay
 * for a worker at all.
 */
export function historyWorker(): (path: string, bytes: ArrayBuffer) => Promise<FromHistoryWorker> {
  let worker: Worker | undefined
  let last = 0
  const waiting = new Map<number, { answer: (answer: FromHistoryWorker) => void; timer: Timer }>()

  /** Answers one write, once. Whoever gets there first — the worker, its death or the clock. */
  const settle = (id: number, answer: FromHistoryWorker): void => {
    const pending = waiting.get(id)
    if (!pending) return
    waiting.delete(id)
    clearTimeout(pending.timer)
    pending.answer(answer)
  }

  const start = (): Worker => {
    const started = new Worker(chrome.runtime.getURL(WORKER_PATH))
    started.onmessage = (event: MessageEvent) => {
      const answer = event.data as FromHistoryWorker
      settle(answer.id, answer)
    }
    started.onerror = () => {
      // The worker died: every write waiting on it is answered as failed, so the queue in the
      // writer moves on, and the next batch starts a new one.
      for (const id of [...waiting.keys()]) {
        settle(id, { type: 'failed', id, error: 'the history worker stopped', quota: false })
      }
      started.terminate()
      worker = undefined
    }
    return started
  }

  return (path, bytes) =>
    new Promise<FromHistoryWorker>((resolve) => {
      worker ??= start()
      const request: ToHistoryWorker = { type: 'write', id: ++last, path, bytes }
      // The last resort, and the only one left when the worker stops being able to speak at all.
      // `onerror` covers a script that failed to load or threw out of the top level; it does not
      // cover a worker killed under memory pressure, and it does not cover a rejection that
      // reaches nobody. Without this the queue in the writer — one batch at a time — stops for
      // good on the first such write and takes every later batch of every session with it,
      // silently, on a page that goes on playing.
      const timer = setTimeout(() => {
        settle(request.id, {
          type: 'failed',
          id: request.id,
          error: 'the history worker did not answer',
          quota: false,
        })
      }, WRITE_TIMEOUT_MS)
      waiting.set(request.id, { answer: resolve, timer })
      worker.postMessage(request, [bytes])
    })
}
