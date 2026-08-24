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
 * The media_time of the first edit of a track, in its own ticks.
 *
 * It is not noise to be thrown away and not a number to be recomputed: a picture track carries
 * the composition delay of its B-frames there, an AAC track its encoder priming, an Opus track
 * its pre-skip. Every time this program states an entry point it adds to this, never replaces
 * it — a media_time worked out from zero moved a cut by 61 ms and put the sound out of step by
 * 17 ms when it was measured.
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
    if (view.byteLength < 12 || view.getUint32(4) < 1) return 0

    // Version 1 states the times in 64 bits; both versions state media_time signed, and −1 is a
    // legal value meaning an empty edit — a hole at the head, not an offset into the material.
    const media = view.getUint8(0) === 1
      ? Number(view.getBigInt64(16))
      : view.getInt32(12)
    return media > 0 ? media : 0
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
