import { boxBody, boxesIn, childBoxes, topLevelBoxes, type Box } from './reader'
import type { TrackKind } from '../../shared/types'

/**
 * Where the children of a sample entry begin, counted from the first byte of the entry box.
 *
 * A sample entry is a box with a fixed run of fields in front of whatever describes the codec,
 * and the run is a different length for a picture and for a sound. Both numbers are the sum of
 * the fields ISO/IEC 14496-12 lists, and both are checked against the fixtures: an avc1 of 170
 * bytes holds an avcC, a pasp and a btrt behind 86 of them, an mp4a of 110 holds an esds and a
 * btrt behind 36.
 */
const VIDEO_ENTRY_FIELDS = 86
const AUDIO_ENTRY_FIELDS = 36

/**
 * What versions 1 and 2 of a QuickTime sound entry add behind those 36 bytes.
 *
 * QuickTime numbers its sound entries in the two bytes ISO BMFF calls reserved, at offset 16 of
 * the entry. Version 1 adds four counts of 32 bits; version 2 replaces the rate and the channel
 * count with placeholders and states the real ones in 36 bytes of its own — a struct size, the
 * rate as a float64, the channel count as 32 bits, then words of layout (QTFF, "Sound Sample
 * Description (Version 2)"). Read at the fixed offset either way, the walk for child boxes lands
 * inside those fields, finds no esds, and an AAC track is taken for one nothing can decode.
 */
const AUDIO_V1_EXTRA = 16
const AUDIO_V2_EXTRA = 36

export interface SampleEntry {
  /** avc1 | avc3 | hev1 | hvc1 | vp09 | av01 | mp4a | Opus — the four letters of the entry box. */
  format: string
  trackId: number
  /** Picture: the coded frame size the entry states. Zero for a sound. */
  codedWidth: number
  codedHeight: number
  /** Sound: what the container declares. Zero for a picture. */
  channels: number
  sampleRate: number
  /** avcC, hvcC, vpcC, av1C, dOps, esds, colr, pasp — the body of each, without its box header. */
  children: Map<string, Uint8Array>
  /** The entry as the stsd holds it, header and all: what a writer copies into its own stsd. */
  bytes: Uint8Array
}

/** The track_ID a tkhd states, in either of the box's two versions. */
export function trackIdOf(data: Uint8Array, tkhd: Box): number {
  const view = viewOf(data, tkhd)
  return view.getUint8(0) === 1 ? view.getUint32(20) : view.getUint32(12)
}

export function videoSampleEntry(init: Uint8Array): SampleEntry | null {
  return firstOfKind(init, 'video')
}

export function audioSampleEntry(init: Uint8Array): SampleEntry | null {
  return firstOfKind(init, 'audio')
}

export function sampleEntryOf(init: Uint8Array, trackId: number): SampleEntry | null {
  for (const track of tracksOf(init)) {
    if (track.trackId === trackId) return entryOf(init, track)
  }
  return null
}

export function sampleEntryBytes(init: Uint8Array, trackId: number): Uint8Array | null {
  return sampleEntryOf(init, trackId)?.bytes ?? null
}

interface TrackParts {
  trackId: number
  kind: TrackKind
  stsd: Box
}

function viewOf(data: Uint8Array, box: Box): DataView {
  const body = boxBody(data, box)
  return new DataView(body.buffer, body.byteOffset, body.byteLength)
}

/**
 * The tracks of an init, down to the box that holds their sample entry.
 *
 * parseInit walks the same path and answers a different question — what the track is called and
 * how its time is counted. This one keeps the box, because what is wanted here is bytes: the
 * entry as it lies, to be handed to a decoder or copied into a file being written.
 */
function tracksOf(init: Uint8Array): TrackParts[] {
  const moov = topLevelBoxes(init).find((b) => b.type === 'moov')
  if (!moov) return []

  const tracks: TrackParts[] = []

  for (const trak of childBoxes(init, moov).filter((b) => b.type === 'trak')) {
    const parts = childBoxes(init, trak)
    const tkhd = parts.find((b) => b.type === 'tkhd')
    const mdia = parts.find((b) => b.type === 'mdia')
    if (!tkhd || !mdia || tkhd.size < tkhd.headerSize + 24) continue

    const media = childBoxes(init, mdia)
    const hdlr = media.find((b) => b.type === 'hdlr')
    const minf = media.find((b) => b.type === 'minf')
    if (!hdlr || !minf) continue

    const kind = kindOf(init, hdlr)
    if (!kind) continue

    const stbl = childBoxes(init, minf).find((b) => b.type === 'stbl')
    const stsd = stbl && childBoxes(init, stbl).find((b) => b.type === 'stsd')
    if (!stsd) continue

    tracks.push({ trackId: trackIdOf(init, tkhd), kind, stsd })
  }

  return tracks
}

/** hdlr: version(1) flags(3) pre_defined(4) handler_type(4) */
function kindOf(init: Uint8Array, hdlr: Box): TrackKind | null {
  const body = boxBody(init, hdlr)
  if (body.byteLength < 12) return null
  const type = String.fromCharCode(body[8]!, body[9]!, body[10]!, body[11]!)
  if (type === 'vide') return 'video'
  if (type === 'soun') return 'audio'
  return null
}

function firstOfKind(init: Uint8Array, kind: TrackKind): SampleEntry | null {
  for (const track of tracksOf(init)) {
    if (track.kind !== kind) continue
    const entry = entryOf(init, track)
    if (entry) return entry
  }
  return null
}

/**
 * The first entry of an stsd, taken apart.
 *
 * The first and only the first: a track that changed codec mid-stream would state a second one,
 * and this program does not carry such a track — a change of codec is a change of representation,
 * and the editor keeps a clip inside one.
 */
function entryOf(init: Uint8Array, track: TrackParts): SampleEntry | null {
  const { stsd } = track
  // version and flags, then entry_count, then the entries themselves
  const from = stsd.start + stsd.headerSize + 8
  const entry = boxesIn(init, from, stsd.start + stsd.size)[0]
  if (!entry) return null

  const video = track.kind === 'video'
  if (entry.size < (video ? VIDEO_ENTRY_FIELDS : AUDIO_ENTRY_FIELDS)) return null

  const view = new DataView(init.buffer, init.byteOffset + entry.start, entry.size)
  // The version of the stsd and not of the entry: an stsd of version 1 holds ISO's own
  // AudioSampleEntryV1, which states entry_version 1 in the same two bytes and adds nothing.
  const sound = video ? null : soundFieldsOf(view, init[stsd.start + stsd.headerSize] === 0)
  const fields = sound ? sound.fields : VIDEO_ENTRY_FIELDS
  if (entry.size < fields) return null

  const children = new Map<string, Uint8Array>()
  for (const child of boxesIn(init, entry.start + fields, entry.start + entry.size)) {
    if (!children.has(child.type)) children.set(child.type, boxBody(init, child))
  }

  return {
    format: entry.type,
    trackId: track.trackId,
    codedWidth: video ? view.getUint16(32) : 0,
    codedHeight: video ? view.getUint16(34) : 0,
    channels: sound ? sound.channels : 0,
    sampleRate: sound ? sound.sampleRate : 0,
    children,
    bytes: init.subarray(entry.start, entry.start + entry.size),
  }
}

/** The length of the fixed fields of a sound entry, and what they say, by its version. */
function soundFieldsOf(
  view: DataView,
  quickTime: boolean,
): { fields: number; channels: number; sampleRate: number } {
  const version = quickTime ? view.getUint16(16) : 0
  // A sampling rate is a 16.16 fixed-point number of hertz; nothing in the wild states a
  // fraction of one, and the integer half is what a decoder is configured with.
  const ordinary = { channels: view.getUint16(24), sampleRate: view.getUint32(32) >>> 16 }

  if (version === 1) return { fields: AUDIO_ENTRY_FIELDS + AUDIO_V1_EXTRA, ...ordinary }
  if (version === 2) {
    const fields = AUDIO_ENTRY_FIELDS + AUDIO_V2_EXTRA
    // Too short to hold what it promises: the placeholders are all there is, and they say
    // nothing a decoder could be configured with.
    if (view.byteLength < fields) return { fields, channels: 0, sampleRate: 0 }
    return {
      fields,
      channels: view.getUint32(48),
      sampleRate: Math.round(view.getFloat64(40)),
    }
  }

  // Version 0, and anything QuickTime never defined: the ISO BMFF layout, which is version 0's.
  return { fields: AUDIO_ENTRY_FIELDS, ...ordinary }
}
