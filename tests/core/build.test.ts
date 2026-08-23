import { describe, it, expect } from 'vitest'
import { buildAudioInit, buildFragment, type Sample } from '../../src/core/iso/build'
import { parseInit } from '../../src/core/iso/init'
import { parseFragment } from '../../src/core/iso/fragment'
import { boxBody, childBoxes, findBox, topLevelBoxes } from '../../src/core/iso/reader'
import { boxOf, u16, u32, zeroes } from '../../src/core/iso/writer'

/**
 * A sample entry of the shape every sound codec shares, with a made-up four-letter name. The
 * builder is not to know what codec it is writing: the entry arrives ready and goes into the stsd
 * as it is.
 */
const sampleEntry = boxOf(
  'tSt1',
  zeroes(6),
  u16(1),
  zeroes(8),
  u16(2, 16, 0, 0),
  u32(48000 * 0x10000),
)

const TRACK_ID = 1
const TIMESCALE = 48000

const init = buildAudioInit({ trackId: TRACK_ID, timescale: TIMESCALE, sampleEntry })

const sample = (duration: number, ...bytes: number[]): Sample => ({
  duration,
  bytes: Uint8Array.from(bytes),
})

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

describe('buildAudioInit', () => {
  it('reads back through the parser of init segments', () => {
    expect(parseInit(init)).toEqual({
      tracks: [
        { trackId: TRACK_ID, kind: 'audio', timescale: TIMESCALE, codec: 'tSt1', width: 0, height: 0 },
      ],
    })
  })

  it('opens with an ftyp and holds one moov', () => {
    expect(topLevelBoxes(init).map((b) => b.type)).toEqual(['ftyp', 'moov'])
  })

  it('states the boxes a fragmented movie is read through', () => {
    for (const path of [
      ['moov', 'mvhd'],
      ['moov', 'trak', 'tkhd'],
      ['moov', 'trak', 'mdia', 'mdhd'],
      ['moov', 'trak', 'mdia', 'hdlr'],
      ['moov', 'trak', 'mdia', 'minf', 'smhd'],
      ['moov', 'trak', 'mdia', 'minf', 'dinf', 'dref'],
      ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'],
      ['moov', 'mvex', 'trex'],
    ]) {
      expect(findBox(init, path), path.join('/')).not.toBeNull()
    }
  })

  it('leaves the sample tables empty: a fragmented movie states its samples per fragment', () => {
    const stbl = findBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl'])!
    for (const table of ['stts', 'stsc', 'stco']) {
      const box = childBoxes(init, stbl).find((b) => b.type === table)!
      expect(view(boxBody(init, box)).getUint32(4), table).toBe(0)
    }
    const stsz = childBoxes(init, stbl).find((b) => b.type === 'stsz')!
    expect(view(boxBody(init, stsz)).getUint32(8)).toBe(0)
  })

  it('states the track in the trex under the number the tkhd gives it', () => {
    const trex = findBox(init, ['moov', 'mvex', 'trex'])!
    const body = view(boxBody(init, trex))
    expect(body.getUint32(4)).toBe(TRACK_ID)
    // The sample description index points at the one entry of the stsd; the sample flags say
    // every sample stands on its own, which is what a sound track is made of.
    expect(body.getUint32(8)).toBe(1)
    expect(body.getUint32(20)).toBe(0x02000000)
  })

  it('states no length: the length of a clip is not known until it has been cut', () => {
    const mvhd = findBox(init, ['moov', 'mvhd'])!
    expect(view(boxBody(init, mvhd)).getUint32(16)).toBe(0)
  })

  it('leaves room in next_track_ID for the number it gave the track', () => {
    const mvhd = findBox(init, ['moov', 'mvhd'])!
    const body = boxBody(init, mvhd)
    expect(view(body).getUint32(body.byteLength - 4)).toBe(TRACK_ID + 1)
  })

  it('numbers the track as it is asked to', () => {
    const other = buildAudioInit({ trackId: 7, timescale: TIMESCALE, sampleEntry })
    expect(parseInit(other)!.tracks[0]!.trackId).toBe(7)
  })
})

describe('buildFragment', () => {
  const samples = [sample(960, 1, 2, 3), sample(1008, 4, 5), sample(960, 6, 7, 8, 9)]
  const fragment = buildFragment(TRACK_ID, 95088, samples)

  it('reads back through the parser of media segments', () => {
    expect(parseFragment(fragment)).toEqual({
      trackId: TRACK_ID,
      baseMediaDecodeTime: 95088,
      // The three sample durations added up: what the fragment covers of the timeline.
      duration: 960 + 1008 + 960,
    })
  })

  it('is a moof followed by an mdat and nothing else', () => {
    expect(topLevelBoxes(fragment).map((b) => b.type)).toEqual(['moof', 'mdat'])
  })

  it('carries the coded bytes into the mdat in the order they were given', () => {
    const mdat = topLevelBoxes(fragment).find((b) => b.type === 'mdat')!
    expect([...boxBody(fragment, mdat)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('points the trun at the first byte of the sample data, counted from the moof', () => {
    const trun = findBox(fragment, ['moof', 'traf', 'trun'])!
    const dataOffset = view(boxBody(fragment, trun)).getUint32(8)
    const moof = topLevelBoxes(fragment)[0]!

    // The base is the start of the moof, which is the start of the fragment: default-base-is-moof
    // is set and nothing else addresses the samples.
    expect(moof.start).toBe(0)
    expect(fragment[dataOffset]).toBe(1)
  })

  it('addresses its samples from its own moof, so the fragment survives being moved', () => {
    const tfhd = findBox(fragment, ['moof', 'traf', 'tfhd'])!
    const flags = view(boxBody(fragment, tfhd)).getUint32(0) & 0x00ffffff
    expect(flags & 0x020000, 'default-base-is-moof').toBeTruthy()
    expect(flags & 0x000001, 'base-data-offset must not be stated').toBe(0)
  })

  it('states each sample its own duration and its own size', () => {
    const trun = findBox(fragment, ['moof', 'traf', 'trun'])!
    const body = view(boxBody(fragment, trun))
    expect(body.getUint32(4)).toBe(3)

    const entries = [0, 1, 2].map((i) => [body.getUint32(12 + i * 8), body.getUint32(16 + i * 8)])
    expect(entries).toEqual([
      [960, 3],
      [1008, 2],
      [960, 4],
    ])
  })

  it('writes the decode time into a wide field: a long recording outgrows a narrow one', () => {
    const tfdt = findBox(fragment, ['moof', 'traf', 'tfdt'])!
    const body = boxBody(fragment, tfdt)
    expect(body[0], 'version').toBe(1)
    expect(Number(view(body).getBigUint64(4))).toBe(95088)
  })

  it('carries a decode time past what four bytes can hold', () => {
    // Twelve hours at 48 kHz: 2 073 600 000 ticks, which a 32-bit field still holds, and a day of
    // it does not. Either way the field is the same width, and this is where that is checked.
    const long = buildFragment(TRACK_ID, 8_000_000_000, [sample(960, 1)])
    expect(parseFragment(long)!.baseMediaDecodeTime).toBe(8_000_000_000)
  })

  it('numbers the fragment as it is asked to', () => {
    const numbered = buildFragment(TRACK_ID, 0, samples, 42)
    const mfhd = findBox(numbered, ['moof', 'mfhd'])!
    expect(view(boxBody(numbered, mfhd)).getUint32(4)).toBe(42)
  })

  it('holds a fragment of one sample together just as well', () => {
    const one = buildFragment(TRACK_ID, 0, [sample(960, 0xaa)])
    expect(parseFragment(one)).toEqual({ trackId: TRACK_ID, baseMediaDecodeTime: 0, duration: 960 })

    const mdat = topLevelBoxes(one).find((b) => b.type === 'mdat')!
    expect([...boxBody(one, mdat)]).toEqual([0xaa])
  })

  it('reads a sample that is a view into a wider buffer, not the buffer under it', () => {
    const backing = Uint8Array.from([0xaa, 0xaa, 1, 2, 0xbb])
    const built = buildFragment(TRACK_ID, 0, [{ duration: 960, bytes: backing.subarray(2, 4) }])
    const mdat = topLevelBoxes(built).find((b) => b.type === 'mdat')!
    expect([...boxBody(built, mdat)]).toEqual([1, 2])
  })

  it('leaves the sample bytes it was handed untouched', () => {
    const bytes = Uint8Array.from([1, 2, 3])
    buildFragment(TRACK_ID, 0, [{ duration: 960, bytes }])
    expect([...bytes]).toEqual([1, 2, 3])
  })
})

describe('an init and its fragments make a stream a parser can follow', () => {
  it('gives the same track number in the moov and in every fragment of it', () => {
    const declared = parseInit(init)!.tracks[0]!.trackId
    const fragments = [0, 96000].map((at) => buildFragment(declared, at, [sample(960, 1)]))
    expect(fragments.map((f) => parseFragment(f)!.trackId)).toEqual([declared, declared])
  })

  it('turns ticks into the seconds the registry lays material out in', () => {
    const declared = parseInit(init)!.tracks[0]!
    const fragment = parseFragment(buildFragment(TRACK_ID, 95088, [sample(960, 1)]))!
    expect(fragment.baseMediaDecodeTime / declared.timescale).toBeCloseTo(1.981, 6)
  })
})
