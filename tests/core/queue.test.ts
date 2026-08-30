import { describe, it, expect } from 'vitest'
import {
  EMPTY_QUEUE,
  PARALLEL,
  etaOf,
  queueBusy,
  reduceQueue,
  startable,
  type Job,
  type Queue,
  type QueueEvent,
} from '../../src/core/export/queue'

const three = [
  { id: 'j1', clipId: 'c1', kind: 'copy' as const, name: 'One', fileName: 'One.mp4' },
  { id: 'j2', clipId: 'c2', kind: 'copy' as const, name: 'Two', fileName: 'Two.mp4' },
  { id: 'j3', clipId: 'c3', kind: 'copy' as const, name: 'Three', fileName: 'Three.mp4' },
]

const encodes = [
  {
    id: 'e1',
    clipId: 'ce1',
    kind: 'encode' as const,
    name: 'Encode one',
    fileName: 'Encode-one.mp4',
    frames: 240,
  },
  {
    id: 'e2',
    clipId: 'ce2',
    kind: 'encode' as const,
    name: 'Encode two',
    fileName: 'Encode-two.mp4',
    frames: 480,
  },
]

const play = (events: QueueEvent[], from: Queue = EMPTY_QUEUE): Queue =>
  events.reduce(reduceQueue, from)

const enqueued = (count = 3): Queue => play([{ type: 'enqueue', jobs: three.slice(0, count) }])

const jobOf = (queue: Queue, id: string): Job => queue.jobs.find((job) => job.id === id)!
const states = (queue: Queue): string[] => queue.jobs.map((job) => job.state)

describe('the export queue', () => {
  it('takes work in as waiting', () => {
    const queue = enqueued()
    expect(states(queue)).toEqual(['queued', 'queued', 'queued'])
    expect(queue.jobs[0]).toMatchObject({ id: 'j1', clipId: 'c1', progress: 0, bytes: 0 })
  })

  it('lets three run at once and no more', () => {
    const four = play([
      {
        type: 'enqueue',
        jobs: [
          ...three,
          { id: 'j4', clipId: 'c4', kind: 'copy', name: 'Four', fileName: 'Four.mp4' },
        ],
      },
    ])

    expect(PARALLEL).toEqual({ copy: 3, encode: 1 })
    expect(startable(four).map((job) => job.id)).toEqual(['j1', 'j2', 'j3'])

    const running = play(
      three.map((job): QueueEvent => ({ type: 'start', id: job.id, now: 1_000 })),
      four,
    )
    expect(startable(running)).toEqual([])

    const one = reduceQueue(running, { type: 'finish', id: 'j2', bytes: 400, now: 1_200 })
    expect(startable(one).map((job) => job.id)).toEqual(['j4'])
  })

  it('fills the copy and encode lanes independently', () => {
    const queue = play([{ type: 'enqueue', jobs: [...three, ...encodes] }])

    expect(startable(queue).map((job) => job.id)).toEqual(['j1', 'j2', 'j3', 'e1'])
  })

  it('starts another copy while an encode is still running', () => {
    const copies = [
      ...three,
      { id: 'j4', clipId: 'c4', kind: 'copy' as const, name: 'Four', fileName: 'Four.mp4' },
    ]
    const full = play([{ type: 'enqueue', jobs: [encodes[0]!, ...copies] }])
    const running = play(
      [encodes[0]!, ...three].map(
        (job): QueueEvent => ({ type: 'start', id: job.id, now: 1_000 }),
      ),
      full,
    )

    expect(startable(running)).toEqual([])
    const oneCopyDone = reduceQueue(running, {
      type: 'finish',
      id: 'j2',
      bytes: 400,
      now: 1_200,
    })
    expect(startable(oneCopyDone).map((job) => job.id)).toEqual(['j4'])
  })

  it('starts the next encode after the first finishes, fails, or is cancelled', () => {
    const running = play(
      [
        { type: 'enqueue', jobs: encodes },
        { type: 'start', id: 'e1', now: 1_000 },
      ],
      EMPTY_QUEUE,
    )
    const terminal: QueueEvent[] = [
      { type: 'finish', id: 'e1', bytes: 400, now: 1_200 },
      { type: 'fail', id: 'e1', error: 'encoder stopped', now: 1_200 },
      { type: 'cancel', id: 'e1' },
    ]

    expect(startable(running).map((job) => job.id)).toEqual([])
    for (const event of terminal) {
      expect(startable(reduceQueue(running, event)).map((job) => job.id)).toEqual(['e2'])
    }
  })

  it('keeps the order in which work entered each lane', () => {
    const queue = play([
      {
        type: 'enqueue',
        jobs: [encodes[0]!, three[0]!, encodes[1]!, three[1]!, three[2]!],
      },
    ])
    const ready = startable(queue)

    expect(ready.filter((job) => job.kind === 'copy').map((job) => job.id)).toEqual([
      'j1',
      'j2',
      'j3',
    ])
    expect(ready.filter((job) => job.kind === 'encode').map((job) => job.id)).toEqual(['e1'])
  })

  it('is busy for queued and running work in the encode lane', () => {
    const queued = play([{ type: 'enqueue', jobs: [encodes[0]!] }])
    const running = reduceQueue(queued, { type: 'start', id: 'e1', now: 1_000 })
    const done = reduceQueue(running, { type: 'finish', id: 'e1', bytes: 400, now: 1_200 })

    expect(queueBusy(queued)).toBe(true)
    expect(queueBusy(running)).toBe(true)
    expect(queueBusy(done)).toBe(false)
  })

  it('keeps an encode job in its lane with its frame count when cancelled', () => {
    const queued = play([{ type: 'enqueue', jobs: [encodes[0]!] }])
    const cancelled = reduceQueue(queued, { type: 'cancel', id: 'e1' })

    expect(jobOf(cancelled, 'e1')).toMatchObject({
      state: 'cancelled',
      kind: 'encode',
      frames: 240,
    })
  })

  it('keeps an encode job in its lane with its frame count when retried', () => {
    const queued = play([{ type: 'enqueue', jobs: [encodes[0]!] }])
    const cancelled = reduceQueue(queued, { type: 'cancel', id: 'e1' })
    const retried = reduceQueue(cancelled, { type: 'retry', id: 'e1' })

    expect(jobOf(retried, 'e1')).toMatchObject({
      state: 'queued',
      kind: 'encode',
      frames: 240,
    })
  })

  it('counts progress and stops counting when the work is over', () => {
    const running = play([{ type: 'start', id: 'j1', now: 0 }], enqueued(1))
    const half = reduceQueue(running, { type: 'progress', id: 'j1', done: 50, total: 100 })

    expect(jobOf(half, 'j1').progress).toBe(0.5)

    // Nothing to read is not everything read: a total of zero divides to NaN, and a NaN is a
    // progress bar of no width at all next to a job that is working.
    expect(
      jobOf(reduceQueue(running, { type: 'progress', id: 'j1', done: 0, total: 0 }), 'j1').progress,
    ).toBe(0)

    const done = reduceQueue(half, { type: 'finish', id: 'j1', bytes: 4_096, now: 900 })
    expect(jobOf(done, 'j1')).toMatchObject({
      state: 'done',
      progress: 1,
      bytes: 4_096,
      finishedAt: 900,
    })

    // A late report from a job already finished changes nothing: the runner and the queue are two
    // objects, and the last progress event of a job can land after its finish.
    expect(reduceQueue(done, { type: 'progress', id: 'j1', done: 60, total: 100 })).toBe(done)
  })

  it('marks one job failed and leaves the others alone', () => {
    const running = play(
      [
        { type: 'start', id: 'j1', now: 0 },
        { type: 'start', id: 'j2', now: 0 },
      ],
      enqueued(),
    )
    const failed = reduceQueue(running, { type: 'fail', id: 'j1', error: 'no material', now: 5 })

    expect(states(failed)).toEqual(['failed', 'running', 'queued'])
    expect(jobOf(failed, 'j1').error).toBe('no material')
    expect(startable(failed).map((job) => job.id)).toEqual(['j3'])
  })

  it('fails a job that never got to run', () => {
    // The material can be gone before a waiting job's turn comes, and it has to be able to say so
    // without pretending to have run.
    const failed = reduceQueue(enqueued(1), { type: 'fail', id: 'j1', error: 'gone', now: 5 })
    expect(jobOf(failed, 'j1').state).toBe('failed')
  })

  it('puts a failed job back in the queue clean', () => {
    const failed = play(
      [
        { type: 'start', id: 'j1', now: 0 },
        { type: 'progress', id: 'j1', done: 30, total: 100 },
        { type: 'fail', id: 'j1', error: 'no material', now: 5 },
      ],
      enqueued(1),
    )
    const again = reduceQueue(failed, { type: 'retry', id: 'j1' })

    expect(again.jobs[0]).toEqual({
      id: 'j1',
      clipId: 'c1',
      name: 'One',
      fileName: 'One.mp4',
      kind: 'copy',
      frames: undefined,
      state: 'queued',
      progress: 0,
      bytes: 0,
    })
  })

  it('cancels what is waiting and what is running, and nothing else', () => {
    const mixed = play(
      [
        { type: 'start', id: 'j1', now: 0 },
        { type: 'finish', id: 'j1', bytes: 10, now: 1 },
        { type: 'start', id: 'j2', now: 1 },
      ],
      enqueued(),
    )

    expect(states(reduceQueue(mixed, { type: 'cancel', id: 'j2' }))).toEqual([
      'done',
      'cancelled',
      'queued',
    ])
    expect(states(reduceQueue(mixed, { type: 'cancel', id: 'j3' }))).toEqual([
      'done',
      'running',
      'cancelled',
    ])
    // A file already handed to the browser is the browser's: cancelling a finished job is not
    // something the interface offers, and the state machine does not invent it either.
    expect(reduceQueue(mixed, { type: 'cancel', id: 'j1' })).toBe(mixed)
  })

  it('brings a cancelled job back on retry', () => {
    const cancelled = reduceQueue(enqueued(1), { type: 'cancel', id: 'j1' })
    expect(jobOf(reduceQueue(cancelled, { type: 'retry', id: 'j1' }), 'j1').state).toBe('queued')
  })

  it('answers an event about nobody with the queue it was given', () => {
    const queue = enqueued(1)
    expect(reduceQueue(queue, { type: 'start', id: 'nobody', now: 0 })).toBe(queue)
    expect(reduceQueue(queue, { type: 'enqueue', jobs: [] })).toBe(queue)
  })

  it('refuses to start a job twice', () => {
    const running = play([{ type: 'start', id: 'j1', now: 0 }], enqueued(1))
    expect(reduceQueue(running, { type: 'start', id: 'j1', now: 50 })).toBe(running)
  })

  it('works out what is left from the speed the job has shown', () => {
    const running = play(
      [
        { type: 'start', id: 'j1', now: 1_000 },
        { type: 'progress', id: 'j1', done: 25, total: 100 },
      ],
      enqueued(1),
    )

    // A quarter in two seconds: six more to go.
    expect(etaOf(jobOf(running, 'j1'), 3_000)).toBeCloseTo(6, 6)
  })

  it('says nothing about what is left while any answer would be a guess', () => {
    const waiting = enqueued(1)
    expect(etaOf(jobOf(waiting, 'j1'), 5_000)).toBeNull()

    const started = reduceQueue(waiting, { type: 'start', id: 'j1', now: 1_000 })
    expect(etaOf(jobOf(started, 'j1'), 1_050)).toBeNull()
  })

  it('knows when there is nothing left to wait for', () => {
    expect(queueBusy(EMPTY_QUEUE)).toBe(false)
    expect(queueBusy(enqueued(1))).toBe(true)
    expect(
      queueBusy(
        play(
          [
            { type: 'start', id: 'j1', now: 0 },
            { type: 'finish', id: 'j1', bytes: 1, now: 2 },
          ],
          enqueued(1),
        ),
      ),
    ).toBe(false)
  })
})
