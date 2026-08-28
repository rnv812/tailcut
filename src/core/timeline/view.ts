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
