import { boxBody, childBoxes, topLevelBoxes, type Box } from './reader'
import type { InitInfo, TrackInfo, TrackKind } from '../../shared/types'

function view(data: Uint8Array, box: Box): DataView {
  const body = boxBody(data, box)
  return new DataView(body.buffer, body.byteOffset, body.byteLength)
}

/** tkhd: version(1) flags(3) [времена] track_id ... width/height в конце. */
function parseTkhd(data: Uint8Array, tkhd: Box): { trackId: number; width: number; height: number } {
  const v = view(data, tkhd)
  const version = v.getUint8(0)
  const trackId = version === 1 ? v.getUint32(20) : v.getUint32(12)
  // width и height — последние два поля, 16.16 с фиксированной точкой
  const width = v.getUint32(v.byteLength - 8) / 65536
  const height = v.getUint32(v.byteLength - 4) / 65536
  return { trackId, width: Math.round(width), height: Math.round(height) }
}

/** mdhd: version(1) flags(3) [времена] timescale ... */
function parseTimescale(data: Uint8Array, mdhd: Box): number {
  const v = view(data, mdhd)
  const version = v.getUint8(0)
  return version === 1 ? v.getUint32(20) : v.getUint32(12)
}

/** hdlr: version(1) flags(3) pre_defined(4) handler_type(4) */
function parseHandler(data: Uint8Array, hdlr: Box): TrackKind | null {
  const body = boxBody(data, hdlr)
  const type = String.fromCharCode(body[8]!, body[9]!, body[10]!, body[11]!)
  if (type === 'vide') return 'video'
  if (type === 'soun') return 'audio'
  return null
}

/** stsd: version(1) flags(3) entry_count(4), затем sample entry — его тип и есть кодек. */
function parseCodec(data: Uint8Array, stsd: Box): string | null {
  const body = boxBody(data, stsd)
  if (body.byteLength < 16) return null
  return String.fromCharCode(body[12]!, body[13]!, body[14]!, body[15]!)
}

/**
 * Sample duration each track's `trex` states, by track_ID; empty when the movie has no `mvex`.
 *
 * The last of the three places a packager may say how long a sample lasts (14496-12 §8.8.3), and
 * on some sites the only one: dzen.ru writes its picture with no durations in the `trun` and no
 * default in the `tfhd`, so a fragment of it can be measured by nothing else. It is read here,
 * once per init segment, and travels on the track — a media segment carries no `moov` to look it
 * up in.
 *
 * trex: version and flags, track_ID, sample_description_index, then default_sample_duration.
 */
function sampleDefaults(data: Uint8Array, moov: Box): Map<number, number> {
  const defaults = new Map<number, number>()

  const mvex = childBoxes(data, moov).find((b) => b.type === 'mvex')
  if (!mvex) return defaults

  for (const trex of childBoxes(data, mvex)) {
    if (trex.type !== 'trex') continue

    const body = boxBody(data, trex)
    // A trex too short to hold the field says nothing rather than being read past its end.
    if (body.byteLength < 16) continue

    const v = new DataView(body.buffer, body.byteOffset, body.byteLength)
    defaults.set(v.getUint32(4), v.getUint32(12))
  }

  return defaults
}

export function parseInit(data: Uint8Array): InitInfo | null {
  const moov = topLevelBoxes(data).find((b) => b.type === 'moov')
  if (!moov) return null

  const defaults = sampleDefaults(data, moov)
  const tracks: TrackInfo[] = []

  for (const trak of childBoxes(data, moov).filter((b) => b.type === 'trak')) {
    const tkhd = childBoxes(data, trak).find((b) => b.type === 'tkhd')
    const mdia = childBoxes(data, trak).find((b) => b.type === 'mdia')
    if (!tkhd || !mdia) continue

    const mdhd = childBoxes(data, mdia).find((b) => b.type === 'mdhd')
    const hdlr = childBoxes(data, mdia).find((b) => b.type === 'hdlr')
    if (!mdhd || !hdlr) continue

    const kind = parseHandler(data, hdlr)
    if (!kind) continue

    const minf = childBoxes(data, mdia).find((b) => b.type === 'minf')
    const stbl = minf ? childBoxes(data, minf).find((b) => b.type === 'stbl') : undefined
    const stsd = stbl ? childBoxes(data, stbl).find((b) => b.type === 'stsd') : undefined
    const codec = stsd ? parseCodec(data, stsd) : null
    if (!codec) continue

    const { trackId, width, height } = parseTkhd(data, tkhd)

    tracks.push({
      trackId,
      kind,
      timescale: parseTimescale(data, mdhd),
      codec,
      width,
      height,
      defaultSampleDuration: defaults.get(trackId) ?? 0,
    })
  }

  return tracks.length ? { tracks } : null
}
