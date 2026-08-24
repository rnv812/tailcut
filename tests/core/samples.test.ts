import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { editOffset, samplesInSegment, trackDefaults } from '../../src/core/iso/samples'
import { ingestInit } from '../../src/core/container'
import { buildAudioInit, buildFragment, buildVideoInit } from '../../src/core/iso/build'
import { parseFragment } from '../../src/core/iso/fragment'
import { topLevelBoxes as topLevelBoxesOf } from '../../src/core/iso/reader'
import { boxOf, fullBoxOf, i64, u16, u32, u64, zeroes } from '../../src/core/iso/writer'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

const h264Video = read('tests/fixtures/h264/init-stream0.m4s')
const h264Audio = read('tests/fixtures/h264/init-stream1.m4s')
const minuteVideo = read('tests/fixtures/minute/init-stream0.m4s')
const vp9Init = read('tests/fixtures/vp9/init-stream0.m4s')
const av1Init = read('tests/fixtures/av1/init-stream0.m4s')

const videoSegments = [1, 2, 3].map((n) =>
  read(`tests/fixtures/h264/chunk-stream0-0000${n}.m4s`),
)
const audioSegments = [1, 2, 3, 4].map((n) =>
  read(`tests/fixtures/h264/chunk-stream1-0000${n}.m4s`),
)
const av1Segment = read('tests/fixtures/av1/chunk-stream0-00001.m4s')

/** A sound entry of the shape every codec shares, with a made-up name — see build.test.ts. */
const sampleEntry = boxOf(
  'tSt1',
  zeroes(6),
  u16(1),
  zeroes(8),
  u16(2, 16, 0, 0),
  u32(48000 * 0x10000),
)

describe('trackDefaults', () => {
  it('reads what the trex of the fixtures states, which is nothing', () => {
    // ffmpeg's DASH muxer leaves every trex field at zero and repeats the real values in the
    // tfhd of each fragment. That is a fact about these fixtures, not about the format, and it
    // is why the trex fallback needs material of our own to be exercised at all.
    expect(trackDefaults(h264Video)).toEqual(new Map([[1, { duration: 0, size: 0, flags: 0 }]]))
    expect(trackDefaults(h264Audio)).toEqual(new Map([[1, { duration: 0, size: 0, flags: 0 }]]))
  })

  it('reads the trex our own writer puts in front of a converted WebM track', () => {
    const sound = ingestInit(
      read('tests/fixtures/webm/init-stream1.webm'),
      'audio/webm; codecs="opus"',
    )!
    // 0x02000000: sample_depends_on = 2, and the non-sync bit clear. Every Opus packet is a sync
    // sample and the trex is the only place that says so.
    expect(trackDefaults(sound.initBytes).get(1)).toEqual({
      duration: 0,
      size: 0,
      flags: 0x02000000,
    })

    const picture = ingestInit(
      read('tests/fixtures/webm/init-stream0.webm'),
      'video/webm; codecs="vp9"',
    )!
    expect(trackDefaults(picture.initBytes).get(1)).toEqual({
      duration: 0,
      size: 0,
      flags: 0x01010000,
    })
  })

  it('gives an empty map for an init with no mvex and for bytes that are not one', () => {
    expect(trackDefaults(videoSegments[0]!).size).toBe(0)
    expect(trackDefaults(new Uint8Array(0)).size).toBe(0)
  })
})

/**
 * An init holding one track and one edit list, written here byte for byte.
 *
 * Every fixture in this repository was made by ffmpeg, and ffmpeg writes one shape of elst:
 * version 0, one entry, a media_time that fits in 32 bits and is never negative. The other
 * shapes the format allows arrive from elsewhere — QuickTime writes version 1, a recording long
 * enough outgrows the 32-bit field, and an empty edit states −1 — and none of them can be read
 * off material we have. They are built here or they are never read at all.
 */
function initWithEditList(trackId: number, elst: Uint8Array): Uint8Array {
  // tkhd version 0: creation, modification, track_ID, reserved, duration, then the 60 bytes of
  // layer, volume, matrix and frame size editOffset never looks at.
  const tkhd = fullBoxOf('tkhd', 0, 3, u32(0, 0, trackId, 0, 0), zeroes(60))
  return boxOf('moov', boxOf('trak', tkhd, boxOf('edts', elst)))
}

/** elst version 1: segment_duration and media_time eight bytes each. */
function elstV1(segmentDuration: number, mediaTime: number): Uint8Array {
  return fullBoxOf('elst', 1, 0, u32(1), u64(segmentDuration), i64(mediaTime), u16(1, 0))
}

/** elst version 0: the same two fields four bytes each, media_time still signed. */
function elstV0(segmentDuration: number, mediaTime: number): Uint8Array {
  return fullBoxOf('elst', 0, 0, u32(1), u32(segmentDuration), i32(mediaTime), u16(1, 0))
}

/** A signed 32-bit field. The writer has no i32: no box this program writes needs one. */
function i32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setInt32(0, value)
  return out
}

describe('editOffset', () => {
  it('reads the media_time the source elst carries', () => {
    // 1024 ticks of 12288 is 83 ms: the two frames of B-frame delay ffmpeg compensates for.
    expect(editOffset(h264Video, 1)).toBe(1024)
    // The sound of the same clip: 1024 samples of 44100 is the AAC encoder priming.
    expect(editOffset(h264Audio, 1)).toBe(1024)
    // A different frame rate, a different delay: 2048 ticks of 10240 is 200 ms.
    expect(editOffset(minuteVideo, 1)).toBe(2048)
  })

  it('is zero where the elst hides nothing', () => {
    // VP9 and AV1 have no B-frames here, so ffmpeg wrote an elst with media_time 0.
    expect(editOffset(vp9Init, 1)).toBe(0)
    expect(editOffset(av1Init, 1)).toBe(0)
  })

  it('reads a media_time the version-1 box states in 64 bits', () => {
    // Read at the version-0 offset, a version-1 box hands back the low half of segment_duration:
    // a number that has nothing to do with the edit, and one that looks entirely plausible.
    expect(editOffset(initWithEditList(1, elstV1(600_000, 1_024)), 1)).toBe(1_024)

    // And the field is eight bytes because it has to be: 3.3 billion ticks of 48 kHz is a
    // recording of nineteen hours, and its media_time does not fit in what version 0 has.
    expect(editOffset(initWithEditList(1, elstV1(1_000, 3_300_000_000)), 1)).toBe(3_300_000_000)
  })

  it('takes an empty edit as no offset at all, in either version', () => {
    // The handcrafted list is read at all: a positive media_time comes back as it was written.
    expect(editOffset(initWithEditList(1, elstV0(600_000, 512)), 1)).toBe(512)

    // −1 is the one negative media_time the format allows, and it is not an offset into the
    // material: it is an empty edit, a hole held at the head before the media starts. Added to a
    // pts the way a real offset is subtracted from one, it would shift every frame of the table
    // the wrong way by a tick — and the table is what the cut, the readout and the grid read.
    expect(editOffset(initWithEditList(1, elstV0(600_000, -1)), 1)).toBe(0)
    expect(editOffset(initWithEditList(1, elstV1(600_000, -1)), 1)).toBe(0)
  })

  it('is zero for a track with no edit list, an unknown track and junk', () => {
    const written = buildAudioInit({ trackId: 3, timescale: 48000, sampleEntry })
    expect(editOffset(written, 3)).toBe(0)
    expect(editOffset(h264Video, 9)).toBe(0)
    expect(editOffset(new Uint8Array(0), 1)).toBe(0)
  })
})

/** Nothing declared anywhere: what a segment falls back on when its init states no trex. */
const NO_DEFAULTS = new Map<number, { duration: number; size: number; flags: number }>()

/** A budget for one synchronous pass over a segment; a runaway loop over 2^32 entries blows it. */
const PARSE_BUDGET_MS = 1000

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now()
  const value = fn()
  return { value, ms: performance.now() - start }
}

const int32 = (...values: number[]): number[] => {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  for (const [i, value] of values.entries()) view.setInt32(i * 4, value)
  return [...bytes]
}
const be32 = (...values: number[]): number[] => {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  for (const [i, value] of values.entries()) view.setUint32(i * 4, value >>> 0)
  return [...bytes]
}
const be64 = (value: number): number[] => [...be32(Math.floor(value / 2 ** 32)), ...be32(value)]

/** A box built by hand: the shapes ffmpeg never writes have to be written here. */
function raw(type: string, body: number[]): number[] {
  return [...be32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body]
}
function moofOf(...children: number[][]): Uint8Array {
  return new Uint8Array(raw('moof', [...raw('mfhd', be32(0, 1)), ...children.flat()]))
}
function segmentOf(moof: Uint8Array, payload: number): Uint8Array {
  const mdat = new Uint8Array(raw('mdat', new Array<number>(payload).fill(0x5a)))
  const out = new Uint8Array(moof.byteLength + mdat.byteLength)
  out.set(moof, 0)
  out.set(mdat, moof.byteLength)
  return out
}

describe('samplesInSegment', () => {
  const defaults = trackDefaults(h264Video)

  it('indexes every sample of a media segment', () => {
    const [track] = samplesInSegment(videoSegments[0]!, defaults)
    expect(track!.trackId).toBe(1)
    expect(track!.samples).toHaveLength(48)

    // The fixture carries styp and sidx in front of the moof, so the moof starts at 76 and the
    // mdat payload at 760. A reader that took the base as zero would be out by exactly 76.
    expect(track!.samples[0]).toEqual({
      dts: 0,
      pts: 1024,
      duration: 512,
      at: 760,
      size: 5082,
      sync: true,
    })
    expect(track!.samples[1]).toEqual({
      dts: 512,
      pts: 3072,
      duration: 512,
      at: 5842,
      size: 2417,
      sync: false,
    })

    const last = track!.samples[47]!
    expect(last.at + last.size).toBe(videoSegments[0]!.byteLength)
  })

  it('agrees with the fragment reader about the length of the fragment', () => {
    for (const segment of [...videoSegments, ...audioSegments]) {
      const [track] = samplesInSegment(segment, defaults)
      const total = track!.samples.reduce((sum, s) => sum + s.duration, 0)
      expect(total).toBe(parseFragment(segment)!.duration)

      const bytes = track!.samples.reduce((sum, s) => sum + s.size, 0)
      const mdat = topLevelBoxesOf(segment).find((b) => b.type === 'mdat')!
      expect(bytes).toBe(mdat.size - mdat.headerSize)
    }
  })

  it('lays the segments of a track on one decode timeline', () => {
    const samples = videoSegments.flatMap((s) => samplesInSegment(s, defaults)[0]!.samples)
    expect(samples).toHaveLength(144)
    expect(samples.reduce((sum, s) => sum + s.duration, 0)).toBe(73728)

    // A key frame a second at 24 frames a second, and B-frames between them: the presentation
    // times run out of order while the decode times do not.
    const syncs = samples.flatMap((s, i) => (s.sync ? [i] : []))
    expect(syncs).toEqual([0, 24, 48, 72, 96, 120])
    expect(Math.max(...samples.map((s) => s.pts))).toBe(74240)
    expect(samples.map((s) => s.pts).slice(0, 5)).toEqual([1024, 3072, 2048, 1536, 2560])
    expect(samples.every((s, i) => i === 0 || s.dts > samples[i - 1]!.dts)).toBe(true)
  })

  it('takes the duration and the flags from the tfhd when the trun states neither', () => {
    // The sound of the fixture: trun flags 0x201 — a data offset and a size per sample, nothing
    // else. Everything else comes out of the tfhd, including the flag that makes every packet a
    // place a player may start from.
    const [track] = samplesInSegment(audioSegments[0]!, defaults)
    expect(track!.samples).toHaveLength(84)
    expect(track!.samples.every((s) => s.duration === 1024)).toBe(true)
    expect(track!.samples.every((s) => s.sync)).toBe(true)
    expect(track!.samples.every((s) => s.pts === s.dts)).toBe(true)

    // The last segment states durations per sample instead, and the last of them is short.
    const [tail] = samplesInSegment(audioSegments[3]!, defaults)
    expect(tail!.samples.map((s) => s.duration)).toEqual([1024, 1024, 408])
    expect(tail!.samples[0]!.dts).toBe(263168)
  })

  it('takes the sync flag of the first sample from first_sample_flags', () => {
    // The AV1 fixture writes trun flags 0x205: a data offset, one set of flags for the first
    // sample, and a size per sample. The other nineteen samples fall back to the tfhd.
    const [track] = samplesInSegment(av1Segment, trackDefaults(av1Init))
    expect(track!.samples).toHaveLength(20)
    expect(track!.samples[0]!.sync).toBe(true)
    expect(track!.samples.slice(1).every((s) => !s.sync)).toBe(true)
    expect(track!.samples[0]!.at).toBe(268)
  })

  it('falls back to the trex when neither the trun nor the tfhd states the flags', () => {
    // Our own writer: a picture track whose trex says "not a sync sample" and whose fragment
    // states no flags at all. This is the shape a converted WebM picture takes whenever the
    // frames of a cluster are not marked one by one.
    const init = buildVideoInit({
      trackId: 1,
      timescale: 1000,
      sampleEntry,
      width: 256,
      height: 144,
    })
    const fragment = buildFragment(1, 0, [
      { duration: 100, bytes: Uint8Array.from([1, 2, 3]) },
      { duration: 100, bytes: Uint8Array.from([4, 5, 6]) },
    ])

    const [withTrex] = samplesInSegment(fragment, trackDefaults(init))
    expect(withTrex!.samples.map((s) => s.sync)).toEqual([false, false])

    // Without the fallback the very same bytes read as two key frames — the failure this test
    // exists for. A player would offer both as places to seek to and show a smear at either.
    const [without] = samplesInSegment(fragment, NO_DEFAULTS)
    expect(without!.samples.map((s) => s.sync)).toEqual([true, true])
  })

  it('takes the duration and the size from the trex when nobody else states them', () => {
    // tfhd with default-base-is-moof and nothing else; trun with a data offset and nothing else.
    const moof = moofOf(
      raw('traf', [
        ...raw('tfhd', [...be32(0x020000), ...be32(4)]),
        ...raw('tfdt', [...be32(0x01000000), ...be64(5000)]),
        ...raw('trun', [...be32(0x000001), ...be32(3), ...int32(200)]),
      ]),
    )
    const trex = new Map([[4, { duration: 90, size: 7, flags: 0x02000000 }]])

    const [track] = samplesInSegment(segmentOf(moof, 21), trex)
    expect(track!.trackId).toBe(4)
    expect(track!.samples).toHaveLength(3)
    expect(track!.samples.map((s) => s.duration)).toEqual([90, 90, 90])
    expect(track!.samples.map((s) => s.size)).toEqual([7, 7, 7])
    expect(track!.samples.map((s) => s.dts)).toEqual([5000, 5090, 5180])
    expect(track!.samples.map((s) => s.at)).toEqual([200, 207, 214])
    expect(track!.samples.every((s) => s.sync)).toBe(true)
  })

  it('reads the data offset of a trun as signed', () => {
    // A packager may address its mdat backwards from the moof. Read unsigned, this offset comes
    // out as four billion and the samples point past the end of the buffer.
    const moof = moofOf(
      raw('traf', [
        ...raw('tfhd', [...be32(0x000001 | 0x000008 | 0x000010), ...be32(2), ...be64(1000), ...be32(50), ...be32(4)]),
        ...raw('tfdt', [...be32(0), ...be32(0)]),
        ...raw('trun', [...be32(0x000001), ...be32(2), ...int32(-120)]),
      ]),
    )
    const [track] = samplesInSegment(segmentOf(moof, 8), new Map())
    expect(track!.samples.map((s) => s.at)).toEqual([880, 884])
  })

  it('lets an explicit base_data_offset win over default-base-is-moof', () => {
    // The specification is explicit: the flag is ignored whenever the field is present. A reader
    // that let the flag win would address the mdat from the wrong place on any packager that
    // writes both, and would do it silently — the sizes still add up.
    const moof = moofOf(
      raw('traf', [
        ...raw('tfhd', [
          ...be32(0x020000 | 0x000001 | 0x000008 | 0x000010),
          ...be32(1),
          ...be64(400),
          ...be32(20),
          ...be32(5),
        ]),
        ...raw('tfdt', [...be32(0), ...be32(0)]),
        ...raw('trun', [...be32(0x000001), ...be32(2), ...int32(16)]),
      ]),
    )
    const [track] = samplesInSegment(segmentOf(moof, 8), new Map())
    expect(track!.samples.map((s) => s.at)).toEqual([416, 421])
  })

  it('reads composition offsets as signed only in version 1', () => {
    const trun = (version: number, cts: number): Uint8Array =>
      moofOf(
        raw('traf', [
          ...raw('tfhd', [...be32(0x020000 | 0x000008 | 0x000010), ...be32(1), ...be32(10), ...be32(2)]),
          ...raw('tfdt', [...be32(0), ...be32(100)]),
          ...raw('trun', [
            ...be32((version << 24) | 0x000801),
            ...be32(1),
            ...int32(0),
            ...int32(cts),
          ]),
        ]),
      )

    const [signed] = samplesInSegment(trun(1, -30), new Map())
    expect(signed!.samples[0]!.pts).toBe(70)

    // Version 0 states the field unsigned, and a reader that signed it would turn a large
    // positive offset into a negative one.
    const [unsigned] = samplesInSegment(trun(0, 0x80000000), new Map())
    expect(unsigned!.samples[0]!.pts).toBe(100 + 0x80000000)
  })

  it('gives every traf of a segment that carries two tracks', () => {
    const trafOf = (trackId: number, duration: number, offset: number): number[] =>
      raw('traf', [
        ...raw('tfhd', [...be32(0x020000 | 0x000008 | 0x000010), ...be32(trackId), ...be32(duration), ...be32(3)]),
        ...raw('tfdt', [...be32(0), ...be32(0)]),
        ...raw('trun', [...be32(0x000001), ...be32(2), ...int32(offset)]),
      ])

    const tracks = samplesInSegment(segmentOf(moofOf(trafOf(1, 512, 300), trafOf(2, 1024, 306)), 12), new Map())
    expect(tracks.map((t) => t.trackId)).toEqual([1, 2])
    expect(tracks[0]!.samples.map((s) => s.dts)).toEqual([0, 512])
    expect(tracks[1]!.samples.map((s) => s.dts)).toEqual([0, 1024])
    expect(tracks[1]!.samples[0]!.at).toBe(306)
  })

  it('gives an empty list for an init segment and for junk', () => {
    expect(samplesInSegment(h264Video, defaults)).toEqual([])
    expect(samplesInSegment(new Uint8Array(0), defaults)).toEqual([])
    expect(samplesInSegment(Uint8Array.from([0, 0, 0, 9, 109, 111, 111, 102, 0]), defaults)).toEqual([])
  })

  it('does not read past a truncated trun', () => {
    const moof = moofOf(
      raw('traf', [
        ...raw('tfhd', [...be32(0x020000 | 0x000008), ...be32(1), ...be32(64)]),
        ...raw('tfdt', [...be32(0), ...be32(0)]),
        // sample_count promises a thousand; the body holds three sizes
        ...raw('trun', [...be32(0x000201), ...be32(1000), ...int32(120), ...be32(10, 20, 30)]),
      ]),
    )
    const [track] = samplesInSegment(segmentOf(moof, 60), new Map())
    expect(track!.samples.map((s) => s.size)).toEqual([10, 20, 30])
  })

  it('does not spin on a trun that promises four billion samples of nothing', () => {
    // The worst shape: sample_count at its maximum and no per-sample fields at all, so nothing
    // in the body bounds the walk. A segment cannot hold more samples than it has bytes, and
    // that is the bound. Without it this loop runs for minutes.
    const moof = moofOf(
      raw('traf', [
        ...raw('tfhd', [...be32(0x020000 | 0x000008 | 0x000010), ...be32(1), ...be32(1), ...be32(1)]),
        ...raw('tfdt', [...be32(0), ...be32(0)]),
        ...raw('trun', [...be32(0x000001), ...be32(0xffffffff), ...int32(0)]),
      ]),
    )
    const segment = segmentOf(moof, 16)
    const { value, ms } = timed(() => samplesInSegment(segment, new Map()))
    expect(value[0]!.samples.length).toBeLessThanOrEqual(segment.byteLength)
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('skips a traf whose boxes are cut short instead of throwing', () => {
    const moof = moofOf(
      raw('traf', [...raw('tfhd', [...be32(0x020000)])]),
      raw('traf', [
        ...raw('tfhd', [...be32(0x020000 | 0x000008 | 0x000010), ...be32(6), ...be32(30), ...be32(2)]),
        ...raw('tfdt', [...be32(0), ...be32(0)]),
        ...raw('trun', [...be32(0x000001), ...be32(1), ...int32(100)]),
      ]),
    )
    const tracks = samplesInSegment(segmentOf(moof, 8), new Map())
    expect(tracks.map((t) => t.trackId)).toEqual([6])
  })

  it('takes the samples out of a view with an offset of its own', () => {
    const backing = new Uint8Array(9 + videoSegments[0]!.byteLength + 7).fill(0xaa)
    backing.set(videoSegments[0]!, 9)
    const view = backing.subarray(9, 9 + videoSegments[0]!.byteLength)

    // The offsets are counted from the start of the segment, not from the start of the buffer
    // the segment happens to sit in.
    expect(samplesInSegment(view, defaults)).toEqual(samplesInSegment(videoSegments[0]!, defaults))
  })
})
