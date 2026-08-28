/**
 * The frame grid: every time a cut is allowed to fall on.
 *
 * It holds frame *boundaries*, not frame starts — the start of every frame plus the end of the
 * last frame of every run. Two things follow, and both are needed. An out point can take in the
 * last frame of the material, because the end of that frame is on the grid. And no point can land
 * inside a gap, because a gap has no boundaries in it: the nearest one is its edge. Inside a run
 * the two coincide anyway — the end of a frame is the start of the next.
 */

/** Boundaries out of a frame table. `pts` and `durations` are the two columns of it. */
export function frameGrid(input: { pts: Float64Array; durations: Float64Array }): Float64Array {
  const times: number[] = []
  const { pts, durations } = input

  for (let i = 0; i < pts.length; i++) {
    const start = pts[i]!
    if (!times.length || start > times[times.length - 1]! + 1e-9) times.push(start)
    const end = start + (durations[i] ?? 0)
    // The end is written only when the next frame does not begin there: inside a run it would be
    // the same number twice, and the grid is searched, so duplicates cost searches.
    const next = pts[i + 1]
    if (next === undefined || next > end + 1e-9) times.push(end)
  }

  return Float64Array.from(times)
}

/** Index of the boundary at or before a time; the first one for anything earlier. */
export function boundaryIndexAt(frames: Float64Array, time: number): number {
  let lo = 0
  let hi = frames.length

  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (frames[mid]! <= time) lo = mid + 1
    else hi = mid
  }

  return Math.max(0, lo - 1)
}

export function boundaryTime(frames: Float64Array, index: number): number {
  if (!frames.length) return 0
  return frames[Math.min(frames.length - 1, Math.max(0, index))]!
}

export function nearestBoundary(frames: Float64Array, time: number): number {
  const at = boundaryIndexAt(frames, time)
  const next = at + 1
  if (next >= frames.length) return at
  return time - frames[at]! <= frames[next]! - time ? at : next
}

/** The nearest time a cut may fall on. An empty grid means no picture: the time stands as it is. */
export function quantize(frames: Float64Array, time: number): number {
  if (!frames.length) return time
  return frames[nearestBoundary(frames, time)]!
}

/** Whole frames forwards or backwards, stopping at the ends of the material. */
export function shiftBy(frames: Float64Array, time: number, steps: number): number {
  if (!frames.length) return time
  return boundaryTime(frames, boundaryIndexAt(frames, time) + steps)
}
