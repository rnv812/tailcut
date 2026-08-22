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

  let total = 0
  for (let i = 0; i < sampleCount; i++) {
    const at = offset + i * entrySize
    if (at + 4 > v.byteLength) break
    total += v.getUint32(at)
  }

  return total
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

  const tfhd = parseTfhd(data, tfhdBox)
  const baseMediaDecodeTime = parseTfdt(data, tfdtBox)

  let duration = 0
  for (const trun of children.filter((b) => b.type === 'trun')) {
    duration += parseTrunDuration(data, trun, tfhd.defaultSampleDuration)
  }

  return { trackId: tfhd.trackId, baseMediaDecodeTime, duration }
}
