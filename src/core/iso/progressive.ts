import {
  dataInformation,
  fileType,
  handler,
  mediaHeader,
  mediaInformationHeader,
  movieHeader,
  trackHeader,
} from './boxes'
import { ascii, boxOf, fullBoxOf, i64, u16, u32, u64 } from './writer'
import type { TrackKind } from '../../shared/types'

/**
 * Writing a clip as an ordinary mp4: a moov that describes every sample, and one mdat holding
 * them all.
 *
 * The capture writes fragments and this does not, and the reason is measured rather than
 * aesthetic. An edit list on a fragmented file is honoured by Chromium alone: ffmpeg 7 trims the
 * sound and not the picture, which is worse than trimming neither; VLC ignores it; `-c copy`
 * erases it. On a progressive file the same three read the same cut. So a clip carries real
 * tables — stts, ctts, stss, stsc, stsz, stco — and the edit list is left with the one job it
 * does everywhere: hiding the head before the frame the user asked for. The tail is cut by not
 * writing the samples, never by shortening the edit; see editList below for why.
 */

/**
 * Ticks per second of the movie timeline.
 *
 * Ninety thousand and not the thousand a packager writes, because this number decides where a
 * clip can end. An edit list states its length in ticks of the movie, and at a thousand a second
 * a 24 fps boundary falls half a tick out — measured: the frame after the out point crept back
 * into the file. At ninety thousand every rate this program is likely to meet divides evenly.
 * The width costs nothing: a tkhd duration is 32 bits, which is thirteen hours at this scale.
 */
export const MOVIE_TIMESCALE = 90000

const MDAT_HEADER_BYTES = 8
const MDAT_LARGE_HEADER_BYTES = 16
const MAX_UINT32 = 0xffffffff

/** One coded frame on its way into the file. */
export interface OutSample {
  /** The coded bytes. Copied into the mdat as they are; a view into a segment is fine. */
  bytes: Uint8Array
  /** How long it lasts, in ticks of the track. */
  duration: number
  /** pts − dts in ticks of the track. Negative is legal and is what a ctts version 1 is for. */
  cts: number
  /** The frame can be decoded on its own — a place a player may seek to. */
  sync: boolean
}

export interface ProgressiveTrack {
  trackId: number
  kind: TrackKind
  timescale: number
  /** The sample entry out of the source init, byte for byte: the pixels are not being touched. */
  sampleEntry: Uint8Array
  width: number
  height: number
  samples: OutSample[]
  /**
   * Ticks of presentation to hide at the head: the distance from the first sample of the file to
   * the frame the user pointed at, plus whatever the source was already hiding. Zero writes no
   * edit list at all.
   *
   * There is no field for the tail on purpose. Everything this file shows, it shows to the end;
   * a shorter clip is a shorter list of samples.
   */
  skipTicks: number
  /** Silence before this track begins, in ticks of this track. */
  delayTicks?: number
}

export interface ProgressiveOptions {
  /**
   * Write the 64-bit chunk offsets and the 64-bit mdat header whatever the size. Chosen by the
   * writer for a file past four gigabytes; the flag is here so that a test can exercise the wide
   * path without producing one.
   */
  largeOffsets?: boolean
}

/**
 * How much presentation a track shows.
 *
 * Not the sum of the durations: the last frame of a reordered picture is composed after the last
 * one is decoded, so the presentation runs past the decode timeline by the delay. Shared with the
 * export plan, which states the length of a clip and must state the same number this does.
 */
export function presentationTicks(track: {
  samples: Array<{ duration: number; cts: number }>
  skipTicks: number
  delayTicks?: number
}): number {
  let decode = 0
  let end = 0
  for (const sample of track.samples) {
    const finish = decode + sample.cts + sample.duration
    if (finish > end) end = finish
    decode += sample.duration
  }

  return Math.max(0, track.delayTicks ?? 0) + Math.max(0, end - track.skipTicks)
}

/**
 * Whether the file has to be written in the wide forms: 64-bit chunk offsets and the 64-bit mdat
 * header that goes with them.
 *
 * `before` is everything standing in front of the material — the ftyp and the moov — because a
 * chunk offset is counted from the start of the file and not from the mdat. Weighing the payload
 * alone would give 32-bit offsets to a clip whose last chunk lies past what they can state, and
 * the only capture that shows it is four gigabytes long, which is why this is a function of its
 * own rather than a comparison inside the writer.
 */
export function needsWideOffsets(before: number, payload: number): boolean {
  return before + MDAT_HEADER_BYTES + payload > MAX_UINT32
}

/**
 * The tracks come out in the order they were given, less the ones holding nothing, and any order
 * is allowed: the picture first is what the export plan happens to build, not something this
 * writer leans on.
 *
 * What it does lean on is that everything counted per track is counted against the list that
 * survives the filter, and never against the list handed in. The two agree only while the empty
 * tracks come last; one standing in front of a written track would otherwise hand that track its
 * neighbour's numbers, and a length taken from an empty track is zero.
 */
export function buildProgressiveMp4(
  tracks: ProgressiveTrack[],
  options: ProgressiveOptions = {},
): Uint8Array {
  // A track with nothing in it would be a trak with empty tables: legal, and a player would open
  // a file promising sound it does not have.
  const written = tracks.filter((track) => track.samples.length > 0)
  if (written.length === 0) return new Uint8Array(0)

  const ftyp = fileType('isom', 0x200, ['isom', 'iso2', 'avc1', 'mp41'])
  const spans = written.map((track) => presentationTicks(track))
  const movieDuration = Math.max(
    ...written.map((track, i) => toMovieTicks(spans[i]!, track.timescale)),
  )

  let payload = 0
  for (const track of written) {
    for (const sample of track.samples) payload += sample.bytes.byteLength
  }

  // The chunk offsets are absolute, so they cannot be written until the moov is as long as it is
  // going to be. Built once with zeroes to be measured, once for keeps: every field is of fixed
  // width, so the second moov comes out exactly the length the first one measured.
  const zeroOffsets = written.map(() => 0)
  const narrow = movieBox(written, spans, movieDuration, zeroOffsets, false)
  const large =
    options.largeOffsets ?? needsWideOffsets(ftyp.byteLength + narrow.byteLength, payload)

  const mdatHeaderBytes = large ? MDAT_LARGE_HEADER_BYTES : MDAT_HEADER_BYTES
  const measured = large ? movieBox(written, spans, movieDuration, zeroOffsets, true) : narrow
  const dataStart = ftyp.byteLength + measured.byteLength + mdatHeaderBytes

  const offsets: number[] = []
  let at = dataStart
  for (const track of written) {
    offsets.push(at)
    for (const sample of track.samples) at += sample.bytes.byteLength
  }

  const moov = movieBox(written, spans, movieDuration, offsets, large)

  const out = new Uint8Array(dataStart + payload)
  out.set(ftyp, 0)
  out.set(moov, ftyp.byteLength)

  const mdatAt = ftyp.byteLength + moov.byteLength
  const header = new DataView(out.buffer, out.byteOffset + mdatAt, mdatHeaderBytes)
  if (large) {
    header.setUint32(0, 1) // size 1: the real one follows the type, in eight bytes
    out.set(ascii('mdat'), mdatAt + 4)
    header.setBigUint64(8, BigInt(mdatHeaderBytes + payload))
  } else {
    header.setUint32(0, mdatHeaderBytes + payload)
    out.set(ascii('mdat'), mdatAt + 4)
  }

  let write = dataStart
  for (const track of written) {
    for (const sample of track.samples) {
      out.set(sample.bytes, write)
      write += sample.bytes.byteLength
    }
  }

  return out
}

function toMovieTicks(ticks: number, timescale: number): number {
  // Floor and not round: this number is where the presentation stops, and a file that claims more
  // of it than it holds is a claim a player acts on. Measured at MOVIE_TIMESCALE 1000, where a
  // 24 fps boundary does not divide evenly, rounding up let the frame after the out point back in.
  return Math.floor((ticks * MOVIE_TIMESCALE) / timescale)
}

function movieBox(
  tracks: ProgressiveTrack[],
  spans: number[],
  movieDuration: number,
  offsets: number[],
  large: boolean,
): Uint8Array {
  return boxOf(
    'moov',
    movieHeader(MOVIE_TIMESCALE, movieDuration, tracks.length + 1),
    ...tracks.map((track, i) => trackBox(track, spans[i]!, offsets[i]!, large)),
  )
}

function trackBox(
  track: ProgressiveTrack,
  span: number,
  offset: number,
  large: boolean,
): Uint8Array {
  let mediaDuration = 0
  for (const sample of track.samples) mediaDuration += sample.duration

  const parts: Uint8Array[] = [
    trackHeader(track.trackId, track.kind, track.width, track.height, toMovieTicks(span, track.timescale)),
  ]
  const edits = editList(track, span)
  if (edits) parts.push(edits)

  parts.push(
    boxOf(
      'mdia',
      mediaHeader(track.timescale, mediaDuration),
      handler(track.kind),
      boxOf(
        'minf',
        mediaInformationHeader(track.kind),
        dataInformation(),
        sampleTable(track, offset, large),
      ),
    ),
  )

  return boxOf('trak', ...parts)
}

/**
 * The edit list: one media entry, optionally preceded by silence.
 *
 * A list of several was the obvious way to skip over the stretches the viewer never watched, and
 * it was measured and rejected: the picture comes out right and the sound does not — ffmpeg butts
 * the entries together and starts the next one at a whole packet, about 90 ms out at the first
 * seam and accumulating. Holes are closed by rewriting the decode timeline instead.
 *
 * The one entry hides the head and nothing else. `segment_duration` looks like the cheap way to
 * drop the tail as well, and it is the trap of this format: ffmpeg and Chromium honour it, VLC
 * ignores it and plays to the end of the material, and `ffmpeg -c copy` erases it outright —
 * measured, seventy frames came back as seventy-one. So the duration written here is simply how
 * much presentation is left after the skip, and a clip that ends early ends early because the
 * samples past its out point were never written.
 */
function editList(track: ProgressiveTrack, span: number): Uint8Array | null {
  const delay = Math.max(0, track.delayTicks ?? 0)
  if (track.skipTicks <= 0 && delay <= 0) return null

  const entries: Uint8Array[] = []
  if (delay > 0) {
    entries.push(
      u64(toMovieTicks(delay, track.timescale)),
      i64(-1),
      u16(1, 0),
    )
  }

  const mediaSpan = Math.max(0, span - delay)
  entries.push(
    u64(toMovieTicks(mediaSpan, track.timescale)),
    i64(Math.max(0, track.skipTicks)),
    u16(1, 0),
  )

  return boxOf(
    'edts',
    fullBoxOf(
      'elst',
      1,
      0,
      u32(delay > 0 ? 2 : 1),
      ...entries,
    ),
  )
}

function sampleTable(track: ProgressiveTrack, offset: number, large: boolean): Uint8Array {
  const parts: Uint8Array[] = [
    fullBoxOf('stsd', 0, 0, u32(1), track.sampleEntry),
    timeToSample(track.samples),
  ]

  const composition = compositionOffsets(track.samples)
  if (composition) parts.push(composition)

  const syncs = syncSamples(track.samples)
  if (syncs) parts.push(syncs)

  parts.push(
    // One chunk a track: every sample of it lies in the mdat in order, which is the whole of what
    // a clip needs. Interleaving buys a network player nothing here — the file is read from disk
    // or from a blob, both of which seek for free.
    fullBoxOf('stsc', 0, 0, u32(1), u32(1, track.samples.length, 1)),
    sampleSizes(track.samples),
    chunkOffsets(offset, large),
  )

  return boxOf('stbl', ...parts)
}

function timeToSample(samples: OutSample[]): Uint8Array {
  const counts: number[] = []
  const deltas: number[] = []

  for (const sample of samples) {
    const last = deltas.length - 1
    if (last >= 0 && deltas[last] === sample.duration) counts[last]! += 1
    else {
      counts.push(1)
      deltas.push(sample.duration)
    }
  }

  const entries = new Uint8Array(counts.length * 8)
  const view = new DataView(entries.buffer)
  for (const [i, count] of counts.entries()) {
    view.setUint32(i * 8, count)
    view.setUint32(i * 8 + 4, Math.max(0, Math.round(deltas[i]!)))
  }

  return fullBoxOf('stts', 0, 0, u32(counts.length), entries)
}

/**
 * The composition offsets, in the version that can state a negative one.
 *
 * Version 0 holds the field unsigned, and material cut at an arbitrary frame produces a first
 * sample whose presentation precedes its decode. Written only when there is something to say:
 * a track whose frames are in order pays no bytes to say so.
 */
function compositionOffsets(samples: OutSample[]): Uint8Array | null {
  if (!samples.some((sample) => sample.cts !== 0)) return null

  const counts: number[] = []
  const offsets: number[] = []

  for (const sample of samples) {
    const last = offsets.length - 1
    if (last >= 0 && offsets[last] === sample.cts) counts[last]! += 1
    else {
      counts.push(1)
      offsets.push(sample.cts)
    }
  }

  const entries = new Uint8Array(counts.length * 8)
  const view = new DataView(entries.buffer)
  for (const [i, count] of counts.entries()) {
    view.setUint32(i * 8, count)
    view.setInt32(i * 8 + 4, Math.round(offsets[i]!))
  }

  return fullBoxOf('ctts', 1, 0, u32(counts.length), entries)
}

/**
 * The samples a player may start from, by number, counted from one.
 *
 * Absent means every sample is one, which is true of every sound track and of nothing else. A
 * picture track that wrote no stss would offer a seek every frame and show a smear at most of
 * them; one that wrote an empty stss would offer none and show nothing.
 */
function syncSamples(samples: OutSample[]): Uint8Array | null {
  if (samples.every((sample) => sample.sync)) return null

  const numbers: number[] = []
  for (const [i, sample] of samples.entries()) if (sample.sync) numbers.push(i + 1)

  return fullBoxOf('stss', 0, 0, u32(numbers.length), u32(...numbers))
}

function sampleSizes(samples: OutSample[]): Uint8Array {
  const entries = new Uint8Array(samples.length * 4)
  const view = new DataView(entries.buffer)
  for (const [i, sample] of samples.entries()) view.setUint32(i * 4, sample.bytes.byteLength)

  // A zero in the first field means the sizes are stated one by one in the table behind it.
  return fullBoxOf('stsz', 0, 0, u32(0, samples.length), entries)
}

function chunkOffsets(offset: number, large: boolean): Uint8Array {
  return large
    ? fullBoxOf('co64', 0, 0, u32(1), u64(offset))
    : fullBoxOf('stco', 0, 0, u32(1), u32(offset))
}
