// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildPreview } from '../../src/editor/source/preview'
import { planSnapshot, type SnapshotSource } from '../../src/core/snapshot/build'
import { SnapshotReader } from '../../src/core/snapshot/read'
import { materialOf } from '../../src/core/snapshot/material'
import { concatBytes } from '../../src/core/iso/writer'
import { topLevelBoxes } from '../../src/core/iso/reader'
import { parseInit } from '../../src/core/iso/init'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/** Video of the fixture: 320×240, 24 fps, 48 frames and two seconds in each segment. */
const INIT = read('h264/init-stream0.m4s')
const SEGMENTS = [1, 2, 3].map((n) => read(`h264/chunk-stream0-0000${n}.m4s`))
const FPS = 24
const PER_SEGMENT = 48

/**
 * The other kind of material: one ordinary complete file, never intercepted by anything.
 *
 * Six seconds, sixty frames of picture at 256×144 with sound beside them, and — this is what
 * makes it worth using here — its movie box at the very end, behind the media. A reader that
 * looked for the tables at the front of the range would find an `ftyp` and give up.
 */
const WHOLE = read('plain/whole.mp4')
const WHOLE_FRAMES = 60

/**
 * A second intercepted recording, and a different picture: 256×144 against the 320×240 above.
 *
 * Here for one claim and one only — that the size of the picture is read off the track of the
 * file that was assembled. One fixture cannot make that claim: with a single intercepted size in
 * the file, `{ width: 320, height: 240 }` written out as a constant in `buildPreview` passed the
 * whole suite, and the ordinary-file test below could not see it, because an ordinary file goes
 * down the other branch. This is that branch's second size.
 */
const MINUTE_INIT = read('minute/init-stream0.m4s')
const MINUTE_SEGMENT = read('minute/chunk-stream0-00001.m4s')

/**
 * The same file with its picture declaring another size.
 *
 * `width` and `height` of a VisualSampleEntry are two 16-bit fields at a fixed place inside it —
 * eight bytes of box header, six reserved, the data reference index, two pre-defined, two
 * reserved and twelve more pre-defined — and they are what a reader is told the picture is. The
 * two are patched here rather than a second file being added to the repository, because what is
 * under test is exactly that the number comes out of this declaration: every complete file in
 * tests/fixtures is 256×144, and one size cannot tell reading from assuming.
 */
function declaringSize(file: Uint8Array, width: number, height: number): Uint8Array {
  const copy = file.slice()
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)

  // The four letters appear twice — once as a brand in `ftyp`, once as the type of the sample
  // entry — and only the second is a box: it is preceded by its own length, which a brand is not.
  let at = -1
  for (let index = 4; index + 32 < copy.byteLength; index++) {
    const type = String.fromCharCode(copy[index]!, copy[index + 1]!, copy[index + 2]!, copy[index + 3]!)
    const size = view.getUint32(index - 4)
    if (type === 'avc1' && size >= 86 && index - 4 + size <= copy.byteLength) {
      at = index
      break
    }
  }
  expect(at, 'no avc1 sample entry in the fixture').toBeGreaterThan(0)
  // Read before written: if these two offsets were wrong the patch would land in the middle of
  // something else and this test would be about nothing.
  expect([view.getUint16(at + 28), view.getUint16(at + 30)]).toEqual([256, 144])
  view.setUint16(at + 28, width)
  view.setUint16(at + 30, height)

  return copy
}

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
async function snapshotFrom(
  source: SnapshotSource,
  options: { short?: boolean } = {},
): Promise<SnapshotReader> {
  const plan = planSnapshot(source, {
    id: 'x',
    capturedAt: 1_756_022_400_000,
    producer: 'tailcut test',
  })
  const file = concatBytes(plan.parts)

  const read = async (at: number, length: number): Promise<Uint8Array> => {
    const bytes = file.subarray(at, at + length)
    // Storage reclaimed part of the file under the open tab: a read of the material comes back
    // short of what the index promised, while the index and the footer are still there to read.
    return options.short && length > 1024 ? bytes.subarray(0, bytes.byteLength - 1) : bytes
  }

  return (await SnapshotReader.open(read, file.byteLength))!
}

/**
 * A snapshot of an ordinary file: the file whole, with its movie box named inside it.
 *
 * The shape the bridge writes for a session whose material was never intercepted — see
 * `fileSnapshotSourceOf`. One track and not two: a file states its picture and its sound in one
 * movie box and holds their samples in one `mdat`, so there is one piece of material here.
 */
async function snapshotOfFile(
  file: Uint8Array,
  options: { short?: boolean } = {},
): Promise<SnapshotReader> {
  const moov = topLevelBoxes(file).find((box) => box.type === 'moov')!
  const info = parseInit(file)!

  return snapshotFrom(
    {
      page,
      tracks: [
        {
          id: 't0',
          bufferId: 'file',
          representation: 'file:avc1+mp4a',
          kinds: ['video', 'audio'],
          info,
          initBytes: file,
          movie: { at: moov.start, length: moov.size },
          chunks: [{ start: 0, end: 6, bytes: new Uint8Array(0) }],
        },
      ],
    },
    options,
  )
}

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

  return snapshotFrom(source)
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
    // two, then two more. This is the shape the preview/export path turns on, and the only one
    // where the two clocks disagree — on unbroken material every number below is the same on both.
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

  /**
   * The material that reaches the editor without ever having been captured.
   *
   * Eighteen of the twenty-one live pages that delivered any video at all deliver it as an
   * ordinary file, so this is not a corner of the web. Edit used to answer "there is nothing to
   * edit in this session yet" over every one of them — beside a Save all button that saved the
   * same file perfectly — because a plain session keeps no tracks in the registry and the freeze
   * found nothing to lay out.
   */
  describe('over an ordinary complete file', () => {
    it('reads the tables out of the snapshot and counts every frame of the file', async () => {
      const reader = await snapshotOfFile(WHOLE)
      const built = await buildPreview(reader, materialOf(reader.index))

      expect(built, 'the editor refused a file it has the tables of').not.toBeNull()
      expect(built!.frames.count()).toBe(WHOLE_FRAMES)
      expect(built!.bytes).toBeGreaterThan(0)
      expect(built!.url).toMatch(/^blob:/)

      built!.release()
    })

    it('lays the frames out on one continuous clock, first to last', async () => {
      const reader = await snapshotOfFile(WHOLE)
      const built = (await buildPreview(reader, materialOf(reader.index)))!
      const frames = built.frames

      // A complete file has no holes in it — nothing was ever not watched — so the two clocks
      // agree everywhere and every frame follows the one before it by exactly one.
      const fps = frames.fps()
      for (const at of [0, 1, WHOLE_FRAMES - 1]) {
        expect(frames.at(at)!.out, `frame ${at} sits elsewhere in the file`).toBeCloseTo(at / fps, 5)
      }
      expect(frames.at(0)!.pts).toBeCloseTo(0, 6)
      expect(frames.indexAtOut(10 / fps)).toBe(10)

      built.release()
    })

    it('carries the sound of the file into the preview', async () => {
      const reader = await snapshotOfFile(WHOLE)
      const material = materialOf(reader.index)
      const built = (await buildPreview(reader, material))!

      // One track holding both kinds, exactly as a muxed init does on the captured path: the
      // audio slot of the material is empty and the sound is in the picture's own material.
      expect(material.audio).toBeNull()
      expect(material.video!.kinds).toEqual(['video', 'audio'])
      // The written clip weighs about what the source did: dropping the sound would take a fifth
      // of it away, and dropping the picture rather more.
      expect(built.bytes).toBeGreaterThan(WHOLE.byteLength * 0.9)

      built.release()
    })

    it('refuses a file the storage came back short of', async () => {
      const reader = await snapshotOfFile(WHOLE, { short: true })

      // The index promises a file of so many bytes and the storage hands over fewer: the browser
      // reclaimed part of it under the open tab. A plan over it would name samples that are not
      // there, and the writer would throw in the middle of a frame.
      expect(await buildPreview(reader, materialOf(reader.index))).toBeNull()
    })
  })

  /**
   * The picture size, which defines the coordinate space for the crop rectangle.
   *
   * It is taken here rather than off the <video> element on purpose: the element reports the size
   * it is laid out at, which is the window's business, and a rectangle of that would be a
   * rectangle of the browser window. Zero is what makes this worth a test of its own — a zero
   * assembles, passes every other check in this file, and leaves the crop dead: normalizeCrop
   * clamps all four numbers to nothing, and the encoder is asked for a frame 0×0.
   */
  it('reads the size of the picture off the track of the file it assembled', async () => {
    const built = await preview([0, 1, 2])

    expect(built.frameSize).toEqual({ width: 320, height: 240 })
    expect(built.frameSize.width, 'a zero here is a crop that collapses in silence').not.toBe(0)
    expect(built.frameSize.height, 'a zero here is a crop that collapses in silence').not.toBe(0)

    built.release()
  })

  it('reads it off the track of a second intercepted recording too', async () => {
    // The same branch as the test above — material that was captured segment by segment, which
    // is how eighteen of twenty-one live pages are *not* delivered but every large site is — and
    // a different picture: 256×144 against 320×240. Two sizes down one branch is what makes the
    // claim above a claim: with one, a constant written into `buildPreview` passed the entire
    // suite, and neither the ordinary-file test below nor anything else went red.
    const reader = await snapshotFrom({
      page,
      tracks: [
        {
          id: 't0',
          bufferId: 'sb-1',
          representation: 'video:avc1.4d401e:256x144',
          kinds: ['video'],
          info: parseInit(MINUTE_INIT)!,
          initBytes: MINUTE_INIT,
          chunks: [{ start: 0, end: 5, bytes: MINUTE_SEGMENT }],
        },
      ],
    })
    const built = (await buildPreview(reader, materialOf(reader.index)))!

    expect(built.frameSize).toEqual({ width: 256, height: 144 })

    built.release()
  })

  it('reads it off each material rather than assuming one size', async () => {
    // The other kind of material — an ordinary complete file, down the other branch — and the
    // same question asked of it: a size that came from anywhere but this file's own video track
    // would answer here with whatever the fragmented path answers.
    const reader = await snapshotOfFile(WHOLE)
    const built = (await buildPreview(reader, materialOf(reader.index)))!

    expect(built.frameSize).toEqual({ width: 256, height: 144 })

    built.release()
  })

  it('reads the ordinary file’s own declaration, and not one size for every file', async () => {
    // Every complete file in tests/fixtures is 256×144, so the test above cannot tell the size
    // being read from a constant of that value on this branch — and a constant of that value did
    // pass it. Here the picture of this one file declares something else, and the preview has to
    // say what the file says.
    const reader = await snapshotOfFile(declaringSize(WHOLE, 320, 240))
    const built = (await buildPreview(reader, materialOf(reader.index)))!

    expect(built.frameSize).toEqual({ width: 320, height: 240 })

    built.release()
  })

  it('has nothing to play when the snapshot holds no picture', async () => {
    const reader = await snapshotOf([0])
    const material = materialOf(reader.index)

    expect(await buildPreview(reader, { ...material, video: null })).toBeNull()
  })
})
