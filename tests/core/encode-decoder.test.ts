import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { decoderConfigOf, sampleEntryFormat } from '../../src/core/encode/decoder'
import { videoSampleEntry, type SampleEntry } from '../../src/core/iso/entry'
import { boxOf, u32, u8, zeroes } from '../../src/core/iso/writer'
import { parseInit as parseWebmInit } from '../../src/core/webm/init'
import { webmToIso } from '../../src/core/webm/to-iso'

/**
 * What a decoder is told about the material this program recorded, out of the material itself.
 *
 * Every case but one is a fixture of this repository, and that is the whole point of the file:
 * the question is not whether a codec string can be spelled, it is whether **our own** recordings
 * are recognised. HEVC is the exception and it is built by hand — there is no machine here that
 * can make such a fixture — so its record is written out field by field from the specification.
 */

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

const entryIn = (init: Uint8Array): SampleEntry => videoSampleEntry(init)!

const isoEntry = (path: string): SampleEntry => entryIn(read(path))

/** The type a page opened its SourceBuffer with; a VP track is converted by way of it. */
const webmEntry = (path: string, mime: string): SampleEntry =>
  entryIn(webmToIso(parseWebmInit(read(path))!, mime)!.initBytes)

const H264 = 'tests/fixtures/h264/init-stream0.m4s'
const MINUTE = 'tests/fixtures/minute/init-stream0.m4s'
const MUXED = 'tests/fixtures/muxed/init-stream0.m4s'
const VP9 = 'tests/fixtures/vp9/init-stream0.m4s'
const AV1 = 'tests/fixtures/av1/init-stream0.m4s'
const WEBM_VP9 = 'tests/fixtures/webm/init-stream0.webm'
const WEBM_VP8 = 'tests/fixtures/webm-vp8/init-stream0.webm'

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * A VisualSampleEntry with whatever is given inside it.
 *
 * Seventy-eight bytes of fields — the eighty-six the format counts, less the box header — and
 * then the children. The one field that is read out of them is the frame size, twenty-four bytes
 * in: 0x0140 by 0x00f0, which is 320 by 240. Used for the two cases no fixture of this repository
 * holds: an HEVC track, and an entry describing itself with nothing anybody here can read.
 */
const visualEntry = (format: string, ...children: Uint8Array[]): Uint8Array =>
  boxOf(format, zeroes(24), u32(0x0140_00f0), zeroes(50), ...children)

describe('decoderConfigOf: H.264', () => {
  it('spells the profile, the compatibility and the level out of the avcC, and hands the record on', () => {
    const cases = [
      { name: 'h264', init: H264, codec: 'avc1.4d400d', width: 320, height: 240 },
      { name: 'minute', init: MINUTE, codec: 'avc1.4d400b', width: 256, height: 144 },
      { name: 'muxed', init: MUXED, codec: 'avc1.4d400b', width: 256, height: 144 },
    ]

    for (const one of cases) {
      const entry = isoEntry(one.init)
      const avcC = entry.children.get('avcC')
      // The premise, stated rather than hoped for: this fixture really does carry a record. A
      // configuration built out of an absent one would be green here and worth nothing.
      expect(avcC, `${one.name} carries no avcC`).toBeDefined()
      expect(avcC!.byteLength, `${one.name} carries a record too short to read`).toBeGreaterThan(3)

      const config = decoderConfigOf(entry.bytes)
      expect(config, one.name).not.toBeNull()
      expect(config!.codec, one.name).toBe(one.codec)
      // The six digits are three bytes of the record and not a string from anywhere else.
      expect(hex(avcC!.subarray(1, 4)), one.name).toBe(one.codec.slice('avc1.'.length))
      // Byte for byte: what the decoder is handed is the record, not a copy of some of it.
      expect(config!.description, one.name).toEqual(avcC)
      expect(config!.codedWidth, one.name).toBe(one.width)
      expect(config!.codedHeight, one.name).toBe(one.height)
    }
  })
})

describe('decoderConfigOf: VP9 and VP8', () => {
  it('reads profile, level and depth off the vpcC of a VP9 track in an mp4, and describes it with nothing else', () => {
    const entry = isoEntry(VP9)
    const vpcC = entry.children.get('vpcC')
    expect(vpcC, 'the VP9 fixture carries no vpcC').toBeDefined()
    // Version and flags of the full box, then profile, level, and the byte the depth is packed
    // into: 0, 20 and 0x82 in this recording, which is profile 0, level 2.0, eight bits.
    expect(Array.from(vpcC!.subarray(4, 7))).toEqual([0x00, 0x14, 0x82])

    const config = decoderConfigOf(entry.bytes)
    expect(config).not.toBeNull()
    expect(config!.codec).toBe('vp09.00.20.08')
    expect(config!.codedWidth).toBe(320)
    expect(config!.codedHeight).toBe(240)
    // Not an empty description — no description at all. Chrome refuses a VP9 configuration that
    // carries one, so the field has to be absent rather than zero-length.
    expect('description' in config!).toBe(false)
  })

  it('reads the same record off a VP9 track that arrived in a WebM', () => {
    const entry = webmEntry(WEBM_VP9, 'video/webm; codecs="vp09.00.10.08"')
    const vpcC = entry.children.get('vpcC')
    expect(vpcC, 'the converted WebM carries no vpcC').toBeDefined()
    expect(Array.from(vpcC!.subarray(4, 7))).toEqual([0x00, 0x0a, 0x82])

    const config = decoderConfigOf(entry.bytes)
    expect(config).not.toBeNull()
    expect(config!.codec).toBe('vp09.00.10.08')
    expect(config!.codedWidth).toBe(256)
    expect(config!.codedHeight).toBe(144)
    expect('description' in config!).toBe(false)
  })

  it('calls a VP8 track by the one word WebCodecs has for it', () => {
    const entry = webmEntry(WEBM_VP8, 'video/webm; codecs="vp8"')
    // The premise: this entry is the older codec's, and it carries the same record VP9 does —
    // which is exactly why a reader that went by the record alone would call it VP9.
    expect(entry.format).toBe('vp08')
    expect(entry.children.get('vpcC'), 'the converted WebM carries no vpcC').toBeDefined()

    const config = decoderConfigOf(entry.bytes)
    expect(config).not.toBeNull()
    // No profile, no level, no depth, and no dots: `vp8` is the whole of the string.
    expect(config!.codec).toBe('vp8')
    expect(config!.codedWidth).toBe(256)
    expect(config!.codedHeight).toBe(144)
    expect('description' in config!).toBe(false)
  })
})

describe('decoderConfigOf: AV1', () => {
  it('spells profile, level, tier and depth out of the av1C', () => {
    const entry = isoEntry(AV1)
    const av1C = entry.children.get('av1C')
    expect(av1C, 'the AV1 fixture carries no av1C').toBeDefined()
    // Marker and version, then profile 0 with level index 0, then a byte whose top bit is the
    // tier and whose next two are the depth: 0x0c is main tier, eight bits, 4:2:0.
    expect(Array.from(av1C!.subarray(0, 3))).toEqual([0x81, 0x00, 0x0c])

    const config = decoderConfigOf(entry.bytes)
    expect(config).not.toBeNull()
    expect(config!.codec).toBe('av01.0.00M.08')
    expect(config!.description).toEqual(av1C)
    expect(config!.codedWidth).toBe(256)
    expect(config!.codedHeight).toBe(144)
  })
})

describe('decoderConfigOf: HEVC', () => {
  it('writes the four fields of an hvc1 string the way RFC 6381 spells them', () => {
    // Main profile, main tier, level 4.0, the one constraint byte every encoder writes: the
    // string a Chrome-encoded HEVC file is described by, and the one this program will write.
    const main = new Uint8Array([
      0x01, // configurationVersion
      0x01, // profile_space 0, tier L, profile_idc 1
      0x60, 0x00, 0x00, 0x00, // compatibility flags
      0xb0, 0x00, 0x00, 0x00, 0x00, 0x00, // constraint indicators
      120, // level_idc — 4.0
    ])

    const config = decoderConfigOf(visualEntry('hvc1', boxOf('hvcC', main)))
    expect(config).not.toBeNull()
    // 0x60000000 with its bits reversed is 6, not 60000000: the field is spelled least
    // significant bit first, and a string that states it either way round looks plausible.
    expect(config!.codec).toBe('hvc1.1.6.L120.b0')
    expect(config!.description).toEqual(main)
    expect(config!.codedWidth).toBe(320)
    expect(config!.codedHeight).toBe(240)

    // The other end of every field: a profile space that is a letter, the high tier, a
    // compatibility field whose reversal is not a short number, and constraint bytes whose last
    // one is not zero — so that nothing but the trailing zeroes is dropped.
    const exotic = new Uint8Array([
      0x01,
      0xa4, // profile_space 2 (B), tier H, profile_idc 4
      0x00, 0x00, 0x00, 0x01,
      0xb0, 0x00, 0x00, 0x00, 0x00, 0x01,
      186, // 6.2
    ])

    const second = decoderConfigOf(visualEntry('hvc1', boxOf('hvcC', exotic)))
    expect(second!.codec).toBe('hvc1.B4.80000000.H186.b0.00.00.00.00.01')
  })
})

describe('decoderConfigOf: material nobody here can describe', () => {
  it('refuses an entry with no configuration in it rather than guessing a string', () => {
    // A well-formed visual sample entry with children that say nothing about the codec. Answered
    // with a string, this would configure a decoder for a stream it has never seen.
    expect(decoderConfigOf(visualEntry('avc1', boxOf('pasp', u32(1, 1))))).toBeNull()
    // A record too short to hold the fields the string is spelled from is no record either.
    expect(decoderConfigOf(visualEntry('avc1', boxOf('avcC', u8(1, 0x4d))))).toBeNull()
    // Nothing at all: no entry, no answer.
    expect(decoderConfigOf(new Uint8Array(0))).toBeNull()
  })
})

describe('sampleEntryFormat', () => {
  it('gives the four letters §8.4 decides by', () => {
    expect(sampleEntryFormat(isoEntry(H264).bytes)).toBe('avc1')
    expect(sampleEntryFormat(isoEntry(VP9).bytes)).toBe('vp09')
    expect(sampleEntryFormat(isoEntry(AV1).bytes)).toBe('av01')
    expect(sampleEntryFormat(webmEntry(WEBM_VP9, 'video/webm; codecs="vp09.00.10.08"').bytes)).toBe('vp09')
    expect(sampleEntryFormat(webmEntry(WEBM_VP8, 'video/webm; codecs="vp8"').bytes)).toBe('vp08')
    // Not a guess and not a throw: bytes that hold no box at all name no format.
    expect(sampleEntryFormat(new Uint8Array(0))).toBe('')
  })
})
