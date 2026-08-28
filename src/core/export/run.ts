import { assembleMp4 } from './assemble'
import type { ExportPlan } from './plan'
import { PARALLEL, reduceQueue, startable, type Job, type Queue, type QueueEvent } from './queue'
// The lookup lives beside the address space it answers about (Task 3): the runner reads slices,
// the preview reads snapshot ranges, and both ask the same question of the same shape.
import { bytesFrom } from './source'
import type { Located } from '../../shared/types'

/**
 * How much material one read asks for.
 *
 * Big enough that a clip of a few seconds comes back in one call, small enough that the progress
 * of a long one moves and that a cancelled job stops within a read rather than at the end.
 */
export const SLICE_BYTES = 4 * 1024 * 1024

/** A hole this small between two samples is cheaper to read through than to seek around. */
export const SLICE_SLACK_BYTES = 64 * 1024

export const MATERIAL_GONE = 'The recording is no longer in storage.'
export const EMPTY_CLIP = 'There is nothing in this clip to write.'

export interface ExportRequest {
  clipId: string
  name: string
  fileName: string
  plan: ExportPlan
}

/** Everything the runner wants of the world: bytes in, a file out. */
export interface ExportIo {
  read(at: Located): Promise<Uint8Array>
  save(file: Uint8Array, fileName: string): Promise<void>
}

export interface RunnerOptions {
  parallel?: number
  sliceBytes?: number
  now?: () => number
}

export interface ExportRunner {
  queue(): Queue
  subscribe(listener: (queue: Queue) => void): () => void
  enqueue(requests: readonly ExportRequest[]): void
  cancel(id: string): void
  retry(id: string): void
  /** Resolves when nothing is running and nothing is waiting. */
  settled(): Promise<void>
}

/**
 * The reads one plan needs, in order, with the ones that touch merged.
 *
 * Samples of a clip lie next to each other in the recording, so a clip of a few seconds comes out
 * as one read. What must never happen is a slice cutting through a sample: the sample would be
 * split across two buffers and the writer would be handed half a frame. So a slice always holds
 * whole samples — one of them, if that one is bigger than the limit.
 */
export function planSlices(
  plan: ExportPlan,
  sliceBytes = SLICE_BYTES,
  slack = SLICE_SLACK_BYTES,
): Located[] {
  const ranges = plan.tracks
    .flatMap((track) => track.samples.map((sample) => sample.source))
    .sort((a, b) => a.at - b.at || a.length - b.length)

  const slices: Located[] = []

  for (const range of ranges) {
    const last = slices[slices.length - 1]
    const end = range.at + range.length

    if (!last) {
      slices.push({ at: range.at, length: range.length })
      continue
    }

    const lastEnd = last.at + last.length
    // Already covered: two tracks can name the same bytes, and two clips can share a sample.
    if (end <= lastEnd) continue

    const grown = end - last.at
    if (range.at - lastEnd <= slack && grown <= sliceBytes) {
      last.length = grown
      continue
    }

    slices.push({ at: range.at, length: range.length })
  }

  return slices
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function createRunner(io: ExportIo, options: RunnerOptions = {}): ExportRunner {
  const parallel = options.parallel ?? PARALLEL
  const sliceBytes = options.sliceBytes ?? SLICE_BYTES
  const now = options.now ?? (() => Date.now())

  let queue: Queue = { jobs: [], parallel }
  let nextId = 1

  const requests = new Map<string, ExportRequest>()

  /**
   * Which attempt of each job is the live one. Absent means the first.
   *
   * A run is not a job. It is one attempt at one, and its name is the pair (job, attempt) — which
   * is the whole of the matter. Cancelling used to raise a flag the running loop read, and
   * retrying lowered that same flag before starting a second run, so the first run woke from its
   * read to a clean flag, believed it had never been called off, and saved the file the queue had
   * already promised to somebody else. A number cannot be lowered. Both commands move the job on
   * to the next attempt, every run holds the number it was born with, and a run whose number has
   * moved on may touch nothing at all: no further read, no report, and above all no file.
   */
  const attempts = new Map<string, number>()

  /** Jobs with a run in flight — the live attempt, or a stale one still winding down. */
  const inFlight = new Set<string>()

  /** Jobs whose file has gone to `io.save`. There is nothing left there to call off (see `cancel`). */
  const handedOver = new Set<string>()

  const listeners = new Set<(queue: Queue) => void>()
  const settling: Array<() => void> = []

  const attemptOf = (id: string): number => attempts.get(id) ?? 0

  const busy = (): boolean =>
    queue.jobs.some((job) => job.state === 'queued' || job.state === 'running')

  /** Answers whether the queue moved: the attempt number turns over with the row and never alone. */
  function emit(event: QueueEvent): boolean {
    const next = reduceQueue(queue, event)
    if (next === queue) return false

    queue = next
    for (const listener of listeners) listener(queue)
    if (!busy()) for (const resolve of settling.splice(0)) resolve()
    return true
  }

  /**
   * Sends the one kind of command that ends an attempt, and turns the attempt over if it landed.
   *
   * Cancel and retry both rebuild the row, and a rebuilt row is a new attempt: whatever run was
   * working towards the old one is nobody's answer from here. Only if it landed, though — the
   * queue refuses to retry a job that is neither failed nor cancelled, and a number moved behind
   * that refusal would strand the run of a job still going: stale, silent, and with no fresh
   * attempt to replace it, so the row would sit at "Writing" for ever and no file would arrive.
   */
  function endAttempt(event: { type: 'cancel' | 'retry'; id: string }): boolean {
    if (!emit(event)) return false
    attempts.set(event.id, attemptOf(event.id) + 1)
    return true
  }

  function pump(): void {
    // startable answers with as many jobs as there is room for, so the loop cannot over-start:
    // every job it hands back is marked running by the first line of work, before any await.
    for (const job of startable(queue)) {
      // A retried job whose earlier run has not let go yet. Starting now would put two runs of
      // one clip in flight, each holding that clip's material; the stale one stops at its next
      // slice and pumps from its own `finally`, and this attempt begins there instead. So a job
      // has one run at a time, always, and the marks below can only ever be that run's own.
      if (inFlight.has(job.id)) continue

      const request = requests.get(job.id)
      if (!request) {
        emit({ type: 'fail', id: job.id, error: EMPTY_CLIP, now: now() })
        continue
      }
      void work(job, request)
    }
  }

  async function work(job: Job, request: ExportRequest): Promise<void> {
    const attempt = attemptOf(job.id)
    /** Called off, or retried out from under this run: it is nobody's answer any more. */
    const stale = (): boolean => attemptOf(job.id) !== attempt

    inFlight.add(job.id)
    emit({ type: 'start', id: job.id, now: now() })

    try {
      const slices = planSlices(request.plan, sliceBytes)
      if (!slices.length) throw new Error(EMPTY_CLIP)

      let total = 0
      for (const slice of slices) total += slice.length

      // The check §8.6 asks for, and it looks at the last of the material rather than the first.
      // Storage is best-effort: a snapshot the browser has reclaimed, or one whose tail never
      // reached the disk, answers short here — and the job fails now instead of at ninety per
      // cent. The bytes are not wasted: this is the last slice, and it goes into the file.
      const tail = slices[slices.length - 1]!
      const read = await io.read(tail)
      if (read.byteLength !== tail.length) throw new Error(MATERIAL_GONE)

      const buffers: Uint8Array[] = []
      let done = 0

      for (const [at, slice] of slices.entries()) {
        // One check a slice, and it stands before the read: a run that has been called off asks
        // for nothing more. It is enough because a read is the only place this loop waits, so
        // the check on the way round catches the call-off that landed during the read before it,
        // before that read is reported or used — and the gate below catches the last one.
        if (stale()) return

        const bytes = at === slices.length - 1 ? read : await io.read(slice)
        if (bytes.byteLength !== slice.length) throw new Error(MATERIAL_GONE)

        buffers.push(bytes)
        done += slice.length
        emit({ type: 'progress', id: job.id, done, total })
      }

      // The gate, with the point of no return immediately behind it: past here the file is the
      // browser's, so a call-off arriving later is refused rather than obeyed (see `cancel`).
      // Without the refusal the row would say "Cancelled" over a file that was written anyway,
      // and Try again would open a second one behind a save already in flight. Subscribers are
      // told synchronously, so the last thing the loop reported is a place a call-off can land.
      if (stale()) return

      const file = assembleMp4(request.plan, bytesFrom(slices, buffers))
      if (!file.byteLength) throw new Error(EMPTY_CLIP)

      handedOver.add(job.id)
      await io.save(file, request.fileName)
      emit({ type: 'finish', id: job.id, bytes: file.byteLength, now: now() })
    } catch (error) {
      // Not a word out of a run nobody is waiting on. The only row left for it to land on is the
      // attempt that replaced it, which has not read a byte — and 'fail' takes a waiting job as
      // readily as a running one, so the queue would blame the fresh attempt for the old one's
      // material and then quietly write the file anyway.
      if (stale()) return

      // One clip failing is one clip failing (§8.6): the row says what happened and offers to try
      // again, and the queue goes on to the next one from the finally below.
      emit({ type: 'fail', id: job.id, error: messageOf(error), now: now() })
    } finally {
      handedOver.delete(job.id)
      inFlight.delete(job.id)
      pump()
    }
  }

  return {
    queue: () => queue,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    enqueue(list) {
      const jobs = list.map((request) => {
        const id = `j${nextId++}`
        requests.set(id, request)
        return { id, clipId: request.clipId, name: request.name, fileName: request.fileName }
      })
      if (!jobs.length) return

      emit({ type: 'enqueue', jobs })
      pump()
    },

    cancel(id) {
      // Too late: the file has gone to the browser and cannot be taken back, so the row must not
      // claim it was. The run finishes this attempt whatever the button says, and "Saved" is the
      // truth about it. Every earlier moment is fair game, and the run stops at its next slice.
      if (handedOver.has(id)) return
      endAttempt({ type: 'cancel', id })
    },

    retry(id) {
      if (endAttempt({ type: 'retry', id })) pump()
    },

    settled() {
      if (!busy()) return Promise.resolve()
      return new Promise<void>((resolve) => settling.push(resolve))
    },
  }
}
