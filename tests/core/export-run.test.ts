import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { concatBytes } from '../../src/core/iso/writer'
import type { EncodingChoice } from '../../src/core/encode/codec'
import type { ClipPath } from '../../src/core/encode/path'
import { planFrames } from '../../src/core/encode/plan'
import { clipSourceOf } from '../../src/core/export/source'
import { planClip, type ClipSource, type ExportPlan } from '../../src/core/export/plan'
import {
  EMPTY_CLIP,
  MATERIAL_GONE,
  createRunner,
  planSlices,
  type ExportIo,
  type ExportRequest,
} from '../../src/core/export/run'
import type { Located } from '../../src/shared/types'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

const VIDEO_INIT = read('h264/init-stream0.m4s')
const SEGMENTS = [1, 2, 3].map((n) => read(`h264/chunk-stream0-0000${n}.m4s`))

/**
 * The three segments in one buffer, and the same offsets handed to the indexer.
 *
 * That is exactly the shape of a snapshot: segments one after another in a file, addressed by
 * range. The fake io below reads out of this buffer the way the real one reads out of OPFS.
 */
const MATERIAL = concatBytes(SEGMENTS)
const PLACED: Located[] = (() => {
  const out: Located[] = []
  let at = 0
  for (const bytes of SEGMENTS) {
    out.push({ at, length: bytes.byteLength })
    at += bytes.byteLength
  }
  return out
})()

const source: ClipSource = clipSourceOf([
  {
    kind: 'video',
    initBytes: VIDEO_INIT,
    segments: SEGMENTS.map((bytes, at) => ({ bytes, at: PLACED[at]! })),
  },
])!

const planFor = (from: number, to: number): ExportPlan =>
  planClip(source, { in: from, out: to, sound: false })

const request = (id: string, plan: ExportPlan): ExportRequest => ({
  clipId: id,
  name: id,
  fileName: `${id}.mp4`,
  path: { kind: 'copy', plan },
})

const encodingChoice: EncodingChoice = {
  kind: 'h264-sw',
  config: { codec: 'avc1.640028', width: 320, height: 240, framerate: 24 },
  control: 'fixed-bitrate',
  bitrate: 1_000_000,
}

const encodePath = (from = 1, to = 3): Extract<ClipPath, { kind: 'encode' }> => ({
  kind: 'encode',
  plan: planFrames(source, { in: from, out: to, sound: false }, null, 24)!,
  choice: encodingChoice,
})

const pathRequest = (id: string, path: ClipPath): ExportRequest => ({
  clipId: id,
  name: id,
  fileName: `${id}.mp4`,
  path,
})

interface Saved {
  fileName: string
  bytes: number
}

type TestIo = ExportIo & {
  saved: Saved[]
  encode(
    request: ExportRequest,
    report: (frames: number) => void,
    stale: () => boolean,
  ): Promise<Uint8Array | null>
}

/** Reads out of the buffer, records what was written, and can be told to lie about the file. */
function fakeIo(overrides: Partial<TestIo> = {}): TestIo {
  const saved: Saved[] = []

  return {
    saved,
    read: async (at: Located) => MATERIAL.subarray(at.at, at.at + at.length),
    save: async (file: Uint8Array, fileName: string) => {
      saved.push({ fileName, bytes: file.byteLength })
    },
    encode: async () => null,
    ...overrides,
  }
}

/** A turn of the event loop, which drains whatever number of awaits the runner takes. */
const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Reads that park until they are let go, so a command can land in the middle of a run.
 *
 * Cancel and retry are two clicks a second apart at most, and what they race is a read in flight
 * — not the gap between two runs. Holding the reads is the only way to put a test in that gap on
 * purpose. `short` names parked reads, by the order they parked, that come back a byte light: a
 * run that has been called off can still be handed material that has gone away.
 */
function heldIo(
  short: readonly number[] = [],
): ExportIo & { saved: Saved[]; release(): void; peakReads(): number } {
  const io = fakeIo()
  const parked: Array<() => void> = []
  let holding = true
  let seen = 0
  let open = 0
  let peak = 0

  return {
    saved: io.saved,
    peakReads: () => peak,

    read: async (at: Located) => {
      open += 1
      peak = Math.max(peak, open)
      try {
        let cut = false
        if (holding) {
          cut = short.includes(seen++)
          await new Promise<void>((resolve) => parked.push(resolve))
        }
        const bytes = await io.read(at)
        return cut ? bytes.subarray(0, bytes.byteLength - 1) : bytes
      } finally {
        open -= 1
      }
    },

    save: io.save,
    encode: io.encode,

    release(): void {
      holding = false
      for (const resolve of parked.splice(0)) resolve()
    },
  }
}

describe('planSlices', () => {
  it('reads a clip in one go when its samples lie together', () => {
    expect(planSlices(planFor(0.5, 1.5))).toHaveLength(1)
  })

  it('never cuts a slice through the middle of a sample', () => {
    // A tiny limit forces many slices; every sample must still be inside exactly one of them, or
    // the writer is handed half a frame and the file decodes to rubbish.
    const plan = planFor(0, 6)
    const slices = planSlices(plan, 4_096)

    expect(slices.length).toBeGreaterThan(4)

    for (const track of plan.tracks) {
      for (const sample of track.samples) {
        const holder = slices.find(
          (slice) =>
            sample.source.at >= slice.at &&
            sample.source.at + sample.source.length <= slice.at + slice.length,
        )
        expect(holder, `the sample at ${sample.source.at} is in no slice`).toBeDefined()
      }
    }
  })

  it('does not read through a hole it has no use for', () => {
    // Two clips' worth of samples with a segment between them: reading the middle would be a
    // megabyte of nothing, and on a three-minute recording it would be most of the file.
    const plan: ExportPlan = {
      tracks: [
        {
          kind: 'video',
          timescale: 12_288,
          sampleEntry: new Uint8Array(0),
          width: 320,
          height: 240,
          skipTicks: 0,
          samples: [
            { source: { at: 0, length: 100 }, duration: 1, cts: 0, sync: true },
            { source: { at: 5_000_000, length: 100 }, duration: 1, cts: 0, sync: true },
          ],
        },
      ],
      duration: 1,
      bytes: 200,
    }

    expect(planSlices(plan)).toEqual([
      { at: 0, length: 100 },
      { at: 5_000_000, length: 100 },
    ])
  })
})

describe('the export runner', () => {
  it('writes every clip it is given, into files named after them', async () => {
    const io = fakeIo()
    const runner = createRunner(io)

    runner.enqueue([request('c1', planFor(0.5, 1.5)), request('c2', planFor(3, 4))])
    await runner.settled()

    expect(io.saved.map((one) => one.fileName)).toEqual(['c1.mp4', 'c2.mp4'])
    expect(io.saved.every((one) => one.bytes > 1_000)).toBe(true)
    expect(runner.queue().jobs.map((job) => job.state)).toEqual(['done', 'done'])
    expect(runner.queue().jobs.map((job) => job.progress)).toEqual([1, 1])
  })

  it('reports how much of the clip it has read, every slice of the way', async () => {
    // The bar in the panel and the "N s left" beside it are drawn from this and from nothing
    // else, so what has to hold is the fraction and not the fact that a report arrived. A run
    // that said "all of it" on its first slice would fill the bar at once, leave the estimate
    // with nothing to estimate from, and read on the screen as a clip that wrote itself.
    const plan = planFor(0, 6)
    const slices = planSlices(plan, 4_096)
    expect(slices.length, 'the clip came out in too few slices to watch one move').toBeGreaterThan(4)

    let read = 0
    const total = slices.reduce((sum, slice) => sum + slice.length, 0)
    const climbing = slices.map((slice) => {
      read += slice.length
      return read / total
    })

    const io = fakeIo()
    const runner = createRunner(io, { parallel: { copy: 1, encode: 1 }, sliceBytes: 4_096 })

    const seen: number[] = []
    runner.subscribe((queue) => {
      const job = queue.jobs[0]!
      if (job.state === 'running') seen.push(job.progress)
    })

    runner.enqueue([request('c1', plan)])
    await runner.settled()

    // Nought where it starts, then the coded bytes behind it over the coded bytes there are —
    // the same arithmetic the estimate divides by, one term of it per slice.
    expect(seen).toEqual([0, ...climbing])
    expect(io.saved.map((one) => one.fileName)).toEqual(['c1.mp4'])
  })

  it('runs three at once and no more', async () => {
    const held: Array<() => void> = []
    const io = fakeIo({
      save: async () => {
        await new Promise<void>((resolve) => held.push(resolve))
      },
    })
    const runner = createRunner(io)

    runner.enqueue(['a', 'b', 'c', 'd'].map((id) => request(id, planFor(0.5, 1.5))))
    // A turn of the event loop and not of the microtask queue: it drains whatever number of
    // awaits the reads take, which is an implementation detail of the runner and not a fact
    // this test should know.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runner.queue().jobs.filter((job) => job.state === 'running')).toHaveLength(3)
    expect(runner.queue().jobs[3]!.state).toBe('queued')

    for (const release of held.splice(0)) release()
    // The fourth cannot even reach its save until one of the three has let go of its own, so it
    // is held on the next turn and not on this one. Releasing once would leave it hanging there
    // and the wait below would time out.
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const release of held.splice(0)) release()
    await runner.settled()

    expect(runner.queue().jobs.map((job) => job.state)).toEqual(['done', 'done', 'done', 'done'])
  })

  it('keeps one clip failing from touching the others', async () => {
    const io = fakeIo()
    const refusing: ExportIo = {
      read: io.read,
      encode: io.encode,
      save: async (file, fileName) => {
        if (fileName === 'c2.mp4') throw new Error('the browser refused the download')
        await io.save(file, fileName)
      },
    }
    const runner = createRunner(refusing)

    runner.enqueue([
      request('c1', planFor(0.5, 1.5)),
      request('c2', planFor(2, 3)),
      request('c3', planFor(4, 5)),
    ])
    await runner.settled()

    expect(runner.queue().jobs.map((job) => job.state)).toEqual(['done', 'failed', 'done'])
    expect(runner.queue().jobs[1]!.error).toContain('refused')
    expect(io.saved.map((one) => one.fileName)).toEqual(['c1.mp4', 'c3.mp4'])
  })

  it('checks the material is there before it reads any of it', async () => {
    // The snapshot has been reclaimed and answers short. One read decides it — not one read of
    // ninety megabytes followed by a failure on the last slice.
    const io = fakeIo({
      read: async (at: Located) => MATERIAL.subarray(at.at, at.at + at.length - 1),
    })
    const reads = vi.spyOn(io, 'read')
    // Slices small enough that this clip is sixty-six of them: with the default limit the whole
    // of it comes back in one read, and then "one read" would be true of a runner that checked
    // nothing at all.
    const runner = createRunner(io, { sliceBytes: 4_096 })

    runner.enqueue([request('c1', planFor(0, 6))])
    await runner.settled()

    expect(runner.queue().jobs[0]).toMatchObject({
      state: 'failed',
      error: MATERIAL_GONE,
      progress: 0,
    })
    expect(reads).toHaveBeenCalledTimes(1)
    expect(io.saved).toEqual([])
  })

  it('stops when the material runs short in the middle and not only at its tail', async () => {
    // The tail is checked first and is whole here: the hole is further up, where only the read
    // of that slice can find it. Left unchecked, the short buffer reaches the writer, and what
    // the user is told is a RangeError out of the byte lookup instead of the one useful thing.
    const whole = fakeIo()
    let reads = 0
    const io: ExportIo & { saved: Saved[] } = {
      saved: whole.saved,
      encode: whole.encode,
      read: async (at: Located) => {
        const bytes = await whole.read(at)
        // The tail is read first, so this is the third slice of the loop and not the last.
        return reads++ === 3 ? bytes.subarray(0, bytes.byteLength - 1) : bytes
      },
      save: whole.save,
    }
    const runner = createRunner(io, { sliceBytes: 4_096 })

    runner.enqueue([request('c1', planFor(0, 6))])
    await runner.settled()

    expect(runner.queue().jobs[0]).toMatchObject({ state: 'failed', error: MATERIAL_GONE })
    expect(io.saved).toEqual([])
  })

  it('refuses a clip with nothing in it before it opens a file', async () => {
    const io = fakeIo()
    const runner = createRunner(io)

    runner.enqueue([request('c1', { tracks: [], duration: 0, bytes: 0 })])
    await runner.settled()

    expect(runner.queue().jobs[0]).toMatchObject({ state: 'failed', error: EMPTY_CLIP })
    expect(io.saved).toEqual([])
  })

  it('drops a job called off before its turn and one called off while it works', async () => {
    // Small slices, so the running job is in the middle of its reads when the cancel lands, and
    // an ordinary recording save: a job that missed the cancel would read on to the end and
    // write its file, and the empty list below is what says it did not. A save that never
    // resolved would leave that list empty whatever the runner did.
    const io = fakeIo()
    const reads = vi.spyOn(io, 'read')
    const runner = createRunner(io, { parallel: { copy: 1, encode: 1 }, sliceBytes: 4_096 })

    runner.enqueue([request('c1', planFor(0, 6)), request('c2', planFor(0, 6))])
    runner.cancel(runner.queue().jobs[1]!.id)
    expect(runner.queue().jobs[1]!.state).toBe('cancelled')

    runner.cancel(runner.queue().jobs[0]!.id)
    await runner.settled()
    // Settled says the rows have moved. The reads of the job called off are still in flight, and
    // this turn of the loop is the one it would have saved on.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runner.queue().jobs.map((job) => job.state)).toEqual(['cancelled', 'cancelled'])
    expect(io.saved).toEqual([])
    // The one read that decides the material is there, and then it stopped: sixty-five more
    // slices were never asked for, and the job that never started asked for nothing at all.
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('runs a failed clip again on demand', async () => {
    let refuse = true
    const io = fakeIo()
    const flaky: ExportIo = {
      read: io.read,
      encode: io.encode,
      save: async (file, fileName) => {
        if (refuse) throw new Error('not this time')
        await io.save(file, fileName)
      },
    }
    const runner = createRunner(flaky)

    runner.enqueue([request('c1', planFor(0.5, 1.5))])
    await runner.settled()
    expect(runner.queue().jobs[0]!.state).toBe('failed')

    refuse = false
    runner.retry(runner.queue().jobs[0]!.id)
    await runner.settled()

    // Two assertions and not one `toMatchObject({ error: undefined })`: a retry builds the row
    // afresh, so the key is not there at all, and matching against undefined asks for a key that
    // is present and holds undefined. What matters is that nothing is left to show, either way.
    expect(runner.queue().jobs[0]!.state).toBe('done')
    expect(runner.queue().jobs[0]!.error).toBeUndefined()
    expect(io.saved).toHaveLength(1)
  })

  it('writes one file when a job is retried while the run it called off is still reading', async () => {
    // The sequence a user can type in a second: Cancel, then Try again, while the run is parked
    // on a read. Retry used to clear the very flag the running loop read, so the run woke up
    // believing it had never been called off — it read on, saved, and reported done, and the
    // second run saved the same name again. One "Saved" row in the queue, two files on disk.
    const io = heldIo()
    const runner = createRunner(io, { parallel: { copy: 1, encode: 1 }, sliceBytes: 4_096 })

    runner.enqueue([request('c1', planFor(0, 6))])
    const id = runner.queue().jobs[0]!.id
    expect(runner.queue().jobs[0]!.state).toBe('running')

    runner.cancel(id)
    runner.retry(id)
    io.release()
    await runner.settled()
    // Settled says a row reached done. The run that was called off is still coming back from its
    // read, and these are the turns on which it would save.
    await turn()
    await turn()

    expect(io.saved.map((one) => one.fileName)).toEqual(['c1.mp4'])
    expect(runner.queue().jobs.map((job) => job.state)).toEqual(['done'])
  })

  it('keeps a stale run from failing the attempt that replaced it', async () => {
    // The same two clicks, and this time the material goes away under the run that was called
    // off. Its error belongs to nobody: the only row left to land on is the fresh attempt, which
    // has not read a byte, and 'fail' takes a waiting job as readily as a running one. The file
    // went out and the queue said it had not.
    const io = heldIo([0])
    const runner = createRunner(io, { parallel: { copy: 1, encode: 1 }, sliceBytes: 4_096 })

    runner.enqueue([request('c1', planFor(0, 6))])
    const id = runner.queue().jobs[0]!.id

    runner.cancel(id)
    runner.retry(id)
    io.release()
    await runner.settled()
    await turn()

    expect(runner.queue().jobs[0]!.state).toBe('done')
    expect(runner.queue().jobs[0]!.error).toBeUndefined()
    expect(io.saved.map((one) => one.fileName)).toEqual(['c1.mp4'])
  })

  it('does not start the fresh attempt until the run it replaced has let go', async () => {
    // One clip, one run, always. Two runs of a clip hold that clip's material twice over, and
    // worse than the memory: the runner keeps its marks by job id, so the run winding down would
    // clear the point of no return belonging to the run beside it — and the file goes out twice
    // again by a longer road. The retried row waits, visibly, and starts when the other lets go.
    const io = heldIo()
    const runner = createRunner(io, { parallel: { copy: 1, encode: 1 }, sliceBytes: 4_096 })

    runner.enqueue([request('c1', planFor(0, 6))])
    const id = runner.queue().jobs[0]!.id

    runner.cancel(id)
    runner.retry(id)
    expect(runner.queue().jobs[0]!.state).toBe('queued')

    io.release()
    await runner.settled()
    await turn()

    expect(io.peakReads()).toBe(1)
    expect(io.saved.map((one) => one.fileName)).toEqual(['c1.mp4'])
  })

  it('stops a file called off on the last thing the queue was told about it', async () => {
    // The gate before the save, and the way to arrive at it: subscribers are told synchronously,
    // so a listener that calls off on the closing progress report lands after the read loop has
    // run out of turns. Past that gate the file is the browser's, so the answer has to be no
    // here — or the row says "Cancelled" over a file that went out all the same.
    const io = fakeIo()
    const runner = createRunner(io, { parallel: { copy: 1, encode: 1 }, sliceBytes: 4_096 })

    runner.enqueue([request('c1', planFor(0, 6))])
    const id = runner.queue().jobs[0]!.id
    runner.subscribe((queue) => {
      const job = queue.jobs[0]!
      if (job.state === 'running' && job.progress === 1) runner.cancel(id)
    })

    await runner.settled()
    await turn()

    expect(runner.queue().jobs[0]!.state).toBe('cancelled')
    expect(io.saved).toEqual([])
  })

  it('refuses to call off a file already handed over, and does not write a second one', async () => {
    // The narrow end of the same window. Past the save there is nothing left to stop: the row
    // must not say it was stopped, and Try again must not open a second file behind the first.
    const io = fakeIo()
    const saves: Array<() => void> = []
    const holding: ExportIo = {
      read: io.read,
      encode: io.encode,
      save: async (file, fileName) => {
        await new Promise<void>((resolve) => saves.push(resolve))
        await io.save(file, fileName)
      },
    }
    const runner = createRunner(holding, { parallel: { copy: 1, encode: 1 } })

    runner.enqueue([request('c1', planFor(0.5, 1.5))])
    await turn()
    const id = runner.queue().jobs[0]!.id
    expect(saves).toHaveLength(1)

    runner.cancel(id)
    expect(runner.queue().jobs[0]!.state).toBe('running')
    runner.retry(id)

    // Let go of whatever save is waiting, turn by turn: a second run would park on one of its own.
    for (let round = 0; round < 4; round++) {
      for (const resolve of saves.splice(0)) resolve()
      await turn()
    }

    expect(io.saved.map((one) => one.fileName)).toEqual(['c1.mp4'])
    expect(runner.queue().jobs.map((job) => job.state)).toEqual(['done'])
  })

  it('leaves a run alone when Try again is asked of a job that never stopped', async () => {
    // The queue refuses this: Try again is not offered on a row that is still writing. The
    // runner must refuse it the same way and not merely ignore it — a job whose attempt turned
    // over behind the refusal would have its run go stale with nothing waiting to replace it,
    // and the row would sit at "Writing" for ever over a file that never arrived.
    const io = heldIo()
    const runner = createRunner(io, { parallel: { copy: 1, encode: 1 }, sliceBytes: 4_096 })

    runner.enqueue([request('c1', planFor(0, 6))])
    const id = runner.queue().jobs[0]!.id

    runner.retry(id)
    expect(runner.queue().jobs[0]!.state).toBe('running')

    io.release()
    await runner.settled()
    await turn()

    expect(runner.queue().jobs[0]!.state).toBe('done')
    expect(io.saved.map((one) => one.fileName)).toEqual(['c1.mp4'])
  })

  it('lets a retried job be called off again after a save that fell over', async () => {
    // The point of no return belongs to one attempt and not to the job. A save that threw leaves
    // the row failed, and the mark behind it has to go the same way: the attempt that follows is
    // called off in its reads like any other. A Cancel button that does nothing is a lie, and a
    // job that cannot be called off is a job that writes its file whatever the user asks.
    const io = fakeIo()
    const parked: Array<() => void> = []
    let refuse = true
    let holding = false
    const flaky: ExportIo = {
      encode: io.encode,
      read: async (at: Located) => {
        if (holding) await new Promise<void>((resolve) => parked.push(resolve))
        return io.read(at)
      },
      save: async (file, fileName) => {
        if (refuse) throw new Error('not this time')
        await io.save(file, fileName)
      },
    }
    const runner = createRunner(flaky, { parallel: { copy: 1, encode: 1 }, sliceBytes: 4_096 })

    runner.enqueue([request('c1', planFor(0, 6))])
    await runner.settled()
    expect(runner.queue().jobs[0]!.state).toBe('failed')

    refuse = false
    holding = true
    const id = runner.queue().jobs[0]!.id
    runner.retry(id)
    expect(runner.queue().jobs[0]!.state).toBe('running')

    runner.cancel(id)
    expect(runner.queue().jobs[0]!.state).toBe('cancelled')

    holding = false
    for (const resolve of parked.splice(0)) resolve()
    await turn()
    await turn()

    expect(io.saved).toEqual([])
  })

  it('tells whoever is listening, and lets them go', async () => {
    const io = fakeIo()
    const runner = createRunner(io)
    const heard: number[] = []
    const off = runner.subscribe((queue) => heard.push(queue.jobs.length))

    runner.enqueue([request('c1', planFor(0.5, 1.5))])
    await runner.settled()
    expect(heard.length).toBeGreaterThan(2)

    off()
    const before = heard.length
    runner.enqueue([request('c2', planFor(2, 3))])
    await runner.settled()

    expect(heard).toHaveLength(before)
  })

  it('hands an encode path to io without reading its slices in the runner', async () => {
    const io = fakeIo({ encode: vi.fn(async () => new Uint8Array([1, 2, 3])) })
    const reads = vi.spyOn(io, 'read')
    const runner = createRunner(io)

    runner.enqueue([pathRequest('encoded', encodePath())])
    await runner.settled()

    expect(reads).not.toHaveBeenCalled()
    expect(io.encode).toHaveBeenCalledTimes(1)
    expect(io.saved).toEqual([{ fileName: 'encoded.mp4', bytes: 3 }])
    expect(runner.queue().jobs[0]!.state).toBe('done')
  })

  it('reports encode progress in frames before the file is finished', async () => {
    let release!: () => void
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    const path = encodePath()
    const io = fakeIo({
      encode: async (_request, report) => {
        report(path.plan.kept)
        await parked
        return new Uint8Array([1])
      },
    })
    const runner = createRunner(io)

    runner.enqueue([pathRequest('progress', path)])
    await turn()

    expect(runner.queue().jobs[0]).toMatchObject({ state: 'running', progress: 1 })

    release()
    await runner.settled()
  })

  it('makes a running encode stale on cancel and saves no partial file', async () => {
    let release!: () => void
    let stale!: () => boolean
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    const io = fakeIo({
      encode: async (_request, _report, isStale) => {
        stale = isStale
        await parked
        // Return bytes deliberately: the runner's post-encode gate, not a cooperative fake, has
        // to keep a cancelled attempt from saving a file.
        return new Uint8Array([1, 2, 3])
      },
    })
    const runner = createRunner(io)

    runner.enqueue([pathRequest('cancelled', encodePath())])
    const id = runner.queue().jobs[0]!.id
    runner.cancel(id)

    expect(stale()).toBe(true)
    expect(runner.queue().jobs[0]!.state).toBe('cancelled')

    release()
    await turn()
    expect(io.saved).toEqual([])
  })

  it('fails one refused encode and drives the next one to completion', async () => {
    const io = fakeIo({
      encode: async (asked) => {
        if (asked.clipId === 'bad') throw new Error('the encoder refused this clip')
        return new Uint8Array([1, 2])
      },
    })
    const runner = createRunner(io)

    runner.enqueue([pathRequest('bad', encodePath()), pathRequest('good', encodePath(3, 4))])
    await runner.settled()

    expect(runner.queue().jobs.map((job) => job.state)).toEqual(['failed', 'done'])
    expect(runner.queue().jobs[0]!.error).toBe('the encoder refused this clip')
    expect(io.saved).toEqual([{ fileName: 'good.mp4', bytes: 2 }])
  })

  it('fails each blocked reason in words without calling the encoder, and continues', async () => {
    const noEncoder = 'This machine has no encoder for that picture.'
    const noMaterial = 'There is no picture in this clip to re-encode.'
    const geometry = { width: 320, height: 240, framerate: 24 }
    const io = fakeIo({ encode: vi.fn(async () => new Uint8Array([1])) })
    const runner = createRunner(io)

    runner.enqueue([
      pathRequest('encoder', { kind: 'blocked', reason: 'no-encoder', geometry }),
      pathRequest('material', { kind: 'blocked', reason: 'no-material', geometry }),
      pathRequest('good', encodePath()),
    ])
    await runner.settled()

    expect(runner.queue().jobs.map((job) => job.state)).toEqual(['failed', 'failed', 'done'])
    expect(runner.queue().jobs.map((job) => job.error)).toEqual([noEncoder, noMaterial, undefined])
    expect(io.encode).toHaveBeenCalledTimes(1)
    expect(io.saved).toEqual([{ fileName: 'good.mp4', bytes: 1 }])
  })

  it('refuses cancellation after an encoded file has been handed to save', async () => {
    let release!: () => void
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    const io = fakeIo({
      encode: async () => new Uint8Array([1, 2, 3]),
      save: async (file, fileName) => {
        await parked
        io.saved.push({ fileName, bytes: file.byteLength })
      },
    })
    const runner = createRunner(io)

    runner.enqueue([pathRequest('handed-over', encodePath())])
    await turn()
    const id = runner.queue().jobs[0]!.id

    runner.cancel(id)
    expect(runner.queue().jobs[0]!.state).toBe('running')

    release()
    await runner.settled()
    expect(runner.queue().jobs[0]!.state).toBe('done')
    expect(io.saved).toEqual([{ fileName: 'handed-over.mp4', bytes: 3 }])
  })

  it('ignores a late progress report from the encode attempt a retry replaced', async () => {
    let firstReport!: (frames: number) => void
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let calls = 0
    const firstParked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondParked = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const io = fakeIo({
      encode: async (_request, report) => {
        calls += 1
        if (calls === 1) {
          firstReport = report
          await firstParked
          return null
        }
        await secondParked
        return new Uint8Array([1])
      },
    })
    const path = encodePath()
    const runner = createRunner(io)

    runner.enqueue([pathRequest('retried', path)])
    const id = runner.queue().jobs[0]!.id
    runner.cancel(id)
    runner.retry(id)

    releaseFirst()
    await turn()
    expect(calls).toBe(2)
    expect(runner.queue().jobs[0]).toMatchObject({ state: 'running', progress: 0 })

    firstReport(path.plan.kept)
    expect(runner.queue().jobs[0]).toMatchObject({ state: 'running', progress: 0 })

    releaseSecond()
    await runner.settled()
  })
})
