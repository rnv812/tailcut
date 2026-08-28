import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { vp9ConfigOfKeyframe } from '../../src/core/vp9/bitstream'
import { vp9SampleEntry } from '../../src/core/vp9/mp4'
import { parseInit } from '../../src/core/webm/init'
import { parseClusters } from '../../src/core/webm/fragment'
import { buildProgressiveMp4, type OutSample } from '../../src/core/iso/progressive'
import { decodeWarnings, probeFile, unexpectedWarnings, writeTemp } from '../support/media'

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

const whole = load('plain/watched.webm')
const picture = parseInit(whole)!.tracks.find((track) => track.kind === 'video')!
const frames = parseClusters(whole)
  .flatMap((cluster) => cluster.frames)
  .filter((frame) => frame.trackNumber === picture.trackId)
  .sort((a, b) => a.timestamp - b.timestamp)

const keyframe = frames.find((frame) => frame.keyframe)!.data
const interframe = frames.find((frame) => !frame.keyframe)!.data

/** Writes bits the way the uncompressed header is read: most significant first. */
class BitWriter {
  private readonly bits: number[] = []

  put(value: number, width: number): this {
    for (let i = width - 1; i >= 0; i--) this.bits.push((value >> i) & 1)
    return this
  }

  get bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8))
    this.bits.forEach((bit, i) => {
      if (bit) out[i >> 3]! |= 0x80 >> (i & 7)
    })
    return out
  }
}

/**
 * A synthetic uncompressed header, so that the shapes no fixture holds can be read too.
 *
 * The fixture is profile 0, eight bits, 4:2:0, which is what the web is made of. The branches
 * that a ten-bit or a 4:4:4 stream would take have no material to exercise them, and a reader
 * that got them wrong would describe such a file as eight-bit 4:2:0 in silence.
 */
function header(options: {
  profile?: number
  tenOrTwelve?: number
  colourSpace?: number
  range?: number
  subsamplingX?: number
  subsamplingY?: number
  width?: number
  height?: number
  keyframe?: boolean
  showExisting?: boolean
}): Uint8Array {
  const profile = options.profile ?? 0
  const colourSpace = options.colourSpace ?? 2
  const bits = new BitWriter()

  bits.put(2, 2) // frame_marker
  bits.put(profile & 1, 1) // profile_low_bit
  bits.put((profile >> 1) & 1, 1) // profile_high_bit
  if (profile === 3) bits.put(0, 1) // reserved_zero

  bits.put(options.showExisting ? 1 : 0, 1)
  if (options.showExisting) {
    bits.put(0, 3) // frame_to_show_map_idx
    return bits.bytes
  }

  bits.put(options.keyframe === false ? 1 : 0, 1) // frame_type
  bits.put(1, 1) // show_frame
  bits.put(0, 1) // error_resilient_mode
  if (options.keyframe === false) return bits.bytes

  bits.put(0x49, 8).put(0x83, 8).put(0x42, 8) // frame_sync_code

  if (profile >= 2) bits.put(options.tenOrTwelve ?? 0, 1)
  bits.put(colourSpace, 3)

  if (colourSpace !== 7) {
    bits.put(options.range ?? 0, 1)
    if (profile === 1 || profile === 3) {
      bits.put(options.subsamplingX ?? 1, 1)
      bits.put(options.subsamplingY ?? 1, 1)
      bits.put(0, 1) // reserved_zero
    }
  } else if (profile === 1 || profile === 3) {
    bits.put(0, 1) // reserved_zero
  }

  bits.put((options.width ?? 320) - 1, 16)
  bits.put((options.height ?? 240) - 1, 16)

  return bits.bytes
}

describe('vp9ConfigOfKeyframe', () => {
  it('reads a real keyframe of the web as it is: profile zero, eight bits, 4:2:0', () => {
    const config = vp9ConfigOfKeyframe(keyframe)

    expect(config).not.toBeNull()
    expect(config!.profile).toBe(0)
    expect(config!.bitDepth).toBe(8)
    expect(config!.chromaSubsampling).toBe(1)
    expect(config!.fullRange).toBe(false)
    expect(config!.width).toBe(256)
    expect(config!.height).toBe(144)
  })

  it('reads the deeper shapes a fixture cannot show', () => {
    // Profile 2 states its bit depth in a bit of its own, and the bit says ten or twelve.
    expect(vp9ConfigOfKeyframe(header({ profile: 2 }))!.bitDepth).toBe(10)
    expect(vp9ConfigOfKeyframe(header({ profile: 2, tenOrTwelve: 1 }))!.bitDepth).toBe(12)

    // Profile 1 and 3 state their subsampling; 0 and 2 are 4:2:0 and cannot say otherwise.
    const chroma = (x: number, y: number): number =>
      vp9ConfigOfKeyframe(header({ profile: 1, subsamplingX: x, subsamplingY: y }))!
        .chromaSubsampling

    expect(chroma(1, 1)).toBe(1) // 4:2:0
    expect(chroma(1, 0)).toBe(2) // 4:2:2
    expect(chroma(0, 0)).toBe(3) // 4:4:4
    // Chroma subsampled vertically and not horizontally is not a shape the format has.
    expect(vp9ConfigOfKeyframe(header({ profile: 1, subsamplingX: 0, subsamplingY: 1 }))).toBeNull()
  })

  it('reads the one colour fact the bitstream carries', () => {
    // The bitstream names a colour space and that name is a matrix; the primaries and the
    // transfer it does not carry at all, and 2 is the CICP code for "the stream does not say".
    const matrix = (space: number): number =>
      vp9ConfigOfKeyframe(header({ colourSpace: space }))!.matrixCoefficients

    expect(matrix(0)).toBe(2) // unknown
    expect(matrix(1)).toBe(5) // BT.601
    expect(matrix(2)).toBe(1) // BT.709
    expect(matrix(5)).toBe(9) // BT.2020

    const config = vp9ConfigOfKeyframe(header({ colourSpace: 2 }))!
    expect([config.colourPrimaries, config.transferCharacteristics]).toEqual([2, 2])

    // sRGB is the one space that is not subsampled and is always full range.
    const srgb = vp9ConfigOfKeyframe(header({ profile: 1, colourSpace: 7 }))!
    expect(srgb.matrixCoefficients).toBe(0)
    expect(srgb.fullRange).toBe(true)
    expect(srgb.chromaSubsampling).toBe(3)
    // And it is illegal in the profiles that have no 4:4:4 to put it in.
    expect(vp9ConfigOfKeyframe(header({ profile: 0, colourSpace: 7 }))).toBeNull()
  })

  it('states the range the stream states', () => {
    expect(vp9ConfigOfKeyframe(header({ range: 1 }))!.fullRange).toBe(true)
  })

  it('refuses anything that is not a keyframe to read', () => {
    expect(vp9ConfigOfKeyframe(interframe)).toBeNull()
    expect(vp9ConfigOfKeyframe(header({ keyframe: false }))).toBeNull()
    // A frame that shows one already decoded carries no description of anything.
    expect(vp9ConfigOfKeyframe(header({ showExisting: true }))).toBeNull()
    expect(vp9ConfigOfKeyframe(new Uint8Array(2))).toBeNull()
    expect(vp9ConfigOfKeyframe(new Uint8Array(0))).toBeNull()
  })

  it('refuses a header whose sync code is not there', () => {
    const broken = header({})
    broken[1] = 0x00

    expect(vp9ConfigOfKeyframe(broken)).toBeNull()
  })

  it('describes a file ffmpeg reads as VP9 and decodes without a word', () => {
    const samples: OutSample[] = frames.map((frame, index) => ({
      bytes: frame.data,
      duration: (frames[index + 1]?.timestamp ?? frame.timestamp + 100) - frame.timestamp,
      cts: 0,
      sync: frame.keyframe,
    }))

    const file = writeTemp(
      'vp9-bitstream.mp4',
      buildProgressiveMp4([
        {
          trackId: 1,
          kind: 'video',
          timescale: 1000,
          sampleEntry: vp9SampleEntry(
            vp9ConfigOfKeyframe(keyframe)!,
            picture.width,
            picture.height,
          ),
          width: picture.width,
          height: picture.height,
          samples,
          skipTicks: 0,
        },
      ]),
    )

    const probed = probeFile(file)
    expect(probed.status, probed.stderr).toBe(0)
    expect(probed.stderr).toBe('')

    const stream = probed.probed!.streams[0]!
    expect(stream.codec_name).toBe('vp9')
    expect(Number(stream.nb_read_frames)).toBe(frames.length)
    expect(unexpectedWarnings(decodeWarnings(file))).toEqual([])
  })
})
