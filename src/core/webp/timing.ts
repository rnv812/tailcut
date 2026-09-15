import type { EncodeGeometry } from '../encode/codec'

/** Default maximum frame rate; slower sources retain their own rate. */
export const WEBP_FPS = 15

/** Default longest side, adjustable per clip. */
export const WEBP_MAX_SIDE = 640

export interface WebpOptions {
  /** Fit inside this longest side, preserving the crop's aspect ratio without upscaling. */
  maxSide: number
  /** Maximum output frame rate. Slower recordings retain their own frame rate. */
  fps: number
}

export const DEFAULT_WEBP: Readonly<WebpOptions> = { maxSide: WEBP_MAX_SIDE, fps: WEBP_FPS }
export const WEBP_SIDE_LIMIT = 16383
// Frame durations <= 10 ms have implementation-defined playback in WebP (RFC 9649).
export const WEBP_FPS_LIMIT = 60

export function validWebpOptions(options: WebpOptions): boolean {
  return Number.isInteger(options.maxSide) && options.maxSide >= 1 && options.maxSide <= WEBP_SIDE_LIMIT &&
    Number.isFinite(options.fps) && options.fps >= 1 && options.fps <= WEBP_FPS_LIMIT
}

/**
 * The quality `convertToBlob` is asked for — and the ceiling it must stay under.
 *
 * 1.0 is not "the best lossy setting", it is a different codec: `convertToBlob` switches to
 * lossless VP8L, and a ten-second 640×360 clip goes from 4.562 MB at 0.99 to 17.936 MB at 1.0.
 * The number is fixed here rather than exposed, and one is not offered even as a preset.
 */
export const WEBP_QUALITY = 0.75

/**
 * How long each written frame is shown, in whole milliseconds, off the source's own clock.
 *
 * **The rate is not a constant and must never be treated as one.** An animation is written at
 * the selected frame rate *at most*; a recording made at ten frames a second keeps all of them and has to be
 * written at ten, and spacing them at fifteen would play the clip a third too fast — measured,
 * ten seconds of material read back as 6.667 s. So the times come from the frames themselves:
 * `ticks` is the presentation time of every frame the animation writes, ascending, in the
 * track's own timescale, and `endTicks` is where the last of them stops.
 *
 * The format has no timescale, so every boundary is rounded once on its way to milliseconds and
 * the durations are the differences between *rounded boundaries*. That is the cumulative
 * rounding: a constant 33 ms at 30 fps loses 600 ms over a minute, while this sums to
 * `round((endTicks − ticks[0]) × 1000 ÷ timescale)` exactly, whatever the recording did in
 * between — which is what makes it right on material whose frames are not evenly spaced.
 */
export function frameDurations(
  ticks: readonly number[],
  endTicks: number,
  timescale: number,
): number[] {
  if (!ticks.length || timescale <= 0) return []

  const origin = ticks[0]!
  const ms = (at: number): number => Math.round(((at - origin) * 1000) / timescale)

  const out: number[] = []
  for (let k = 0; k < ticks.length; k++) {
    const to = k + 1 < ticks.length ? ticks[k + 1]! : endTicks
    out.push(Math.max(0, ms(to) - ms(ticks[k]!)))
  }
  return out
}

/**
 * Which of the source frames are kept when the animation runs slower than the recording did.
 *
 * The answers are strictly increasing and therefore distinct — the step `sourceFrames / wanted`
 * is at least one, so no two rounded positions can land on the same frame. That is worth saying
 * because two callers count this list: the queue row (`framesOf`) and the file itself, and a
 * repeated index would make the two disagree about one number.
 */
export function keptForRate(sourceFrames: number, sourceFps: number, fps: number): number[] {
  if (fps >= sourceFps) return Array.from({ length: sourceFrames }, (_, i) => i)
  const wanted = Math.max(1, Math.round((sourceFrames * fps) / sourceFps))
  const out: number[] = []
  for (let k = 0; k < wanted; k++) out.push(Math.min(sourceFrames - 1, Math.round((k * sourceFrames) / wanted)))
  return out
}

/**
 * The picture an animation is written at: the crop, fitted under the cap, and the rate.
 *
 * The rate is the lesser of the ceiling and the recording's own, for the same reason
 * `frameDurations` reads the frames' times: a ten-frame-a-second recording is written at ten, and
 * a geometry claiming fifteen would be a number nobody could act on. Zero source rate — a
 * recording with no picture — falls back to the ceiling; there are no frames to write either way.
 */
export function webpGeometry(
  crop: { width: number; height: number },
  sourceFramerate: number,
  options: WebpOptions = DEFAULT_WEBP,
): EncodeGeometry {
  if (!validWebpOptions(options)) throw new Error('Invalid WebP size or frame rate.')
  const longest = Math.max(crop.width, crop.height)
  const scale = Math.min(1, options.maxSide / longest)
  return {
    width: Math.max(1, Math.round(crop.width * scale)),
    height: Math.max(1, Math.round(crop.height * scale)),
    framerate: sourceFramerate > 0 ? Math.min(options.fps, sourceFramerate) : options.fps,
  }
}
