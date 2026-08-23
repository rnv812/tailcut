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
 * How long one track fragment lasts, in ticks of its own track: the sample durations its trun
 * boxes state, falling back to the default in the tfhd for a trun that states none of its own.
 * Zero when neither of the two carries a duration — a packager that keeps its defaults in the
 * trex alone says nothing here, and inventing a length for such a fragment would be worse.
 *
 * Shared with the muxer, which needs the same number to work out how long a clip is: two readings
 * of one trun would be two chances to read it differently.
 */
export function trafDuration(data: Uint8Array, traf: Box): number {
  const children = childBoxes(data, traf)
  const tfhdBox = children.find((b) => b.type === 'tfhd')
  if (!tfhdBox) return 0

  const { defaultSampleDuration } = parseTfhd(data, tfhdBox)

  let duration = 0
  for (const trun of children.filter((b) => b.type === 'trun')) {
    duration += parseTrunDuration(data, trun, defaultSampleDuration)
  }

  return duration
}

export function parseFragment(data: Uint8Array): FragmentInfo | null {
  const moof = topLevelBoxes(data).find((b) => b.type === 'moof')
  if (!moof) return null

  const traf = childBoxes(data, moof).find((b) => b.type === 'traf')
  if (!traf) return null

  const children = childBoxes(data, traf)
  const tfhdBox = children.find((b) => b.type === 'tfhd')
  const tfdtBox = children.find((b) => b.type === 'tfdt')
  if (!tfhdBox || !tfdtBox) return null

  return {
    trackId: parseTfhd(data, tfhdBox).trackId,
    baseMediaDecodeTime: parseTfdt(data, tfdtBox),
    duration: trafDuration(data, traf),
  }
}
