import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { muxFragmentedMp4 } from '../../src/core/mux'
import { boxOf, concatBytes } from '../../src/core/iso/writer'
import { boxBody, childBoxes, topLevelBoxes, type Box } from '../../src/core/iso/reader'
import { withTrexDefault, withoutTfhdDefault } from './trex-defaults'
import { decodeWarnings, unexpectedWarnings } from '../support/media'
import { withSdtp } from '../support/fragments'

/** Video of the fixture: timescale 12288, three segments of two seconds, 48 frames each. */
const videoInit = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const videoSegments = [1, 2, 3].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/h264/chunk-stream0-0000${n}.m4s`)),
)
/** Sound of the same clip: timescale 44100, four segments, 84 + 86 + 87 + 3 samples. */
const audioInit = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream1.m4s'))
const audioSegments = [1, 2, 3, 4].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/h264/chunk-stream1-0000${n}.m4s`)),
)

/** Ticks per second of the two tracks — the two scales the muxer has to reconcile. */
const VIDEO_TIMESCALE = 12288
/** Ticks one frame of the picture lasts: 12288 / 24 fps, and what its tfhd states per fragment. */
const VIDEO_SAMPLE_TICKS = 512
const AUDIO_TIMESCALE = 44100

/**
 * Frames of the fixture, counted out of the trun boxes of its segments rather than out of what
 * came out of the muxer: 48 + 48 + 48 samples of picture and 84 + 86 + 87 + 3 of sound.
 */
const VIDEO_FRAMES = 144
const AUDIO_FRAMES = 260

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const u32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4)
  view(bytes).setUint32(0, value)
  return bytes
}

const u64 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(8)
  view(bytes).setBigUint64(0, BigInt(value))
  return bytes
}

/** A digest of bytes: comparing whole buffers without flooding the output on a mismatch. */
function digest(...parts: Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

/** The same bytes inside a wider buffer: a view at a non-zero offset, not the buffer's owner. */
function viewWithOffset(bytes: Uint8Array): Uint8Array {
  const offset = 9
  const backing = new Uint8Array(offset + bytes.byteLength + 7).fill(0xaa)
  backing.set(bytes, offset)
  return backing.subarray(offset, offset + bytes.byteLength)
}

const typeIn = (boxes: Box[], type: string): Box | undefined => boxes.find((b) => b.type === type)

interface Probed {
  format: { duration: string }
  streams: Array<{
    codec_type: string
    codec_name: string
    start_time: string
    nb_read_frames: string
  }>
}

/**
 * Writes the file out and reads it back through ffprobe.
 *
 * -count_frames drives ffprobe through every packet instead of the headers alone: material laid
 * out wrongly inside mdat leaves the boxes intact and shows up only when the frames are actually
 * decoded — as complaints in stderr, with the exit code still zero.
 */
function probe(name: string, bytes: Uint8Array): Probed {
  mkdirSync('tests/tmp', { recursive: true })
  const file = `tests/tmp/${name}`
  writeFileSync(file, bytes)

  const probed = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-count_frames',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,start_time,nb_read_frames',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )

  expect(probed.error).toBeUndefined()
  expect(probed.status, probed.stderr).toBe(0)
  expect(probed.stderr, 'ffprobe complains about reading the file').toBe('')

  return JSON.parse(probed.stdout) as Probed
}

/** Ticks per second of every track the moov declares, by the track_id the moov gives it. */
function timescalesOf(file: Uint8Array): Map<number, number> {
  const scales = new Map<number, number>()
  const moov = typeIn(topLevelBoxes(file), 'moov')
  if (!moov) return scales

  for (const trak of childBoxes(file, moov).filter((b) => b.type === 'trak')) {
    const tkhd = typeIn(childBoxes(file, trak), 'tkhd')
    const mdia = typeIn(childBoxes(file, trak), 'mdia')
    const mdhd = mdia && typeIn(childBoxes(file, mdia), 'mdhd')
    if (!tkhd || !mdhd) continue

    const head = view(boxBody(file, tkhd))
    const media = view(boxBody(file, mdhd))
    const trackId = head.getUint8(0) === 1 ? head.getUint32(20) : head.getUint32(12)
    scales.set(trackId, media.getUint8(0) === 1 ? media.getUint32(20) : media.getUint32(12))
  }

  return scales
}

interface Placed {
  trackId: number
  /** Decode time of the fragment in seconds — the scale the tracks are compared on. */
  time: number
  /** Number the fragment carries in mfhd. */
  sequence: number
}

/**
 * Every fragment of the file in the order it lies there. Read straight out of the bytes and not
 * out of anything the muxer returned on the side: the order of the fragments in the file is the
 * thing being checked.
 */
function fragmentsOf(file: Uint8Array): Placed[] {
  const scales = timescalesOf(file)
  const placed: Placed[] = []

  for (const moof of topLevelBoxes(file).filter((b) => b.type === 'moof')) {
    const children = childBoxes(file, moof)
    const mfhd = typeIn(children, 'mfhd')
    const traf = typeIn(children, 'traf')
    if (!mfhd || !traf) continue

    const inside = childBoxes(file, traf)
    const tfhd = typeIn(inside, 'tfhd')
    const tfdt = typeIn(inside, 'tfdt')
    if (!tfhd || !tfdt) continue

    const trackId = view(boxBody(file, tfhd)).getUint32(4)
    const time = view(boxBody(file, tfdt))
    const ticks = time.getUint8(0) === 1 ? Number(time.getBigUint64(4)) : time.getUint32(4)

    placed.push({
      trackId,
      time: ticks / (scales.get(trackId) ?? 1),
      sequence: view(boxBody(file, mfhd)).getUint32(4),
    })
  }

  return placed
}

/** Media data of a file: the bodies of its mdat boxes in the order they lie there. */
const mediaOf = (file: Uint8Array): Uint8Array[] =>
  topLevelBoxes(file)
    .filter((b) => b.type === 'mdat')
    .map((b) => boxBody(file, b))

/**
 * The same segment with its sample data addressed absolutely: base-data-offset-present in tfhd
 * instead of default-base-is-moof. ffmpeg writes fragments in exactly this shape unless it is
 * asked for `+default_base_moof`, so the form is an ordinary one — and it is the single form a
 * muxer breaks by moving fragments about, because an absolute offset stops being true the moment
 * its fragment lands anywhere else in the file.
 *
 * The base is stated from the start of the media segment, which is what the byte stream format
 * of MSE requires of a segment appended on its own.
 */
function withAbsoluteDataOffset(segment: Uint8Array): Uint8Array {
  const moof = typeIn(topLevelBoxes(segment), 'moof')!
  const traf = typeIn(childBoxes(segment, moof), 'traf')!

  const inside = childBoxes(segment, traf).map((child) => {
    const body = boxBody(segment, child)

    if (child.type === 'tfhd') {
      // base_data_offset stands right after track_id and pushes the fields behind it by eight
      // bytes; default-base-is-moof goes out, because the two ways of stating the base exclude
      // each other.
      const flags = (view(body).getUint32(0) & ~0x020000) | 0x000001
      return boxOf('tfhd', u32(flags), body.subarray(4, 8), u64(moof.start), body.subarray(8))
    }

    if (child.type === 'trun') {
      // data_offset follows the flags and the sample count. It is counted from the base, and the
      // eight new bytes of tfhd push the data that much further from it.
      const patched = body.slice()
      view(patched).setUint32(8, view(patched).getUint32(8) + 8)
      return boxOf('trun', patched)
    }

    return segment.slice(child.start, child.start + child.size)
  })

  const rebuilt = childBoxes(segment, moof).map((child) =>
    child.type === 'traf'
      ? boxOf('traf', ...inside)
      : segment.slice(child.start, child.start + child.size),
  )

  return concatBytes([
    segment.slice(0, moof.start),
    boxOf('moof', ...rebuilt),
    segment.slice(moof.start + moof.size),
  ])
}

/**
 * Where a box states how long it lasts. mvhd and mdhd carry the field after the timescale, tkhd
 * after the reserved word behind its track number, and version 1 doubles every time before it as
 * well as the field itself. Written out here rather than imported from the muxer on purpose: a
 * test that reads the field back through the code that wrote it would agree with any offset.
 */
function durationField(bytes: Uint8Array, box: Box): { at: number; wide: boolean } {
  const body = box.start + box.headerSize
  const wide = bytes[body] === 1
  return { at: body + (box.type === 'tkhd' ? (wide ? 28 : 20) : wide ? 24 : 16), wide }
}

function durationTicks(bytes: Uint8Array, box: Box): number {
  const { at, wide } = durationField(bytes, box)
  return wide ? Number(view(bytes).getBigUint64(at)) : view(bytes).getUint32(at)
}

function setDurationTicks(bytes: Uint8Array, box: Box, ticks: number): void {
  const { at, wide } = durationField(bytes, box)
  if (wide) view(bytes).setBigUint64(at, BigInt(ticks))
  else view(bytes).setUint32(at, ticks)
}

/** Ticks per second of an mvhd or an mdhd: both state it in the same place. */
function timescaleTicks(bytes: Uint8Array, box: Box): number {
  const body = box.start + box.headerSize
  return view(bytes).getUint32(bytes[body] === 1 ? body + 20 : body + 12)
}

/** mvhd of a file, and the tkhd and mdhd of each of its tracks. */
function headers(file: Uint8Array): { mvhd: Box; tkhd: Box[]; mdhd: Box[] } {
  const moov = typeIn(topLevelBoxes(file), 'moov')!
  const inside = childBoxes(file, moov)
  const traks = inside.filter((b) => b.type === 'trak')

  return {
    mvhd: typeIn(inside, 'mvhd')!,
    tkhd: traks.map((trak) => typeIn(childBoxes(file, trak), 'tkhd')!),
    mdhd: traks.map((trak) => {
      const mdia = typeIn(childBoxes(file, trak), 'mdia')!
      return typeIn(childBoxes(file, mdia), 'mdhd')!
    }),
  }
}

/** How long the file says it lasts: the movie header first, then a header of every track. */
function declaredSeconds(file: Uint8Array): number[] {
  const { mvhd, tkhd, mdhd } = headers(file)
  const movie = timescaleTicks(file, mvhd)

  return [
    durationTicks(file, mvhd) / movie,
    ...tkhd.map((box) => durationTicks(file, box) / movie),
    ...mdhd.map((box) => durationTicks(file, box) / timescaleTicks(file, box)),
  ]
}

/**
 * The same init with the length of the whole video written into it.
 *
 * A packager that knows how long the film is says so: the init segments of YouTube state the full
 * running time of the video in mvhd, tkhd and mdhd, and a clip cut out of it is a fraction of
 * that. ffmpeg's DASH muxer leaves all three at zero, so the fixtures on their own never show
 * what the muxer does with a duration it must not believe.
 */
function withDeclaredDuration(init: Uint8Array, seconds: number): Uint8Array {
  const patched = init.slice()
  const { mvhd, tkhd, mdhd } = headers(patched)
  const movie = Math.round(seconds * timescaleTicks(patched, mvhd))

  setDurationTicks(patched, mvhd, movie)
  for (const box of tkhd) setDurationTicks(patched, box, movie)
  for (const box of mdhd) {
    setDurationTicks(patched, box, Math.round(seconds * timescaleTicks(patched, box)))
  }

  return patched
}

/** Rebuilds a tree of boxes, letting the caller replace the body of any box it recognises. */
function rewrite(
  data: Uint8Array,
  boxes: Box[],
  body: (type: string, body: Uint8Array) => Uint8Array | null,
): Uint8Array[] {
  return boxes.map((box) => {
    const children = childBoxes(data, box)
    if (children.length) return boxOf(box.type, ...rewrite(data, children, body))

    const replaced = body(box.type, boxBody(data, box))
    return replaced ? boxOf(box.type, replaced) : data.slice(box.start, box.start + box.size)
  })
}

/**
 * The same init with its headers stated in version 1 — the times widened from 32 bits to 64.
 * Both versions are ordinary in the wild, and every one of the three durations sits at an offset
 * of its own in each of them, so a muxer that writes the clip's length has two ways to write it
 * into the wrong bytes.
 */
function asVersion1(init: Uint8Array): Uint8Array {
  return concatBytes(
    rewrite(init, topLevelBoxes(init), (type, body) => {
      const flags = body.subarray(1, 4)
      const at = (offset: number): Uint8Array => u64(view(body).getUint32(offset))

      // creation and modification times, then the fields the box keeps as they were.
      if (type === 'mvhd' || type === 'mdhd') {
        return concatBytes([
          Uint8Array.of(1),
          flags,
          at(4),
          at(8),
          body.subarray(12, 16),
          at(16),
          body.subarray(20),
        ])
      }
      if (type === 'tkhd') {
        return concatBytes([
          Uint8Array.of(1),
          flags,
          at(4),
          at(8),
          body.subarray(12, 20),
          at(20),
          body.subarray(24),
        ])
      }
      return null
    }),
  )
}

const video = { initBytes: videoInit, segments: videoSegments }
const audio = { initBytes: audioInit, segments: audioSegments }


/**
 * Two media segments joined into one that carries both fragments.
 *
 * The moof and the mdat of the second appended to the whole of the first, with the styp and the
 * sidx that described it as a standalone delivery left off — a segment holding two moof/mdat
 * pairs, which the format allows and no packager measured writes. The readers of a segment take
 * its first fragment and say so (`samplesInSegment` in core/iso/samples.ts); the muxer is the one
 * that walks them all, and the walk has no material of its own without this.
 */
function packedSegment(first: Uint8Array, second: Uint8Array): Uint8Array {
  const boxes = topLevelBoxes(second)
  const moof = typeIn(boxes, 'moof')!
  const last = boxes[boxes.length - 1]!
  return concatBytes([first, second.subarray(moof.start, last.start + last.size)])
}

/**
 * Length of the fixture, from the first tick of either track to the last one of them.
 *
 * The picture runs to exactly six seconds. The sound runs 23 milliseconds past it: its last
 * fragment starts at 263168 ticks and holds three samples that its trun measures out one by one,
 * 2446 ticks in all — a tail shorter than the 1024 ticks a whole sample of it lasts.
 */
const CLIP_SECONDS = (263168 + 2446) / AUDIO_TIMESCALE

describe('muxFragmentedMp4', () => {
  it('gathers both tracks under one ftyp and one moov', () => {
    const file = muxFragmentedMp4([video, audio])
    const types = topLevelBoxes(file).map((b) => b.type)

    // Two init segments laid one after the other are two ftyp boxes and two moov boxes — a file
    // no player reads past the first track.
    expect(types.filter((t) => t === 'ftyp')).toHaveLength(1)
    expect(types.filter((t) => t === 'moov')).toHaveLength(1)
    expect(types[0]).toBe('ftyp')
    expect(types[1]).toBe('moov')

    // Nothing else survives from the media segments: the styp and the sidx of a segment describe
    // it as a standalone delivery, and inside a file they address bytes that have moved.
    expect(types.slice(2)).toEqual(
      Array.from({ length: videoSegments.length + audioSegments.length }, () => ['moof', 'mdat'])
        .flat(),
    )
  })

  it('describes every track in the moov: a trak of its own and a trex of its own', () => {
    const file = muxFragmentedMp4([video, audio])
    const moov = typeIn(topLevelBoxes(file), 'moov')!
    const inside = childBoxes(file, moov)
    const mvex = typeIn(inside, 'mvex')!

    expect(inside.filter((b) => b.type === 'trak')).toHaveLength(2)
    expect(childBoxes(file, mvex).filter((b) => b.type === 'trex')).toHaveLength(2)

    // Both fixtures call their track number one. Left as they came, the two traks would claim the
    // same number and every fragment would land on whichever of them the player looked up first.
    expect([...timescalesOf(file).entries()]).toEqual([
      [1, VIDEO_TIMESCALE],
      [2, AUDIO_TIMESCALE],
    ])

    // The defaults of a fragment are read out of the trex of its track, so the trex boxes have to
    // be renumbered along with the traks — otherwise the sound takes the sample size of the
    // picture.
    const trexIds = childBoxes(file, mvex)
      .filter((b) => b.type === 'trex')
      .map((b) => view(boxBody(file, b)).getUint32(4))
    expect(trexIds).toEqual([1, 2])
  })

  it('lays the fragments of the two tracks in one order of time', () => {
    const placed = fragmentsOf(muxFragmentedMp4([video, audio]))

    // Video at 0, 2, 4 seconds; sound at 0, 1.951, 3.947, 5.968. Interleaved, that is the order
    // any multiplexed stream comes in — sound of the second second before picture of the third,
    // so a player reading the file front to back always has both tracks for the moment it is at.
    expect(placed.map((f) => f.trackId)).toEqual([1, 2, 2, 1, 2, 1, 2])

    const times = placed.map((f) => f.time)
    expect(times).toEqual([...times].sort((a, b) => a - b))

    // Numbered along the file rather than each track from one: the sequence number then says what
    // it is meant to say, which is the order the fragments lie in.
    expect(placed.map((f) => f.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('gives ffprobe a file of two streams, picture and sound, decoding without complaint', () => {
    const probed = probe('mux-two-track.mp4', muxFragmentedMp4([video, audio]))

    expect(probed.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
      ['video', 'h264'],
      ['audio', 'aac'],
    ])

    // Six seconds of source: 144 frames of picture at 24 a second, 260 frames of sound of 1024
    // samples each at 44100.
    expect(probed.streams.map((s) => Number(s.nb_read_frames))).toEqual([
      VIDEO_FRAMES,
      AUDIO_FRAMES,
    ])

    const seconds = Number(probed.format.duration)
    expect(seconds).toBeGreaterThan(5.9)
    expect(seconds).toBeLessThan(6.1)
  })

  it('carries a fragment that brought its own sdtp into a file that decodes whole', () => {
    const file = muxFragmentedMp4([
      { initBytes: videoInit, segments: videoSegments.map(withSdtp) },
      { initBytes: audioInit, segments: audioSegments.map(withSdtp) },
    ])
    const probed = probe('mux-sdtp.mp4', file)

    // Not a frame is lost to the box the packager put there: it is described by the trun as it
    // always was, and the sdtp beside it says nothing that contradicts it.
    expect(probed.streams.map((s) => Number(s.nb_read_frames))).toEqual([
      VIDEO_FRAMES,
      AUDIO_FRAMES,
    ])

    const said = decodeWarnings('tests/tmp/mux-sdtp.mp4')

    // ffmpeg keeps one sample-dependency table per stream and says so when a second arrives. It
    // is the file's own truth, not a defect of the save: every rutube clip we write carries one
    // of these per fragment. What the suite must not do is either fail over it or fall silent —
    // it is named, with its reason, and everything else ffmpeg might say still fails.
    expect(said, 'the fragments no longer carry the box this is about').toContain(
      'Duplicated SDTP atom',
    )
    expect(unexpectedWarnings(said), 'ffmpeg complains of something else as well').toEqual([])
  })

  it('keeps the offset between the tracks when the clip starts in the middle', () => {
    // A clip cut out of the middle: picture from 2.0 seconds, sound from 1.951 — the two tracks
    // are cut into segments of different length and never begin at the same instant.
    const tail = muxFragmentedMp4([
      { initBytes: videoInit, segments: videoSegments.slice(1) },
      { initBytes: audioInit, segments: audioSegments.slice(1) },
    ])
    const probed = probe('mux-tail.mp4', tail)

    // Both tracks are moved back by one and the same stretch of real time — the earliest of them
    // — so the file starts at zero and the 49 milliseconds between the tracks stay where they
    // were. Moving each track back to its own first fragment would zero that offset out and drag
    // the sound onto the wrong picture.
    const offset = 24576 / VIDEO_TIMESCALE - 86016 / AUDIO_TIMESCALE
    expect(offset).toBeCloseTo(0.0494, 3)

    const started = probed.streams.map((s) => Number(s.start_time))
    // The sound is the earlier of the two, so it is the one that defines the origin and opens the
    // file. ffprobe shows it a shade before zero: the edit list of the source skips the priming
    // samples of the encoder, and that edit is carried over as it was.
    expect(started[1]!).toBeLessThan(0.001)
    expect(started[1]!).toBeGreaterThan(-0.05)
    // The picture keeps the 49 milliseconds it stood behind the sound by.
    expect(started[0]!).toBeGreaterThan(offset - 0.01)
    expect(started[0]!).toBeLessThan(offset + 0.01)

    // 96 frames of picture and 176 of sound left in the two of them.
    expect(probed.streams.map((s) => Number(s.nb_read_frames))).toEqual([96, 176])

    const seconds = Number(probed.format.duration)
    expect(seconds).toBeGreaterThan(4.0)
    expect(seconds).toBeLessThan(4.2)
  })

  it('starts the file at zero however deep into the video the clip was cut', () => {
    const tail = muxFragmentedMp4([{ initBytes: videoInit, segments: videoSegments.slice(2) }])

    // The fragment carried a decode time of four seconds. Left as it was, the file would announce
    // six seconds of which the first four hold nothing at all.
    expect(fragmentsOf(tail).map((f) => f.time)).toEqual([0])

    const seconds = Number(probe('mux-late.mp4', tail).format.duration)
    expect(seconds).toBeGreaterThan(1.9)
    expect(seconds).toBeLessThan(2.1)
  })

  it('takes every fragment of a segment that packs more than one', () => {
    // A media segment is one moof and one mdat everywhere it has been measured, so the loop over
    // the moofs of a segment has never turned twice. It is live code all the same: the format
    // puts no limit on how many fragments a segment holds, and the boundary it works out — from
    // one moof to the next, and from the last one to the end of the readable bytes — decides
    // which bytes move with which fragment.
    const packed = packedSegment(videoSegments[0]!, videoSegments[1]!)
    const file = muxFragmentedMp4([{ initBytes: videoInit, segments: [packed, videoSegments[2]!] }])

    // Both fragments of the packed segment came across, and each was placed on the timeline by
    // its own decode time: 0, 2 and 4 seconds, numbered along the file.
    expect(fragmentsOf(file).map((f) => f.time)).toEqual([0, 2, 4])
    expect(fragmentsOf(file).map((f) => f.sequence)).toEqual([1, 2, 3])
    expect(probe('mux-packed.mp4', file).streams.map((s) => Number(s.nb_read_frames))).toEqual([
      VIDEO_FRAMES,
    ])

    // Every byte of media once and in order. A fragment given the rest of the segment instead of
    // the stretch up to the next moof would carry its neighbour's mdat inside itself and the file
    // would hold that material twice.
    expect(digest(...mediaOf(file))).toBe(
      digest(...videoSegments.flatMap((segment) => mediaOf(segment))),
    )
  })

  it('makes a playable file out of a single track too', () => {
    const probed = probe('mux-one-track.mp4', muxFragmentedMp4([video]))

    expect(probed.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([['video', 'h264']])
    expect(probed.streams.map((s) => Number(s.nb_read_frames))).toEqual([VIDEO_FRAMES])

    const seconds = Number(probed.format.duration)
    expect(seconds).toBeGreaterThan(5.9)
    expect(seconds).toBeLessThan(6.1)
  })

  it('carries the media data over whole and in the order of the fragments', () => {
    const file = muxFragmentedMp4([video, audio])

    // Not a byte of the material is rewritten: the muxer works on the boxes around it. The order
    // is the interleaved one, so this fixes both what got into the file and where.
    expect(digest(...mediaOf(file))).toBe(
      digest(
        ...mediaOf(videoSegments[0]!),
        ...mediaOf(audioSegments[0]!),
        ...mediaOf(audioSegments[1]!),
        ...mediaOf(videoSegments[1]!),
        ...mediaOf(audioSegments[2]!),
        ...mediaOf(videoSegments[2]!),
        ...mediaOf(audioSegments[3]!),
      ),
    )
  })

  it('follows an absolute data offset to where the fragment ended up', () => {
    const absolute = videoSegments.map(withAbsoluteDataOffset)
    const probed = probe(
      'mux-absolute-offsets.mp4',
      muxFragmentedMp4([{ initBytes: videoInit, segments: absolute }]),
    )

    // The offset was true of the segment on its own and false of the file: a fragment that keeps
    // it reads its samples out of the moov, and the decoder is handed noise.
    expect(probed.streams.map((s) => Number(s.nb_read_frames))).toEqual([VIDEO_FRAMES])
  })

  it('reads the body of a view, not the buffer under it', () => {
    const file = muxFragmentedMp4([
      { initBytes: viewWithOffset(videoInit), segments: videoSegments.map(viewWithOffset) },
      { initBytes: viewWithOffset(audioInit), segments: audioSegments.map(viewWithOffset) },
    ])

    expect(digest(file)).toBe(digest(muxFragmentedMp4([video, audio])))
  })

  it('leaves the material it was given untouched', () => {
    const before = digest(videoInit, ...videoSegments, audioInit, ...audioSegments)
    muxFragmentedMp4([video, audio])

    // The init and the fragments belong to a live session and are saved again on the next click.
    // Renumbering them in place would leave the second file numbered after the first.
    expect(digest(videoInit, ...videoSegments, audioInit, ...audioSegments)).toBe(before)
  })

  it('states the length of the clip, not the length of the video it was cut from', () => {
    // Ten minutes of film in the init, six seconds of it in the fragments. Left as it came, the
    // file says ten minutes: a player then shows the material it has, walks the empty rest of the
    // timeline and calls that the end of the clip.
    const file = muxFragmentedMp4([
      { initBytes: withDeclaredDuration(videoInit, 600), segments: videoSegments },
      { initBytes: withDeclaredDuration(audioInit, 600), segments: audioSegments },
    ])

    // The movie header and both headers of both tracks — every place a file states how long it is.
    for (const seconds of declaredSeconds(file)) expect(seconds).toBeCloseTo(CLIP_SECONDS, 2)
  })

  it('gives ffprobe the length of the clip when the init states the length of the film', () => {
    const probed = probe(
      'mux-declared-duration.mp4',
      muxFragmentedMp4([
        { initBytes: withDeclaredDuration(videoInit, 600), segments: videoSegments },
        { initBytes: withDeclaredDuration(audioInit, 600), segments: audioSegments },
      ]),
    )

    expect(Number(probed.format.duration)).toBeCloseTo(CLIP_SECONDS, 1)
    expect(probed.streams.map((s) => Number(s.nb_read_frames))).toEqual([
      VIDEO_FRAMES,
      AUDIO_FRAMES,
    ])
  })

  it('writes the length of the clip into the wide fields of a version 1 header', () => {
    const file = muxFragmentedMp4([
      { initBytes: asVersion1(withDeclaredDuration(videoInit, 600)), segments: videoSegments },
      { initBytes: asVersion1(withDeclaredDuration(audioInit, 600)), segments: audioSegments },
    ])

    // The same three durations, each eight bytes wide now and each at an offset of its own.
    for (const seconds of declaredSeconds(file)) expect(seconds).toBeCloseTo(CLIP_SECONDS, 2)

    const probed = probe('mux-version-1.mp4', file)
    expect(Number(probed.format.duration)).toBeCloseTo(CLIP_SECONDS, 1)
    expect(probed.streams.map((s) => Number(s.nb_read_frames))).toEqual([
      VIDEO_FRAMES,
      AUDIO_FRAMES,
    ])
  })

  it('states no length at all for a header the fragments give no length to', () => {
    // A track that has collected nothing leaves nothing here to measure the clip by. Zero is what
    // a fragmented file says in that case, and a player works the length out of the fragments;
    // the ten minutes of the source would be a number invented out of material that is not in
    // the file.
    const file = muxFragmentedMp4([
      { initBytes: withDeclaredDuration(videoInit, 600), segments: [] },
    ])

    expect(declaredSeconds(file)).toEqual([0, 0, 0])
  })

  it('measures a clip whose sample durations are stated in the trex alone', () => {
    // The same material described the other way ISO/IEC 14496-12 §8.8.3 allows: nothing about a
    // sample's length in the fragment, all of it in the movie header. dzen.ru delivers its
    // picture exactly so, and read as an instant per fragment it gave a clip of 6 seconds out of
    // 92 — the one segment whose trun happened to state its own samples.
    //
    // Asserted against the tfhd-shaped build of the same bytes rather than against numbers of its
    // own: what has to hold is that the description makes no difference to the file.
    //
    // The picture alone, because the sound of this fixture would hide the failure: its last
    // fragment is a partial one and states its three samples in the trun, so the clip would come
    // out the right length however the fragments in front of it were read.
    const stated = muxFragmentedMp4([video])
    const inTrex = muxFragmentedMp4([
      {
        initBytes: withTrexDefault(videoInit, 1, VIDEO_SAMPLE_TICKS),
        segments: videoSegments.map(withoutTfhdDefault),
      },
    ])

    // Two seconds a segment, three of them: read as instants, the clip ends where its last
    // fragment begins and the file says four seconds of the six it holds.
    for (const seconds of declaredSeconds(inTrex)) expect(seconds).toBeCloseTo(6, 2)
    expect(declaredSeconds(inTrex)).toEqual(declaredSeconds(stated))

    const probed = probe('mux-trex-defaults.mp4', inTrex)
    expect(Number(probed.format.duration)).toBeCloseTo(6, 1)
    expect(probed.streams.map((s) => Number(s.nb_read_frames))).toEqual([VIDEO_FRAMES])
  })

  it('gives the header alone for a track that has collected nothing yet', () => {
    const file = muxFragmentedMp4([{ initBytes: videoInit, segments: [] }])

    expect(topLevelBoxes(file).map((b) => b.type)).toEqual(['ftyp', 'moov'])
  })

  it('gives no file at all when there is nothing to put in one', () => {
    expect(muxFragmentedMp4([])).toHaveLength(0)
    expect(muxFragmentedMp4([{ initBytes: videoSegments[0]!, segments: [] }])).toHaveLength(0)
  })
})
