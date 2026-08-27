import type { Located } from '../../shared/types'
import { boxBody, childBoxes, findBox, topLevelBoxes, type Box } from './reader'
import { trackIdOf } from './entry'

export interface SampleDefaults {
  duration: number
  size: number
  flags: number
}

/**
 * What the movie says about samples a fragment leaves unsaid.
 *
 * The trex is the last of four places sample flags can live, and on our own material it is the
 * only one: the writer in build.ts states them once per track and no fragment repeats them. A
 * reader that skipped it would call every sample of such a track a sync sample, because the bit
 * it looks for is zero in a field that was never read.
 */
export function trackDefaults(init: Uint8Array): Map<number, SampleDefaults> {
  const defaults = new Map<number, SampleDefaults>()
  const mvex = findBox(init, ['moov', 'mvex'])
  if (!mvex) return defaults

  for (const trex of childBoxes(init, mvex).filter((b) => b.type === 'trex')) {
    const view = viewOf(init, trex)
    if (view.byteLength < 24) continue
    defaults.set(view.getUint32(4), {
      duration: view.getUint32(12),
      size: view.getUint32(16),
      flags: view.getUint32(20),
    })
  }

  return defaults
}

/**
 * Where in the material the presentation of a track begins, in its own ticks.
 *
 * It is not noise to be thrown away and not a number to be recomputed: a picture track carries
 * the composition delay of its B-frames there, an AAC track its encoder priming, an Opus track
 * its pre-skip. Every time this program states an entry point it adds to this, never replaces
 * it — a media_time worked out from zero moved a cut by 61 ms and put the sound out of step by
 * 17 ms when it was measured.
 *
 * The first entry of the edit list that names a place in the material, and not simply the first
 * entry. An entry states one media_time (14496-12 §8.6.6), so a track that both holds its head
 * empty for a while and then starts part way into its material needs two of them, and the
 * ordinary shape of that is `[media_time −1, the real one]`. Stopping at entry zero reads the
 * −1, calls the track unoffset and loses exactly the priming or the reordering delay this
 * function exists to carry.
 *
 * What is not read is the length of the empty edit itself — a stretch of presentation with no
 * material under it, counted in ticks of the movie rather than of the track. This program has no
 * place to put one: its timeline is `(pts − editOffset) / timescale` throughout, so a leading
 * blank moves every frame of a track by the same amount and cancels out of every cut made in
 * those seconds. It would not cancel between two tracks whose empty edits differ, and no material
 * measured on any site so far writes one at all.
 */
export function editOffset(init: Uint8Array, trackId: number): number {
  const moov = topLevelBoxes(init).find((b) => b.type === 'moov')
  if (!moov) return 0

  for (const trak of childBoxes(init, moov).filter((b) => b.type === 'trak')) {
    const parts = childBoxes(init, trak)
    const tkhd = parts.find((b) => b.type === 'tkhd')
    if (!tkhd || tkhd.size < tkhd.headerSize + 24 || trackIdOf(init, tkhd) !== trackId) continue

    const edts = parts.find((b) => b.type === 'edts')
    const elst = edts && childBoxes(init, edts).find((b) => b.type === 'elst')
    if (!elst) return 0

    const view = viewOf(init, elst)
    if (view.byteLength < 8) return 0

    // Version 1 states segment_duration and media_time in 64 bits apiece; version 0 in 32. Both
    // put a media_rate of four bytes behind the pair.
    const wide = view.getUint8(0) === 1
    const width = wide ? 20 : 12
    const count = view.getUint32(4)

    for (let i = 0; i < count; i++) {
      const at = 8 + i * width
      // entry_count is four bytes of a foreign file and may promise more than the box holds.
      if (at + width > view.byteLength) break

      const media = wide ? Number(view.getBigInt64(at + 8)) : view.getInt32(at + 4)
      // −1 is the negative media_time the format allows, and it is not a place in the material:
      // it is an empty edit, a hole held at the head before the media starts. Taken as an offset
      // it would shift every frame of the table the wrong way by a tick — and the table is what
      // the cut, the readout and the grid read. The entry behind it is the one to answer with.
      if (media >= 0) return media
    }

    return 0
  }

  return 0
}

function viewOf(data: Uint8Array, box: Box): DataView {
  const body = boxBody(data, box)
  return new DataView(body.buffer, body.byteOffset, body.byteLength)
}

/** tfhd: which of the optional fields the box carries. */
const TFHD_BASE_DATA_OFFSET = 0x000001
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010
const TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020

/** trun: the same for the run of samples behind it. */
const TRUN_DATA_OFFSET = 0x000001
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004
const TRUN_SAMPLE_DURATION = 0x000100
const TRUN_SAMPLE_SIZE = 0x000200
const TRUN_SAMPLE_FLAGS = 0x000400
const TRUN_SAMPLE_CTS = 0x000800

/** The one bit of sample_flags this program reads: a frame no player may start from. */
const SAMPLE_IS_NON_SYNC = 0x00010000

export interface SampleRef {
  /** Decode time in ticks of the track: the tfdt of the fragment plus the durations before it. */
  dts: number
  /** dts plus the composition offset. Runs out of order wherever the material has B-frames. */
  pts: number
  duration: number
  /** Where the coded bytes lie, counted from the first byte of the segment passed in. */
  at: number
  size: number
  sync: boolean
}

export interface TrackSamples {
  trackId: number
  samples: SampleRef[]
}

interface FragmentHeader {
  trackId: number
  baseDataOffset: number
  defaults: SampleDefaults
}

/**
 * Every sample of every track of one media segment.
 *
 * Total by design: the bytes come from a page nobody vouches for, and a segment that cannot be
 * read is an empty list, not an exception thrown into the middle of an editor building a clip.
 * A truncated box costs its traf and no more.
 *
 * **One fragment of the segment, the first one it holds.** A media segment may carry several
 * moof/mdat pairs, and a segment that does has the fragments behind its first silently left out
 * of the index — with no mark of it here or in what comes back. That is a contract and not an
 * oversight: MSE is fed one fragment per media segment by every packager measured, and the
 * capture registry lays one chunk on the map per segment, so a second moof would be material the
 * map has nowhere to put either. The muxer is the one reader that does walk them all
 * (`fragmentsOf` in core/mux.ts), because a save copies bytes rather than placing samples.
 * Should a site turn up that packs fragments together, this is the loop to open first.
 */
export function samplesInSegment(
  segment: Uint8Array,
  defaults: Map<number, SampleDefaults>,
): TrackSamples[] {
  const moof = topLevelBoxes(segment).find((b) => b.type === 'moof')
  if (!moof) return []

  const tracks: TrackSamples[] = []

  for (const traf of childBoxes(segment, moof).filter((b) => b.type === 'traf')) {
    const parts = childBoxes(segment, traf)
    const tfhd = parts.find((b) => b.type === 'tfhd')
    if (!tfhd) continue

    try {
      const header = readHeader(segment, tfhd, moof.start, defaults)
      const tfdt = parts.find((b) => b.type === 'tfdt')
      const samples: SampleRef[] = []

      let dts = tfdt ? readBaseTime(segment, tfdt) : 0
      let at = header.baseDataOffset

      for (const trun of parts.filter((b) => b.type === 'trun')) {
        ;({ dts, at } = readRun(segment, trun, header, dts, at, samples))
      }

      tracks.push({ trackId: header.trackId, samples })
    } catch {
      // A box cut short: the reader stepped off the end of its body. The traf is unreadable and
      // is dropped, and its neighbours are not — a segment half of which arrived is still worth
      // the half that did.
      continue
    }
  }

  return tracks
}

function readHeader(
  segment: Uint8Array,
  tfhd: Box,
  moofStart: number,
  trex: Map<number, SampleDefaults>,
): FragmentHeader {
  const view = viewOf(segment, tfhd)
  const flags = view.getUint32(0) & 0x00ffffff
  const trackId = view.getUint32(4)
  const fallback = trex.get(trackId) ?? { duration: 0, size: 0, flags: 0 }

  let field = 8
  // Where the samples are addressed from. The first byte of the moof unless the box states
  // otherwise — which covers both the default-base-is-moof flag and the older shape that stated
  // nothing at all — and an explicit base_data_offset beats both: the specification says the flag
  // is ignored whenever the field is present. Getting that precedence backwards addresses the
  // mdat from the wrong place on any packager that writes the two together, and does it quietly,
  // because the sizes still add up.
  let baseDataOffset = moofStart
  if (flags & TFHD_BASE_DATA_OFFSET) {
    baseDataOffset = Number(view.getBigUint64(field))
    field += 8
  }
  if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) field += 4

  const defaults = { ...fallback }
  if (flags & TFHD_DEFAULT_SAMPLE_DURATION) {
    defaults.duration = view.getUint32(field)
    field += 4
  }
  if (flags & TFHD_DEFAULT_SAMPLE_SIZE) {
    defaults.size = view.getUint32(field)
    field += 4
  }
  if (flags & TFHD_DEFAULT_SAMPLE_FLAGS) {
    defaults.flags = view.getUint32(field)
  }

  return { trackId, baseDataOffset, defaults }
}

function readBaseTime(segment: Uint8Array, tfdt: Box): number {
  const view = viewOf(segment, tfdt)
  return view.getUint8(0) === 1 ? Number(view.getBigUint64(4)) : view.getUint32(4)
}

function readRun(
  segment: Uint8Array,
  trun: Box,
  header: FragmentHeader,
  startDts: number,
  startAt: number,
  into: SampleRef[],
): { dts: number; at: number } {
  const view = viewOf(segment, trun)
  const version = view.getUint8(0)
  const flags = view.getUint32(0) & 0x00ffffff
  const count = view.getUint32(4)

  let field = 8
  let at = startAt
  if (flags & TRUN_DATA_OFFSET) {
    at = header.baseDataOffset + view.getInt32(field)
    field += 4
  }
  let firstFlags: number | null = null
  if (flags & TRUN_FIRST_SAMPLE_FLAGS) {
    firstFlags = view.getUint32(field)
    field += 4
  }

  const entry =
    (flags & TRUN_SAMPLE_DURATION ? 4 : 0) +
    (flags & TRUN_SAMPLE_SIZE ? 4 : 0) +
    (flags & TRUN_SAMPLE_FLAGS ? 4 : 0) +
    (flags & TRUN_SAMPLE_CTS ? 4 : 0)

  // sample_count is four bytes of a foreign file and may promise anything. Two things bound the
  // walk: the body of the box, and — for a run that states no per-sample field at all, where the
  // body bounds nothing — the length of the segment, since a sample with no bytes is not one.
  const limit = Math.min(count, segment.byteLength)
  let dts = startDts

  for (let i = 0; i < limit; i++) {
    let read = field + i * entry
    if (read + entry > view.byteLength) break

    let duration = header.defaults.duration
    let size = header.defaults.size
    let sampleFlags = header.defaults.flags
    let cts = 0

    if (flags & TRUN_SAMPLE_DURATION) {
      duration = view.getUint32(read)
      read += 4
    }
    if (flags & TRUN_SAMPLE_SIZE) {
      size = view.getUint32(read)
      read += 4
    }
    if (flags & TRUN_SAMPLE_FLAGS) {
      sampleFlags = view.getUint32(read)
      read += 4
    }
    if (flags & TRUN_SAMPLE_CTS) {
      // Version 0 states the offset unsigned; version 1 signed, which is how a file that puts a
      // frame before the one it was predicted from expresses it.
      cts = version === 0 ? view.getUint32(read) : view.getInt32(read)
    }
    if (i === 0 && firstFlags !== null) sampleFlags = firstFlags

    into.push({
      dts,
      pts: dts + cts,
      duration,
      at,
      size,
      sync: (sampleFlags & SAMPLE_IS_NON_SYNC) === 0,
    })

    dts += duration
    at += size
  }

  return { dts, at }
}

/** One media segment, and where its bytes lie in whatever source it was read out of. */
export interface PlacedSegment {
  bytes: Uint8Array
  source: Located
}

/** A sample addressed in that source rather than in the segment it was found in. */
export interface LocatedSample {
  dts: number
  pts: number
  duration: number
  sync: boolean
  source: Located
}

/** Samples of one segment, addressed inside the byte source that segment lies in. */
export function locateSamples(samples: SampleRef[], segment: Located): LocatedSample[] {
  return samples.map((sample) => ({
    dts: sample.dts,
    pts: sample.pts,
    duration: sample.duration,
    sync: sample.sync,
    source: { at: segment.at + sample.at, length: sample.size },
  }))
}

export interface SampleRun {
  /** In decode order, dts ascending, one sample per decode time. */
  samples: LocatedSample[]
  /** How many samples were dropped because that decode time was already taken. */
  dropped: number
}

export interface SampleRunInput {
  /** The segments of one run of the recording, in any order. */
  segments: readonly PlacedSegment[]
  /** Which ISO track of them to walk. */
  trackId: number
  /** What the movie says about samples a fragment leaves unsaid; see `trackDefaults`. */
  defaults: Map<number, SampleDefaults>
  /**
   * Take the only traf of a segment even where it numbers the track something else.
   *
   * A segment carrying one track is free to number its traf anything, and packagers do differ
   * from their own init here; there is only one track it could be about, so the index a clip is
   * cut from takes it as that one. The frame table does not, and the difference is deliberate:
   * the index has an init in hand that describes exactly this representation, while the table is
   * asked for a numbered track and answers about that number or about nothing.
   */
  loneTrack?: boolean
}

/**
 * Every sample of one track across a run of segments, each decode time carried once.
 *
 * **The only place this program turns segments into a sequence of samples.** The frame table the
 * editor draws and steps by and the index a clip is cut from both come through here, and that is
 * the point of the function: they used to walk the segments apiece, one of them dropped the
 * repeats and the other kept them, and a recording of six seconds was previewed as six and
 * written as eight — eight the decoder could not read, because the same coded frames twice in one
 * decode timeline lose a H.264 decoder its reference state.
 *
 * Overlap is ordinary rather than exceptional: a re-watch comes back with boundaries a few frames
 * off, the map keeps any two chunks whose starts differ by a millisecond or more
 * (`SAME_CHUNK_TOLERANCE_SECONDS` in `core/timeline/map.ts`), and both copies are then handed
 * over to be indexed.
 *
 * A sample is its decode time in ticks of the track, and never a time in seconds: seconds are
 * where the rounding lives, and a tolerance in seconds is exactly what let a duplicate through as
 * close-but-not-equal. Of two samples at one decode time the first in run order stays and the
 * later one goes whole — not merged, because half of one copy and half of the other is a frame
 * nobody recorded. The count of the dropped is handed back and not swallowed: a recording that
 * overlaps itself is something the interface will want to say out loud, and a fact thrown away
 * here cannot be said anywhere later.
 */
export function sampleRunOf(input: SampleRunInput): SampleRun {
  const arrived: LocatedSample[] = []

  for (const segment of input.segments) {
    const tracks = samplesInSegment(segment.bytes, input.defaults)
    const found =
      tracks.find((track) => track.trackId === input.trackId) ??
      (input.loneTrack && tracks.length === 1 ? tracks[0] : undefined)
    if (!found) continue

    for (const sample of locateSamples(found.samples, segment.source)) arrived.push(sample)
  }

  // The map keeps its chunks in order of media time, but a caller is free to hand them over in
  // any order at all, and the writer lays samples down exactly as they arrive. The sort is stable
  // — the language says so — which is what makes "the first at this decode time" mean the first
  // that arrived rather than whichever the sort left in front.
  arrived.sort((a, b) => a.dts - b.dts)

  const samples: LocatedSample[] = []
  let dropped = 0

  for (const sample of arrived) {
    if (samples[samples.length - 1]?.dts === sample.dts) {
      dropped++
      continue
    }
    samples.push(sample)
  }

  return { samples, dropped }
}
