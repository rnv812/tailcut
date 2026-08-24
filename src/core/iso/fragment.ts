import { boxBody, childBoxes, topLevelBoxes, type Box } from './reader'
import type { FragmentInfo } from '../../shared/types'

const TFHD_BASE_DATA_OFFSET = 0x000001
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008

const TRUN_DATA_OFFSET = 0x000001
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004
const TRUN_SAMPLE_DURATION = 0x000100
const TRUN_SAMPLE_SIZE = 0x000200
const TRUN_SAMPLE_FLAGS = 0x000400
const TRUN_SAMPLE_CTS = 0x000800

function bodyView(data: Uint8Array, box: Box): DataView {
  const body = boxBody(data, box)
  return new DataView(body.buffer, body.byteOffset, body.byteLength)
}

interface Tfhd {
  trackId: number
  defaultSampleDuration: number
}

function parseTfhd(data: Uint8Array, tfhd: Box): Tfhd {
  const v = bodyView(data, tfhd)
  const flags = v.getUint32(0) & 0x00ffffff
  const trackId = v.getUint32(4)

  let offset = 8
  if (flags & TFHD_BASE_DATA_OFFSET) offset += 8
  if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) offset += 4

  const defaultSampleDuration = flags & TFHD_DEFAULT_SAMPLE_DURATION ? v.getUint32(offset) : 0

  return { trackId, defaultSampleDuration }
}

function parseTfdt(data: Uint8Array, tfdt: Box): number {
  const v = bodyView(data, tfdt)
  const version = v.getUint8(0)
  return version === 1 ? Number(v.getBigUint64(4)) : v.getUint32(4)
}

function parseTrunDuration(data: Uint8Array, trun: Box, defaultSampleDuration: number): number {
  const v = bodyView(data, trun)
  const flags = v.getUint32(0) & 0x00ffffff
  const sampleCount = v.getUint32(4)

  if (!(flags & TRUN_SAMPLE_DURATION)) {
    return sampleCount * defaultSampleDuration
  }

  let offset = 8
  if (flags & TRUN_DATA_OFFSET) offset += 4
  if (flags & TRUN_FIRST_SAMPLE_FLAGS) offset += 4

  const entrySize =
    4 +
    (flags & TRUN_SAMPLE_SIZE ? 4 : 0) +
    (flags & TRUN_SAMPLE_FLAGS ? 4 : 0) +
    (flags & TRUN_SAMPLE_CTS ? 4 : 0)

  // sample_count comes out of foreign bytes and may promise anything up to 2^32-1 entries. The
  // walk stops at the end of the box body through break and not continue: continue would give
  // the same answer but spin through billions of empty turns and hang the parse. A truncated
  // trun is then handed back as an ordinary one — the sum of the entries that were readable,
  // with no mark of the truncation in FragmentInfo. A deliberate choice: a broken segment gives
  // an understated duration rather than a refusal to parse, and the price is a silent shift of
  // the next fragment on the PTS map.
  let total = 0
  for (let i = 0; i < sampleCount; i++) {
    const at = offset + i * entrySize
    if (at + 4 > v.byteLength) break
    total += v.getUint32(at)
  }

  return total
}

/**
 * What the movie header said about a track, for a fragment that says nothing about itself.
 *
 * Shaped so that the tracks of a parsed init segment can be handed over as they are: `TrackInfo`
 * satisfies it. Only the two fields are read, and only when the fragment leaves no other way of
 * measuring its samples.
 */
export interface MovieDefaults {
  trackId: number
  /** Ticks one sample of that track lasts, as its `trex` states; absent or zero — none stated. */
  defaultSampleDuration?: number
}

/**
 * How long one track fragment lasts, in ticks of its own track.
 *
 * The three places 14496-12 §8.8.3 allows a sample duration to be stated, read in the order it
 * lays down: the `trun` per sample, then the `default_sample_duration` of the `tfhd` for a `trun`
 * that states none, then the `trex` of the movie for a `tfhd` that states none either. Falling
 * through only the first two used to be enough for every site measured, and then it was not:
 * dzen.ru writes its picture with the length of a sample in the `trex` and nowhere else, and read
 * as zero its fragments measured out as instants — 92 seconds of recording came out as the one
 * segment whose `trun` happened to carry its own samples.
 *
 * Zero when none of the three carries a duration. Nothing is invented for such a fragment.
 *
 * Shared with the muxer, which needs the same number to work out how long a clip is: two readings
 * of one trun would be two chances to read it differently.
 */
export function trafDuration(data: Uint8Array, traf: Box, movieDefault = 0): number {
  const children = childBoxes(data, traf)
  const tfhdBox = children.find((b) => b.type === 'tfhd')
  if (!tfhdBox) return 0

  const { defaultSampleDuration } = parseTfhd(data, tfhdBox)
  const perSample = defaultSampleDuration || movieDefault

  let duration = 0
  for (const trun of children.filter((b) => b.type === 'trun')) {
    duration += parseTrunDuration(data, trun, perSample)
  }

  return duration
}

/**
 * `declared` is what the init segment of this very buffer said about its tracks — pass the tracks
 * of a parsed `InitInfo`. Left out, a fragment that states nothing of its own has no length, which
 * is the honest answer when the movie header is not to hand.
 *
 * **One traf of the moof, the first one it states.** `FragmentInfo` names a single track, and a
 * muxed buffer hands over a moof with a traf per track; what comes back then describes the leading
 * one and says so in `trackId`. That is enough for what asks: the registry lays one chunk per
 * media segment on the map, the segment carries both tracks whichever of them was measured, and
 * the two cover the same stretch of the recording to within the tenths of a second their
 * boundaries differ by. What must not slip is which track the number belongs to — measured against
 * the wrong trex, the 43 packets of a two-second sound fragment come out five and a half seconds
 * long — and that is why the movie default is looked up by `trackId` and not taken from the head
 * of `declared`.
 */
export function parseFragment(
  data: Uint8Array,
  declared: readonly MovieDefaults[] = [],
): FragmentInfo | null {
  const moof = topLevelBoxes(data).find((b) => b.type === 'moof')
  if (!moof) return null

  const traf = childBoxes(data, moof).find((b) => b.type === 'traf')
  if (!traf) return null

  const children = childBoxes(data, traf)
  const tfhdBox = children.find((b) => b.type === 'tfhd')
  const tfdtBox = children.find((b) => b.type === 'tfdt')
  if (!tfhdBox || !tfdtBox) return null

  const { trackId } = parseTfhd(data, tfhdBox)
  // The default of this track and not of the first one declared: a muxed init describes several,
  // and the picture and the sound of one video do not last the same.
  const movieDefault = declared.find((t) => t.trackId === trackId)?.defaultSampleDuration ?? 0

  return {
    trackId,
    baseMediaDecodeTime: parseTfdt(data, tfdtBox),
    duration: trafDuration(data, traf, movieDefault),
  }
}
