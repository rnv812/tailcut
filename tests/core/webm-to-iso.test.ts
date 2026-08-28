import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { webmToIso } from '../../src/core/webm/to-iso'
import { parseInit as parseWebmInit } from '../../src/core/webm/init'
import { parseInit } from '../../src/core/iso/init'
import { parseFragment } from '../../src/core/iso/fragment'
import { parseClusters } from '../../src/core/webm/fragment'
import { boxBody, findBox, topLevelBoxes } from '../../src/core/iso/reader'
import { OPUS_SAMPLE_RATE } from '../../src/core/opus/packets'
import type { InitInfo } from '../../src/shared/types'

/** The type the fixture's picture would be served under: profile 0, level 1.0, eight bits. */
const VP9_TYPE = 'video/webm; codecs="vp09.00.10.08"'

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

const opusInit = parseWebmInit(load('webm/init-stream1.webm'))!
const vp9Init = parseWebmInit(load('webm/init-stream0.webm'))!

/** The pair a page may open a SourceBuffer for as readily as it may serve it as a file. */
const VP8_TYPE = 'video/webm; codecs="vp8"'
const vorbisInit = parseWebmInit(load('webm-vp8/init-stream1.webm'))!
const vp8Init = parseWebmInit(load('webm-vp8/init-stream0.webm'))!

/** Four media segments of the Opus track: 0…1.961, 1.981…3.961, 3.981…5.961 and one last frame. */
const audioSegments = [1, 2, 3, 4].map((n) => load(`webm/chunk-stream1-0000${n}.webm`))

/** Three media segments of the VP9 track, two seconds each, a keyframe at the head of every one. */
const videoSegments = [1, 2, 3].map((n) => load(`webm/chunk-stream0-0000${n}.webm`))

const converter = webmToIso(opusInit)!
const video = webmToIso(vp9Init, VP9_TYPE)!

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/**
 * Sample durations a converted fragment states, in ticks of the track it was written for. The
 * stride is the width of one trun entry, which is wider on a track that states a flag per sample.
 */
function durationsOf(fragment: Uint8Array, stride = 8): number[] {
  const trun = findBox(fragment, ['moof', 'traf', 'trun'])!
  const body = view(boxBody(fragment, trun))
  const count = body.getUint32(4)

  return Array.from({ length: count }, (_unused, i) => body.getUint32(12 + i * stride))
}

describe('webmToIso: what it takes and what it refuses', () => {
  it('takes an Opus track', () => {
    expect(webmToIso(opusInit)).not.toBeNull()
  })

  it('takes a VP9 track when the page has said what it is', () => {
    // A vp09 sample entry needs facts about the stream that Matroska does not carry — profile,
    // level, bit depth, subsampling. They come from the type the page opened its SourceBuffer
    // with, and with that in hand the track is written like any other.
    expect(vp9Init.tracks[0]!.codec).toBe('V_VP9')
    expect(webmToIso(vp9Init, VP9_TYPE)).not.toBeNull()
  })

  it('refuses a VP9 track the page has said nothing about', () => {
    // Refusing here leaves the buffer without a track; opening one would collect segments for the
    // length of a recording and end as a picture stream no player could make sense of.
    expect(webmToIso(vp9Init)).toBeNull()
    expect(webmToIso(vp9Init, 'video/webm')).toBeNull()
    expect(webmToIso(vp9Init, 'video/webm; codecs="vp09.00.10.10"')).toBeNull()
  })

  it('refuses a VP9 track whose frame size the container never stated', () => {
    // Both the sample entry and the track header have to state one, and zero is not a picture.
    const track = { ...vp9Init.tracks[0]!, width: 0 }
    expect(webmToIso({ tracks: [track] }, VP9_TYPE)).toBeNull()
  })

  it('refuses a WebM track in a codec written here for neither container', () => {
    // Theora, which a Matroska may legally carry and an mp4 has no place for at all.
    const theora = { ...vp9Init.tracks[0]!, codec: 'V_THEORA' }
    expect(webmToIso({ tracks: [theora] }, 'video/webm; codecs="theora"')).toBeNull()
  })

  it('refuses an init that declares more than one track', () => {
    const muxed: InitInfo = { tracks: [...opusInit.tracks, ...vp9Init.tracks] }
    expect(webmToIso(muxed)).toBeNull()
  })

  it('refuses a track with no CodecPrivate: dOps has nothing to be built out of', () => {
    const track = { ...opusInit.tracks[0]! }
    delete track.codecPrivate
    expect(webmToIso({ tracks: [track] })).toBeNull()
  })

  it('refuses a track whose CodecPrivate is not an OpusHead', () => {
    const codecPrivate = new Uint8Array(19)
    expect(webmToIso({ tracks: [{ ...opusInit.tracks[0]!, codecPrivate }] })).toBeNull()
  })

  it('refuses a segment whose timestamps have no scale to be read in', () => {
    expect(webmToIso({ tracks: [{ ...opusInit.tracks[0]!, timescale: 0 }] })).toBeNull()
  })
})

describe('webmToIso: the track it declares', () => {
  it('writes an init segment the ISO BMFF reader makes sense of', () => {
    expect(parseInit(converter.initBytes)).toEqual({
      tracks: [
        {
          trackId: 1, kind: 'audio', timescale: OPUS_SAMPLE_RATE, codec: 'Opus',
          width: 0, height: 0, defaultSampleDuration: 0,
        },
      ],
    })
  })

  it('keeps the name the container gave the codec: it is the page stream being identified', () => {
    // The registry keys sessions by what the page declared. 'Opus' is what this program writes
    // into the file it builds; A_OPUS is what the page is serving, and that is the identity.
    expect(converter.info.tracks[0]!.codec).toBe('A_OPUS')
    expect(converter.info.tracks[0]!.kind).toBe('audio')
  })

  it('reports the timescale it actually wrote, not the one Matroska counted in', () => {
    expect(opusInit.tracks[0]!.timescale).toBe(1000)
    expect(converter.info.tracks[0]!.timescale).toBe(OPUS_SAMPLE_RATE)

    const mdhd = findBox(converter.initBytes, ['moov', 'trak', 'mdia', 'mdhd'])!
    expect(view(boxBody(converter.initBytes, mdhd)).getUint32(12)).toBe(OPUS_SAMPLE_RATE)
  })

  it('carries the OpusHead of the page into the dOps of the file', () => {
    const stsd = findBox(converter.initBytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!
    const body = boxBody(converter.initBytes, stsd)
    // Past version and flags, entry count, and the fixed part of the sample entry.
    const dOps = body.subarray(8 + 8 + 28)
    expect([...dOps.subarray(0, 8)]).toEqual([0, 0, 0, 19, 0x64, 0x4f, 0x70, 0x73])
    // Version, two channels, 312 samples of pre-skip, 48 kHz in, no gain, mapping family zero.
    expect([...dOps.subarray(8)]).toEqual([0, 2, 0x01, 0x38, 0x00, 0x00, 0xbb, 0x80, 0, 0, 0])
  })
})

describe('webmToIso: segments across', () => {
  it('places the first segment at the start of the recording', () => {
    const converted = converter.segment(audioSegments[0]!)!
    expect(converted.start).toBe(0)
    expect(parseFragment(converted.bytes)!.baseMediaDecodeTime).toBe(0)
  })

  it('scales a Matroska timestamp into ticks of the track it writes', () => {
    // The second segment opens at 1981 milliseconds. At 48 kHz that is 95 088 samples, and this
    // is the multiplication the whole placement of a WebM track on an mp4 timeline rests on.
    const converted = converter.segment(audioSegments[1]!)!
    expect(parseFragment(converted.bytes)!.baseMediaDecodeTime).toBe(1981 * 48)
    expect(converted.start).toBeCloseTo(1.981, 9)
  })

  it('reports the stretch it covers in seconds, as the timeline is measured in', () => {
    const converted = converter.segment(audioSegments[0]!)!
    // Ninety-nine packets of 20 ms, plus the millisecond the container rounded away at the front.
    expect(converted.end).toBeCloseTo(1.981, 9)
    expect(converted.end - converted.start).toBeGreaterThan(1.9)
  })

  it('leaves no seam between one segment and the next', () => {
    const converted = audioSegments.map((bytes) => converter.segment(bytes)!)

    for (const [index, segment] of converted.slice(1).entries()) {
      // Exactly, not nearly: the rounding of the millisecond timestamps is kept inside the
      // fragment that precedes the boundary, so the two meet on the same tick.
      expect(segment.start, `segment ${index + 2}`).toBe(converted[index]!.end)
    }
  })

  it('runs from the start of the recording to its end with no time unaccounted for', () => {
    const converted = audioSegments.map((bytes) => converter.segment(bytes)!)
    const covered = converted.reduce((total, s) => total + (s.end - s.start), 0)

    expect(converted[0]!.start).toBe(0)
    // Three hundred packets of 20 ms: six seconds, and the millisecond of rounding on top.
    expect(converted[converted.length - 1]!.end).toBeCloseTo(6.001, 9)
    expect(covered).toBeCloseTo(6.001, 9)
  })

  it('measures every sample but the last by the distance to the one after it', () => {
    const durations = durationsOf(converter.segment(audioSegments[0]!)!.bytes)

    // The container rounds 20 ms of 48 kHz to whole milliseconds, and the first step swallows the
    // rounding: 21 ms, then 20 ms all the way. Stating a true 960 for every packet would end the
    // fragment a millisecond before the next one starts.
    expect(durations[0]).toBe(1008)
    expect([...new Set(durations.slice(1))]).toEqual([960])
  })

  it('measures the last sample by the packet itself, which has no next timestamp', () => {
    const durations = durationsOf(converter.segment(audioSegments[3]!)!.bytes)
    // The final segment of the fixture holds exactly one packet: 20 ms of 48 kHz.
    expect(durations).toEqual([960])
  })

  it('carries every packet of the segment over, whole and in order', () => {
    const source = load('webm/chunk-stream1-00001.webm')
    const converted = converter.segment(source)!
    const mdat = topLevelBoxes(converted.bytes).find((b) => b.type === 'mdat')!
    const payload = boxBody(converted.bytes, mdat)

    const durations = durationsOf(converted.bytes)
    expect(durations.length).toBe(99)

    // Every packet opens with its TOC byte, and the sizes in the trun say where each one starts:
    // walking the mdat by those sizes has to land on a readable TOC every time.
    const trun = findBox(converted.bytes, ['moof', 'traf', 'trun'])!
    const body = view(boxBody(converted.bytes, trun))
    let at = 0
    for (let i = 0; i < durations.length; i++) at += body.getUint32(16 + i * 8)
    expect(at).toBe(payload.byteLength)
  })

  it('gives nothing back for bytes that are not a segment of this track', () => {
    expect(converter.segment(load('h264/chunk-stream0-00001.m4s'))).toBeNull()
    expect(converter.segment(load('webm/chunk-stream0-00001.webm'))).toBeNull()
    expect(converter.segment(new Uint8Array(0))).toBeNull()
    expect(converter.segment(load('webm/init-stream1.webm'))).toBeNull()
  })

  it('leaves the bytes the page appended untouched', () => {
    const source = Uint8Array.from(audioSegments[0]!)
    converter.segment(source)
    expect([...source]).toEqual([...audioSegments[0]!])
  })
})

describe('webmToIso: the picture track it declares', () => {
  it('writes an init segment the ISO BMFF reader makes sense of', () => {
    expect(parseInit(video.initBytes)).toEqual({
      tracks: [
        {
          trackId: 1, kind: 'video', timescale: 1000, codec: 'vp09',
          width: 256, height: 144, defaultSampleDuration: 0,
        },
      ],
    })
  })

  it('keeps the name the container gave the codec', () => {
    expect(video.info.tracks[0]!.codec).toBe('V_VP9')
    expect(video.info.tracks[0]!.kind).toBe('video')
  })

  it('counts in the ticks Matroska counted in: they cross over with nothing to round', () => {
    expect(vp9Init.tracks[0]!.timescale).toBe(1000)
    expect(video.info.tracks[0]!.timescale).toBe(1000)

    const mdhd = findBox(video.initBytes, ['moov', 'trak', 'mdia', 'mdhd'])!
    expect(view(boxBody(video.initBytes, mdhd)).getUint32(12)).toBe(1000)
  })

  it('describes the stream in a vpcC, out of the codec string and nowhere else', () => {
    const stsd = findBox(video.initBytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!
    const body = boxBody(video.initBytes, stsd)
    // Past version and flags, entry count, the box header of the sample entry, and the fixed part
    // of a VisualSampleEntry.
    const vpcC = body.subarray(4 + 4 + 8 + 78)

    expect([...vpcC.subarray(0, 8)]).toEqual([0, 0, 0, 20, 0x76, 0x70, 0x63, 0x43])
    // Version one, then profile 0, level 1.0, eight bits and 4:2:0, BT.709, no init data.
    expect([...vpcC.subarray(8)]).toEqual([1, 0, 0, 0, 0, 10, 0x82, 1, 1, 1, 0, 0])
  })
})

describe('webmToIso: picture segments across', () => {
  const converted = videoSegments.map((bytes) => video.segment(bytes)!)

  /** Sample flags a converted fragment states, one per sample. */
  function flagsOf(fragment: Uint8Array): number[] {
    const trun = findBox(fragment, ['moof', 'traf', 'trun'])!
    const body = view(boxBody(fragment, trun))
    const count = body.getUint32(4)

    return Array.from({ length: count }, (_unused, i) => body.getUint32(12 + i * 12 + 8))
  }

  it('places each segment where the cluster timeline puts it', () => {
    // The material starts fourteen milliseconds in and runs two seconds a segment.
    expect(converted.map((segment) => segment.start)).toEqual([0.014, 2.014, 4.014])
    expect(converted.map((segment) => segment.end)).toEqual([2.014, 4.014, 6.014])
  })

  it('states the decode time in the ticks the track counts in', () => {
    expect(converted.map((s) => parseFragment(s.bytes)!.baseMediaDecodeTime)).toEqual([
      14, 2014, 4014,
    ])
  })

  it('leaves no seam between one segment and the next', () => {
    for (const [index, segment] of converted.slice(1).entries()) {
      expect(segment.start, `segment ${index + 2}`).toBe(converted[index]!.end)
    }
  })

  it('measures every frame by the cluster timeline, as the sound is measured', () => {
    const durations = durationsOf(converted[0]!.bytes, 12)
    // Twenty frames of a hundred milliseconds: ten a second, which is what the fixture runs at.
    expect(durations.length).toBe(20)
    expect([...new Set(durations)]).toEqual([100])
  })

  it('measures the last frame of a fragment by the step the ones before it went at', () => {
    // Nothing in a SimpleBlock states how long a frame lasts and nothing inside a coded frame
    // does either, so the final one takes the step of its neighbours. Understating it would leave
    // a gap at every segment boundary; overstating it would overlap the next segment.
    const durations = durationsOf(converted[2]!.bytes, 12)
    expect(durations[durations.length - 1]).toBe(100)
  })

  it('marks the keyframes and nothing else', () => {
    // One at the head of each segment in this material, which is what a two-second key interval
    // at ten frames a second comes to.
    for (const [index, segment] of converted.entries()) {
      const flags = flagsOf(segment.bytes)
      expect(flags[0], `segment ${index + 1}`).toBe(0x02000000)
      expect([...new Set(flags.slice(1))], `segment ${index + 1}`).toEqual([0x01010000])
    }
  })

  it('carries every frame of the segment over, whole and in order', () => {
    const mdat = topLevelBoxes(converted[0]!.bytes).find((b) => b.type === 'mdat')!
    const payload = boxBody(converted[0]!.bytes, mdat)

    const trun = findBox(converted[0]!.bytes, ['moof', 'traf', 'trun'])!
    const body = view(boxBody(converted[0]!.bytes, trun))
    let at = 0
    for (let i = 0; i < body.getUint32(4); i++) at += body.getUint32(16 + i * 12)
    expect(at).toBe(payload.byteLength)
  })

  it('gives nothing back for bytes that are not a segment of this track', () => {
    expect(video.segment(load('webm/chunk-stream1-00001.webm'))).toBeNull()
    expect(video.segment(load('h264/chunk-stream0-00001.m4s'))).toBeNull()
    expect(video.segment(new Uint8Array(0))).toBeNull()
  })

  it('leaves the bytes the page appended untouched', () => {
    const source = Uint8Array.from(videoSegments[0]!)
    video.segment(source)
    expect([...source]).toEqual([...videoSegments[0]!])
  })
})

/**
 * The two older codecs, which this converter refused until an imageboard's file made the case.
 *
 * They are here for the same reason VP9 and Opus are: a page is free to open a SourceBuffer for
 * either, and a track refused at this boundary is a whole kind of media missing from the saved
 * file. Both are legal in an mp4 and both play — see src/core/vp8/mp4.ts and
 * src/core/vorbis/mp4.ts, where the measurements are.
 */
describe('webmToIso: the older pair', () => {
  const vorbis = webmToIso(vorbisInit)!
  const vp8 = webmToIso(vp8Init, VP8_TYPE)!

  it('takes a Vorbis track, which needs nothing the init segment does not carry', () => {
    expect(vorbisInit.tracks[0]!.codec).toBe('A_VORBIS')
    expect(vorbis).not.toBeNull()

    expect(parseInit(vorbis.initBytes)).toEqual({
      tracks: [
        {
          trackId: 1,
          kind: 'audio',
          // The rate the material was encoded at: Vorbis decodes at what it was fed.
          timescale: 22_050,
          codec: 'mp4a',
          width: 0,
          height: 0,
          defaultSampleDuration: 0,
        },
      ],
    })
  })

  it('refuses a Vorbis track with no setup headers to describe it', () => {
    const bare = { tracks: [{ ...vorbisInit.tracks[0]!, codecPrivate: undefined }] }
    expect(webmToIso(bare)).toBeNull()
  })

  it('takes a VP8 track, which has one shape and nothing to be told about it', () => {
    // The argument that makes a VP9 track wait for a codec string does not reach VP8: the format
    // has one bit depth, one subsampling and one colour space, so there is nothing about the
    // shape of the stream for a declaration to get wrong.
    expect(vp8Init.tracks[0]!.codec).toBe('V_VP8')
    expect(webmToIso(vp8Init, VP8_TYPE)).not.toBeNull()
    expect(webmToIso(vp8Init, 'video/webm')).not.toBeNull()
    expect(webmToIso(vp8Init)).not.toBeNull()
  })

  it('declares the VP8 picture as vp08 with the frame size the container stated', () => {
    expect(parseInit(vp8.initBytes)).toEqual({
      tracks: [
        {
          trackId: 1,
          kind: 'video',
          timescale: 1000,
          codec: 'vp08',
          width: 256,
          height: 144,
          defaultSampleDuration: 0,
        },
      ],
    })
  })

  it('refuses a VP8 track whose frame size the container never stated', () => {
    const sizeless = { tracks: [{ ...vp8Init.tracks[0]!, width: 0, height: 0 }] }
    expect(webmToIso(sizeless, VP8_TYPE)).toBeNull()
  })

  it('carries the segments of both across with no seam between them', () => {
    for (const [name, converter, chunks] of [
      ['vorbis', vorbis, [1, 2, 3].map((n) => load(`webm-vp8/chunk-stream1-0000${n}.webm`))],
      ['vp8', vp8, [1, 2, 3].map((n) => load(`webm-vp8/chunk-stream0-0000${n}.webm`))],
    ] as const) {
      const across = chunks.map((bytes) => converter.segment(bytes)!)

      expect(across.every(Boolean), `a ${name} segment came back empty`).toBe(true)
      // Where the material starts is the container's business and not zero: this muxer puts the
      // first picture frame 23 ms in and the first packet of sound at the head.
      expect(across[0]!.start).toBeLessThan(0.05)

      for (let i = 1; i < across.length; i++) {
        // Where one segment stops, the next starts. The picture lands on it exactly — a coded
        // picture track runs at a constant rate, so the step between the last two frames is the
        // length of the last one. The sound does not, and cannot: nothing a reader can get at
        // cheaply states how long a Vorbis packet is, and the shortest step the container shows
        // stands in for it. What that comes to is measured here rather than waved at — one tick
        // of the Matroska timeline, which is a millisecond — and it is understated on purpose:
        // an overlap would have the sound gain a millisecond per segment, and nothing downstream
        // takes one back.
        const seam = across[i]!.start - across[i - 1]!.end
        expect(seam, `the ${name} track overlaps itself`).toBeGreaterThanOrEqual(0)
        expect(seam, `a seam in the ${name} track`).toBeLessThanOrEqual(name === 'vp8' ? 0 : 0.001)
      }

      expect(across[across.length - 1]!.end).toBeGreaterThan(5.9)
    }
  })

  it('marks the keyframes of the VP8 picture and nothing else', () => {
    const fragment = vp8.segment(load('webm-vp8/chunk-stream0-00001.webm'))!
    const trun = findBox(fragment.bytes, ['moof', 'traf', 'trun'])!
    const body = view(boxBody(fragment.bytes, trun))
    const count = body.getUint32(4)
    const flags = Array.from({ length: count }, (_unused, i) => body.getUint32(12 + i * 12 + 8))

    // A key frame at the head of the segment and nineteen behind it that a seek must not land on
    // — the same two words the VP9 track states, because the flags are the container's and not
    // the codec's.
    expect(flags[0]).toBe(0x02000000)
    expect([...new Set(flags.slice(1))]).toEqual([0x01010000])
  })

  it('carries every Vorbis packet over, whole and in order', () => {
    const bytes = load('webm-vp8/chunk-stream1-00001.webm')
    const fragment = vorbis.segment(bytes)!
    const mdat = topLevelBoxes(fragment.bytes).find((box) => box.type === 'mdat')!
    const payload = boxBody(fragment.bytes, mdat)

    const frames = parseClusters(bytes).flatMap((cluster) => cluster.frames)
    let at = 0
    for (const frame of frames) {
      expect(payload.subarray(at, at + frame.data.byteLength)).toEqual(frame.data)
      at += frame.data.byteLength
    }
    expect(at).toBe(payload.byteLength)
  })
})
