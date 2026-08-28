import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { concatBytes } from '../../src/core/iso/writer'
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
  plan,
})

interface Saved {
  fileName: string
  bytes: number
}

/** Reads out of the buffer, records what was written, and can be told to lie about the file. */
function fakeIo(overrides: Partial<ExportIo> = {}): ExportIo & { saved: Saved[] } {
  const saved: Saved[] = []

  return {
    saved,
    read: async (at: Located) => MATERIAL.subarray(at.at, at.at + at.length),
    save: async (file: Uint8Array, fileName: string) => {
      saved.push({ fileName, bytes: file.byteLength })
    },
    ...overrides,
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
    const runner = createRunner(io, { parallel: 1, sliceBytes: 4_096 })

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
})
