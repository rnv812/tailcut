import { forcesEncoder, type Clip } from '../edit/clip'
import type { EditContext } from '../edit/context'
import { planClip, type ClipSource, type ExportPlan } from '../export/plan'
import type { JobKind } from '../export/queue'
import { keptForRate, WEBP_FPS } from '../webp/timing'
import type { Choice, EncodeGeometry, EncodingChoice } from './codec'
import { geometryOf } from './crop'
import { planFrames, type FramePlan } from './plan'

/**
 * Whether a clip is copied or encoded, and the resources required by that path.
 *
 * One value, because it decides three things that must agree: the lane of the queue, the unit the
 * progress is counted in, and which half of the io writes the file. Carried on the request as
 * itself rather than flattened into a `kind` beside a plan beside a frame count — three fields
 * that have to be kept in step are three fields that will one day not be.
 */
export type ClipPath =
  | { kind: 'copy'; plan: ExportPlan }
  | { kind: 'encode'; plan: FramePlan; choice: EncodingChoice }
  | { kind: 'webp'; plan: FramePlan }
  | { kind: 'blocked'; reason: BlockedReason; geometry: EncodeGeometry }

/**
 * Why a clip that needs the encoder is not getting one.
 *
 * `no-encoder` means the codec ladder is empty for this picture. It is a normal capability result,
 * not a failure: the inspector names the geometry and offers to drop the crop. `no-material` —
 * there is no picture to decode, or none `decoderConfigOf` can describe. Unreachable for a clip
 * the editor let the user make, and an answer rather than a throw because this is asked while a
 * panel is being drawn.
 */
export type BlockedReason = 'no-encoder' | 'no-material'

/**
 * The path, and never null: every clip has an answer, including "nothing here can do this".
 *
 * `ctx.keyframes.includes` — `Float64Array` has `includes`, and exact equality is right here:
 * `clip.in` was quantised onto frame boundaries by the same `quantize` that built the table.
 */
export function pathFor(
  clip: Clip,
  source: ClipSource,
  ctx: EditContext,
  choice: Choice | null,
  rewriteHead: boolean,
): ClipPath {
  const request = { in: clip.in, out: clip.out, sound: clip.sound }
  const startsOnKeyframe = ctx.keyframes.includes(clip.in)

  if (!forcesEncoder(clip, startsOnKeyframe, rewriteHead)) {
    return { kind: 'copy', plan: planClip(source, request) }
  }

  const plan = planFrames(source, request, clip.crop, ctx.fps)
  if (!plan) {
    return {
      kind: 'blocked',
      reason: 'no-material',
      geometry: geometryOf(clip.crop, ctx.frameSize, ctx.fps),
    }
  }

  if (clip.format === 'webp') return { kind: 'webp', plan }
  if (!choice || choice.kind === 'none') {
    return { kind: 'blocked', reason: 'no-encoder', geometry: plan.geometry }
  }

  return { kind: 'encode', plan, choice }
}

/** Queue lane for this path: up to three copies run together, while encodes run one at a time. */
export const laneOf = (path: ClipPath): JobKind => (path.kind === 'copy' ? 'copy' : 'encode')

/**
 * Frames this path will write, or undefined for one that counts in bytes.
 *
 * An animation may write fewer than it decodes: `WEBP_FPS` is a **ceiling**, so a recording made
 * faster than that is thinned and one made slower keeps every frame. Either way the number in the
 * queue row is the number of frames that reach the file, and it is counted by the same call that
 * chooses them, so the row and the file cannot disagree.
 */
export const framesOf = (path: ClipPath): number | undefined => {
  if (path.kind === 'encode') return path.plan.kept
  if (path.kind === 'webp') {
    return keptForRate(path.plan.kept, path.plan.geometry.framerate, WEBP_FPS).length
  }
  return undefined
}
