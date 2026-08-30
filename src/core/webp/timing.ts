import type { EncodeGeometry } from '../encode/codec'

/**
 * The most frames a second an animation is written at.
 *
 * A ceiling and not a rate: a recording slower than this keeps every frame and is written at its
 * own speed (see `frameDurations`). Not because browsers clamp short durations — measured, they
 * do not: a 17 ms frame plays as 17 ms and ninety of them last a second and a half. Because the
 * bytes grow strictly linearly with the rate, and this is a format that already costs seven to
 * ten times what the same clip costs as MP4. Fifteen is where a loop still reads as motion.
 */
export const WEBP_FPS = 15

/**
 * The longest side an animation is written at.
 *
 * The same reason and the same measurement: bytes go with pixels, and a minute of 1080p as
 * animated WebP is a file nobody wanted. Cropping smaller than this is honoured as it is; a
 * larger picture is fitted into it, and the panel says the size it will actually write.
 */
export const WEBP_MAX_SIDE = 640

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
 * `WEBP_FPS` *at most*; a recording made at ten frames a second keeps all of them and has to be
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
): EncodeGeometry {
  const longest = Math.max(crop.width, crop.height)
  const scale = longest > WEBP_MAX_SIDE ? WEBP_MAX_SIDE / longest : 1
  return {
    width: Math.max(1, Math.round(crop.width * scale)),
    height: Math.max(1, Math.round(crop.height * scale)),
    framerate: sourceFramerate > 0 ? Math.min(WEBP_FPS, sourceFramerate) : WEBP_FPS,
  }
}
