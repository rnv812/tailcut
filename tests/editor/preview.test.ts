// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildPreview } from '../../src/editor/source/preview'
import { planSnapshot, type SnapshotSource } from '../../src/core/snapshot/build'
import { SnapshotReader } from '../../src/core/snapshot/read'
import { materialOf } from '../../src/core/snapshot/material'
import { concatBytes } from '../../src/core/iso/writer'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/** Video of the fixture: 320×240, 24 fps, 48 frames and two seconds in each segment. */
const INIT = read('h264/init-stream0.m4s')
const SEGMENTS = [1, 2, 3].map((n) => read(`h264/chunk-stream0-0000${n}.m4s`))
const FPS = 24
const PER_SEGMENT = 48

const page = {
  sessionKey: 'https://site.example/watch|avc1|inf',
  url: 'https://site.example/watch?v=abc',
  title: 'Clip — site.example',
  createdAt: 1_756_022_100_000,
  lastSeenAt: 1_756_022_399_000,
  refusedTracks: false,
}

/**
 * A snapshot holding the segments named, laid out at the seconds they were watched at.
 *
 * The chunks keep their real times, so leaving one out leaves a hole in the material — which is
 * the only shape that tells the two clocks of this module apart.
 */
async function snapshotOf(indexes: number[]): Promise<SnapshotReader> {
  const source: SnapshotSource = {
    page,
    tracks: [
      {
        id: 't0',
        bufferId: 'sb-1',
        representation: 'video:avc1.4d401e:320x240',
        kinds: ['video'],
        info: {
          tracks: [
            {
              trackId: 1,
              kind: 'video',
              timescale: 12_288,
              codec: 'avc1.4d401e',
              width: 320,
              height: 240,
            },
          ],
        },
        initBytes: INIT,
        chunks: indexes.map((at) => ({
          start: at * 2,
          end: at * 2 + 2,
          bytes: SEGMENTS[at]!,
        })),
      },
    ],
  }

  const plan = planSnapshot(source, {
    id: 'x',
    capturedAt: 1_756_022_400_000,
    producer: 'tailcut test',
  })
  const file = concatBytes(plan.parts)

  return (await SnapshotReader.open(
    async (at, length) => file.subarray(at, at + length),
    file.byteLength,
  ))!
}

const preview = async (indexes: number[]) => {
  const reader = await snapshotOf(indexes)
  const built = await buildPreview(reader, materialOf(reader.index))
  expect(built, 'the preview was refused on material that has a picture in it').not.toBeNull()
  return built!
}

describe('buildPreview', () => {
  it('assembles a file out of the whole of the material and counts its frames', async () => {
    const built = await preview([0, 1, 2])

    expect(built.frames.count()).toBe(3 * PER_SEGMENT)
    expect(built.bytes).toBeGreaterThan(0)
    expect(built.url).toMatch(/^blob:/)
    // The edit list of the fixture is 1024 ticks of B-frame delay, and a table that did not take
    // it off would start the recording 83 ms — two frames — away from what <video> shows.
    expect(built.frames.at(0)!.pts).toBeCloseTo(0, 9)

    built.release()
  })

  it('keeps the gap on the session clock and closes it on the clock of the file', async () => {
    // Two segments with the middle one never watched: two seconds of material, then a hole of
    // two, then two more. This is the shape the whole task turns on, and the only one where the
    // two clocks disagree — on unbroken material every number below is the same on both.
    const built = await preview([0, 2])
    const frames = built.frames

    expect(frames.count()).toBe(2 * PER_SEGMENT)

    const before = frames.at(PER_SEGMENT - 1)!
    const after = frames.at(PER_SEGMENT)!

    // The session remembers when these frames were watched: the hole is still there.
    expect(before.pts).toBeCloseTo((PER_SEGMENT - 1) / FPS, 6)
    expect(after.pts).toBeCloseTo(4, 6)

    // The file the player is handed has no hole to jump: the plan closed it, and the frame after
    // the seam follows the one before it by a single frame.
    expect(after.out - before.out).toBeCloseTo(1 / FPS, 6)

    // Every frame of the file lies one frame after the last, first to last.
    for (const at of [0, 1, PER_SEGMENT, 2 * PER_SEGMENT - 1]) {
      expect(frames.at(at)!.out, `frame ${at} sits elsewhere in the file`).toBeCloseTo(at / FPS, 6)
    }

    // And the seek the player issues is stated in the file's clock, not the session's: asked for
    // the session's number, the element would land two seconds past every frame after the seam.
    expect(frames.seekTimeOf(PER_SEGMENT)).toBeCloseTo(PER_SEGMENT / FPS + 1 / FPS / 2, 6)
    expect(frames.indexAtOut(PER_SEGMENT / FPS)).toBe(PER_SEGMENT)

    built.release()
  })

  it('has nothing to play when the snapshot holds no picture', async () => {
    const reader = await snapshotOf([0])
    const material = materialOf(reader.index)

    expect(await buildPreview(reader, { ...material, video: null })).toBeNull()
  })
})
