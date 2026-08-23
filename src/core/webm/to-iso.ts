import { buildAudioInit, buildFragment, type Sample } from '../iso/build'
import { opusSampleEntry } from '../opus/mp4'
import { OPUS_SAMPLE_RATE, packetSamples, parseOpusHead } from '../opus/packets'
import { parseClusters, type Frame } from './fragment'
import type { InitInfo } from '../../shared/types'

/**
 * A WebM track turned into an ISO BMFF one, at the boundary where its bytes arrive.
 *
 * A page hands over whatever it chose, and the two containers arrive together more often than
 * apart: YouTube serves its sound as audio/webm; codecs="opus" beside a picture that is usually
 * mp4. A saved file is one container, so somewhere the two have to meet. Here is the earliest
 * place they can, and the cheapest: the coded frames cross over untouched — an Opus packet is an
 * Opus packet in either container — and only the description around them is rewritten.
 *
 * Converting on the way in rather than on the way out is what keeps the rest of the program
 * single-format. The registry, the timeline, the selection of material and the muxer all go on
 * seeing nothing but ISO BMFF, and none of them grows a branch per container.
 *
 * Opus and nothing else, for now. A WebM video track is refused by codec name rather than guessed
 * at: writing a vp09 sample entry needs facts about the bitstream that Matroska does not carry,
 * and a track opened here that could never be written would swallow its segments one by one and
 * end up as a stream of nothing inside a file that claims to have one.
 */

/** The Matroska CodecID this converter reads. */
const OPUS_CODEC_ID = 'A_OPUS'

/**
 * track_ID of the converted track inside its own init segment. The number only has to be a legal
 * one: a track keeps its own init until it is saved, and the muxer renumbers every track as it
 * lays them into the file.
 */
const ISO_TRACK_ID = 1

/** One media segment, converted, with the stretch of the timeline it covers. */
export interface ConvertedSegment {
  /** moof and mdat: the segment as the rest of the program reads segments. */
  bytes: Uint8Array
  /** Where it begins, in seconds. */
  start: number
  /** Where its samples run out, in the same seconds. */
  end: number
}

/** A track being converted: what it now is, and how its segments come across. */
export interface WebmToIso {
  /** ftyp and moov of the converted track — what a saved file is built out of. */
  initBytes: Uint8Array
  /**
   * The track as it now stands. The codec keeps the name the container gave it — A_OPUS, not the
   * four letters the mp4 sample entry spells — because that name is what identifies the stream to
   * the registry, and it is the page's stream that is being identified, not our rewriting of it.
   * The timescale is the one actually written into the mdhd.
   */
  info: InitInfo
  /** One media segment across, or null when these bytes hold nothing of this track. */
  segment(bytes: Uint8Array): ConvertedSegment | null
}

/**
 * Sets up the conversion of one WebM track, or refuses it.
 *
 * Refused: a stream in a codec not written here, an init declaring more than one track (a muxed
 * WebM would need every one of its tracks converted, and one of them is video), an OpusHead that
 * cannot be read, a segment whose TimestampScale leaves its times unreadable. Each of those is a
 * null and not a default, so an unsupported stream never reaches the registry looking like a
 * supported one.
 */
export function webmToIso(info: InitInfo): WebmToIso | null {
  const track = info.tracks.length === 1 ? info.tracks[0] : undefined
  if (!track || track.codec !== OPUS_CODEC_ID) return null

  // Ticks per second of the Matroska timestamps. Times are scaled through it, so a zero would be
  // a division by zero on every frame.
  if (!(track.timescale > 0)) return null

  // dOps is built out of the OpusHead and there is nothing else to build it from: the channel
  // count and the pre-skip live nowhere but there.
  const head = track.codecPrivate ? parseOpusHead(track.codecPrivate) : null
  if (!head) return null

  /** Matroska ticks to mp4 ticks. Opus decodes at 48 kHz, so that is what the track counts in. */
  const scale = OPUS_SAMPLE_RATE / track.timescale
  const trackNumber = track.trackId

  return {
    initBytes: buildAudioInit({
      trackId: ISO_TRACK_ID,
      timescale: OPUS_SAMPLE_RATE,
      sampleEntry: opusSampleEntry(head),
    }),
    info: {
      tracks: [{ ...track, trackId: ISO_TRACK_ID, timescale: OPUS_SAMPLE_RATE }],
    },
    segment: (bytes) => convertSegment(bytes, trackNumber, scale),
  }
}

function convertSegment(
  bytes: Uint8Array,
  trackNumber: number,
  scale: number,
): ConvertedSegment | null {
  const frames: Frame[] = []
  for (const cluster of parseClusters(bytes)) {
    for (const frame of cluster.frames) {
      if (frame.trackNumber === trackNumber) frames.push(frame)
    }
  }

  if (!frames.length) return null

  // Blocks of one cluster are written in decode order and Opus has no reordering, but a segment
  // may hold several clusters and a page may deliver them in any order it likes. Sorted here so
  // that the trun states the samples in the order their times run: otherwise a difference between
  // two timestamps — which is what the durations below are — could come out negative.
  frames.sort((a, b) => a.timestamp - b.timestamp)

  const ticks = frames.map((frame) => Math.round(frame.timestamp * scale))
  const base = ticks[0]!
  // Matroska allows a block to be presented before the cluster it sits in, and the first cluster
  // of a stream can carry one. A decode time is unsigned, and there is no honest place before
  // zero to put such a fragment.
  if (base < 0) return null

  const samples: Sample[] = frames.map((frame, index) => ({
    duration: sampleDuration(frame, ticks, index),
    bytes: frame.data,
  }))

  let covered = 0
  for (const sample of samples) covered += sample.duration

  return {
    bytes: buildFragment(ISO_TRACK_ID, base, samples),
    start: base / OPUS_SAMPLE_RATE,
    end: (base + covered) / OPUS_SAMPLE_RATE,
  }
}

/**
 * How long one sample lasts.
 *
 * For every sample but the last it is the distance to the one after it. Matroska writes its
 * timestamps in whole milliseconds and an Opus packet is 20 ms of 48 kHz samples, which is not a
 * whole number of them: taking the distance rather than the packet's own length keeps the
 * rounding inside the fragment, so the samples add up to exactly where the next fragment says it
 * starts and the track has no seam at the boundary. Stating the true length of every packet
 * instead would leave a fragment ending a millisecond short of the next one — a gap in the sound
 * once a segment, silent but real.
 *
 * The last sample has no next timestamp to measure against, and that is where the packet itself
 * answers: the TOC byte says how long it is, exactly. A packet whose length cannot be read comes
 * out as zero — the fragment then understates itself and the map shows a gap, which is what the
 * rest of the program already does with material it cannot measure.
 */
function sampleDuration(frame: Frame, ticks: number[], index: number): number {
  const next = ticks[index + 1]
  if (next !== undefined) return next - ticks[index]!
  return packetSamples(frame.data)
}
