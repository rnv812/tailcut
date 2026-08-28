export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: string
  clipId: string
  /** The clip's name as it stood when the export was asked for. */
  name: string
  fileName: string
  state: JobState
  /** Coded bytes read so far, as a fraction: 0…1. */
  progress: number
  /** Weight of the file written; zero until there is one. */
  bytes: number
  error?: string
  startedAt?: number
  finishedAt?: number
}

export interface Queue {
  jobs: Job[]
  parallel: number
}

/**
 * How many clips are written at once.
 *
 * A lossless clip is a copy of bytes, so this is a limit on memory and not on the processor: each
 * job holds the material it is reading, and three jobs on a three-minute recording is around
 * three hundred megabytes on top of the snapshot and the preview. Re-encoding, when it comes
 * (stage 4), will want a limit of its own for the opposite reason.
 */
export const PARALLEL = 3

export const EMPTY_QUEUE: Queue = { jobs: [], parallel: PARALLEL }

export type QueueEvent =
  | { type: 'enqueue'; jobs: Array<{ id: string; clipId: string; name: string; fileName: string }> }
  | { type: 'start'; id: string; now: number }
  | { type: 'progress'; id: string; done: number; total: number }
  | { type: 'finish'; id: string; bytes: number; now: number }
  | { type: 'fail'; id: string; error: string; now: number }
  | { type: 'retry'; id: string }
  | { type: 'cancel'; id: string }

type JobEvent = Exclude<QueueEvent, { type: 'enqueue' }>

const waiting = (job: { id: string; clipId: string; name: string; fileName: string }): Job => ({
  ...job,
  state: 'queued',
  progress: 0,
  bytes: 0,
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
        ? waiting({ id: job.id, clipId: job.clipId, name: job.name, fileName: job.fileName })
        : job

    case 'cancel':
      // Not a finished one: the file is with the browser, and taking the row away would say it
      // had never been written.
      return job.state === 'queued' || job.state === 'running'
        ? {
            id: job.id,
            clipId: job.clipId,
            name: job.name,
            fileName: job.fileName,
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

/** The jobs that may be set going right now, in the order they were asked for. */
export function startable(queue: Queue): Job[] {
  const running = queue.jobs.filter((job) => job.state === 'running').length
  const room = queue.parallel - running
  if (room <= 0) return []
  return queue.jobs.filter((job) => job.state === 'queued').slice(0, room)
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
