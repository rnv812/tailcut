import { opusSampleEntry } from '../opus/mp4'
import { OPUS_SAMPLE_RATE, parseOpusHead } from '../opus/packets'
import { vp8ConfigOfKeyframe, vp8SampleEntry } from '../vp8/mp4'
import { vp9ConfigOfKeyframe } from '../vp9/bitstream'
import { vp9SampleEntry } from '../vp9/mp4'
import { vorbisSampleEntry } from '../vorbis/mp4'
import { webmEncrypted } from '../webm/encryption'
import { parseInit } from '../webm/init'
import type { WebmFrame } from '../webm/whole'
import type { PlainFile } from './plain'
import { presentationSpan, type SourceTrack } from './plan'
import type { Located, TrackInfo } from '../../shared/types'

/**
 * The tracks of a whole Matroska as one source to save from — the counterpart of `movieTracksOf`
 * next door, and the far side of the same boundary.
 *
 * What comes out is the same `SourceTrack` an mp4 produces, so the cut, the writer and the popup
 * behind them cannot tell the two apart. That is the whole reason the conversion happens here: a
 * Matroska is turned into the vocabulary of an mp4 at the edge, exactly as the captured path
 * turns a WebM segment into an ISO fragment on the way in (src/core/webm/to-iso.ts), and nothing
 * above this line grows a branch per container.
 *
 * Three things have to be produced for each track and each of them comes from somewhere different:
 *
 * - **A sample entry.** Matroska describes a track with a CodecID string and a CodecPrivate blob;
 *   an mp4 wants a four-letter box with a configuration record in it. Four codecs are written
 *   here — VP9, VP8, Opus and Vorbis — which is what the plain web serves in a Matroska. A track
 *   in anything else is left out and the loss is written down, because a file short of a whole
 *   kind of media must not be offered as if it were the video.
 * - **A timescale.** Matroska times everything in one TimestampScale for the whole segment, a
 *   millisecond a tick as every muxer writes it. The picture keeps those ticks — they divide
 *   evenly and there is nothing to round — and the sound is counted in its own sampling rate,
 *   which is what an mp4 audio track conventionally states and what the Opus mapping requires.
 * - **A run of samples.** Every frame the cluster walk found, addressed where it lies in the
 *   file, with a duration each. Matroska states no duration on a block, so a sample lasts until
 *   the next one starts; the last has nothing after it and takes whatever the container stated
 *   for it, or the step before it.
 */

/** The Matroska CodecIDs this program can describe in an mp4. */
const VP9 = 'V_VP9'
const VP8 = 'V_VP8'
const OPUS = 'A_OPUS'
const VORBIS = 'A_VORBIS'

/** One track's frames, sorted, with the numbers the mp4 side counts in worked out. */
interface Converted {
  timescale: number
  sampleEntry: Uint8Array
}

/**
 * A whole Matroska as a `PlainFile`: what it holds, and every sample of it addressed in the file.
 *
 * `bytesOf` fetches one stretch of the file and is called at most once per picture track: a vpcC
 * is written out of the first keyframe, which is the only description of a VP8 or VP9 stream that
 * exists — see src/core/vp9/bitstream.ts for why the bitstream is both allowed and required here
 * where the captured path may not touch it.
 *
 * Null when nothing of the file can be offered: no Tracks to read, no track this program can
 * describe, no frame under any of them. Protection is answered before any of that and answered
 * whole (§5.4): an encrypted file comes back as a `PlainFile` carrying the flag and nothing else,
 * which is what the mp4 side does with a `pssh`.
 */
export async function matroskaFileOf(
  head: Uint8Array,
  frames: readonly WebmFrame[],
  total: number,
  bytesOf: (at: Located) => Promise<Uint8Array | null>,
): Promise<PlainFile | null> {
  if (webmEncrypted(head)) {
    return {
      total,
      tracks: [],
      codecs: [],
      durationSeconds: 0,
      refusedTracks: false,
      encrypted: true,
    }
  }

  const declared = parseInit(head)?.tracks ?? []
  if (declared.length === 0) return null

  const tracks: SourceTrack[] = []

  for (const track of declared) {
    const own = frames
      .filter((frame) => frame.trackNumber === track.trackId)
      .sort((a, b) => a.timestamp - b.timestamp)
    if (own.length === 0) continue

    const converted = await describe(track, own, bytesOf)
    if (!converted) continue

    const samples = samplesOf(own, track.timescale, converted.timescale)
    if (!samples) continue

    tracks.push({
      kind: track.kind,
      timescale: converted.timescale,
      sampleEntry: converted.sampleEntry,
      width: track.width,
      height: track.height,
      // A Matroska carries no edit list and no composition offset: the block's timestamp is when
      // the frame is shown, and the presentation of the track begins at its first frame.
      editOffset: 0,
      samples,
      // A complete file states each frame once. There is no re-watch to overlap with — that is a
      // property of a recording assembled out of what a player happened to fetch twice.
      dropped: 0,
    })
  }

  if (tracks.length === 0) return null

  let durationSeconds = 0
  for (const track of tracks) {
    const span = presentationSpan(track)
    if (span.end > durationSeconds) durationSeconds = span.end
  }

  const codecs: string[] = []
  for (const track of declared) if (!codecs.includes(track.codec)) codecs.push(track.codec)

  return {
    total,
    tracks,
    codecs,
    durationSeconds,
    // A track the file declares and this could not describe — a codec not written here, a picture
    // of no size, a keyframe that could not be read. Nothing of it reaches the saved file.
    refusedTracks: tracks.length < declared.length,
    encrypted: false,
  }
}

/**
 * How one track is to be described in the mp4, or null when it cannot be.
 *
 * Refused rather than guessed at, in every case: a track opened here that could not be written
 * would end up as a stream of nothing inside a file that claims to have one, which is worse than
 * a file that is honestly short of it.
 */
async function describe(
  track: TrackInfo,
  frames: readonly WebmFrame[],
  bytesOf: (at: Located) => Promise<Uint8Array | null>,
): Promise<Converted | null> {
  // Ticks per second of the Matroska timestamps. A zero would be a division by zero on every
  // frame, and there is no honest substitute for a scale the file did not state.
  if (!(track.timescale > 0)) return null

  if (track.codec === OPUS) {
    // dOps is built out of the OpusHead and there is nothing else to build it from: the channel
    // count and the pre-skip live nowhere but there.
    const head = track.codecPrivate ? parseOpusHead(track.codecPrivate) : null
    if (!head) return null

    return { timescale: OPUS_SAMPLE_RATE, sampleEntry: opusSampleEntry(head) }
  }

  if (track.codec === VORBIS) {
    // The three setup headers, xiph-laced, are the whole of a Vorbis decoder's configuration and
    // a stream without them cannot be started at all.
    if (!track.codecPrivate || track.codecPrivate.byteLength === 0) return null
    if (!(track.sampleRate! > 0) || !(track.channels! > 0)) return null

    return {
      timescale: track.sampleRate!,
      sampleEntry: vorbisSampleEntry({
        channels: track.channels!,
        sampleRate: track.sampleRate!,
        setup: track.codecPrivate,
      }),
    }
  }

  if (track.codec !== VP9 && track.codec !== VP8) return null

  // The sample entry and the track header both state the frame size, and a picture of no size is
  // not something either of them can describe.
  if (!(track.width > 0 && track.height > 0)) return null

  // The Matroska ticks per second, kept whole. The usual scale of a millisecond gives a round
  // 1000, so the frame times cross over exactly; an unusual one that comes out fractional is
  // rounded, and the timestamps are scaled to match.
  const timescale = Math.round(track.timescale)
  if (!(timescale > 0)) return null

  const first = frames.find((frame) => frame.keyframe)
  // A picture track with no keyframe in it cannot be described and could not be cut anyway: a
  // clip has to start at a frame that decodes on its own.
  if (!first) return null

  const bytes = await bytesOf(first.source)
  if (!bytes || bytes.byteLength < first.source.length) return null

  if (track.codec === VP9) {
    const config = vp9ConfigOfKeyframe(bytes)
    return config
      ? { timescale, sampleEntry: vp9SampleEntry(config, track.width, track.height) }
      : null
  }

  const config = vp8ConfigOfKeyframe(bytes)
  return config ? { timescale, sampleEntry: vp8SampleEntry(config, track.width, track.height) } : null
}

/**
 * The frames of one track as samples of an mp4 track, in ticks of it.
 *
 * A sample lasts until the next one starts. Matroska writes its timestamps in whole milliseconds
 * and an Opus packet is 20 ms of 48 kHz samples, which is not a whole number of them: measuring by
 * the distance rather than by each packet's own length keeps the rounding inside the run, so the
 * samples add up to exactly where the track ends and there is no seam anywhere in it. The picture
 * is measured the same way, and there a seam would be a frame shown twice or not at all.
 *
 * The last sample has nothing after it to measure against. What answers instead is whatever the
 * container stated for it — ffmpeg writes the final packet of a track in a BlockGroup with a
 * BlockDuration for exactly this reason — and where it stated nothing, the step before it. At the
 * constant rate a coded picture runs at that step is exact; for a sound whose packet is not a
 * whole number of the container's milliseconds it is within one of them, and the file then claims
 * a millisecond it does not have or gives one up. Which of the two costs nothing here: there is no
 * fragment behind this one to be put in the wrong place, only the end of the material.
 *
 * Null for a track whose times cannot be laid on a timeline: a frame presented before zero, which
 * Matroska allows and a decode time cannot express.
 */
function samplesOf(
  frames: readonly WebmFrame[],
  from: number,
  to: number,
): SourceTrack['samples'] | null {
  const scale = to / from
  const ticks = frames.map((frame) => Math.round(frame.timestamp * scale))
  if (ticks[0]! < 0) return null

  const last = frames.length - 1
  const stated = Math.round(frames[last]!.duration * scale)
  const step = frames.length > 1 ? ticks[last]! - ticks[last - 1]! : 0
  const tail = stated > 0 ? stated : step

  return frames.map((frame, index) => {
    const at = ticks[index]!
    const duration = index < last ? ticks[index + 1]! - at : tail

    return {
      dts: at,
      // None of the four codecs written here reorders its frames, so the time a frame is decoded
      // and the time it is shown are one number: no ctts, no composition offset anywhere.
      pts: at,
      duration,
      sync: frame.keyframe,
      source: frame.source,
    }
  })
}
