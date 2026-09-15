import { describe, expect, it } from 'vitest'
import { codedSampleEntry } from '../../src/core/encode/entry'
import { decoderConfigOf } from '../../src/core/encode/decoder'
import { boxOf, u16, u32, u8, zeroes } from '../../src/core/iso/writer'
import { boxesIn, boxBody } from '../../src/core/iso/reader'

const description = Uint8Array.of(1, 66, 0, 31)
const colour = { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: true } as const

describe('encoded and source colour metadata', () => {
  it('writes the encoder colour space and range instead of labelling every output BT.709', () => {
    const entry = codedSampleEntry('avc1', description, 64, 64, colour)
    const colr = boxesIn(entry, 86, entry.length).find(box => box.type === 'colr')!
    const body = boxBody(entry, colr)
    expect(Array.from(body)).toEqual([110, 99, 108, 120, 0, 6, 0, 6, 0, 6, 128])
    expect(decoderConfigOf(entry)?.colorSpace).toEqual(colour)
  })

  it('does not invent a colour space when the encoder did not report one', () => {
    const entry = codedSampleEntry('avc1', description, 64, 64)
    expect(boxesIn(entry, 86, entry.length).map(box => box.type)).toEqual(['avcC'])
  })

  it('reads container-only colour information before decoding', () => {
    const entry = boxOf('avc1', zeroes(24), u16(64, 64), zeroes(50),
      boxOf('avcC', description),
      boxOf('colr', u32(0x6e636c78), u16(1, 1, 1), u8(0)))
    expect(decoderConfigOf(entry)?.colorSpace).toEqual({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false })
  })
})
