import { buildAudioInit, buildFragment, buildVideoInit, type Sample } from '../iso/build'
import { opusSampleEntry } from '../opus/mp4'
import { OPUS_SAMPLE_RATE, packetSamples, parseOpusHead } from '../opus/packets'
import { vp8Config, vp8SampleEntry } from '../vp8/mp4'
import { vp9Config } from '../vp9/codec'
import { vp9SampleEntry } from '../vp9/mp4'
import { vorbisSampleEntry } from '../vorbis/mp4'
import { parseClusters, type Frame } from './fragment'
import type { InitInfo, TrackInfo } from '../../shared/types'

/**
 * A WebM track turned into an ISO BMFF one, at the boundary where its bytes arrive.
 *
 * A page hands over whatever it chose, and the two containers arrive together more often than
 * apart: YouTube serves its sound as audio/webm; codecs="opus", and its picture as WebM too
 * whenever AV1 is not on offer. A saved file is one container, so somewhere the two have to meet.
 * Here is the earliest place they can, and the cheapest: the coded frames cross over untouched —
 * an Opus packet is an Opus packet in either container, and so is a VP9 frame — and only the
 * description around them is rewritten.
 *
 * Converting on the way in rather than on the way out is what keeps the rest of the program
 * single-format. The registry, the timeline, the selection of material and the muxer all go on
 * seeing nothing but ISO BMFF, and none of them grows a branch per container.
 *
 * Four codecs, and a stream in any other is refused by CodecID rather than guessed at: a track
 * opened here that could never be written would swallow its segments one by one and end up as a
 * stream of nothing inside a file that claims to have one. The same refusal catches a VP9 track
 * whose shape this program cannot describe — see src/core/vp9/codec.ts for what those are and
 * where the description comes from.
 *
 * Two of the four are the older pair, and they are here because a plain file made the case for
 * them: an imageboard's video is VP8 with Vorbis, both are legal inside an mp4, and both play —
 * the measurements are in src/core/vp8/mp4.ts and src/core/vorbis/mp4.ts. What is true of them
 * over a whole file is true of them over a SourceBuffer, so the boundary takes them here as well
 * rather than leaving a page that opens one short of a whole kind of media.
 */

/** The Matroska CodecIDs this converter reads. */
const OPUS_CODEC_ID = 'A_OPUS'
const VORBIS_CODEC_ID = 'A_VORBIS'
const VP9_CODEC_ID = 'V_VP9'
const VP8_CODEC_ID = 'V_VP8'

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
   * The track as it now stands. The codec keeps the name the container gave it — A_OPUS and
   * V_VP9, not the four letters the mp4 sample entry spells — because that name is what
   * identifies the stream to the registry, and it is the page's stream that is being identified,
   * not our rewriting of it. The timescale is the one actually written into the mdhd.
   */
  info: InitInfo
  /** One media segment across, or null when these bytes hold nothing of this track. */
  segment(bytes: Uint8Array): ConvertedSegment | null
}

/**
 * Everything the conversion of one track's media segments turns on, settled once when its init
 * segment is read so that no segment has to work any of it out again.
 */
interface Conversion {
  /** TrackNumber the blocks of this track address — what parseInit reported as trackId. */
  trackNumber: number
  /** Matroska ticks into ticks of the mp4 track. */
  scale: number
  /** Ticks per second the mp4 track is timed in: the number written into its mdhd. */
  timescale: number
  /**
   * The samples are to state their own sync flag, one by one. A picture track has to — seeking to
   * a frame that was predicted from one the player never decoded shows the wrong picture, or
   * none. A sound track does not: every packet of it is a sync sample and its trex says so once.
   */
  statesSync: boolean
  /**
   * How long the final sample of a fragment lasts, in ticks of the mp4 track. Every other sample
   * is measured by the distance to the one after it; the last has no next timestamp, and each
   * codec answers the question with what it has — see the two implementations below.
   */
  tail(frame: Frame, ticks: number[]): number
}

/**
 * Sets up the conversion of one WebM track, or refuses it.
 *
 * `mime` is the type the page opened its SourceBuffer with, verbatim. It is not needed for sound
 * and it is the whole description of a picture: see src/core/vp9/codec.ts.
 *
 * Refused: a stream in a codec not written here, an init declaring more than one track (a muxed
 * WebM would need every one of its tracks converted, and the numbering of the tracks inside one
 * mp4 init is not something this converter writes), an OpusHead that cannot be read, a VP9 track
 * with no usable description or no frame size, a segment whose TimestampScale leaves its times
 * unreadable. Each of those is a null and not a default, so an unsupported stream never reaches
 * the registry looking like a supported one.
 */
export function webmToIso(info: InitInfo, mime?: string): WebmToIso | null {
  const track = info.tracks.length === 1 ? info.tracks[0] : undefined
  if (!track) return null

  // Ticks per second of the Matroska timestamps. Times are scaled through it, so a zero would be
  // a division by zero on every frame.
  if (!(track.timescale > 0)) return null

  if (track.codec === OPUS_CODEC_ID) return opusTrack(track)
  if (track.codec === VORBIS_CODEC_ID) return vorbisTrack(track)
  if (track.codec === VP9_CODEC_ID) return vp9Track(track, mime)
  if (track.codec === VP8_CODEC_ID) return vp8Track(track, mime)
  return null
}

function opusTrack(track: TrackInfo): WebmToIso | null {
  // dOps is built out of the OpusHead and there is nothing else to build it from: the channel
  // count and the pre-skip live nowhere but there.
  const head = track.codecPrivate ? parseOpusHead(track.codecPrivate) : null
  if (!head) return null

  const conversion: Conversion = {
    trackNumber: track.trackId,
    // Matroska ticks to mp4 ticks. Opus decodes at 48 kHz, so that is what the track counts in.
    scale: OPUS_SAMPLE_RATE / track.timescale,
    timescale: OPUS_SAMPLE_RATE,
    statesSync: false,
    // The packet itself answers, exactly: its TOC byte says how long it is. A packet whose length
    // cannot be read comes out as zero — the fragment then understates itself and the map shows a
    // gap, which is what the rest of the program already does with material it cannot measure.
    tail: (frame) => packetSamples(frame.data),
  }

  return {
    initBytes: buildAudioInit({
      trackId: ISO_TRACK_ID,
      timescale: OPUS_SAMPLE_RATE,
      sampleEntry: opusSampleEntry(head),
    }),
    info: {
      tracks: [{ ...track, trackId: ISO_TRACK_ID, timescale: OPUS_SAMPLE_RATE }],
    },
    segment: (bytes) => convertSegment(bytes, conversion),
  }
}

/**
 * A Vorbis track, which needs nothing the init segment does not already carry.
 *
 * Its three setup headers are in the CodecPrivate, which is where a Matroska keeps them and the
 * only place they exist; the rate and the channel count are in the Audio element beside it. So
 * unlike a VP9 picture, a Vorbis track can be described in full the moment its init lands, and
 * there is nothing here to refuse for want of a codec string.
 */
function vorbisTrack(track: TrackInfo): WebmToIso | null {
  // A stream whose codebooks never arrived cannot be started at all, whatever else is known.
  if (!track.codecPrivate || track.codecPrivate.byteLength === 0) return null

  const rate = track.sampleRate ?? 0
  const channels = track.channels ?? 0
  if (!(rate > 0 && channels > 0)) return null

  const conversion: Conversion = {
    trackNumber: track.trackId,
    // Matroska ticks to mp4 ticks. Vorbis decodes at the rate it was encoded at, and the track is
    // timed in that rate — where Opus is fixed at 48 kHz whatever it was fed.
    scale: rate / track.timescale,
    timescale: rate,
    statesSync: false,
    // A Vorbis packet does not state its own length anywhere a reader can get at cheaply: the
    // window size is in the setup headers and which window this packet used is a mode number
    // whose width is only known after the codebooks have been read. So the container's own
    // timeline answers instead — and the answer is the *shortest* step the packets of this
    // fragment went at, not the last of them.
    //
    // The shortest, because the tail must not overrun. Matroska writes its timestamps in whole
    // milliseconds and a Vorbis packet is not a whole number of them — 1024 samples at 22 050 Hz
    // is 46.44 — so the steps come out 46, 47, 46, and the last of them is as likely to be the
    // long one as the short one. Overstated by a millisecond, the fragment ends after the next
    // one begins, and nothing downstream corrects that: `planTrack` widens a sample to close a
    // hole and never narrows one, so the sound would gain a millisecond per fragment and drift
    // away from the picture. Understated, it leaves a gap that shows and that the seam
    // arithmetic already knows what to do with.
    tail: (_frame, ticks) => {
      let shortest = 0
      for (let i = 1; i < ticks.length; i++) {
        const step = ticks[i]! - ticks[i - 1]!
        if (step > 0 && (shortest === 0 || step < shortest)) shortest = step
      }
      return shortest
    },
  }

  return {
    initBytes: buildAudioInit({
      trackId: ISO_TRACK_ID,
      timescale: rate,
      sampleEntry: vorbisSampleEntry({ channels, sampleRate: rate, setup: track.codecPrivate }),
    }),
    info: { tracks: [{ ...track, trackId: ISO_TRACK_ID, timescale: rate }] },
    segment: (bytes) => convertSegment(bytes, conversion),
  }
}

/**
 * A VP8 track, which is described without waiting for anything.
 *
 * The one thing a VP9 track has to be told — what shape its samples are — VP8 does not have: one
 * bit depth, one subsampling, one colour space, and the version that remains is read by a decoder
 * out of every frame. So there is no refusal here for a page that said nothing, and no guess
 * either: see vp8Config.
 */
function vp8Track(track: TrackInfo, mime: string | undefined): WebmToIso | null {
  if (!(track.width > 0 && track.height > 0)) return null

  const timescale = Math.round(track.timescale)
  if (!(timescale > 0)) return null

  const conversion = pictureConversion(track, timescale)

  return {
    initBytes: buildVideoInit({
      trackId: ISO_TRACK_ID,
      timescale,
      width: track.width,
      height: track.height,
      sampleEntry: vp8SampleEntry(vp8Config(mime, track.width, track.height), track.width, track.height),
    }),
    info: { tracks: [{ ...track, trackId: ISO_TRACK_ID, timescale }] },
    segment: (bytes) => convertSegment(bytes, conversion),
  }
}

function vp9Track(track: TrackInfo, mime: string | undefined): WebmToIso | null {
  // The sample entry and the track header both state the frame size, and a picture of no size is
  // not something either of them can describe.
  if (!(track.width > 0 && track.height > 0)) return null

  const config = vp9Config(mime, track.width, track.height)
  if (!config) return null

  // The Matroska ticks per second, kept as they are. An mp4 timescale is a whole number of ticks
  // and the usual TimestampScale of one millisecond gives a round 1000, so the frame times cross
  // over exactly, with no rescaling and nothing to round. An unusual scale that comes out
  // fractional is rounded to the nearest whole number of ticks per second and the timestamps are
  // scaled to match — the ratio is then within a tick of one, and that tick is what a timestamp
  // was measured in anyway.
  const timescale = Math.round(track.timescale)
  if (!(timescale > 0)) return null

  const conversion = pictureConversion(track, timescale)

  return {
    initBytes: buildVideoInit({
      trackId: ISO_TRACK_ID,
      timescale,
      width: track.width,
      height: track.height,
      sampleEntry: vp9SampleEntry(config, track.width, track.height),
    }),
    info: {
      tracks: [{ ...track, trackId: ISO_TRACK_ID, timescale }],
    },
    segment: (bytes) => convertSegment(bytes, conversion),
  }
}

/**
 * How a picture track's times cross over, which is the same for both of the two written here.
 *
 * Neither VP8 nor VP9 reorders its frames, so a block's timestamp is both when the frame is shown
 * and when it is decoded, and the samples state their own sync flag because a seek that lands on
 * a frame predicted from one nobody decoded shows the wrong picture or none.
 */
function pictureConversion(track: TrackInfo, timescale: number): Conversion {
  const scale = timescale / track.timescale

  return {
    trackNumber: track.trackId,
    scale,
    timescale,
    statesSync: true,
    // A SimpleBlock states no duration and a picture frame carries none inside it either. What
    // the container does give is the step the frames go at: a BlockGroup that stated a
    // BlockDuration is believed, and otherwise the distance between the last two frames stands in
    // for it. At the constant frame rate a coded picture track runs at, that step is exact.
    tail: (frame, ticks) => {
      if (frame.duration > 0) return Math.round(frame.duration * scale)
      const last = ticks[ticks.length - 1]
      const before = ticks[ticks.length - 2]
      return last !== undefined && before !== undefined ? last - before : 0
    },
  }
}

function convertSegment(bytes: Uint8Array, conversion: Conversion): ConvertedSegment | null {
  const frames: Frame[] = []
  for (const cluster of parseClusters(bytes)) {
    for (const frame of cluster.frames) {
      if (frame.trackNumber === conversion.trackNumber) frames.push(frame)
    }
  }

  if (!frames.length) return null

  // Blocks of one cluster are written in decode order, but a segment may hold several clusters
  // and a page may deliver them in any order it likes. Sorted here so that the trun states the
  // samples in the order their times run: otherwise a difference between two timestamps — which
  // is what the durations below are — could come out negative. Sorting is safe for every codec
  // this converter takes: none of the four reorders, so presentation order is decode order.
  frames.sort((a, b) => a.timestamp - b.timestamp)

  const ticks = frames.map((frame) => Math.round(frame.timestamp * conversion.scale))
  const base = ticks[0]!
  // Matroska allows a block to be presented before the cluster it sits in, and the first cluster
  // of a stream can carry one. A decode time is unsigned, and there is no honest place before
  // zero to put such a fragment.
  if (base < 0) return null

  const samples: Sample[] = frames.map((frame, index) => {
    const duration = sampleDuration(frame, ticks, index, conversion)
    return conversion.statesSync
      ? { duration, bytes: frame.data, keyframe: frame.keyframe }
      : { duration, bytes: frame.data }
  })

  let covered = 0
  for (const sample of samples) covered += sample.duration

  return {
    bytes: buildFragment(ISO_TRACK_ID, base, samples),
    start: base / conversion.timescale,
    end: (base + covered) / conversion.timescale,
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
 * once a segment, silent but real. A picture track is measured the same way and for the same
 * reason, and there the seam would be a frame shown twice or not at all.
 *
 * The last sample has no next timestamp to measure against, and what answers instead is the one
 * thing that differs between the two codecs — see Conversion.tail.
 */
function sampleDuration(
  frame: Frame,
  ticks: number[],
  index: number,
  conversion: Conversion,
): number {
  const next = ticks[index + 1]
  if (next !== undefined) return next - ticks[index]!
  return conversion.tail(frame, ticks)
}
