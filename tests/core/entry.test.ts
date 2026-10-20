import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  audioSampleEntry,
  sampleEntryBytes,
  sampleEntryOf,
  trackIdOf,
  videoSampleEntry,
} from '../../src/core/iso/entry'
import { ingestInit } from '../../src/core/container'
import { audioDecoderConfig } from '../../src/core/codec/audio'
import { findBox, boxBody } from '../../src/core/iso/reader'
import { boxOf, fullBoxOf, u32, u64, zeroes } from '../../src/core/iso/writer'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

const h264Video = read('tests/fixtures/h264/init-stream0.m4s')
const h264Audio = read('tests/fixtures/h264/init-stream1.m4s')
const vp9 = read('tests/fixtures/vp9/init-stream0.m4s')
const av1 = read('tests/fixtures/av1/init-stream0.m4s')
const mediaSegment = read('tests/fixtures/h264/chunk-stream0-00001.m4s')

/** The same bytes inside a wider buffer: a view at a non-zero offset, not the buffer's owner. */
function viewWithOffset(bytes: Uint8Array): Uint8Array {
  const offset = 9
  const backing = new Uint8Array(offset + bytes.byteLength + 7).fill(0xaa)
  backing.set(bytes, offset)
  return backing.subarray(offset, offset + bytes.byteLength)
}

describe('videoSampleEntry', () => {
  it('reads the picture entry of the h264 fixture', () => {
    const entry = videoSampleEntry(h264Video)!
    expect(entry).not.toBeNull()
    expect(entry.format).toBe('avc1')
    expect(entry.trackId).toBe(1)
    // The coded size out of the entry itself, not out of the tkhd: the two differ whenever a
    // track is displayed at something other than the size it was coded at.
    expect(entry.codedWidth).toBe(320)
    expect(entry.codedHeight).toBe(240)
    expect(entry.channels).toBe(0)
    expect(entry.sampleRate).toBe(0)
    expect([...entry.children.keys()]).toEqual(['avcC', 'pasp', 'btrt'])
    // Bodies, without the eight bytes of box header: that is what a decoder configuration wants.
    expect(entry.children.get('avcC')!.byteLength).toBe(40)
    expect(entry.bytes.byteLength).toBe(170)
  })

  it('reads vp09 and av01 without being shaped around avc1', () => {
    const nine = videoSampleEntry(vp9)!
    expect(nine.format).toBe('vp09')
    expect([nine.codedWidth, nine.codedHeight]).toEqual([320, 240])
    expect([...nine.children.keys()]).toEqual(['vpcC', 'fiel', 'pasp', 'btrt'])
    expect(nine.children.get('vpcC')!.byteLength).toBe(12)

    const one = videoSampleEntry(av1)!
    expect(one.format).toBe('av01')
    expect([one.codedWidth, one.codedHeight]).toEqual([256, 144])
    expect(one.children.get('av1C')!.byteLength).toBe(17)
  })

  it('reads the entries the WebM converter writes', () => {
    const picture = ingestInit(
      read('tests/fixtures/webm/init-stream0.webm'),
      'video/webm; codecs="vp9"',
    )!
    const entry = videoSampleEntry(picture.initBytes)!
    expect(entry.format).toBe('vp09')
    expect([entry.codedWidth, entry.codedHeight]).toEqual([256, 144])
    expect([...entry.children.keys()]).toEqual(['vpcC'])
  })

  it('answers null for an init with no picture in it', () => {
    expect(videoSampleEntry(h264Audio)).toBeNull()
  })

  it('takes the entry out of a view with an offset of its own', () => {
    const straight = videoSampleEntry(h264Video)!
    const shifted = videoSampleEntry(viewWithOffset(h264Video))!
    expect(shifted.format).toBe(straight.format)
    expect([...shifted.bytes]).toEqual([...straight.bytes])
    expect([...shifted.children.get('avcC')!]).toEqual([...straight.children.get('avcC')!])
  })
})

describe('audioSampleEntry', () => {
  it('reads the sound entry of the h264 fixture', () => {
    const entry = audioSampleEntry(h264Audio)!
    expect(entry.format).toBe('mp4a')
    expect(entry.trackId).toBe(1)
    expect(entry.channels).toBe(2)
    expect(entry.sampleRate).toBe(44100)
    expect(entry.codedWidth).toBe(0)
    expect(entry.codedHeight).toBe(0)
    expect([...entry.children.keys()]).toEqual(['esds', 'btrt'])
    expect(entry.children.get('esds')!.byteLength).toBe(46)
    expect(entry.bytes.byteLength).toBe(110)
  })

  it('reads the Opus entry the WebM converter writes', () => {
    const sound = ingestInit(
      read('tests/fixtures/webm/init-stream1.webm'),
      'audio/webm; codecs="opus"',
    )!
    const entry = audioSampleEntry(sound.initBytes)!
    expect(entry.format).toBe('Opus')
    expect(entry.channels).toBe(2)
    expect(entry.sampleRate).toBe(48000)
    // The dOps is the OpusHead minus its magic, and it is what AudioDecoder wants as description.
    expect([...entry.children.keys()]).toEqual(['dOps'])
    expect(entry.children.get('dOps')!.byteLength).toBe(11)
  })

  it('answers null for an init with no sound in it', () => {
    expect(audioSampleEntry(h264Video)).toBeNull()
  })

  it('reads past the extra fields of a QuickTime sound entry of version 1 and 2', () => {
    // QuickTime numbers its sound entries in the two bytes ISO BMFF calls reserved, and versions
    // one and two put 16 and 36 bytes of their own behind the 28 every entry has. Read at the
    // fixed offset, the walk for child boxes starts inside those fields: no esds is found, the
    // AAC track has no decoder configuration, and the export takes it for a sound to convert.
    const ordinary = audioSampleEntry(h264Audio)!
    const esds = ordinary.children.get('esds')!

    const v1 = audioSampleEntry(quickTimeSound(ordinary.bytes, 1))!
    expect([v1.format, v1.channels, v1.sampleRate]).toEqual(['mp4a', 2, 44100])
    expect([...v1.children.keys()]).toEqual(['esds', 'btrt'])
    expect(v1.children.get('esds')).toEqual(esds)
    expect(audioDecoderConfig(v1)).toEqual(audioDecoderConfig(ordinary))

    // Version 2 keeps placeholders in the fields of version 0 — three channels, 65536 Hz — and
    // states the real numbers in its own: the rate as a float64, the channels as 32 bits.
    const v2 = audioSampleEntry(quickTimeSound(ordinary.bytes, 2))!
    expect([v2.format, v2.channels, v2.sampleRate]).toEqual(['mp4a', 2, 44100])
    expect(v2.children.get('esds')).toEqual(esds)
    expect(audioDecoderConfig(v2)).toEqual(audioDecoderConfig(ordinary))

    // ISO's own AudioSampleEntryV1 states entry_version 1 in the very same two bytes and adds no
    // field at all; it is told apart by the version of the stsd that holds it, which is 1.
    const isoV1 = quickTimeSound(ordinary.bytes, 1, 'iso')
    const read = audioSampleEntry(isoV1)!
    expect([read.channels, read.sampleRate, [...read.children.keys()]]).toEqual([2, 44100, ['esds', 'btrt']])
  })
})

/**
 * A one-track init holding the sound entry of `entry` rewritten as QuickTime writes it — or, for
 * `iso`, as ISO's AudioSampleEntryV1, which states the version and adds nothing behind it.
 *
 * The 28 bytes of the ordinary entry stay where they are with the version stated in them, and the
 * fields of that version follow before the child boxes: four counts of 32 bits in version 1, and
 * in version 2 a size, the rate as a float64, the channel count and five words of layout.
 */
function quickTimeSound(entry: Uint8Array, version: 1 | 2, layout: 'quicktime' | 'iso' = 'quicktime'): Uint8Array {
  const fields = entry.slice(8, 36)
  const view = new DataView(fields.buffer)
  const channels = view.getUint16(16)
  const rate = view.getUint32(24) >>> 16
  view.setUint16(8, version)

  let extra: Uint8Array
  if (layout === 'iso') {
    extra = new Uint8Array(0)
  } else if (version === 1) {
    extra = u32(1024, 0, 2 * channels, 2)
  } else {
    // The version-0 fields of a version-2 entry are fixed placeholders.
    view.setUint16(16, 3)
    view.setUint16(18, 16)
    view.setUint16(20, 0xfffe)
    view.setUint32(24, 0x00010000)
    extra = new Uint8Array(36)
    const tail = new DataView(extra.buffer)
    tail.setUint32(0, 72)
    tail.setFloat64(4, rate)
    tail.setUint32(12, channels)
    tail.setUint32(16, 0x7f000000)
  }

  const rebuilt = boxOf('mp4a', fields, extra, entry.subarray(36))
  const tkhd = fullBoxOf('tkhd', 0, 3, u32(0, 0, 1, 0, 0), zeroes(60))
  const hdlr = fullBoxOf('hdlr', 0, 0, u32(0), new TextEncoder().encode('soun'), zeroes(13))
  const stsd = fullBoxOf('stsd', layout === 'iso' ? 1 : 0, 0, u32(1), rebuilt)
  return boxOf(
    'moov',
    boxOf('trak', tkhd, boxOf('mdia', hdlr, boxOf('minf', boxOf('stbl', stsd)))),
  )
}

describe('sampleEntryBytes', () => {
  it('hands back the entry exactly as the stsd holds it', () => {
    const stsd = findBox(h264Video, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!
    const body = boxBody(h264Video, stsd)
    const expected = body.subarray(8, 8 + 170)

    const bytes = sampleEntryBytes(h264Video, 1)!
    expect([...bytes]).toEqual([...expected])
    // Size and type in front, because a writer drops these bytes straight into its own stsd.
    expect(String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!)).toBe('avc1')
  })

  it('answers null for a track the init does not declare', () => {
    expect(sampleEntryBytes(h264Video, 7)).toBeNull()
    expect(sampleEntryOf(h264Video, 7)).toBeNull()
  })
})

describe('trackIdOf', () => {
  /**
   * A stamp with a different number in each half, so that a read taken at the wrong offset comes
   * back with a plausible track_ID rather than with the zero every reserved field would give.
   */
  const CREATED = 7 * 2 ** 32 + 42

  /** The box under test, in the only place a reader ever finds one. */
  function movieWith(tkhd: Uint8Array): Uint8Array {
    return boxOf('moov', boxOf('trak', tkhd))
  }

  const idOf = (movie: Uint8Array): number =>
    trackIdOf(movie, findBox(movie, ['moov', 'trak', 'tkhd'])!)

  it('reads the track_ID out of either version of the box', () => {
    // Every fixture here carries a version-0 tkhd — that is what ffmpeg writes — and the two
    // versions hold the field eight bytes apart: version 1 states creation_time and
    // modification_time in 64 bits each. Read at the version-0 offset, a version-1 box hands
    // back the top half of modification_time, which is a number and not an error.
    const zero = movieWith(fullBoxOf('tkhd', 0, 3, u32(42, 42, 2, 0, 0), zeroes(60)))
    const one = movieWith(
      fullBoxOf('tkhd', 1, 3, u64(CREATED), u64(CREATED), u32(2, 0), u64(0), zeroes(60)),
    )

    expect(idOf(zero)).toBe(2)
    expect(idOf(one)).toBe(2)
  })
})

describe('sample entries of bytes that are not an init', () => {
  it('answer null instead of throwing', () => {
    expect(videoSampleEntry(mediaSegment)).toBeNull()
    expect(audioSampleEntry(mediaSegment)).toBeNull()
    expect(videoSampleEntry(new Uint8Array(0))).toBeNull()
    expect(videoSampleEntry(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull()
    expect(sampleEntryBytes(new Uint8Array(0), 1)).toBeNull()
  })
})
