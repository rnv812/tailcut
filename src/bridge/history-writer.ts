import { layoutBatch, type BatchItem, type HistoryPiece, type HistoryTrack } from '../core/history/layout'
import { concatBytes } from '../core/iso/writer'
import { HISTORY_BATCH_BYTES, newWriterId, pieceName, piecePath } from '../shared/history-files'
import type { FromHistoryWorker, ToHistoryWorker } from './history-worker'
import type { ChunkStored, SessionRekeyed } from './session-store'

/**
 * How long a batch waits for more material before going down as it is.
 *
 * This constant names the loss window: a crash takes at most this much material
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
  /**
   * The row goes in after the file has landed, never before it (see the storage convention).
   *
   * `tracks` are the tracks whose init segment this piece carries, each described by the event
   * that brought it. Described one by one and not by the batch, because a batch regularly carries
   * the init of two — MSE gives the picture and the sound a SourceBuffer apiece and a site opens
   * both in the first second — and the facts of a track cannot be read off whichever chunk
   * happened to close the batch.
   */
  record(id: string, piece: HistoryPiece, tracks: HistoryTrack[], event: ChunkStored): Promise<void>
  /**
   * The largest player the session under this key is being watched in right now, in CSS pixels;
   * 0 — nothing stands under that key in this frame any more.
   *
   * Asked when a piece has landed, which is the latest moment there is, and asked because the
   * stamp the chunks carry is regularly older than the measurement: a player is measured half a
   * second into the page at the earliest, and a site that hands over its whole video in the first
   * second has cut every chunk it will ever cut before then. Stamped alone, such a session would
   * lie on the disk at a width of nothing and be swept as worthless.
   *
   * It answers 0 rather than the truth in one ordinary case, and that is why the stamp is kept
   * beside it: the key of a session moves while it is being recorded, and a batch gathered
   * under the old one lands after the move — see `rekey`, where the batch travels and the event
   * that signs it keeps the key it was gathered under.
   */
  liveWidth(key: string): number
  /** The session on disk is known by another merge key from now on; the row moves, the files do not. */
  rename(id: string, event: SessionRekeyed): Promise<void>
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
  /**
   * Representations whose init is inside this batch already, and what each of those tracks is.
   *
   * The facts and not merely the names, because the row of a track is written from them: the
   * buffer it arrived in, its kinds and the header its init declared. They are put here where the
   * init is attached, so that a track is described by the event that carried its init and not by
   * the freshest event of the batch, which is as likely to be the other track's.
   */
  attached: Map<string, Omit<HistoryTrack, 'init'>>
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
   * exactly one caller, `rekey`, which runs on an event and can land inside that await.
   */
  private claimed = new Set<string>()
  /**
   * Session key → representations whose init segment is on disk or on its way to it.
   *
   * "On its way" is the whole of the difference and it is not a nicety. A site hands out the init
   * of a track in the first second of playback and never repeats it, so the init has to travel
   * again with the next batch if the batch carrying it was lost — which is why this used to be
   * filled in after the write, in the continuation. But the batches are cut synchronously, and a
   * burst cuts the second one before the first has landed: the mark was not there yet, and the
   * init went down a second time. Measured on the disk — 1658 bytes more than had been handed
   * over, two copies of the init of the fixture — and unseen by the set, which waited between
   * batches.
   *
   * So the claim is made where the batch is cut and given back if that batch did not land. The
   * cost is one batch of a burst going down with no init in front of it when the batch that was
   * carrying it fails; the next one brings it. What is bought is the promise `HistoryTrack.init`
   * makes to everything downstream — one init per track, in one place the index can name.
   */
  private carried = new Map<string, Set<string>>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly io: HistoryIo) {}

  /** Whether anything is written at all, wired directly to the disk-history setting. */
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
      attached: new Map<string, Omit<HistoryTrack, 'init'>>(),
      timer: undefined,
    }
    pending.sample = event

    const representation = event.track.representation
    const item: BatchItem = { representation, chunk: event.chunk }

    // The init goes with the first material of its track that this writer sends down, and with
    // nothing after that: the claim is made when the batch is cut, and given back only if that
    // batch failed to land. Sites give their init segments out in the first second of playback and
    // never repeat them, so an init lost with a failed batch has to travel again with the next one
    // or the material is unreadable for good.
    if (!this.carried.get(event.key)?.has(representation) && !pending.attached.has(representation)) {
      item.init = event.track.initBytes
      pending.attached.set(representation, {
        representation,
        bufferId: event.track.bufferId,
        kinds: event.track.kinds,
        info: event.track.info,
      })
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

  /**
   * The session this writer knows under one key is known under another from now on.
   *
   * Three cases, told apart by one question: is there a row on the disk under either key already?
   *
   * Nothing written yet — the ordinary case, because the length a player states arrives in the
   * first second — and everything simply moves: the batch being gathered carries the init
   * segments of its tracks with it, because nothing of them has landed.
   *
   * A row under the old key and none under the new one: the row moves with the key. The identity
   * is the same, the directory is the same, and what has already landed stays landed — which is
   * the whole point, because otherwise the second half of one video would open a row of its own
   * and the popup would show one recording as two.
   *
   * A row under both, which is a merge (SessionStore.absorb): the batch being gathered goes down
   * under the old key, where the init segments that explain it are, and the two rows stay two.
   * Folding them would mean moving files between directories; it is named as a limitation rather
   * than half-done here.
   */
  rekey(event: SessionRekeyed): void {
    const { from, to } = event
    if (from === to) return

    // "Has an identity, or has asked for one." `opened` alone is not the question: a batch queued
    // a moment ago may be inside `io.open` this very second, and answering "nothing was ever
    // written under this key" would leave the identity behind under a key nothing writes to any
    // more — and the next batch under the new key would open a second row for one video, which is
    // the splitting this method exists to prevent.
    const owns = this.opened.has(from) || this.claimed.has(from)
    const carries = owns && !this.opened.has(to) && !this.claimed.has(to)

    if (owns && !carries) {
      // A merge whose survivor has a row of its own: what was gathered under the old key goes
      // down into the old row, beside the init segments that explain it, and the bookkeeping of
      // that key is left standing — the batch just queued finds its identity there instead of
      // asking the index for it a second time.
      this.flush(from)
      return
    }

    const pending = this.pending.get(from)
    const inits = this.carried.get(from)
    this.pending.delete(from)
    this.carried.delete(from)

    if (carries) {
      if (inits) this.carried.set(to, inits)
      // Onto the queue the batches are on, so that no piece is ever written under a key the index
      // has not been told about yet — and the identity is read there rather than here, because
      // the batch that asked for it may still be waiting for the answer. This runs after it.
      this.queue = this.queue
        .then(async () => {
          const id = this.opened.get(from)
          this.opened.delete(from)
          this.claimed.delete(from)
          if (id === undefined) return

          this.opened.set(to, id)
          this.claimed.add(to)
          await this.io.rename(id, event)
        })
        .catch(() => undefined)
    }

    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = undefined

    const standing = this.pending.get(to)
    if (!standing) {
      this.pending.set(to, pending)
      pending.timer = setTimeout(() => this.flush(to), HISTORY_TAIL_MS)
      return
    }

    // Both keys were gathering: one batch out of the two, in the order the material arrived. This
    // is the one case in which an init travels twice — each side claimed the init of its own
    // tracks before the merge, and the claims are not comparable across keys. It costs a few
    // hundred bytes, and nothing here answers it: the index does, in `recordPiece`, by keeping
    // the first place an init landed in and ignoring every later one. Which is a rule of the
    // index and tested as one — `what a landed piece leaves in the index` in
    // tests/e2e/history-db.spec.ts, against the database it really runs on.
    standing.items.push(...pending.items)
    standing.bytes += pending.bytes
    // Signed with the event that saw the page last, and not simply with the one that moved. The
    // two keys were gathering side by side and nothing orders them: the session that survives a
    // merge is as often the one the freshest material went to — which is exactly the case the
    // registry's set describes under `says so on a merge, when the session it moves to is already
    // there`. `sample` is what `openSession` dates a new row by, so taking the wrong one dates
    // the session by material older than itself.
    if (pending.sample.page.lastSeenAt > standing.sample.page.lastSeenAt) {
      standing.sample = pending.sample
    }
    // The facts of a track travel with its init: what the merged batch carries an init for, the
    // merged batch must be able to describe. Whichever side claimed a representation first keeps
    // it — the two describe the same track, so there is nothing to choose between them.
    for (const [representation, facts] of pending.attached) {
      if (!standing.attached.has(representation)) standing.attached.set(representation, facts)
    }
    if (standing.bytes >= HISTORY_BATCH_BYTES) this.flush(to)
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

    // What the index is told about the tracks of this piece: the place each init landed in,
    // beside the facts of the track it explains. `attached` is filled where the init is attached,
    // so an init with nothing beside it here would be an item this writer never took.
    const tracks = layout.inits.flatMap((init) => {
      const facts = pending.attached.get(init.representation)
      return facts ? [{ ...facts, init: { file, at: init.at, length: init.length } }] : []
    })

    // Both of these are said here, synchronously, and not inside the continuation below, because
    // the next batch is cut in a turn the continuation has not run in yet.
    //
    // `claimed`: from this line until the identity lands in `opened` the index may be answering,
    // and to anything reading `opened` alone this key looks like a key that has never written a
    // byte. `rekey` reads it.
    //
    // `carried`: this batch is taking the init segments of `layout.inits` down with it, and the
    // next batch of a burst must not take them down again.
    this.claimed.add(key)
    const carried = this.carried.get(key) ?? new Set<string>()
    for (const init of layout.inits) carried.add(init.representation)
    this.carried.set(key, carried)

    this.queue = this.queue
      .then(async () => {
        let landed = false
        try {
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
          //
          // Signed with the largest player known now and not only with the one the chunks were
          // stamped with: both halves are needed, and each of them is the whole answer in a case
          // the other cannot reach — see HistoryIo.liveWidth.
          const widthPx = Math.max(sample.widthPx, this.io.liveWidth(sample.key))
          await this.io.record(id, layout.piece, tracks, { ...sample, widthPx })
          landed = true
        } finally {
          // The claim is given back by the batch that did not keep it, whichever way it failed —
          // an index that would not open the session, a refused write, a throw out of `record`.
          // The init then travels again with the next batch, which is the only place it can come
          // from: the page handed it over once and will not do it again.
          if (!landed) for (const init of layout.inits) carried.delete(init.representation)
        }
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
