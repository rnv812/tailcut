/**
 * What part of the timeline is on the screen.
 *
 * `scale` is the one number every interaction goes through: pixels of the pointer become seconds
 * by multiplying, seconds become pixels by dividing, and the tolerance of snapping is eight
 * pixels expressed in seconds the same way. Keeping it as seconds-per-pixel rather than
 * pixels-per-second is deliberate: zooming multiplies it, and multiplying is exactly reversible,
 * so a hundred notches out and a hundred back land on the number they started from.
 */
export interface Viewport {
  /** Media time at x = 0, seconds. */
  start: number
  /** Seconds per pixel. */
  scale: number
  /** Width of the drawing area in CSS pixels. */
  widthPx: number
}

export function timeToX(v: Viewport, time: number): number {
  return (time - v.start) / v.scale
}

export function xToTime(v: Viewport, x: number): number {
  return v.start + x * v.scale
}

export function viewEnd(v: Viewport): number {
  return v.start + v.widthPx * v.scale
}

/** Closest two ticks are allowed to stand. */
export const MIN_TICK_PX = 12
/** Closest two labels are allowed to stand. */
export const MIN_LABEL_PX = 84

/**
 * Steps a ruler is allowed to take, in seconds. Round numbers only: a ruler whose step is 0.37 s
 * is unreadable however evenly it is spaced.
 */
const LADDER = [0.04, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/** Multiples of the minor step a major step is allowed to be. */
const MULTIPLES = [1, 2, 4, 5, 10, 20, 25, 50, 100]

function ladderStep(minimum: number): number {
  for (const step of LADDER) if (step >= minimum) return step
  const last = LADDER[LADDER.length - 1]!
  return Math.ceil(minimum / last) * last
}

function multiple(minimum: number): number {
  for (const value of MULTIPLES) if (value >= minimum) return value
  return Math.ceil(minimum / 100) * 100
}

export interface Tick {
  time: number
  /** A major tick carries a label. */
  major: boolean
}

/**
 * The two steps of the ruler.
 *
 * Deep enough in, one frame is wide enough to stand as a tick, and then the ruler counts frames —
 * that is the zoom at which an in point is chosen, and seconds tell nothing there. Further out the
 * step comes off the ladder of round numbers.
 */
export function tickSteps(v: Viewport, fps: number): { minor: number; major: number } {
  const frame = fps > 0 ? 1 / fps : 0
  const minimum = MIN_TICK_PX * v.scale
  const minor = frame > 0 && frame >= minimum ? frame : ladderStep(minimum)
  const major = minor * multiple((MIN_LABEL_PX * v.scale) / minor)
  return { minor, major }
}

export function ticks(v: Viewport, fps: number): Tick[] {
  if (!(v.scale > 0) || v.widthPx <= 0) return []

  const { minor, major } = tickSteps(v, fps)
  const marks: Tick[] = []
  // Negative time is not material: the ruler starts at zero however far left the view is dragged.
  // Clamped twice over, because the ceiling of a hair below zero is -0, and a tick at -0 is a
  // tick every reader of the ruler would have to be told to treat as zero.
  const first = Math.max(0, Math.ceil(Math.max(0, v.start) / minor - 1e-9))
  const last = Math.floor(viewEnd(v) / minor + 1e-9)

  for (let i = first; i <= last; i++) {
    const time = i * minor
    marks.push({ time, major: Math.abs(time / major - Math.round(time / major)) < 1e-6 })
  }

  return marks
}

const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))

/**
 * The label of a major tick.
 *
 * Not the same job as the timecode field of the inspector, which is a fixed HH:MM:SS:FF whatever
 * the number: a ruler drops the hours while the material is short and shows frames only where a
 * frame is what the step counts, because every extra character costs width the next label needs.
 */
export function tickLabel(time: number, majorStep: number, fps: number): string {
  if (majorStep >= 1 || fps <= 0) {
    const whole = Math.floor(time)
    return clock(Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60)
  }

  // Counting in frames rather than seconds keeps 24.9999 s at 25 fps out of "0:24:25".
  const rate = Math.max(1, Math.round(fps))
  const frames = Math.round(time * rate)
  const whole = Math.floor(frames / rate)
  const head = clock(Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60)
  return `${head}:${pad(frames % rate)}`
}

function clock(hours: number, minutes: number, seconds: number): string {
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** What the viewport is allowed to show. */
export interface ViewBounds {
  /** End of the material, seconds. */
  duration: number
  /** Nominal frame rate of the picture; sets the deepest zoom. */
  fps: number
}

/** Deepest zoom: one frame this many pixels wide. Below it there is nothing left to cut by. */
export const FRAME_PX = 40
/** Pixels of wheel travel that multiply the scale by e. */
export const ZOOM_PX_PER_E = 320
/** Air left on both sides when a range is fitted to the screen. */
export const FIT_MARGIN_PX = 24

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

export function zoomLimits(bounds: ViewBounds, widthPx: number): { min: number; max: number } {
  const frame = bounds.fps > 0 ? 1 / bounds.fps : 1 / 30
  const min = frame / FRAME_PX
  const whole = widthPx > 0 && bounds.duration > 0 ? bounds.duration / widthPx : min
  return { min, max: Math.max(min, whole) }
}

/**
 * The viewport inside its limits.
 *
 * Returns the very object it was given when nothing had to move: every action that touches the
 * viewport ends here, and an unchanged object is how the reducer knows the state did not change.
 */
export function clampView(v: Viewport, bounds: ViewBounds): Viewport {
  const limits = zoomLimits(bounds, v.widthPx)
  const scale = clamp(v.scale, limits.min, limits.max)
  const start = clamp(v.start, 0, Math.max(0, bounds.duration - scale * v.widthPx))
  return scale === v.scale && start === v.start ? v : { ...v, scale, start }
}

/**
 * Zoom holding the time under `xPx` in place.
 *
 * At the very edges of the material the anchor gives way to the clamp — the alternative is empty
 * space beyond the last frame, which is worse than a pixel of drift.
 */
export function zoomAt(v: Viewport, xPx: number, factor: number, bounds: ViewBounds): Viewport {
  const anchor = xToTime(v, xPx)
  const limits = zoomLimits(bounds, v.widthPx)
  const scale = clamp(v.scale * factor, limits.min, limits.max)
  if (scale === v.scale) return clampView(v, bounds)
  return clampView({ ...v, scale, start: anchor - xPx * scale }, bounds)
}

/** Zoom anchored on a time: the keyboard has no pointer, so it holds the playhead instead. */
export function zoomToward(v: Viewport, time: number, factor: number, bounds: ViewBounds): Viewport {
  const x = timeToX(v, time)
  const at = x >= 0 && x <= v.widthPx ? x : v.widthPx / 2
  return zoomAt(v, at, factor, bounds)
}

/** Drag right, see earlier time: the material follows the hand. */
export function panBy(v: Viewport, dxPx: number, bounds: ViewBounds): Viewport {
  return clampView({ ...v, start: v.start - dxPx * v.scale }, bounds)
}

export function fitRange(
  v: Viewport,
  range: { start: number; end: number },
  bounds: ViewBounds,
  marginPx = FIT_MARGIN_PX,
): Viewport {
  const usable = Math.max(1, v.widthPx - 2 * marginPx)
  const limits = zoomLimits(bounds, v.widthPx)
  const scale = clamp(Math.max(range.end - range.start, 0) / usable, limits.min, limits.max)
  return clampView({ ...v, scale, start: range.start - marginPx * scale }, bounds)
}

export function fitAll(v: Viewport, bounds: ViewBounds): Viewport {
  return fitRange(v, { start: 0, end: bounds.duration }, bounds, 0)
}

const LINE_PX = 16
const PAGE_PX = 400

/** A wheel speaks in pixels, lines or pages depending on the device; this settles it in pixels. */
export function wheelPixels(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * LINE_PX
  if (deltaMode === 2) return delta * PAGE_PX
  return delta
}

/**
 * Wheel travel as a multiplier of the scale.
 *
 * Exponential, so that a notch one way and a notch the other cancel to the last bit: a viewport
 * that drifts on a rocked wheel loses the place the user was looking at.
 */
export function zoomFactorOf(deltaPx: number): number {
  return Math.exp(deltaPx / ZOOM_PX_PER_E)
}
