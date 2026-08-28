import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DECODER_DELAY_SAMPLES,
  headerFrameAt,
  id3Length,
  mpegHeaderAt,
  walkMpegFrames,
} from '../../src/core/mpeg/frames'

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/**
 * A frame header out of its fields, so that a test can say which bit it is about.
 *
 * The four bytes are eleven bits of sync and then the fields packed against each other; written
 * as hexadecimal literals every one of these tests would be a puzzle rather than a statement.
 */
function header(fields: {
  version?: number
  layer?: number
  protection?: number
  bitrate?: number
  rate?: number
  padding?: number
  mode?: number
}): Uint8Array {
  const version = fields.version ?? 0b11
  const layer = fields.layer ?? 0b01
  const protection = fields.protection ?? 1
  const bitrate = fields.bitrate ?? 5
  const rate = fields.rate ?? 0
  const padding = fields.padding ?? 0
  const mode = fields.mode ?? 0

  return Uint8Array.from([
    0xff,
    0xe0 | (version << 3) | (layer << 1) | protection,
    (bitrate << 4) | (rate << 2) | (padding << 1),
    mode << 6,
  ])
}

/** A frame: its header, and as many zero bytes behind it as the header says it is long. */
function frame(fields: Parameters<typeof header>[0]): Uint8Array {
  const head = header(fields)
  const read = mpegHeaderAt(head, 0)
  if (!read) throw new Error('the test built a header this reader will not take')

  const bytes = new Uint8Array(read.length)
  bytes.set(head)
  return bytes
}

const join = (parts: Uint8Array[]): Uint8Array => {
  let size = 0
  for (const part of parts) size += part.byteLength
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

describe('mpegHeaderAt', () => {
  it('reads the first frame of a real MPEG-1 Layer III stream', () => {
    const bytes = load('plain/track.mp3')
    const read = mpegHeaderAt(bytes, id3Length(bytes))

    expect(read).toMatchObject({ version: 1, layer: 3, sampleRate: 44100, channels: 2 })
    // 1152 samples a frame is what every MPEG-1 Layer III frame carries, whatever its bitrate.
    expect(read?.samples).toBe(1152)
  })

  it('reads the first frame of a real MPEG-2 Layer III stream', () => {
    const bytes = load('plain/track-lsf.mp3')
    const read = mpegHeaderAt(bytes, id3Length(bytes))

    // The low-sampling-frequency extension: half the rate, half the samples per frame, and a
    // bitrate table of its own. A reader that took the MPEG-1 geometry for granted measures this
    // file out as twice its length.
    expect(read).toMatchObject({ version: 2, layer: 3, sampleRate: 22050, channels: 1 })
    expect(read?.samples).toBe(576)
  })

  it.each([
    ['MPEG-1 Layer III at 128 kbit and 44.1 kHz', { bitrate: 9 }, 417],
    ['the same frame with the padding bit set', { bitrate: 9, padding: 1 }, 418],
    ['MPEG-1 Layer III at 32 kbit and 44.1 kHz', { bitrate: 1 }, 104],
    ['MPEG-1 Layer II at 128 kbit and 44.1 kHz', { layer: 0b10, bitrate: 8 }, 417],
    ['MPEG-1 Layer I at 128 kbit and 44.1 kHz', { layer: 0b11, bitrate: 4 }, 136],
    ['MPEG-2 Layer III at 32 kbit and 22.05 kHz', { version: 0b10, bitrate: 4 }, 104],
    ['MPEG-2.5 Layer III at 32 kbit and 11.025 kHz', { version: 0b00, bitrate: 4 }, 208],
  ])('measures %s as %i bytes', (_name, fields, length) => {
    expect(mpegHeaderAt(header(fields), 0)?.length).toBe(length)
  })

  it.each([
    ['Layer I', { layer: 0b11 }, 384],
    ['MPEG-1 Layer II', { layer: 0b10 }, 1152],
    ['MPEG-1 Layer III', { layer: 0b01 }, 1152],
    ['MPEG-2 Layer III', { version: 0b10, layer: 0b01, bitrate: 4 }, 576],
    ['MPEG-2 Layer II', { version: 0b10, layer: 0b10, bitrate: 4 }, 1152],
  ])('says a frame of %s carries %i samples', (_name, fields, samples) => {
    expect(mpegHeaderAt(header(fields), 0)?.samples).toBe(samples)
  })

  it('counts one channel for single-channel mode and two for every other', () => {
    expect(mpegHeaderAt(header({ mode: 0b11 }), 0)?.channels).toBe(1)
    for (const mode of [0b00, 0b01, 0b10]) {
      expect(mpegHeaderAt(header({ mode }), 0)?.channels).toBe(2)
    }
  })

  it.each([
    ['the reserved version', { version: 0b01 }],
    ['the reserved layer', { layer: 0b00 }],
    ['the free bitrate, whose frames state no length at all', { bitrate: 0 }],
    ['the forbidden bitrate index', { bitrate: 0b1111 }],
    ['the reserved sampling rate', { rate: 0b11 }],
  ])('refuses a header stating %s', (_name, fields) => {
    expect(mpegHeaderAt(header(fields), 0)).toBeNull()
  })

  it('refuses bytes that are not a frame header', () => {
    // A file that begins with a box header, which is what an mp4 is: the sync word is not there.
    expect(mpegHeaderAt(Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]), 0)).toBeNull()
    // Eleven bits of sync and not ten: 0xFFC0 is a JPEG marker and not the start of a frame.
    expect(mpegHeaderAt(Uint8Array.from([0xff, 0xc0, 0x00, 0x11]), 0)).toBeNull()
  })

  it('refuses a header cut off by the end of the buffer', () => {
    expect(mpegHeaderAt(header({}).subarray(0, 3), 0)).toBeNull()
  })
})

describe('id3Length', () => {
  it('measures the tag a real encoder wrote in front of its first frame', () => {
    const bytes = load('plain/track.mp3')

    // Ten bytes of tag header and the size the tag states, and the first frame stands right
    // behind it: read as anything else, every frame of the file is off by that much.
    expect(id3Length(bytes)).toBe(45)
    expect(mpegHeaderAt(bytes, 45)).not.toBeNull()
  })

  it('reads the size as seven bits to a byte', () => {
    // 0x01 0x00 in syncsafe form is 128, and read as an ordinary big-endian number it is 256.
    const tag = new Uint8Array(1024)
    tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x01, 0x00])
    expect(id3Length(tag)).toBe(10 + 128)
  })

  it('counts the footer of a tag that states one', () => {
    const tag = new Uint8Array(1024)
    // Bit 4 of the flags is the footer: ten bytes more, behind the tag rather than in front.
    tag.set([0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0x01, 0x00])
    expect(id3Length(tag)).toBe(10 + 128 + 10)
  })

  it('says nothing stands in front of a file that begins with a frame', () => {
    expect(id3Length(header({}))).toBe(0)
  })
})

describe('headerFrameAt', () => {
  it('finds the header frame a real encoder writes at the front of the file', () => {
    const bytes = load('plain/track.mp3')
    const at = id3Length(bytes)
    const read = mpegHeaderAt(bytes, at)!

    // The first frame of the file is not sound: lame writes a frame carrying the Xing tag, whose
    // audio payload is silence. Counted as material it puts 26 ms of nothing at the head of every
    // clip and moves every later frame by that much.
    expect(headerFrameAt(bytes, at, read)).not.toBeNull()
    expect(
      headerFrameAt(bytes, at + read.length, mpegHeaderAt(bytes, at + read.length)!),
    ).toBeNull()
  })

  it('finds the tag behind the side information of a mono MPEG-1 frame', () => {
    const bytes = frame({ mode: 0b11 })
    // Four bytes of header and seventeen of side information for a mono MPEG-1 frame.
    bytes.set([0x58, 0x69, 0x6e, 0x67], 4 + 17)
    expect(headerFrameAt(bytes, 0, mpegHeaderAt(bytes, 0)!)).not.toBeNull()
  })

  it('steps over the checksum of a frame that carries one', () => {
    const bytes = frame({ protection: 0 })
    // Two bytes of CRC between the header and the side information: written at the offset of a
    // frame without one, the tag would sit inside the checked bytes and be missed.
    bytes.set([0x49, 0x6e, 0x66, 0x6f], 4 + 2 + 32)
    expect(headerFrameAt(bytes, 0, mpegHeaderAt(bytes, 0)!)).not.toBeNull()
  })

  it('finds a VBRI tag, which stands at a fixed offset instead', () => {
    const bytes = frame({})
    bytes.set([0x56, 0x42, 0x52, 0x49], 4 + 32)
    // It states no encoder delay of its own; what is left is the delay of the format.
    expect(headerFrameAt(bytes, 0, mpegHeaderAt(bytes, 0)!)?.skipSamples).toBe(
      DECODER_DELAY_SAMPLES,
    )
  })

  it('says an ordinary frame is not one', () => {
    expect(headerFrameAt(frame({}), 0, mpegHeaderAt(header({}), 0)!)).toBeNull()
  })

  it('reads the encoder delay out of the LAME extension behind the tag', () => {
    const bytes = load('plain/track.mp3')
    const at = id3Length(bytes)

    // 576 samples of encoder delay, which is what lame leaves by default, and 529 of decoder
    // delay on top: 1105 samples, 25.1 ms. Measured against ffmpeg's own decode of the same file,
    // that is exactly how far ahead of its zero the material sits.
    expect(headerFrameAt(bytes, at, mpegHeaderAt(bytes, at)!)?.skipSamples).toBe(
      576 + DECODER_DELAY_SAMPLES,
    )
  })

  it('states no delay where the four letters are not a LAME extension', () => {
    const bytes = frame({})
    // A Xing tag with no flags and nothing behind it: the bytes at the offset of the delay field
    // are the payload of the frame, and a number read out of them would be invented.
    bytes.set([0x58, 0x69, 0x6e, 0x67], 4 + 32)
    expect(headerFrameAt(bytes, 0, mpegHeaderAt(bytes, 0)!)?.skipSamples).toBe(0)
  })
})

describe('walkMpegFrames', () => {
  it('walks a real stream end to end and lands exactly on its last byte', () => {
    const bytes = load('plain/track.mp3')
    const walk = walkMpegFrames(bytes, id3Length(bytes), 0)

    // Nine hundred and thirty-nine frames of sound behind the one carrying the tag, and the walk
    // ends where the file does: a length read wrong anywhere in the chain leaves a remainder.
    expect(walk.frames.length).toBe(939)
    expect(walk.at).toBe(bytes.byteLength)
    expect(walk.sampleRate).toBe(44100)
    expect(walk.channels).toBe(2)
    expect(walk.version).toBe(1)
    expect(walk.skipSamples).toBe(576 + DECODER_DELAY_SAMPLES)
  })

  it('reads the header frame only at the front of the stream', () => {
    const bytes = load('plain/track.mp3')
    const at = id3Length(bytes)
    const continued = walkMpegFrames(bytes, at, 0, { head: false })

    // A window that continues a walk begins on an ordinary frame, whatever its payload spells.
    // Told otherwise, this one would drop the frame it starts with as the encoder's.
    expect(continued.frames.length).toBe(940)
    expect(continued.skipSamples).toBe(0)
  })

  it('addresses every frame where it lies in the file', () => {
    const bytes = load('plain/track.mp3')
    const walk = walkMpegFrames(bytes, id3Length(bytes), 0)

    for (const found of walk.frames) {
      expect(mpegHeaderAt(bytes, found.source.at)).not.toBeNull()
      expect(found.source.length).toBe(mpegHeaderAt(bytes, found.source.at)?.length)
    }
  })

  it('counts the samples of the stream, the header frame left out', () => {
    const bytes = load('plain/track.mp3')
    const walk = walkMpegFrames(bytes, id3Length(bytes), 0)

    let samples = 0
    for (const found of walk.frames) samples += found.samples
    // ffprobe measures the file at 24.529 s; 939 frames of 1152 samples at 44.1 kHz is that.
    expect(samples / walk.sampleRate).toBeCloseTo(24.529, 2)
  })

  it('counts the addresses from the base it is given', () => {
    const bytes = load('plain/track.mp3')
    const at = id3Length(bytes)
    const walk = walkMpegFrames(bytes.subarray(at), 0, at)

    // The same file read as a window that begins part way in: a frame is addressed where it lies
    // in the file and not where it lies in the buffer that happens to hold it.
    expect(walk.frames[0]?.source.at).toBe(at + mpegHeaderAt(bytes, at)!.length)
  })

  it('stops in front of a frame the buffer does not hold whole', () => {
    const bytes = load('plain/track.mp3')
    const at = id3Length(bytes)
    const whole = walkMpegFrames(bytes, at, 0)
    const short = walkMpegFrames(bytes.subarray(0, 1000), at, 0)

    // What it stops at is where the next read has to begin: a frame half in the window is not a
    // frame, and an index that took the half of it that arrived would address bytes of the next.
    expect(short.frames.length).toBeLessThan(whole.frames.length)
    expect(short.at).toBeLessThanOrEqual(1000)
    expect(mpegHeaderAt(bytes, short.at)).not.toBeNull()
  })

  it('stops at bytes that are not a frame at all', () => {
    const sound = frame({})
    const stream = join([sound, sound, Uint8Array.from([0x54, 0x41, 0x47, 0x00])])
    const walk = walkMpegFrames(stream, 0, 0)

    // An ID3v1 tag at the tail, which is the ordinary way an mp3 ends. What is behind the last
    // frame is not this reader's business; what matters is that it is not read as one.
    expect(walk.frames.length).toBe(2)
    expect(walk.at).toBe(sound.byteLength * 2)
  })

  it('refuses a stream whose frames disagree about the rate', () => {
    // Two frames of different sampling rates: legal in the file format and not a thing any
    // encoder writes. One track of an mp4 states one rate, so a stream that changes it cannot be
    // described — and being wrong about it means being wrong about every time in the track.
    const stream = join([frame({ rate: 0 }), frame({ rate: 1 })])
    const walk = walkMpegFrames(stream, 0, 0)

    expect(walk.frames.length).toBe(1)
    expect(walk.sampleRate).toBe(44100)
  })

  it('walks frames of different bitrates, which is what a variable-rate file is', () => {
    const stream = join([frame({ bitrate: 1 }), frame({ bitrate: 9 }), frame({ bitrate: 5 })])
    const walk = walkMpegFrames(stream, 0, 0)

    expect(walk.frames.map((found) => found.source.length)).toEqual([104, 417, 208])
  })
})
