import { describe, it, expect } from 'vitest'
import { codecsOf, levelFor, vp9Config, type Vp9Config } from '../../src/core/vp9/codec'
import { vp9SampleEntry } from '../../src/core/vp9/mp4'
import { boxBody, topLevelBoxes } from '../../src/core/iso/reader'

/** The frame size of the WebM fixture, which is what the level of a legacy string is drawn from. */
const WIDTH = 256
const HEIGHT = 144

const config = (mime: string): Vp9Config | null => vp9Config(mime, WIDTH, HEIGHT)

describe('codecsOf', () => {
  it('reads the parameter out of a type, quoted or bare', () => {
    expect(codecsOf('video/webm; codecs="vp09.00.10.08"')).toEqual(['vp09.00.10.08'])
    expect(codecsOf('video/webm;codecs=vp9')).toEqual(['vp9'])
    expect(codecsOf("video/webm; codecs='vp9'")).toEqual(['vp9'])
    expect(codecsOf('VIDEO/WEBM; CODECS="vp9"')).toEqual(['vp9'])
  })

  it('splits a list: a muxed stream declares every codec in it at once', () => {
    expect(codecsOf('video/webm; codecs="vp09.00.10.08, opus"')).toEqual([
      'vp09.00.10.08',
      'opus',
    ])
  })

  it('finds nothing where there is nothing', () => {
    expect(codecsOf('video/webm')).toEqual([])
    expect(codecsOf('video/webm; codecs=""')).toEqual([])
    expect(codecsOf('')).toEqual([])
    // A parameter whose name merely ends in "codecs" is another parameter.
    expect(codecsOf('video/webm; xcodecs="vp9"')).toEqual([])
  })
})

describe('levelFor: the level a picture of a given size asks for', () => {
  it('picks the lowest level the picture fits in', () => {
    expect(levelFor(256, 144)).toBe(10)
    expect(levelFor(320, 240)).toBe(20)
    expect(levelFor(1920, 1080)).toBe(40)
    expect(levelFor(3840, 2160)).toBe(50)
    expect(levelFor(7680, 4320)).toBe(60)
  })

  it('agrees with what a packager writes for the same picture', () => {
    // ffmpeg puts level 20 in the vpcC of the 320x240 VP9 fixture in tests/fixtures/vp9. The
    // table here is the one it consults, so the two must not drift apart.
    expect(levelFor(320, 240)).toBe(20)
  })

  it('is bounded by the longest side and not by the area alone', () => {
    // Few samples, but wider than any level below the top allows.
    expect(levelFor(20_000, 10)).toBe(62)
  })

  it('gives the top level to a picture larger than the table goes', () => {
    expect(levelFor(20_000, 20_000)).toBe(62)
  })
})

describe('vp9Config: the full form of the codec string', () => {
  it('reads every field of the string YouTube declares its VP9 under', () => {
    expect(config('video/webm; codecs="vp09.00.51.08.01.01.01.01.00"')).toEqual({
      profile: 0,
      level: 51,
      bitDepth: 8,
      chromaSubsampling: 1,
      fullRange: false,
      colourPrimaries: 1,
      transferCharacteristics: 1,
      matrixCoefficients: 1,
    })
  })

  it('fills the optional fields in with the defaults the format defines', () => {
    // Three fields are required and the rest default to 4:2:0 colocated, BT.709, studio range.
    expect(config('video/webm; codecs="vp09.00.10.08"')).toEqual({
      profile: 0,
      level: 10,
      bitDepth: 8,
      chromaSubsampling: 1,
      fullRange: false,
      colourPrimaries: 1,
      transferCharacteristics: 1,
      matrixCoefficients: 1,
    })
  })

  it('takes as many of the optional fields as the string states', () => {
    expect(config('video/webm; codecs="vp09.00.10.08.00"')?.chromaSubsampling).toBe(0)
    expect(config('video/webm; codecs="vp09.00.10.08.01.09"')?.colourPrimaries).toBe(9)
  })

  it('reads a ten-bit stream in the wide colour a site serves HDR in', () => {
    // Profile 2, level 5.1, ten bits, 4:2:0, BT.2020 primaries, PQ transfer, BT.2020 matrix.
    expect(config('video/webm; codecs="vp09.02.51.10.01.09.16.09.00"')).toEqual({
      profile: 2,
      level: 51,
      bitDepth: 10,
      chromaSubsampling: 1,
      fullRange: false,
      colourPrimaries: 9,
      transferCharacteristics: 16,
      matrixCoefficients: 9,
    })
  })

  it('reads the full-range flag as the flag it is', () => {
    expect(config('video/webm; codecs="vp09.00.10.08.01.01.01.01.01"')?.fullRange).toBe(true)
  })

  it('picks the VP9 out of a list that declares the sound beside it', () => {
    expect(config('video/webm; codecs="vp09.00.10.08,opus"')?.level).toBe(10)
  })
})

describe('vp9Config: the legacy form', () => {
  it('reads the bare name as profile 0, which is what a browser reads it as', () => {
    // Profile 0 is not a guess about the rest: the format defines it as eight bits and 4:2:0, so
    // the two fields a decoder needs follow from the name itself.
    expect(config('video/webm; codecs="vp9"')).toEqual({
      profile: 0,
      level: 10,
      bitDepth: 8,
      chromaSubsampling: 1,
      fullRange: false,
      colourPrimaries: 2,
      transferCharacteristics: 2,
      matrixCoefficients: 2,
    })
  })

  it('writes the colour fields down as unspecified rather than inventing them', () => {
    const bare = config('video/webm; codecs="vp9"')!
    expect([bare.colourPrimaries, bare.transferCharacteristics, bare.matrixCoefficients]).toEqual([
      2, 2, 2,
    ])
  })

  it('takes the level from the picture, because the name states none', () => {
    expect(vp9Config('video/webm; codecs="vp9"', 1920, 1080)?.level).toBe(40)
  })
})

describe('vp9Config: what it refuses, and why a refusal is better than a guess', () => {
  it('refuses a type with no codecs parameter: the track is then undescribed', () => {
    expect(config('video/webm')).toBeNull()
  })

  it('refuses when there is no type at all', () => {
    expect(vp9Config(undefined, WIDTH, HEIGHT)).toBeNull()
    expect(vp9Config('', WIDTH, HEIGHT)).toBeNull()
  })

  it('refuses a type declaring some other codec', () => {
    expect(config('video/webm; codecs="vp8"')).toBeNull()
    expect(config('video/mp4; codecs="avc1.4d401e"')).toBeNull()
    expect(config('audio/webm; codecs="opus"')).toBeNull()
  })

  it('refuses a profile the format does not have', () => {
    expect(config('video/webm; codecs="vp09.04.10.08"')).toBeNull()
    expect(config('video/webm; codecs="vp09.99.10.08"')).toBeNull()
  })

  it('refuses a bit depth the profile forbids', () => {
    // Profile 0 is eight bits by definition; a ten-bit stream is profile 2.
    expect(config('video/webm; codecs="vp09.00.10.10"')).toBeNull()
    expect(config('video/webm; codecs="vp09.02.10.08"')).toBeNull()
    expect(config('video/webm; codecs="vp09.00.10.09"')).toBeNull()
  })

  it('refuses a chroma subsampling the profile forbids', () => {
    // 4:4:4 belongs to profiles 1 and 3; profile 0 is 4:2:0 and nothing else.
    expect(config('video/webm; codecs="vp09.00.10.08.03"')).toBeNull()
    expect(config('video/webm; codecs="vp09.01.10.08.01"')).toBeNull()
  })

  it('refuses a level the format does not define', () => {
    expect(config('video/webm; codecs="vp09.00.99.08"')).toBeNull()
    expect(config('video/webm; codecs="vp09.00.00.08"')).toBeNull()
  })

  it('refuses a field that is not two digits: the form is fixed and this is not it', () => {
    expect(config('video/webm; codecs="vp09.0.10.08"')).toBeNull()
    expect(config('video/webm; codecs="vp09.000.10.08"')).toBeNull()
    expect(config('video/webm; codecs="vp09.xx.10.08"')).toBeNull()
    expect(config('video/webm; codecs="vp09.-1.10.08"')).toBeNull()
  })

  it('refuses a string with too few fields or more than the form has', () => {
    expect(config('video/webm; codecs="vp09.00"')).toBeNull()
    expect(config('video/webm; codecs="vp09.00.10"')).toBeNull()
    expect(config('video/webm; codecs="vp09.00.10.08.01.01.01.01.00.00"')).toBeNull()
  })

  it('refuses a range flag that is not a flag', () => {
    expect(config('video/webm; codecs="vp09.00.10.08.01.01.01.01.02"')).toBeNull()
  })
})

describe('vp9SampleEntry', () => {
  const entry = vp9SampleEntry(config('video/webm; codecs="vp09.00.10.08"')!, WIDTH, HEIGHT)

  const view = (bytes: Uint8Array): DataView =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  /**
   * The fixed part of a VisualSampleEntry, which every picture codec shares and after which the
   * boxes that describe this one in particular begin. Walked by hand and not through the reader:
   * a sample entry is a box with a prefix of fields in front of its children, and the reader
   * descends only into boxes that are children all the way down.
   */
  const VISUAL_SAMPLE_ENTRY = 78

  const configurationBox = (bytes: Uint8Array): Uint8Array =>
    boxBody(bytes, topLevelBoxes(bytes)[0]!).subarray(VISUAL_SAMPLE_ENTRY)

  it('is a vp09 box and the whole of it is accounted for', () => {
    const [box, ...rest] = topLevelBoxes(entry)
    expect(box!.type).toBe('vp09')
    expect(rest).toEqual([])
    expect(box!.size).toBe(entry.byteLength)
  })

  it('states the frame size in the sample entry, where a demuxer reads it', () => {
    const body = view(boxBody(entry, topLevelBoxes(entry)[0]!))
    // Past the six reserved bytes, the data reference index, and the eight pre_defined ones.
    expect(body.getUint16(24)).toBe(WIDTH)
    expect(body.getUint16(26)).toBe(HEIGHT)
    expect(body.getUint16(6), 'data_reference_index').toBe(1)
  })

  it('carries a vpcC, without which the entry names a codec and describes nothing', () => {
    const box = configurationBox(entry)
    // Twenty bytes of it: size, type, version and flags, and the eight-byte record.
    expect([...box.subarray(0, 8)]).toEqual([0, 0, 0, 20, 0x76, 0x70, 0x63, 0x43])
    expect(box.byteLength).toBe(20)
  })

  it('writes the record of the codec string into the vpcC, field for field', () => {
    // Version one and no flags, then profile, level, the packed byte, three colour codes, and the
    // length of the codec initialisation data — of which VP9 has none.
    expect([...configurationBox(entry).subarray(8)]).toEqual([
      1, 0, 0, 0,
      0, // profile
      10, // level 1.0
      0x82, // eight bits, 4:2:0 colocated, studio range
      1, 1, 1, // BT.709 throughout
      0, 0, // codecIntializationDataSize
    ])
  })

  it('packs bit depth, subsampling and range into the one byte that holds all three', () => {
    const wide = vp9Config('video/webm; codecs="vp09.03.51.12.03.09.16.09.01"', WIDTH, HEIGHT)!
    const record = configurationBox(vp9SampleEntry(wide, WIDTH, HEIGHT)).subarray(12)

    expect(record[0], 'profile').toBe(3)
    expect(record[1], 'level').toBe(51)
    // Twelve bits, 4:4:4, full range: 1100 011 1.
    expect(record[2]).toBe(0xc7)
    expect([record[3], record[4], record[5]]).toEqual([9, 16, 9])
  })
})
