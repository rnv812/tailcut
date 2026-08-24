import {
  ID,
  childElements,
  childWithId,
  elementBody,
  readFloat,
  readString,
  readUint,
  segmentLevel,
  type Element,
} from './reader'
import type { InitInfo, TrackInfo, TrackKind } from '../../shared/types'

/**
 * The initialisation segment of a WebM stream: EBML header, Segment, and inside it the Info that
 * fixes the scale of every timestamp and the Tracks that declare what the stream carries.
 *
 * The counterpart of parseInit for ISO BMFF, and it answers in the same shape. What the two read
 * out of their containers is not the same thing under two names, though:
 *
 * - a track is numbered by TrackNumber, not by track_ID, and the numbering starts at one;
 * - the codec is a CodecID string — V_VP9, A_OPUS — where mp4 has a four-letter sample entry;
 * - the setup bytes sit in a CodecPrivate of their own instead of inside the sample entry, so
 *   they are carried out separately for whoever has to rebuild the track elsewhere;
 * - the timescale belongs to the segment rather than to the track: one TimestampScale governs
 *   every cluster, and the per-track number this fills in is the same for all of them.
 */

/** Nanoseconds per tick when the segment names none: the Matroska default of one millisecond. */
export const DEFAULT_TIMESTAMP_SCALE = 1_000_000

/** Nanoseconds in a second — the numerator that turns a TimestampScale into ticks per second. */
const NANOSECONDS_PER_SECOND = 1_000_000_000

const TRACK_TYPE_VIDEO = 1
const TRACK_TYPE_AUDIO = 2

/** Matroska defaults for an audio track that leaves the fields out. */
const DEFAULT_CHANNELS = 1
const DEFAULT_SAMPLING_FREQUENCY = 8000

function kindOf(trackType: number): TrackKind | null {
  if (trackType === TRACK_TYPE_VIDEO) return 'video'
  if (trackType === TRACK_TYPE_AUDIO) return 'audio'
  return null
}

/** Value of a child element read as an unsigned integer, or `fallback` when the child is absent. */
function uintChild(data: Uint8Array, parent: Element, id: number, fallback: number): number {
  const child = childWithId(data, parent, id)
  return child ? readUint(elementBody(data, child)) : fallback
}

/** Frame size the Video element declares; zeros for a track that has no Video element at all. */
function sizeOf(data: Uint8Array, entry: Element): { width: number; height: number } {
  const video = childWithId(data, entry, ID.video)
  if (!video) return { width: 0, height: 0 }

  return {
    width: uintChild(data, video, ID.pixelWidth, 0),
    height: uintChild(data, video, ID.pixelHeight, 0),
  }
}

/**
 * Channel count and sampling rate of an audio track. The Matroska defaults stand in for a field
 * the Audio element leaves out, and for an Audio element that is missing altogether — a track
 * that declares itself audio and then says nothing about the sound is still audio.
 *
 * SamplingFrequency is a float in the container and comes back rounded: 48000.0 is what it says
 * for Opus, and a fractional sampling rate is not a thing any caller can use.
 */
function audioOf(data: Uint8Array, entry: Element): { channels: number; sampleRate: number } {
  const audio = childWithId(data, entry, ID.audio)
  if (!audio) return { channels: DEFAULT_CHANNELS, sampleRate: DEFAULT_SAMPLING_FREQUENCY }

  const frequency = childWithId(data, audio, ID.samplingFrequency)
  const rate = frequency ? readFloat(elementBody(data, frequency)) : DEFAULT_SAMPLING_FREQUENCY

  return {
    channels: uintChild(data, audio, ID.channels, DEFAULT_CHANNELS),
    // A negative or non-finite rate is nonsense from a foreign page; the default is a value the
    // caller can at least divide by.
    sampleRate: rate > 0 ? Math.round(rate) : DEFAULT_SAMPLING_FREQUENCY,
  }
}

export function parseInit(data: Uint8Array): InitInfo | null {
  const level = segmentLevel(data)

  const tracksElement = level.find((e) => e.id === ID.tracks)
  if (!tracksElement) return null

  const info = level.find((e) => e.id === ID.info)
  const scale = info
    ? uintChild(data, info, ID.timestampScale, DEFAULT_TIMESTAMP_SCALE)
    : DEFAULT_TIMESTAMP_SCALE

  // Every time in the stream is a multiple of this. At zero there is no scale to speak of, and a
  // substitute would invent one: such a segment carries no usable time and is refused whole.
  if (!(scale > 0)) return null

  // Ticks per second, so that a caller divides by it exactly as it does for an mp4 track. The
  // usual one-millisecond scale gives a round 1000; an unusual scale may well give a fraction,
  // which is still the honest number to divide by.
  const timescale = NANOSECONDS_PER_SECOND / scale

  const tracks: TrackInfo[] = []

  for (const entry of childElements(data, tracksElement).filter((e) => e.id === ID.trackEntry)) {
    const fields = childElements(data, entry)

    const numberElement = fields.find((e) => e.id === ID.trackNumber)
    const typeElement = fields.find((e) => e.id === ID.trackType)
    const codecElement = fields.find((e) => e.id === ID.codecId)
    if (!numberElement || !typeElement || !codecElement) continue

    // TrackNumber zero is reserved: blocks address their track by this number, so a track that
    // cannot be addressed is of no use to anybody downstream.
    const trackId = readUint(elementBody(data, numberElement))
    if (!(trackId > 0)) continue

    const kind = kindOf(readUint(elementBody(data, typeElement)))
    if (!kind) continue

    const codec = readString(elementBody(data, codecElement))
    if (!codec) continue

    const { width, height } = sizeOf(data, entry)
    const privateElement = fields.find((e) => e.id === ID.codecPrivate)
    const codecPrivate = privateElement ? elementBody(data, privateElement) : undefined

    const track: TrackInfo = { trackId, kind, timescale, codec, width, height }
    if (codecPrivate && codecPrivate.byteLength > 0) track.codecPrivate = codecPrivate

    if (kind === 'audio') {
      const { channels, sampleRate } = audioOf(data, entry)
      track.channels = channels
      track.sampleRate = sampleRate
    }

    tracks.push(track)
  }

  return tracks.length ? { tracks } : null
}
