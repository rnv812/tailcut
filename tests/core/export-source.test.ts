import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ByteMap,
  bytesFrom,
  clipSourceOf,
  sourceTrackOf,
  type SourceTrackInput,
} from '../../src/core/export/source'
import { findBox } from '../../src/core/iso/reader'
import { parseInit } from '../../src/core/iso/init'
import type { Located } from '../../src/shared/types'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

const VIDEO_INIT = read('h264/init-stream0.m4s')
const VIDEO = [1, 2, 3].map((n) => read(`h264/chunk-stream0-0000${n}.m4s`))
const AUDIO_INIT = read('h264/init-stream1.m4s')
const AUDIO = [1, 2, 3, 4].map((n) => read(`h264/chunk-stream1-0000${n}.m4s`))

/** Segments laid out one after another in an address space of their own, as Save all lays them. */
function placed(kind: 'video' | 'audio', initBytes: Uint8Array, segments: Uint8Array[]) {
  const map = new ByteMap()
  const input: SourceTrackInput = {
    kind,
    initBytes,
    segments: segments.map((bytes) => ({ bytes, at: map.place(bytes) })),
  }
  return { map, input }
}

/** The same segment with its traf calling the track something else, byte for byte otherwise. */
function renumberedTraf(segment: Uint8Array, trackId: number): Uint8Array {
  const copy = new Uint8Array(segment)
  const tfhd = findBox(copy, ['moof', 'traf', 'tfhd'])!
  // The header of the box, then its version and flags, then the number of the track.
  new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint32(
    tfhd.start + tfhd.headerSize + 4,
    trackId,
  )
  return copy
}

describe('sourceTrackOf', () => {
  it('indexes every sample of the picture, keyframes and all', () => {
    const track = sourceTrackOf(placed('video', VIDEO_INIT, VIDEO).input)!

    // Three segments of forty-eight frames, a keyframe every twenty-four.
    expect(track.samples).toHaveLength(144)
    expect(track.samples.filter((sample) => sample.sync)).toHaveLength(6)
    expect(track.kind).toBe('video')
    expect(track.timescale).toBe(12_288)
    expect([track.width, track.height]).toEqual([320, 240])
    expect(track.sampleEntry.byteLength).toBeGreaterThan(0)
    // The edit offset comes through untouched: every time in this plan is measured from it.
    expect(track.editOffset).toBe(1_024)
  })

  it('addresses the bytes of a sample where they really are', () => {
    const { map, input } = placed('video', VIDEO_INIT, VIDEO)
    const track = sourceTrackOf(input)!

    for (const sample of track.samples) {
      expect(sample.source.at).toBeGreaterThanOrEqual(0)
      expect(sample.source.at + sample.source.length).toBeLessThanOrEqual(map.size)
    }

    // The last sample of the first segment, fetched through the map and sliced by hand: the same
    // bytes, or the file gets a frame of somebody else's picture.
    const last = track.samples[47]!
    expect(map.bytesOf(last.source)).toEqual(
      VIDEO[0]!.subarray(last.source.at, last.source.at + last.source.length),
    )
  })

  it('indexes sound whose keyframe flags live only in the trex', () => {
    // 84 + 86 + 87 + 3: the last segment is the tail a packager leaves. The truns of this track
    // carry no per-sample flags at all, so every sample of it is a sync sample by default — read
    // without the trex fallback the whole track would come out unseekable.
    const track = sourceTrackOf(placed('audio', AUDIO_INIT, AUDIO).input)!

    expect(track.samples).toHaveLength(260)
    expect(track.samples.every((sample) => sample.sync)).toBe(true)
    expect(track.timescale).toBe(44_100)
    expect(track.kind).toBe('audio')
  })

  it('keeps the samples in decode order however the segments arrive', () => {
    const map = new ByteMap()
    const backwards = [...VIDEO].reverse().map((bytes) => ({ bytes, at: map.place(bytes) }))
    const track = sourceTrackOf({ kind: 'video', initBytes: VIDEO_INIT, segments: backwards })!

    const times = track.samples.map((sample) => sample.dts)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('reads a single-track segment whose traf numbers the track its own way', () => {
    // A segment carrying one track is free to number its traf anything: there is only one track
    // it could be about, and packagers do differ from their own init here. Every fixture family
    // in this repository says 1 in both places, and so does the WebM rewriter, so this is the
    // one branch of the index no material exercises — and without it the segment is skipped
    // silently and a whole track of the recording comes out empty.
    const renumbered = renumberedTraf(VIDEO[0]!, 7)
    const tfhd = findBox(renumbered, ['moof', 'traf', 'tfhd'])!
    const view = new DataView(renumbered.buffer, renumbered.byteOffset, renumbered.byteLength)
    const stated = view.getUint32(tfhd.start + tfhd.headerSize + 4)
    expect(stated, 'the segment kept the number of the init after all').toBe(7)

    const map = new ByteMap()
    const track = sourceTrackOf({
      kind: 'video',
      initBytes: VIDEO_INIT,
      segments: [{ bytes: renumbered, at: map.place(renumbered) }],
    })!
    const untouched = sourceTrackOf(placed('video', VIDEO_INIT, [VIDEO[0]!]).input)!

    // Read exactly as the untouched segment is: the number in the traf changes nothing else.
    expect(track.samples).toEqual(untouched.samples)
    expect(track.samples).toHaveLength(48)
  })

  it('skips a segment it cannot read instead of throwing', () => {
    const map = new ByteMap()
    const rubbish = new Uint8Array(64).fill(0x7f)
    const track = sourceTrackOf({
      kind: 'video',
      initBytes: VIDEO_INIT,
      segments: [
        { bytes: VIDEO[0]!, at: map.place(VIDEO[0]!) },
        { bytes: rubbish, at: map.place(rubbish) },
      ],
    })!

    expect(track.samples).toHaveLength(48)
  })

  it('gives nothing for an init whose media header states no timescale', () => {
    // Every instant of a plan is a division by this number, and a zero here is not caught
    // anywhere downstream: the seams come out at Infinity, the entry point rounds to NaN, and the
    // writer states a header no player can read. Refused where the track is read instead.
    const broken = new Uint8Array(VIDEO_INIT)
    const mdhd = findBox(broken, ['moov', 'trak', 'mdia', 'mdhd'])!
    const view = new DataView(broken.buffer, broken.byteOffset, broken.byteLength)
    // mdhd: version and flags, then the times — two of them in a version 0, four in a version 1.
    const version = view.getUint8(mdhd.start + mdhd.headerSize)
    view.setUint32(mdhd.start + mdhd.headerSize + (version === 1 ? 20 : 12), 0)
    const stated = parseInit(broken)!.tracks.find((track) => track.kind === 'video')!
    expect(stated.timescale, 'the fixture kept its timescale after all').toBe(0)

    expect(sourceTrackOf(placed('video', broken, VIDEO).input)).toBeNull()
  })

  it('gives nothing for an init that describes no track of that kind', () => {
    expect(sourceTrackOf(placed('video', AUDIO_INIT, AUDIO).input)).toBeNull()
    expect(sourceTrackOf(placed('video', VIDEO_INIT, []).input)).toBeNull()
  })
})

describe('clipSourceOf', () => {
  it('leads with the picture and puts the sound beside it', () => {
    const source = clipSourceOf([
      placed('video', VIDEO_INIT, VIDEO).input,
      placed('audio', AUDIO_INIT, AUDIO).input,
    ])!

    expect(source.video.kind).toBe('video')
    expect(source.audio?.kind).toBe('audio')
  })

  it('leads with the picture whichever way round the tracks are handed over', () => {
    // An adaptation set is free to list its sound first, and plenty do. Taking whatever was read
    // first instead of looking for the picture does not reorder the clip — it loses the picture:
    // the sound takes the leading slot, nothing is left beside it, and the export writes a file
    // with no picture in it at all.
    const source = clipSourceOf([
      placed('audio', AUDIO_INIT, AUDIO).input,
      placed('video', VIDEO_INIT, VIDEO).input,
    ])!

    expect(source.video.kind).toBe('video')
    expect(source.audio?.kind).toBe('audio')
  })

  it('leads with the sound when there is no picture', () => {
    // planClip measures a clip by whatever stands in the leading slot, and a recording of sound
    // alone has to be exportable too — the popup has offered to save one since the first stage.
    const source = clipSourceOf([placed('audio', AUDIO_INIT, AUDIO).input])!

    expect(source.video.kind).toBe('audio')
    expect(source.audio).toBeUndefined()
  })

  it('gives nothing when no track could be read', () => {
    expect(clipSourceOf([])).toBeNull()
    expect(clipSourceOf([placed('video', VIDEO_INIT, []).input])).toBeNull()
  })
})

describe('ByteMap', () => {
  it('hands back exactly the bytes that were put in', () => {
    const map = new ByteMap()
    const first = map.place(VIDEO[0]!)
    const second = map.place(VIDEO[1]!)

    expect(first).toEqual({ at: 0, length: VIDEO[0]!.byteLength })
    expect(second.at).toBe(VIDEO[0]!.byteLength)
    expect(map.size).toBe(VIDEO[0]!.byteLength + VIDEO[1]!.byteLength)
    expect(map.bytesOf({ at: second.at + 10, length: 4 })).toEqual(VIDEO[1]!.subarray(10, 14))
    // The first byte of a segment belongs to that segment and not to the one in front of it: the
    // search has to step past a part it has run off the end of instead of stopping on it.
    expect(map.bytesOf({ at: second.at, length: 4 })).toEqual(VIDEO[1]!.subarray(0, 4))
  })

  it('refuses a range that belongs to nobody, loudly', () => {
    // Silence here would be a file with a hole in the middle of a frame and nothing to read it
    // by: the writer copies whatever it is handed.
    const map = new ByteMap()
    map.place(VIDEO[0]!)

    expect(() => map.bytesOf({ at: map.size, length: 1 })).toThrow(RangeError)
    expect(() => map.bytesOf({ at: map.size - 2, length: 8 })).toThrow(RangeError)
  })
})

describe('bytesFrom', () => {
  it('reads a sample that ends flush with the end of its slice', () => {
    // An mdat ends where its last sample ends, so the last sample of every segment — and of every
    // slice an export fetches — sits flush against the end of the buffer it was read into. A
    // boundary one byte tight rejects it, and every export throws on the last sample of a slice.
    const { input } = placed('video', VIDEO_INIT, VIDEO)
    const track = sourceTrackOf(input)!
    const lookup = bytesFrom(
      input.segments.map((segment) => segment.at),
      input.segments.map((segment) => segment.bytes),
    )

    // The forty-eighth frame closes the first segment; the last frame of all closes the third.
    for (const { index, segment } of [
      { index: 47, segment: 0 },
      { index: 143, segment: 2 },
    ]) {
      const sample = track.samples[index]!
      const bytes = VIDEO[segment]!
      const from = sample.source.at - input.segments[segment]!.at.at
      expect(from + sample.source.length).toBe(bytes.byteLength)
      expect(lookup(sample.source)).toEqual(bytes.subarray(from, from + sample.source.length))
    }
  })

  it('finds the buffer a sample is in and refuses one that was never read', () => {
    const material = VIDEO[0]!
    const slices: Located[] = [
      { at: 0, length: 10 },
      { at: 100, length: 10 },
    ]
    const buffers = [material.subarray(0, 10), material.subarray(100, 110)]
    const lookup = bytesFrom(slices, buffers)

    expect(lookup({ at: 104, length: 3 })).toEqual(material.subarray(104, 107))
    expect(() => lookup({ at: 50, length: 3 })).toThrow(RangeError)
    // A buffer shorter than the slice it stands for: the file was truncated under the plan.
    const short = bytesFrom([{ at: 0, length: 10 }], [material.subarray(0, 4)])
    expect(() => short({ at: 0, length: 10 })).toThrow(RangeError)
  })
})
