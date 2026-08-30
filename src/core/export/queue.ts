export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type JobKind = 'copy' | 'encode'

export interface Job {
  id: string
  clipId: string
  kind: JobKind
  /** The clip's name as it stood when the export was asked for. */
  name: string
  fileName: string
  state: JobState
  /** Coded bytes read, or frames encoded, as a fraction: 0…1. */
  progress: number
  /** Frames this job has to write; absent on a copy, which counts in bytes. */
  frames?: number
  bytes: number
  error?: string
  startedAt?: number
  finishedAt?: number
}

/**
 * How many clips are written at once, per lane.
 *
 * Two different limits for two different reasons. A lossless clip is a copy of bytes, so three of
 * them is a limit on memory: each holds the material it is reading, and three jobs on a
 * three-minute recording is around three hundred megabytes. A re-encoding clip is a limit on the
 * machine: there is one hardware encoder, two sessions on it halve each other's speed and double
 * the memory, and the decoder-encoder pair holds frames on top of that. So copies go three at a
 * time and re-encodes go one at a time — and a copy never waits behind a re-encode, which is what
 * §8.6 means by "instantly".
 */
export const PARALLEL: Record<JobKind, number> = { copy: 3, encode: 1 }

export const EMPTY_QUEUE: Queue = { jobs: [], parallel: PARALLEL }

export interface Queue {
  jobs: Job[]
  parallel: Record<JobKind, number>
}

/** What a row is built from, and everything a rebuilt row has to carry over. */
type JobSeed = Pick<Job, 'id' | 'clipId' | 'kind' | 'name' | 'fileName' | 'frames'>

export type QueueEvent =
  | { type: 'enqueue'; jobs: JobSeed[] }
  | { type: 'start'; id: string; now: number }
  | { type: 'progress'; id: string; done: number; total: number }
  | { type: 'finish'; id: string; bytes: number; now: number }
  | { type: 'fail'; id: string; error: string; now: number }
  | { type: 'retry'; id: string }
  | { type: 'cancel'; id: string }

type JobEvent = Exclude<QueueEvent, { type: 'enqueue' }>

const waiting = (job: JobSeed): Job => ({
  ...job,
  state: 'queued',
  progress: 0,
  bytes: 0,
})

/**
 * The fields a rebuilt row keeps, taken off the row itself.
 *
 * `retry` and `cancel` build a fresh row, and every one of these has to survive that. Written as
 * a projection rather than a literal on purpose: a literal is a list of fields that has to be
 * extended by hand whenever `Job` grows one, and the field it forgets — `kind` — sends a retried
 * re-encode into the lane of the copies, where it competes with two others for one encoder.
 */
const seedOf = (job: Job): JobSeed => ({
  id: job.id,
  clipId: job.clipId,
  kind: job.kind,
  name: job.name,
  fileName: job.fileName,
  frames: job.frames,
})

function changed(job: Job, event: JobEvent): Job {
  switch (event.type) {
    case 'start':
      return job.state === 'queued'
        ? { ...job, state: 'running', progress: 0, startedAt: event.now }
        : job

    case 'progress': {
      if (job.state !== 'running') return job
      const progress = event.total > 0 ? Math.min(1, Math.max(0, event.done / event.total)) : 0
      return progress === job.progress ? job : { ...job, progress }
    }

    case 'finish':
      return job.state === 'running'
        ? { ...job, state: 'done', progress: 1, bytes: event.bytes, finishedAt: event.now }
        : job

    case 'fail':
      // A waiting job can fail too: the material is checked when its turn comes, and by then the
      // browser may have reclaimed the snapshot. Saying "failed" without ever having run is the
      // honest answer, and it keeps the retry button in the same place.
      return job.state === 'running' || job.state === 'queued'
        ? { ...job, state: 'failed', error: event.error, finishedAt: event.now }
        : job

    case 'retry':
      return job.state === 'failed' || job.state === 'cancelled'
        ? waiting(seedOf(job))
        : job

    case 'cancel':
      // Not a finished one: the file is with the browser, and taking the row away would say it
      // had never been written.
      return job.state === 'queued' || job.state === 'running'
        ? {
            ...seedOf(job),
            state: 'cancelled',
            progress: job.progress,
            bytes: 0,
          }
        : job
  }
}

/** Returns the queue itself when nothing moved: nobody is woken for an event about nobody. */
export function reduceQueue(queue: Queue, event: QueueEvent): Queue {
  if (event.type === 'enqueue') {
    if (!event.jobs.length) return queue
    return { ...queue, jobs: [...queue.jobs, ...event.jobs.map(waiting)] }
  }

  const at = queue.jobs.findIndex((job) => job.id === event.id)
  if (at < 0) return queue

  const job = queue.jobs[at]!
  const next = changed(job, event)
  if (next === job) return queue

  const jobs = queue.jobs.slice()
  jobs[at] = next
  return { ...queue, jobs }
}

/** The jobs that may be set going right now, in the order they were asked for, lane by lane. */
export function startable(queue: Queue): Job[] {
  const room: Record<JobKind, number> = { copy: queue.parallel.copy, encode: queue.parallel.encode }
  for (const job of queue.jobs) if (job.state === 'running') room[job.kind] -= 1

  const out: Job[] = []
  for (const job of queue.jobs) {
    if (job.state !== 'queued') continue
    if (room[job.kind] <= 0) continue
    room[job.kind] -= 1
    out.push(job)
  }
  return out
}

/**
 * Seconds left, worked out from the speed this job has actually shown (§8.6), and null while any
 * answer would be a guess: before it starts, and before it has read anything.
 */
export function etaOf(job: Job, now: number): number | null {
  if (job.state !== 'running' || job.startedAt === undefined || job.progress <= 0) return null

  const spent = (now - job.startedAt) / 1_000
  if (spent <= 0) return null

  return (spent / job.progress) * (1 - job.progress)
}

export function queueBusy(queue: Queue): boolean {
  return queue.jobs.some((job) => job.state === 'queued' || job.state === 'running')
}
