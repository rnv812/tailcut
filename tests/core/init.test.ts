import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseInit } from '../../src/core/iso/init'

const h264 = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const vp9 = new Uint8Array(readFileSync('tests/fixtures/vp9/init-stream0.m4s'))
const media = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))

describe('parseInit', () => {
  it('reads an H.264 video track', () => {
    // Assert the complete parse: both track composition and each exact field value. A generic
    // "greater than zero" check could also pass when reading the wrong tkhd or mdhd field.
    expect(parseInit(h264)).toEqual({
      tracks: [{
        trackId: 1, kind: 'video', timescale: 12288, codec: 'avc1',
        width: 320, height: 240, defaultSampleDuration: 0,
      }],
    })
  })

  it('reads a VP9 video track without assuming one codec', () => {
    const video = parseInit(vp9)!.tracks.find((t) => t.kind === 'video')!
    expect(video.codec).toBe('vp09')
    expect(video.timescale).toBe(12288)
    expect(video.trackId).toBe(1)
  })

  it('reads an audio track', () => {
    const audioInit = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream1.m4s'))
    const audio = parseInit(audioInit)!.tracks.find((t) => t.kind === 'audio')!
    expect(audio.codec).toBe('mp4a')
    expect(audio.timescale).toBe(44100)
    expect(audio.trackId).toBe(1)
  })

  it('returns null when moov is absent', () => {
    expect(parseInit(media)).toBeNull()
  })
})

// --- Synthetic init segments for cases absent from the fixtures ---

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))
const u8 = (n: number): Uint8Array => Uint8Array.of(n)
const zeros = (n: number): Uint8Array => new Uint8Array(n)

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

/** A 16.16 fixed-point number, as tkhd stores width and height. */
function fixed1616(value: number): Uint8Array {
  return u32(Math.round(value * 65536))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts)
  return concat(u32(8 + body.byteLength), ascii(type), body)
}

interface TrackSpec {
  /** tkhd and mdhd version; v1 uses eight-byte times and shifts later fields forward. */
  version?: 0 | 1
  trackId: number
  /** handler_type from hdlr: 'vide', 'soun', or any other value such as 'text'. */
  handler: string
  timescale: number
  width?: number
  height?: number
  /** null omits stsd entirely, leaving the track codec unknown. */
  codec?: string | null
  /** A complete stsd override for malformed and truncated boxes. */
  stsd?: Uint8Array
  /** An extra mdhd after the first, producing two same-name boxes in one container. */
  extraTimescale?: number
  /** A required box to omit, modeling an incomplete moov received from a site. */
  omit?: 'tkhd' | 'mdia' | 'mdhd' | 'hdlr' | 'minf' | 'stbl'
}

function tkhd(spec: TrackSpec): Uint8Array {
  const version = spec.version ?? 0
  const time = version === 1 ? zeros(8) : zeros(4)
  const duration = version === 1 ? zeros(8) : zeros(4)
  return box(
    'tkhd',
    u8(version), zeros(3),
    time, time, // creation_time, modification_time
    u32(spec.trackId), zeros(4), // track_ID, reserved
    duration,
    zeros(8), // reserved
    zeros(8), // layer, alternate_group, volume, reserved
    zeros(36), // matrix
    fixed1616(spec.width ?? 0), fixed1616(spec.height ?? 0),
  )
}

function mdhd(spec: TrackSpec): Uint8Array {
  const version = spec.version ?? 0
  const time = version === 1 ? zeros(8) : zeros(4)
  const duration = version === 1 ? zeros(8) : zeros(4)
  return box(
    'mdhd',
    u8(version), zeros(3),
    time, time,
    u32(spec.timescale),
    duration,
    zeros(2), zeros(2), // language, pre_defined
  )
}

function trak(spec: TrackSpec): Uint8Array {
  const codec = spec.codec === undefined ? 'avc1' : spec.codec
  const stsd = spec.stsd ?? (codec === null ? null : box('stsd', zeros(4), u32(1), box(codec, zeros(8))))
  const stbl = stsd === null ? box('stbl') : box('stbl', stsd)
  const minf = box('minf', ...(spec.omit === 'stbl' ? [] : [stbl]))
  const mdia = box(
    'mdia',
    ...(spec.omit === 'mdhd' ? [] : [mdhd(spec)]),
    ...(spec.extraTimescale === undefined ? [] : [mdhd({ ...spec, timescale: spec.extraTimescale })]),
    ...(spec.omit === 'hdlr' ? [] : [box('hdlr', zeros(4), zeros(4), ascii(spec.handler), zeros(4))]),
    ...(spec.omit === 'minf' ? [] : [minf]),
  )
  return box(
    'trak',
    ...(spec.omit === 'tkhd' ? [] : [tkhd(spec)]),
    ...(spec.omit === 'mdia' ? [] : [mdia]),
  )
}

/** A moov shaped like an init segment: mvhd followed by tracks. */
function moov(...traks: Uint8Array[]): Uint8Array {
  return box('moov', box('mvhd', zeros(100)), ...traks)
}

/** trex: version and flags, track_ID, sample_description_index, then the four defaults. */
function trex(trackId: number, sampleDuration: number): Uint8Array {
  return box(
    'trex',
    zeros(4), u32(trackId), u32(1), u32(sampleDuration), u32(0), u32(0),
  )
}

/** The same moov with an mvex in it: this is where a movie states its sample defaults. */
function moovWithMvex(trexes: Uint8Array[], ...traks: Uint8Array[]): Uint8Array {
  return box('moov', box('mvhd', zeros(100)), box('mvex', ...trexes), ...traks)
}

describe('parseInit on synthetic init segments', () => {
  it('reports the sample duration the movie states for a track in its trex', () => {
    // dzen.ru delivers its picture this way: the trun of every fragment past the first states no
    // durations at all and the tfhd states no default, so this one field of the init segment is
    // the whole of what says how long a sample lasts. Read as zero, 92 seconds of picture came
    // out of the registry as 6.
    const init = moovWithMvex(
      [trex(1, 3600)],
      trak({ trackId: 1, handler: 'vide', timescale: 90000, width: 852, height: 480 }),
    )

    expect(parseInit(init)!.tracks[0]!.defaultSampleDuration).toBe(3600)
  })

  it('reports each track its own default and not the first trex it meets', () => {
    const init = moovWithMvex(
      [trex(1, 3600), trex(2, 1023)],
      trak({ trackId: 1, handler: 'vide', timescale: 90000, width: 852, height: 480 }),
      trak({ trackId: 2, handler: 'soun', timescale: 48000, codec: 'mp4a' }),
    )

    const parsed = parseInit(init)!
    expect(parsed.tracks.find((t) => t.trackId === 1)!.defaultSampleDuration).toBe(3600)
    expect(parsed.tracks.find((t) => t.trackId === 2)!.defaultSampleDuration).toBe(1023)
  })

  it('reports no default at all for a movie without an mvex', () => {
    const init = moov(trak({ trackId: 1, handler: 'vide', timescale: 12288, width: 320, height: 240 }))

    expect(parseInit(init)!.tracks[0]!.defaultSampleDuration).toBe(0)
  })

  it('rounds fractional 16.16 dimensions to whole pixels', () => {
    // An anamorphic frame: 853.33 in 16.16 is fractional, and .75 must round upward.
    const init = moov(trak({ trackId: 7, handler: 'vide', timescale: 12800, width: 853.33, height: 479.75 }))
    const video = parseInit(init)!.tracks.find((t) => t.kind === 'video')!
    expect(video.width).toBe(853)
    expect(video.height).toBe(480)
    expect(video.trackId).toBe(7)
  })

  it('divides 16.16 by exactly 65536 on both sides of a half-pixel', () => {
    // 640 + 32767/65536 lies just below half a pixel, while 360 + 32769/65536 lies just above.
    // Dividing by 65535 would push width across the rounding boundary to 641, while 65537 would
    // pull height back to 360.
    const init = moov(trak({
      trackId: 5, handler: 'vide', timescale: 12800,
      width: 640 + 32767 / 65536, height: 360 + 32769 / 65536,
    }))
    const video = parseInit(init)!.tracks.find((t) => t.kind === 'video')!
    expect(video.width).toBe(640)
    expect(video.height).toBe(361)
  })

  it('uses the first mdhd when mdia contains two', () => {
    // Two mdhd boxes in one container violate the format, but bytes come from third-party sites.
    // Selection must be deterministic instead of allowing the last box to win accidentally.
    const init = moov(trak({
      trackId: 1, handler: 'vide', timescale: 12288, extraTimescale: 90000, width: 320, height: 240,
    }))
    expect(parseInit(init)).toEqual({
      tracks: [{
        trackId: 1, kind: 'video', timescale: 12288, codec: 'avc1',
        width: 320, height: 240, defaultSampleDuration: 0,
      }],
    })
  })

  it('reads track_ID and timescale at version 1 offsets', () => {
    const init = moov(trak({
      version: 1, trackId: 42, handler: 'vide', timescale: 90000, width: 640, height: 360,
    }))
    const video = parseInit(init)!.tracks.find((t) => t.kind === 'video')!
    expect(video.trackId).toBe(42)
    expect(video.timescale).toBe(90000)
    expect(video.width).toBe(640)
    expect(video.height).toBe(360)
  })

  it('lists every track in a muxed moov rather than only the first', () => {
    // Video and audio in one moov model a non-DASH init segment.
    const init = parseInit(moov(
      trak({ trackId: 1, handler: 'vide', timescale: 12288, width: 320, height: 240 }),
      trak({ trackId: 2, handler: 'soun', timescale: 44100, codec: 'mp4a' }),
    ))!
    expect(init.tracks).toHaveLength(2)

    const video = init.tracks.find((t) => t.kind === 'video')!
    const audio = init.tracks.find((t) => t.kind === 'audio')!
    // The second track has its own fields rather than copies of the first track's values.
    expect(video.trackId).toBe(1)
    expect(video.timescale).toBe(12288)
    expect(video.codec).toBe('avc1')
    expect(audio.trackId).toBe(2)
    expect(audio.timescale).toBe(44100)
    expect(audio.codec).toBe('mp4a')
  })

  it('drops a track with a truncated stsd instead of producing a codec from zero bytes', () => {
    // The stsd body is exactly eight bytes: version+flags and entry_count, with no sample entry.
    const truncated = trak({
      trackId: 1, handler: 'vide', timescale: 1000, stsd: box('stsd', zeros(4), u32(1)),
    })
    expect(parseInit(moov(truncated))).toBeNull()

    // Control: the same constructor reads a real codec from a complete stsd.
    const whole = trak({ trackId: 1, handler: 'vide', timescale: 1000, codec: 'avc1' })
    expect(parseInit(moov(whole))!.tracks[0]!.codec).toBe('avc1')
  })

  // The sample entry type occupies bytes 12..15 of the stsd body. If the body ends inside that
  // range, missing bytes read as undefined. String.fromCharCode(undefined) returns a non-empty
  // "\0", so without a length check the track would proceed with garbage in place of a codec.
  it.each([12, 13, 14, 15])('drops a track when a %i-byte stsd body truncates the sample entry type', (bodyBytes) => {
    // The sample entry header is cut to bodyBytes - 8 bytes: complete size, partial type.
    const stsd = box('stsd', zeros(4), u32(1), u32(8), ascii('avc1'.slice(0, bodyBytes - 12)))
    expect(stsd.byteLength - 8).toBe(bodyBytes) // Pin the exact body length under test.

    const broken = trak({ trackId: 1, handler: 'vide', timescale: 1000, stsd })
    expect(parseInit(moov(broken))).toBeNull()
  })

  it('accepts an exact 16-byte stsd body with a complete sample entry type', () => {
    // This is the valid minimum: version+flags(4), entry_count(4), and one eight-byte sample entry
    // header. Bytes 12..15 are the last body bytes, but all are present.
    const stsd = box('stsd', zeros(4), u32(1), box('avc1'))
    expect(stsd.byteLength - 8).toBe(16)

    const minimal = trak({ trackId: 3, handler: 'vide', timescale: 1000, width: 320, height: 240, stsd })
    expect(parseInit(moov(minimal))).toEqual({
      tracks: [{
        trackId: 3, kind: 'video', timescale: 1000, codec: 'avc1',
        width: 320, height: 240, defaultSampleDuration: 0,
      }],
    })
  })

  it('returns null when moov contains no usable tracks', () => {
    // Control: the same constructor returns a non-empty parse for a complete track.
    const good = trak({ trackId: 1, handler: 'vide', timescale: 1000, width: 320, height: 240 })
    expect(parseInit(moov(good))!.tracks).toHaveLength(1)

    // A moov with no trak at all.
    expect(parseInit(moov())).toBeNull()
    // A trak without stsd has an unknown codec and is dropped, leaving an empty list.
    const noCodec = trak({ trackId: 1, handler: 'vide', timescale: 1000, codec: null })
    expect(parseInit(moov(noCodec))).toBeNull()
    // A track with an unrelated handler is neither video nor audio and does not count.
    const noKind = trak({ trackId: 1, handler: 'text', timescale: 1000 })
    expect(parseInit(moov(noKind))).toBeNull()
  })

  // parseInit receives arbitrary bytes from third-party sites. A required box may be absent, which
  // must drop the track rather than throw while parsing undefined.
  describe.each(['tkhd', 'mdia', 'mdhd', 'hdlr', 'minf', 'stbl'] as const)('track without %s', (omit) => {
    const broken = trak({ trackId: 2, handler: 'vide', timescale: 90000, width: 640, height: 360, omit })

    it('is dropped without preventing a complete neighboring track from parsing', () => {
      const whole = trak({ trackId: 1, handler: 'vide', timescale: 12288, width: 320, height: 240 })
      expect(parseInit(moov(whole, broken))).toEqual({
        tracks: [{
          trackId: 1, kind: 'video', timescale: 12288, codec: 'avc1',
          width: 320, height: 240, defaultSampleDuration: 0,
        }],
      })
    })

    it('returns null when moov contains no other tracks', () => {
      expect(parseInit(moov(broken))).toBeNull()
    })
  })
})
