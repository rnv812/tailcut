import { planClip, type ClipRequest, type ClipSource, type PlannedTrack } from '../export/plan'
import { geometryOf, normalizeCrop, type Crop } from './crop'
import { decoderConfigOf, sampleEntryFormat } from './decoder'
import type { EncodeGeometry } from './codec'
import type { Located } from '../../shared/types'

/** One coded frame on its way into the decoder, and what is to become of it. */
export interface FrameToKeep {
  source: Located
  /** Presentation time in ticks of the track, before the head is dropped. */
  pts: number
  /** How long it is shown, in ticks — the duration `planClip` settled on, holes already closed. */
  duration: number
  sync: boolean
  /**
   * False for the frames before the entry point: decoded because the ones after them are
   * predicted from them, never encoded. This is the whole of what replaces the edit list.
   */
  keep: boolean
}

export interface FramePlan {
  /** In decode order — the order they go into the decoder. */
  frames: FrameToKeep[]
  /** How many of them are encoded. The unit progress is counted in. */
  kept: number
  /** Ticks of presentation dropped from the head; equal to the edit the copy path would write. */
  headTicks: number
  /**
   * The entry point in the microseconds WebCodecs counts in.
   *
   * Derived here rather than at the decoder so that the only conversion between the file's ticks
   * and the transport's microseconds happens once, beside the number it is a conversion of.
   */
  headUs: number
  timescale: number
  /**
   * The rectangle of the source picture this clip keeps, in the source's own pixels and already
   * put right by `normalizeCrop`; null when the whole picture is kept.
   *
   * **This is where the crop enters the encoding path, and the only place it enters from.** It
   * comes off `Clip.crop`, which the inspector wrote and the reducer normalised; here it is
   * normalised once more against the coded size of the representation, which is the number the
   * samples are actually in. `geometry` below is this rectangle's size, `decodedFrames` cuts
   * every frame to it, and the encoder is configured with that same size — three things derived
   * from one rectangle, so they cannot come to disagree.
   */
  crop: Crop | null
  /**
   * How the decoder is to be configured for this material: codec string and `description`.
   *
   * On the plan rather than at the decoder because it is a property of the recording, and the
   * recording is what a plan is about. `frames.ts` adds `hardwareAcceleration` to it and nothing
   * else.
   */
  decoder: VideoDecoderConfig
  /** The source sample-entry code, such as `avc1`, `vp09`, or `av01`, used for codec warnings. */
  sourceFormat: string
  geometry: EncodeGeometry
  /** The sound, exactly as the copy path plans it. Not re-encoded, not re-timed, not touched. */
  audio: PlannedTrack | null
  /** Seconds the clip runs — the same number `planClip` states for the same request. */
  duration: number
}

/**
 * What the frame path does to a clip: which samples are decoded, which of them are encoded.
 *
 * Built on `planClip` rather than beside it, and that is the only reason the two cannot drift.
 * The seams are pulled there, the sound is planned there, the entry frame is chosen there; here
 * the picture's samples are re-read with one question added — is this frame shown, or is it only
 * a reference for the frames that are.
 *
 * The answer is by presentation time and nothing else. A decoded `VideoFrame` carries the
 * timestamp its chunk was given, so a frame is kept if it is at or after the entry point,
 * whatever place it took in decode order. Reasoning about decode order here would be reasoning
 * about B-frames, which is a thing this program has no need to know.
 */
export function planFrames(
  source: ClipSource,
  request: ClipRequest,
  crop: Crop | null,
  framerate: number,
): FramePlan | null {
  const plan = planClip(source, request)
  const video = plan.tracks.find((track) => track.kind === 'video')
  // WebCodecs accepts no delta chunk after configure: if retention left no entry point at all,
  // `planClip` has nothing decodable to start from and deliberately leaves the first retained
  // sample in place. Refuse it here instead of handing that delta to a decoder as the first chunk
  // and reporting a generic EncodingError after Export was pressed.
  if (!video || !video.samples.length || !video.samples[0]!.sync) return null

  // Nothing decodes without this, so material this program cannot describe has no frame path at
  // all. Unreachable in practice — every picture codec the recorder admits is in the table — and
  // if it is ever reached, "this clip cannot go through the encoder" is the honest answer.
  const decoder = decoderConfigOf(video.sampleEntry)
  if (!decoder) return null

  const audio = plan.tracks.find((track) => track.kind === 'audio') ?? null

  // The rectangle, put right against the size the samples are actually coded in. The reducer
  // normalised it too, against `ctx.frameSize` — the same number — so this is idempotent; it is
  // here so that a plan can be trusted on its own, without knowing who built the clip.
  const picture = { width: video.width, height: video.height }
  const frame = crop ? normalizeCrop(crop, picture) : null

  // Presentation of a sample inside the file the copy path would write: its decode time rebased
  // on the first sample, plus its composition offset. The entry point sits `skipTicks` into it,
  // by the definition of the edit list — which is what makes the comparison below exact rather
  // than approximate.
  const headUs = Math.round((video.skipTicks * 1_000_000) / video.timescale)

  let dts = 0
  const frames: FrameToKeep[] = video.samples.map((sample) => {
    const pts = dts + sample.cts
    dts += sample.duration
    return {
      source: sample.source,
      pts,
      duration: sample.duration,
      sync: sample.sync,
      // In the transport's microseconds, not in the track's ticks, and that is the whole of the
      // change. `decodedFrames` can only ask a decoded frame for its `timestamp`, which is
      // microseconds; if this said `pts >= video.skipTicks` the two would be two roundings of one
      // boundary, agreeing at every timescale anyone has seen and free to disagree at one nobody
      // has. Disagreement is not a frame out of place — it is a frame the stream hands over that
      // this plan never counted, and its timestamp is the entry frame's own, so the guard in
      // `encodeToTrack` lets it through: a sample is written with no duration left to give it,
      // and the progress runs past its own total.
      keep: Math.round((pts * 1_000_000) / video.timescale) >= headUs,
    }
  })

  const kept = frames.reduce((count, frame) => count + (frame.keep ? 1 : 0), 0)

  // Every frame is a reference and none is shown: the entry point sits past the last sample of
  // the clip. `planClip` cannot produce this — `lastSample` keeps at least one — and if it ever
  // does, an empty file is a worse answer than none.
  if (kept === 0) return null

  return {
    frames,
    kept,
    headTicks: video.skipTicks,
    headUs,
    timescale: video.timescale,
    crop: frame,
    decoder,
    sourceFormat: sampleEntryFormat(video.sampleEntry),
    geometry: geometryOf(frame, picture, framerate),
    audio: request.sound ? audio : null,
    duration: plan.duration,
  }
}
