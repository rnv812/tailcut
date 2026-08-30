import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { COLOUR_BT709_LIMITED, codedSampleEntry } from '../../src/core/encode/entry'
import { videoSampleEntry } from '../../src/core/iso/entry'
import { boxBody, boxesIn, topLevelBoxes } from '../../src/core/iso/reader'

/**
 * The stsd entry of a track nobody else described, read back byte by byte.
 *
 * Everything the copy path writes into an stsd was copied out of somebody else's file, so a field
 * of it being wrong was never possible. This entry is written from nothing, and every field of it
 * is a claim: how wide the picture is, where the codec's own record begins, and which colour
 * matrix a reader is to believe. Read with this repository's own box reader, because that reader
 * is the one that has to find the children again — and it finds them at a fixed offset, which is
 * exactly the claim a wrong field run would break.
 */

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/**
 * Where the children of a VisualSampleEntry begin, counted from the first byte of the entry.
 *
 * Eight of box header and seventy-eight of fields, the same number `src/core/iso/entry.ts` steps
 * over to read a foreign entry's children. Written out here rather than imported so that a field
 * run that quietly changed length is caught by this file rather than agreed with by it.
 */
const VISUAL_ENTRY_FIELDS = 86

/** The colour box: four bytes of type, three 16-bit values, one byte of range. */
const COLOUR_BODY_BYTES = 11

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** The avcC of a recording this program actually made: a real decoder configuration, not a blob. */
const avcC = videoSampleEntry(read('tests/fixtures/h264/init-stream0.m4s'))!.children.get('avcC')!

/**
 * An hvcC, built by hand: main profile, main tier, level 4.0.
 *
 * There is no HEVC fixture in this repository and no machine here that can make one — the same
 * reason `tests/core/encode-decoder.test.ts` writes its record out field by field. Thirteen bytes
 * lifted from that file, so that both halves of the HEVC path are tested against the same record.
 */
const hvcC = new Uint8Array([
  0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x00, 120,
])

/** The boxes behind the fixed fields, which is where a sample entry keeps everything that matters. */
const childrenOf = (entry: Uint8Array) => boxesIn(entry, VISUAL_ENTRY_FIELDS, entry.byteLength)

describe('codedSampleEntry', () => {
  it('states the shape of the picture and hands the codec its own record back untouched', () => {
    // The premise: the record really is one, and really is the fixture's. An entry carrying an
    // empty avcC would satisfy every comparison below and describe nothing.
    expect(avcC.byteLength).toBeGreaterThan(7)
    expect(avcC[0], 'configurationVersion of a real avcC').toBe(1)

    const entry = codedSampleEntry('avc1', avcC, 1280, 720)
    const boxes = topLevelBoxes(entry)
    expect(boxes.map((box) => box.type)).toEqual(['avc1'])

    // Every field of the run, by name. They are not decoration: a data_reference_index of zero
    // points at no entry of the dref, and a depth or a frame count of zero is a picture no
    // player lays out. Width and height are the two a wrong order would swap in silence —
    // measured on the copy path, where 240×320 for a 320×240 picture probes clean and plays
    // squeezed.
    const view = viewOf(entry)
    expect({
      dataReferenceIndex: view.getUint16(14),
      width: view.getUint16(32),
      height: view.getUint16(34),
      horizontalResolution: view.getUint32(36),
      verticalResolution: view.getUint32(40),
      frameCount: view.getUint16(48),
      depth: view.getUint16(82),
      trailer: view.getInt16(84),
    }).toEqual({
      dataReferenceIndex: 1,
      width: 1280,
      height: 720,
      horizontalResolution: 0x0048_0000,
      verticalResolution: 0x0048_0000,
      frameCount: 1,
      depth: 0x0018,
      trailer: -1,
    })

    const children = childrenOf(entry)
    expect(children.map((box) => box.type)).toEqual(['avcC', 'colr'])
    expect(boxBody(entry, children[0]!)).toEqual(avcC)
  })

  it('calls the record by the name the codec knows it by', () => {
    // The premise: the two records are not the same bytes, so a name written from the wrong
    // branch would be describing an HEVC stream with an AVC configuration in it.
    expect(hvcC).not.toEqual(avcC)

    const entry = codedSampleEntry('hvc1', hvcC, 3840, 2160)
    expect(topLevelBoxes(entry).map((box) => box.type)).toEqual(['hvc1'])

    const children = childrenOf(entry)
    expect(children.map((box) => box.type)).toEqual(['hvcC', 'colr'])
    expect(boxBody(entry, children[0]!)).toEqual(hvcC)
  })

  it('carries the colour box on every rung, saying BT.709 and limited range', () => {
    for (const [format, description] of [
      ['avc1', avcC],
      ['hvc1', hvcC],
    ] as const) {
      const entry = codedSampleEntry(format, description, 640, 360)
      const colour = childrenOf(entry).find((box) => box.type === 'colr')
      expect(colour, `${format} without a colour box`).toBeDefined()

      const body = boxBody(entry, colour!)
      const view = viewOf(body)
      expect(body.byteLength).toBe(COLOUR_BODY_BYTES)
      expect(String.fromCharCode(...body.subarray(0, 4))).toBe('nclx')
      // Primaries, transfer, matrix — BT.709 in all three. The matrix is the one ffmpeg guesses
      // when nothing states it, and guesses BT.601 for anything smaller than HD.
      expect([view.getUint16(4), view.getUint16(6), view.getUint16(8)]).toEqual([1, 1, 1])
      // full_range_flag in the top bit of the last byte: zero is limited, which is what the
      // encoder actually wrote.
      expect(view.getUint8(10)).toBe(0)

      // And it is the exported box itself, so that a reader of the constant and a reader of the
      // file are reading the same bytes.
      expect(entry.subarray(colour!.start, colour!.start + colour!.size)).toEqual(
        COLOUR_BT709_LIMITED,
      )
    }
  })

  it('states its own length, and fills it exactly', () => {
    const entry = codedSampleEntry('avc1', avcC, 320, 240)

    // The size field is how a reader steps from this entry to whatever follows it in the stsd.
    // An entry that understates it hands the next reader the tail of itself as a box header.
    expect(viewOf(entry).getUint32(0)).toBe(entry.byteLength)

    // And the fields really are the seventy-eight the format counts: the two children begin at
    // byte 86 and run to the last byte, with nothing before them and nothing after.
    expect(entry.byteLength).toBe(
      VISUAL_ENTRY_FIELDS + (8 + avcC.byteLength) + (8 + COLOUR_BODY_BYTES),
    )
    const children = childrenOf(entry)
    expect(children).toHaveLength(2)
    expect(children[0]!.start).toBe(VISUAL_ENTRY_FIELDS)
    expect(children[1]!.start + children[1]!.size).toBe(entry.byteLength)
  })

  it('refuses to describe a track whose configuration never arrived', () => {
    // A file with an avcC of no bytes in it opens in nothing. Failing here names the job that
    // went wrong; writing it hands the user a file that looks finished and plays as nothing.
    expect(() => codedSampleEntry('avc1', new Uint8Array(0), 320, 240)).toThrow(
      /no decoder configuration/i,
    )
    expect(() => codedSampleEntry('hvc1', new Uint8Array(0), 320, 240)).toThrow()
    // The premise: the same call with a record in hand goes through.
    expect(() => codedSampleEntry('avc1', avcC, 320, 240)).not.toThrow()
  })
})
