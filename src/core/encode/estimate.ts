import { framesOf, type BlockedReason, type ClipPath } from './path'
import { webpGeometry } from '../webp/timing'
import type { EncodeGeometry, EncodingChoice } from './codec'
import { secondsFor, type PaceBook } from './pace'

/**
 * Sources a second encoding will not shrink (§8.4).
 *
 * Material recorded in AV1 or VP9 is already packed by a codec of a generation neither H.264 nor
 * HEVC improves on: measured, HEVC's advantage over H.264 is +0.029 SSIM at 800 kbit/s and
 * +0.0003 at 2 Mbit/s — an advantage where the bits are few and none where they are not. Writing
 * such a picture again is a second encoding of an encoded picture: detail goes, and the file is
 * more likely to grow than to shrink. Four letters of the source's sample entry decide it, and
 * the panel says so before the button is pressed rather than after the file arrives.
 *
 * VP8 is deliberately not here: it is old enough that re-encoding it does shrink the file.
 */
const ALREADY_EFFICIENT = new Set(['av01', 'vp09'])

/**
 * What the panel is entitled to say about one clip, as data.
 *
 * Every member carries where its numbers came from, because the honest answer differs by rung and
 * "about 12 MB" written under all of them would be false under two of them. The component turns
 * this into sentences and adds nothing of its own.
 */
export type Estimate =
  | { kind: 'copy'; bytes: number }
  | {
      kind: 'encode'
      rung: EncodingChoice['kind']
      geometry: EncodeGeometry
      frames: number
      seconds: number | null
      /**
       * Only where a bitrate was asked for. Constant quality does not promise a size — and even
       * where it is a number, it is a floor: the software encoder was measured writing more than
       * it was asked for and never less, so the panel says "no smaller than".
       */
      bytes: number | null
      /** The four letters of the source entry: `avc1`, `vp09`, `av01`. */
      sourceCodec: string
      /** §8.4: this source is already efficient, and re-encoding it will more likely inflate it. */
      inflates: boolean
      /** The weight of the same material copied, which is the one number always known. */
      sourceBytes: number
    }
  | {
      kind: 'webp'
      geometry: EncodeGeometry
      frames: number
      seconds: number | null
      /** Measured by encoding a few frames of this very clip, or null until that has answered. */
      bytes: number | null
      sourceBytes: number
    }
  | { kind: 'none'; reason: BlockedReason; geometry: EncodeGeometry }

export interface EstimateInput {
  /** The one answer about this clip. Everything below is what the path cannot know by itself. */
  path: ClipPath
  /** Seconds of the clip: what a bitrate has to be multiplied by. */
  duration: number
  /** The weight of the same material copied. */
  sourceBytes: number
  pace: PaceBook
  /** Bytes the WebP probe came back with, when it has. */
  probedBytes?: number | null
}

/**
 * The estimate, off the path itself.
 *
 * Off the path and not off a handful of fields beside it, because every variant here has to have
 * a variant there to come from — a plain copy used to have none, and fell through to "this
 * machine has no encoder for 1920 × 1080", said about a clip that needs no encoder at all.
 */
export function estimateFor(input: EstimateInput): Estimate {
  const { path } = input

  // The copy: the one estimate that is not an estimate. `plan.bytes` is the sum of the samples
  // the file will hold, so it is the file, give or take a few kilobytes of boxes.
  if (path.kind === 'copy') return { kind: 'copy', bytes: path.plan.bytes }

  if (path.kind === 'blocked') return { kind: 'none', reason: path.reason, geometry: path.geometry }

  if (path.kind === 'webp') {
    // The rate goes in as well as the rectangle: an animation of a ten-frame-a-second recording
    // runs at ten, and a geometry that said fifteen would be a number the panel could not stand
    // behind (`webpGeometry`, task 7 step 1).
    const geometry = webpGeometry(path.plan.crop ?? path.plan.geometry, path.plan.geometry.framerate)
    const frames = framesOf(path) ?? 0
    return {
      kind: 'webp',
      geometry,
      frames,
      seconds: secondsFor(input.pace, 'webp', geometry, frames),
      bytes: input.probedBytes ?? null,
      sourceBytes: input.sourceBytes,
    }
  }

  // The value, not the condition. `const software = path.choice.kind === 'h264-sw'` reads better
  // and does not compile: TypeScript narrows a union through an aliased *condition* only when the
  // discriminant path is made of immutable links, and `ClipPath.choice` is an ordinary mutable
  // property — `path.choice.bitrate` below is then TS2339 on the two hardware rungs. Aliasing the
  // object instead puts the discriminant one step away, where narrowing does hold.
  const choice = path.choice

  return {
    kind: 'encode',
    rung: choice.kind,
    geometry: path.plan.geometry,
    frames: path.plan.kept,
    seconds: secondsFor(input.pace, 'mp4', path.plan.geometry, path.plan.kept),
    // A quantizer decides quality and lets the bytes fall where they will; there is no honest
    // number here, and the panel says so instead of inventing one.
    bytes: choice.kind === 'h264-sw' ? Math.round((choice.bitrate * input.duration) / 8) : null,
    sourceCodec: path.plan.sourceFormat,
    inflates: ALREADY_EFFICIENT.has(path.plan.sourceFormat),
    sourceBytes: input.sourceBytes,
  }
}
