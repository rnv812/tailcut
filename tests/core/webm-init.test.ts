import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseInit } from '../../src/core/webm/init'
import { ID } from '../../src/core/webm/reader'

const audio = new Uint8Array(readFileSync('tests/fixtures/webm/init-stream1.webm'))
const video = new Uint8Array(readFileSync('tests/fixtures/webm/init-stream0.webm'))
const media = new Uint8Array(readFileSync('tests/fixtures/webm/chunk-stream1-00001.webm'))

/** The OpusHead ffmpeg wrote into the CodecPrivate of the fixture: stereo, 48 kHz. */
const OPUS_HEAD = Uint8Array.of(
  0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // "OpusHead"
  0x01, // version
  0x02, // channel count
  0x38, 0x01, // pre-skip, little-endian
  0x80, 0xbb, 0x00, 0x00, // input sample rate, little-endian: 48000
  0x00, 0x00, // output gain
  0x00, // channel mapping family
)

describe('parseInit', () => {
  it('reads an Opus audio track', () => {
    // The whole reading at once, every field an exact value rather than "more than zero": a
    // number picked out of the wrong element is positive too.
    expect(parseInit(audio)).toEqual({
      tracks: [{
        trackId: 2,
        kind: 'audio',
        timescale: 1000,
        codec: 'A_OPUS',
        width: 0,
        height: 0,
        codecPrivate: OPUS_HEAD,
        channels: 2,
        sampleRate: 48000,
      }],
    })
  })

  it('reads a VP9 video track — the reading is not shaped around one codec', () => {
    expect(parseInit(video)).toEqual({
      tracks: [{
        trackId: 1,
        kind: 'video',
        timescale: 1000,
        codec: 'V_VP9',
        width: 256,
        height: 144,
      }],
    })
  })

  it('leaves out what a video track does not have', () => {
    // VP9 carries no CodecPrivate and no sound. The fields stay absent rather than turning up as
    // zeroes a caller would have to tell apart from real ones.
    const track = parseInit(video)!.tracks[0]!
    expect(track.codecPrivate).toBeUndefined()
    expect(track.channels).toBeUndefined()
    expect(track.sampleRate).toBeUndefined()
  })

  it('returns null for a media segment', () => {
    expect(parseInit(media)).toBeNull()
  })

  it('returns null for a fragmented mp4 init segment', () => {
    expect(parseInit(new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s')))).toBeNull()
  })

  it('returns null for bytes that are not media at all', () => {
    const html = '<!DOCTYPE html><html><body>not a video</body></html>'
    expect(parseInit(Uint8Array.from(html, (c) => c.charCodeAt(0)))).toBeNull()
    expect(parseInit(new Uint8Array(0))).toBeNull()
    expect(parseInit(new Uint8Array(512))).toBeNull()
  })

  it('survives the init segment cut off at any length', () => {
    // A segment still arriving is a normal thing to be handed. Every prefix has to end in a
    // refusal or in a whole reading, and never in a throw.
    for (let length = 0; length <= audio.byteLength; length++) {
      const prefix = audio.subarray(0, length)
      const info = parseInit(prefix)
      if (info) {
        expect(info.tracks[0]!.codec).toBe('A_OPUS')
        expect(info.tracks[0]!.timescale).toBe(1000)
      }
    }
    // and the shortest prefix that reads whole is the whole segment: the fixture ends with a
    // Tags element, so the reading is done before the last byte arrives
    expect(parseInit(audio.subarray(0, audio.byteLength - 1))).not.toBeNull()
  })
})

// --- Synthetic init segments, for the shapes the fixtures do not contain ---

function id(value: number): number[] {
  const out: number[] = []
  let rest = value
  while (rest > 0) {
    out.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  }
  return out.length ? out : [0]
}

function size(value: number): number[] {
  let length = 1
  while (value > 2 ** (7 * length) - 2) length++

  const out: number[] = []
  let rest = value
  for (let i = 0; i < length; i++) {
    out.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  }
  out[0]! |= 0x80 >> (length - 1)
  return out
}

const element = (elementId: number, ...body: number[]): number[] =>
  [...id(elementId), ...size(body.length), ...body]

/** An element whose size is the reserved "unknown" value, in eight bytes as ffmpeg writes it. */
const openElement = (elementId: number, ...body: number[]): number[] =>
  [...id(elementId), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...body]

/** An unsigned integer element: the value in as few bytes as it needs. */
function uint(elementId: number, value: number): number[] {
  const bytes: number[] = []
  let rest = value
  do {
    bytes.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  } while (rest > 0)
  return element(elementId, ...bytes)
}

function float(elementId: number, value: number, width: 4 | 8 = 8): number[] {
  const out = new Uint8Array(width)
  const view = new DataView(out.buffer)
  if (width === 4) view.setFloat32(0, value)
  else view.setFloat64(0, value)
  return element(elementId, ...out)
}

const text = (elementId: number, value: string): number[] =>
  element(elementId, ...[...value].map((c) => c.charCodeAt(0)))

interface TrackSpec {
  trackNumber?: number | null
  /** 1 video, 2 audio, anything else a kind the capture path does not take. */
  trackType?: number | null
  codecId?: string | null
  codecPrivate?: number[]
  width?: number
  height?: number
  /** Audio element with these fields; absent means no Audio element at all. */
  audio?: { channels?: number; samplingFrequency?: number; frequencyWidth?: 4 | 8 } | null
}

function trackEntry(spec: TrackSpec): number[] {
  const body: number[] = []

  if (spec.trackNumber !== null) body.push(...uint(ID.trackNumber, spec.trackNumber ?? 1))
  if (spec.trackType !== null) body.push(...uint(ID.trackType, spec.trackType ?? 1))
  if (spec.codecId !== null) body.push(...text(ID.codecId, spec.codecId ?? 'V_VP9'))
  if (spec.codecPrivate) body.push(...element(ID.codecPrivate, ...spec.codecPrivate))

  if (spec.width !== undefined || spec.height !== undefined) {
    body.push(...element(
      ID.video,
      ...uint(ID.pixelWidth, spec.width ?? 0),
      ...uint(ID.pixelHeight, spec.height ?? 0),
    ))
  }

  if (spec.audio) {
    const audioBody: number[] = []
    if (spec.audio.channels !== undefined) audioBody.push(...uint(ID.channels, spec.audio.channels))
    if (spec.audio.samplingFrequency !== undefined) {
      audioBody.push(...float(ID.samplingFrequency, spec.audio.samplingFrequency, spec.audio.frequencyWidth ?? 8))
    }
    body.push(...element(ID.audio, ...audioBody))
  }

  return element(ID.trackEntry, ...body)
}

interface InitSpec {
  /** Nanoseconds per tick; null leaves the Info element out altogether. */
  timestampScale?: number | null
  tracks?: TrackSpec[]
  /** No Tracks element: an init segment that opens nothing. */
  omitTracks?: boolean
  /** Elements at the top level, with no Segment around them. */
  omitSegment?: boolean
}

function initOf(spec: InitSpec = {}): Uint8Array {
  const level: number[] = []

  if (spec.timestampScale !== null) {
    level.push(...element(ID.info, ...uint(ID.timestampScale, spec.timestampScale ?? 1_000_000)))
  }

  if (!spec.omitTracks) {
    const entries = (spec.tracks ?? [{}]).flatMap(trackEntry)
    level.push(...element(ID.tracks, ...entries))
  }

  const header = element(ID.ebml, ...text(ID.docType, 'webm'))
  const body = spec.omitSegment ? level : openElement(ID.segment, ...level)
  return Uint8Array.from([...header, ...body])
}

describe('parseInit on synthetic init segments', () => {
  it('turns the TimestampScale into ticks per second', () => {
    // The scale is nanoseconds per tick, so the number to divide by is a second's worth of them.
    expect(parseInit(initOf({ timestampScale: 1_000_000 }))!.tracks[0]!.timescale).toBe(1000)
    expect(parseInit(initOf({ timestampScale: 500_000 }))!.tracks[0]!.timescale).toBe(2000)
    expect(parseInit(initOf({ timestampScale: 1 }))!.tracks[0]!.timescale).toBe(1_000_000_000)
  })

  it('falls back to one millisecond when the segment names no scale', () => {
    expect(parseInit(initOf({ timestampScale: null }))!.tracks[0]!.timescale).toBe(1000)
  })

  it('refuses a segment whose TimestampScale is zero', () => {
    // Dividing by it gives infinity and substituting for it invents times: neither is a reading.
    expect(parseInit(initOf({ timestampScale: 0 }))).toBeNull()
    // control: the same builder with a scale gives a whole track
    expect(parseInit(initOf({ timestampScale: 1_000_000 }))!.tracks).toHaveLength(1)
  })

  it('reads Tracks lying at the top level, with no Segment around them', () => {
    const info = parseInit(initOf({ omitSegment: true }))!
    expect(info.tracks).toHaveLength(1)
    expect(info.tracks[0]!.timescale).toBe(1000)
  })

  it('returns null when there is no Tracks element', () => {
    expect(parseInit(initOf({ omitTracks: true }))).toBeNull()
  })

  it('lists every track of a Tracks that holds several', () => {
    const info = parseInit(initOf({
      tracks: [
        { trackNumber: 1, trackType: 1, codecId: 'V_VP9', width: 640, height: 360 },
        { trackNumber: 2, trackType: 2, codecId: 'A_OPUS', audio: { channels: 6, samplingFrequency: 48000 } },
      ],
    }))!

    expect(info.tracks).toHaveLength(2)
    // the second track carries its own fields, not the first one's
    expect(info.tracks[0]).toEqual({
      trackId: 1, kind: 'video', timescale: 1000, codec: 'V_VP9', width: 640, height: 360,
    })
    expect(info.tracks[1]).toEqual({
      trackId: 2, kind: 'audio', timescale: 1000, codec: 'A_OPUS', width: 0, height: 0,
      channels: 6, sampleRate: 48000,
    })
  })

  it('takes the Matroska defaults for an audio track that declares no Audio element', () => {
    const track = parseInit(initOf({
      tracks: [{ trackNumber: 1, trackType: 2, codecId: 'A_VORBIS' }],
    }))!.tracks[0]!
    expect(track.channels).toBe(1)
    expect(track.sampleRate).toBe(8000)
  })

  it('takes the Matroska defaults for the fields an Audio element leaves out', () => {
    const track = parseInit(initOf({
      tracks: [{ trackNumber: 1, trackType: 2, codecId: 'A_OPUS', audio: {} }],
    }))!.tracks[0]!
    expect(track.channels).toBe(1)
    expect(track.sampleRate).toBe(8000)
  })

  it('reads a SamplingFrequency written as a four-byte float', () => {
    const track = parseInit(initOf({
      tracks: [{
        trackNumber: 1, trackType: 2, codecId: 'A_OPUS',
        audio: { channels: 2, samplingFrequency: 44100, frequencyWidth: 4 },
      }],
    }))!.tracks[0]!
    expect(track.sampleRate).toBe(44100)
  })

  it('rounds a fractional SamplingFrequency and refuses a nonsensical one', () => {
    const rateOf = (samplingFrequency: number): number => parseInit(initOf({
      tracks: [{ trackNumber: 1, trackType: 2, codecId: 'A_OPUS', audio: { samplingFrequency } }],
    }))!.tracks[0]!.sampleRate!

    expect(rateOf(44099.6)).toBe(44100)
    // zero and below are not a rate; the default stands in, so nothing downstream divides by them
    expect(rateOf(0)).toBe(8000)
    expect(rateOf(-48000)).toBe(8000)
  })

  it('gives a track with no Video element a size of zero', () => {
    const track = parseInit(initOf({
      tracks: [{ trackNumber: 1, trackType: 1, codecId: 'V_AV1' }],
    }))!.tracks[0]!
    expect(track.width).toBe(0)
    expect(track.height).toBe(0)
  })

  it('carries the CodecPrivate out as it lies in the container', () => {
    const bytes = [...OPUS_HEAD]
    const track = parseInit(initOf({
      tracks: [{ trackNumber: 1, trackType: 2, codecId: 'A_OPUS', codecPrivate: bytes }],
    }))!.tracks[0]!
    expect(track.codecPrivate).toEqual(OPUS_HEAD)
  })

  it('leaves out an empty CodecPrivate rather than carrying zero bytes', () => {
    const track = parseInit(initOf({
      tracks: [{ trackNumber: 1, trackType: 2, codecId: 'A_OPUS', codecPrivate: [] }],
    }))!.tracks[0]!
    expect(track.codecPrivate).toBeUndefined()
  })

  // The bytes come from a foreign page: a required element may simply not be there, and that has
  // to end in a track dropped rather than in a throw.
  describe.each([
    ['no TrackNumber', { trackNumber: null }],
    ['no TrackType', { trackType: null }],
    ['no CodecID', { codecId: null }],
    ['an empty CodecID', { codecId: '' }],
    ['TrackNumber zero, which no block can address', { trackNumber: 0 }],
    ['a TrackType the capture path does not take', { trackType: 17 }],
  ] as [string, TrackSpec][])('a track with %s', (_name, broken) => {
    it('is dropped without disturbing a whole track beside it', () => {
      const whole: TrackSpec = { trackNumber: 3, trackType: 2, codecId: 'A_OPUS' }
      const info = parseInit(initOf({ tracks: [{ ...whole, ...broken }, whole] }))!
      expect(info.tracks).toHaveLength(1)
      expect(info.tracks[0]!.trackId).toBe(3)
    })

    it('gives null when there is no other track', () => {
      expect(parseInit(initOf({ tracks: [{ trackNumber: 3, trackType: 2, codecId: 'A_OPUS', ...broken }] }))).toBeNull()
    })
  })

  it('returns null for a Tracks element with nothing in it', () => {
    expect(parseInit(initOf({ tracks: [] }))).toBeNull()
  })
})
