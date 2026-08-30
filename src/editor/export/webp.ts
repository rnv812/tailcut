import type { FramePlan } from '../../core/encode/plan'
import { packAnimation, type AnimationFrame } from '../../core/webp/riff'
import { frameDurations, keptForRate, webpGeometry, WEBP_FPS, WEBP_QUALITY } from '../../core/webp/timing'
import { decodedFrames, type Codecs, type FrameSource } from './frames'

/**
 * The wrapper `convertToBlob` puts on every still and the animation does not keep: measured.
 *
 * `VP8X` 18 + `ICCP` 464 = 482, and it is 482 in every row of the research artifact rather than a
 * number somebody remembered: `webp/out/w10.json` gives `iccpBytes` 72 300 over 150 frames,
 * 144 600 over 300 and 433 800 over 900. At 640×360 that is 6.8 % of the file, not the 5 % an
 * earlier draft of this plan said.
 */
export const STILL_HEADER_BYTES = 482

/** The RIFF/WEBP prefix around one still, before its top-level chunks. */
const STILL_RIFF_BYTES = 12
/** The ANMF chunk header and its frame rectangle before the still's image chunks. */
const ANMF_ENVELOPE_BYTES = 24
/** RIFF/WEBP + VP8X + ANIM around every animation: 12 + 18 + 14. */
const ANIMATION_HEADER_BYTES = 44

/** Frames the weight probe encodes for real. Three: one is the title card, five is a wait. */
const PROBE_FRAMES = 3

/**
 * Somewhere to draw a frame and get a still back.
 *
 * An interface rather than an `OffscreenCanvas` for the reason everything else in this directory
 * is one: `src/core/**` may not touch the DOM and a unit test has no canvas. `liveSurface` below
 * is the whole of the real thing.
 */
export interface Surface {
  resize(width: number, height: number): void
  /** Draws the whole of a frame into the whole of the surface. */
  draw(frame: VideoFrame): void
  /** The surface as a still `.webp`, at the quality asked for. */
  still(quality: number): Promise<Uint8Array>
}

export function liveSurface(): Surface {
  const canvas = new OffscreenCanvas(1, 1)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser gave no 2d context to draw the animation on.')

  return {
    resize(width, height) {
      canvas.width = width
      canvas.height = height
    },
    // The frame arrives already cut to the crop (§8.5, `decodedFrames`), so this is a fit and
    // nothing else: source rectangle to destination rectangle, both whole, aspect ratio kept
    // because `webpGeometry` scaled both sides by one number.
    draw: (frame) => context.drawImage(frame, 0, 0, canvas.width, canvas.height),
    async still(quality) {
      // Never 1: `convertToBlob` switches to lossless VP8L there, and the same ten seconds go
      // from 4.562 MB to 17.936 MB. `WEBP_QUALITY` is 0.75 and the ceiling is not offered.
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
      return new Uint8Array(await blob.arrayBuffer())
    },
  }
}

/**
 * The presentation times of the frames a clip shows, ascending, and where the last of them stops.
 *
 * The plan is in decode order and an animation plays in presentation order, so the times are
 * sorted here rather than assumed. `end` is the far edge of the last frame — its own time plus
 * its own duration — which is what makes the animation last exactly as long as the clip.
 */
function shownTicks(plan: FramePlan): { ticks: number[]; end: number } {
  const kept = plan.frames.filter((frame) => frame.keep)
  const ticks = kept.map((frame) => frame.pts).sort((a, b) => a - b)
  const end = kept.reduce((far, frame) => Math.max(far, frame.pts + frame.duration), 0)
  return { ticks, end }
}

/**
 * The clip as one animated WebP.
 *
 * The frame loop is `decodedFrames` like everything else on this path, so cropping, back-pressure
 * and cancellation are not written twice. What is here and nowhere else is the thinning — an
 * animation runs at `WEBP_FPS` **at most**, and a recording slower than that keeps every frame —
 * and the durations, which come off the kept frames' own times rather than off a constant rate.
 * A constant rate is the bug this function was written twice for: fifteen frames a second laid
 * over a ten-frame-a-second recording plays ten seconds of material in 6.667.
 */
export async function encodeWebp(
  plan: FramePlan,
  source: FrameSource,
  codecs: Codecs,
  surface: Surface,
  onFrames: (frames: number) => void,
): Promise<Uint8Array | null> {
  const geometry = webpGeometry(plan.crop ?? plan.geometry, plan.geometry.framerate)
  // Positions in the stream, which arrives in presentation order — the order an animation plays.
  const kept = keptForRate(plan.kept, plan.geometry.framerate, WEBP_FPS)
  const keep = new Set(kept)
  const shown = shownTicks(plan)
  const durations = frameDurations(
    kept.map((at) => shown.ticks[at] ?? shown.end),
    shown.end,
    plan.timescale,
  )

  surface.resize(geometry.width, geometry.height)

  const frames: AnimationFrame[] = []
  let seen = 0

  for await (const frame of decodedFrames(plan, source, codecs)) {
    const at = seen
    seen += 1

    try {
      // `decodedFrames` checks before each coded sample. This check covers a burst the decoder
      // already handed back: cancellation stops before another expensive canvas conversion.
      if (source.stale()) break
      if (!keep.has(at)) continue
      surface.draw(frame)
      frames.push({
        bytes: await surface.still(WEBP_QUALITY),
        durationMs: durations[frames.length] ?? 0,
      })
      onFrames(frames.length)
    } finally {
      // Always, and immediately. A held frame is a buffer the collector does not count.
      frame.close()
    }
  }

  // Called off, or a clip with nothing in it: an empty animation is a file that says the work
  // succeeded, and it did not.
  if (source.stale() || !frames.length) return null

  return packAnimation({ width: geometry.width, height: geometry.height, frames })
}

/**
 * Three short runs of the plan, each ending on a frame the animation will keep.
 *
 * A weight probe has to encode real frames of *this* clip — a still title card and a moving crowd
 * differ by a factor of five — and it must not decode the clip to do it. So each run starts at
 * the sync sample before its frame and stops on that frame: three groups of pictures, some sixty
 * frames, against the eighteen hundred a minute holds.
 *
 * `headTicks` and `headUs` are moved to the chosen frame. A future reference can precede that
 * frame in decode order while following it in presentation time, so the consumer below also
 * matches the timestamp exactly instead of treating every frame after the head as the probe.
 */
function probeRuns(plan: FramePlan, count: number): FramePlan[] {
  const runs: FramePlan[] = []
  const kept = plan.frames
    .filter((frame) => frame.keep)
    .slice()
    .sort((a, b) => a.pts - b.pts)
  const samples = Math.min(count, kept.length)
  if (!samples) return runs

  for (let n = 0; n < samples; n++) {
    const wanted = kept[Math.floor(((n + 0.5) * kept.length) / samples)]!
    const at = plan.frames.indexOf(wanted)
    let from = at
    while (from > 0 && !plan.frames[from]!.sync) from -= 1

    runs.push({
      ...plan,
      frames: plan.frames.slice(from, at + 1).map((frame) => ({ ...frame, keep: frame === wanted })),
      kept: 1,
      headTicks: wanted.pts,
      headUs: Math.round((wanted.pts * 1_000_000) / plan.timescale),
    })
  }

  return runs
}

/** The frame selected by one probe run, not a future reference decoded before it. */
const isProbeFrame = (frame: VideoFrame, run: FramePlan): boolean => frame.timestamp === run.headUs

/**
 * What an animation of this clip will weigh, in bytes, by encoding a few frames of it for real.
 *
 * The only number about a WebP worth saying out loud, and the panel says "about" in front of it.
 * The per-still wrapper comes off because the animation does not carry it: 482 bytes of `VP8X`
 * and `ICCP` a frame, which at fifteen frames a second is some seven kilobytes a second and
 * nearly seven per cent of a 640×360 file. The still's RIFF prefix comes off too; the ANMF
 * envelope and the animation's one global header go back on, so the estimate names the file that
 * will actually be saved rather than only the compressed pictures inside it.
 */
export async function probeWebpBytes(
  plan: FramePlan,
  source: FrameSource,
  codecs: Codecs,
  surface: Surface,
): Promise<number | null> {
  const geometry = webpGeometry(plan.crop ?? plan.geometry, plan.geometry.framerate)
  surface.resize(geometry.width, geometry.height)

  const sizes: number[] = []

  for (const run of probeRuns(plan, PROBE_FRAMES)) {
    for await (const frame of decodedFrames(run, source, codecs)) {
      try {
        if (!isProbeFrame(frame, run)) continue
        surface.draw(frame)
        sizes.push((await surface.still(WEBP_QUALITY)).byteLength)
      } finally {
        frame.close()
      }
    }
  }

  if (!sizes.length) return null

  const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length
  const perFrame = average - STILL_HEADER_BYTES - STILL_RIFF_BYTES + ANMF_ENVELOPE_BYTES
  const frames = keptForRate(plan.kept, plan.geometry.framerate, WEBP_FPS).length
  return Math.max(0, Math.round(perFrame * frames + ANIMATION_HEADER_BYTES))
}
