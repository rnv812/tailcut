import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { webmToIso } from '../../src/core/webm/to-iso'
import { parseInit as parseWebmInit } from '../../src/core/webm/init'
import { parseInit } from '../../src/core/iso/init'
import { parseFragment } from '../../src/core/iso/fragment'
import { boxBody, findBox, topLevelBoxes } from '../../src/core/iso/reader'
import { OPUS_SAMPLE_RATE } from '../../src/core/opus/packets'
import type { InitInfo } from '../../src/shared/types'

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

const opusInit = parseWebmInit(load('webm/init-stream1.webm'))!
const vp9Init = parseWebmInit(load('webm/init-stream0.webm'))!

/** Four media segments of the Opus track: 0…1.961, 1.981…3.961, 3.981…5.961 and one last frame. */
const audioSegments = [1, 2, 3, 4].map((n) => load(`webm/chunk-stream1-0000${n}.webm`))

const converter = webmToIso(opusInit)!

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** Sample durations a converted fragment states, in ticks of the track it was written for. */
function durationsOf(fragment: Uint8Array): number[] {
  const trun = findBox(fragment, ['moof', 'traf', 'trun'])!
  const body = view(boxBody(fragment, trun))
  const count = body.getUint32(4)

  return Array.from({ length: count }, (_unused, i) => body.getUint32(12 + i * 8))
}

describe('webmToIso: what it takes and what it refuses', () => {
  it('takes an Opus track', () => {
    expect(webmToIso(opusInit)).not.toBeNull()
  })

  it('refuses a WebM video track by codec name rather than guessing at it', () => {
    // A vp09 sample entry needs facts about the bitstream Matroska does not carry. Refusing here
    // leaves the buffer without a track; opening one would collect segments no file could hold.
    expect(vp9Init.tracks[0]!.codec).toBe('V_VP9')
    expect(webmToIso(vp9Init)).toBeNull()
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
        { trackId: 1, kind: 'audio', timescale: OPUS_SAMPLE_RATE, codec: 'Opus', width: 0, height: 0 },
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
