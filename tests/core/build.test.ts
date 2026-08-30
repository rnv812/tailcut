import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  buildAudioInit,
  buildFragment,
  buildVideoInit,
  type Sample,
} from '../../src/core/iso/build'
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

/**
 * The same for a picture: a VisualSampleEntry with a made-up name. What goes inside a real one —
 * a vpcC, an avcC — is the business of the module that writes that codec, not of the builder.
 */
const visualSampleEntry = boxOf(
  'tSt2',
  zeroes(6),
  u16(1),
  u16(0, 0),
  u32(0, 0, 0),
  u16(320, 180),
  u32(0x00480000, 0x00480000),
  u32(0),
  u16(1),
  zeroes(32),
  u16(0x0018),
  u16(0xffff),
)

const TRACK_ID = 1
const TIMESCALE = 48000
const VIDEO_TIMESCALE = 1000
const WIDTH = 320
const HEIGHT = 180

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
        {
          trackId: TRACK_ID, kind: 'audio', timescale: TIMESCALE, codec: 'tSt1',
          width: 0, height: 0, defaultSampleDuration: 0,
        },
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

describe('buildVideoInit', () => {
  const video = buildVideoInit({
    trackId: TRACK_ID,
    timescale: VIDEO_TIMESCALE,
    width: WIDTH,
    height: HEIGHT,
    sampleEntry: visualSampleEntry,
  })

  it('reads back through the parser of init segments, frame size and all', () => {
    expect(parseInit(video)).toEqual({
      tracks: [
        {
          trackId: TRACK_ID,
          kind: 'video',
          timescale: VIDEO_TIMESCALE,
          codec: 'tSt2',
          width: WIDTH,
          height: HEIGHT,
          defaultSampleDuration: 0,
        },
      ],
    })
  })

  it('describes the media with the boxes a picture is described by', () => {
    expect(findBox(video, ['moov', 'trak', 'mdia', 'minf', 'vmhd'])).not.toBeNull()
    expect(findBox(video, ['moov', 'trak', 'mdia', 'minf', 'smhd'])).toBeNull()

    const hdlr = findBox(video, ['moov', 'trak', 'mdia', 'hdlr'])!
    const type = boxBody(video, hdlr).subarray(8, 12)
    expect(String.fromCharCode(...type)).toBe('vide')
  })

  it('states the frame size in the track header as a 16.16 number of pixels', () => {
    const tkhd = findBox(video, ['moov', 'trak', 'tkhd'])!
    const body = view(boxBody(video, tkhd))
    expect(body.getUint32(body.byteLength - 8)).toBe(WIDTH * 0x10000)
    expect(body.getUint32(body.byteLength - 4)).toBe(HEIGHT * 0x10000)
  })

  it('leaves the volume at zero, which is what a picture track sounds like', () => {
    const tkhd = findBox(video, ['moov', 'trak', 'tkhd'])!
    // layer, alternate_group, volume: the third of the three 16-bit fields after the reserved pair.
    expect(view(boxBody(video, tkhd)).getUint16(36)).toBe(0)
  })

  it('presumes a sample is not a sync sample until its own fragment says otherwise', () => {
    // The opposite default to the sound track above, and the reason the fragments of a picture
    // track have to carry flags at all: a picture is mostly frames predicted from other frames,
    // and a trex claiming otherwise would offer a player a hundred wrong places to seek to.
    const trex = findBox(video, ['moov', 'mvex', 'trex'])!
    expect(view(boxBody(video, trex)).getUint32(20)).toBe(0x01010000)
  })

  it('leaves the sound track without a frame size, as it had none before', () => {
    const tkhd = findBox(init, ['moov', 'trak', 'tkhd'])!
    const body = view(boxBody(init, tkhd))
    expect(body.getUint32(body.byteLength - 8)).toBe(0)
    expect(body.getUint32(body.byteLength - 4)).toBe(0)
  })
})

describe('buildFragment: sync sample information', () => {
  const picture = [
    { duration: 100, bytes: Uint8Array.from([1]), keyframe: true },
    { duration: 100, bytes: Uint8Array.from([2, 2]), keyframe: false },
    { duration: 100, bytes: Uint8Array.from([3, 3, 3]), keyframe: false },
  ]
  const fragment = buildFragment(TRACK_ID, 0, picture)

  /** version and flags, sample_count, data_offset: the trun before its entries. */
  const ENTRIES_AT = 12

  const trunFlags = (bytes: Uint8Array): number => {
    const trun = findBox(bytes, ['moof', 'traf', 'trun'])!
    return view(boxBody(bytes, trun)).getUint32(0) & 0x00ffffff
  }

  it('states a flags field per sample when the samples state one', () => {
    // sample-duration | sample-size | sample-flags, and the data offset the run opens with.
    expect(trunFlags(fragment) & 0x000400, 'sample-flags-present').toBeTruthy()
  })

  it('marks the frames that can be decoded on their own, and only those', () => {
    const trun = findBox(fragment, ['moof', 'traf', 'trun'])!
    const body = view(boxBody(fragment, trun))

    const flags = [0, 1, 2].map((i) => body.getUint32(ENTRIES_AT + i * 12 + 8))
    expect(flags).toEqual([0x02000000, 0x01010000, 0x01010000])
  })

  it('keeps the durations and the sizes where they were, a field wider apart', () => {
    const trun = findBox(fragment, ['moof', 'traf', 'trun'])!
    const body = view(boxBody(fragment, trun))

    const entries = [0, 1, 2].map((i) => [
      body.getUint32(ENTRIES_AT + i * 12),
      body.getUint32(ENTRIES_AT + i * 12 + 4),
    ])
    expect(entries).toEqual([
      [100, 1],
      [100, 2],
      [100, 3],
    ])
  })

  it('is still read for its length by the parser the timeline is built on', () => {
    expect(parseFragment(fragment)).toEqual({
      trackId: TRACK_ID,
      baseMediaDecodeTime: 0,
      duration: 300,
    })
  })

  it('points at the sample data across the wider entries', () => {
    const trun = findBox(fragment, ['moof', 'traf', 'trun'])!
    const dataOffset = view(boxBody(fragment, trun)).getUint32(8)
    expect(fragment[dataOffset]).toBe(1)
  })

  it('states no flags at all for a track that leaves them out', () => {
    // A sound track would otherwise pay four bytes a packet to repeat what its trex already says:
    // fifty thousand packets in a twenty-minute recording, and not one of them news.
    expect(trunFlags(buildFragment(TRACK_ID, 0, [sample(960, 1)])) & 0x000400).toBe(0)
  })

  it('gives the whole run flags when any one sample states its own', () => {
    // The box has one set of present-flags for every entry, so a run is flagged or it is not.
    // A sample saying nothing among samples that do is taken as no sync sample, which is the
    // reading that cannot send a player to a frame it may not start from.
    const mixed = buildFragment(TRACK_ID, 0, [
      { duration: 100, bytes: Uint8Array.from([1]) },
      { duration: 100, bytes: Uint8Array.from([2]), keyframe: true },
    ])
    const body = view(boxBody(mixed, findBox(mixed, ['moof', 'traf', 'trun'])!))

    expect(trunFlags(mixed) & 0x000400).toBeTruthy()
    expect(body.getUint32(ENTRIES_AT + 8)).toBe(0x01010000)
    expect(body.getUint32(ENTRIES_AT + 12 + 8)).toBe(0x02000000)
  })
})

describe('the bytes of the init segments', () => {
  it('are what they were before the movie boxes moved into boxes.ts', () => {
    // A characterisation test, not a specification: it exists so that a refactoring which was
    // supposed to change nothing is caught the moment it changes something. If a later change has
    // a reason to write these boxes differently, this is the test that has to be updated by
    // hand, deliberately, with the new bytes measured.
    const audio = buildAudioInit({ trackId: TRACK_ID, timescale: TIMESCALE, sampleEntry })
    expect(audio.byteLength).toBe(557)
    expect(createHash('sha256').update(audio).digest('hex')).toBe(
      '6a5619c8e25bc4f6f91812f538b1e7370c6e78e125f3c478009fccf424ac99ba',
    )

    const video = buildVideoInit({
      trackId: TRACK_ID,
      timescale: VIDEO_TIMESCALE,
      sampleEntry: visualSampleEntry,
      width: WIDTH,
      height: HEIGHT,
    })
    expect(video.byteLength).toBe(611)
    expect(createHash('sha256').update(video).digest('hex')).toBe(
      '4a21c74bbd6512475d4280a8e36b5036c77862a2fee1abdb35aba62eb1174442',
    )
  })
})
