import type { Span, Zone } from './lanes'

export type SnapKind = 'gap' | 'zone' | 'keyframe' | 'marker' | 'clip' | 'playhead'

/**
 * Order of preference when two targets are the same distance away.
 *
 * A gap edge and a zone boundary are properties of the material — cut past them and the file is
 * wrong or the quality changes mid-clip (§8.3). A keyframe is a property of the compression: §8.2
 * lets a cut fall anywhere with an edit list, so missing one costs nothing but a few copied
 * frames. The rest is the user's own markup, and the playhead is where they happen to stand.
 */
export const SNAP_PRIORITY: readonly SnapKind[] = ['gap', 'zone', 'keyframe', 'marker', 'clip', 'playhead']

/** How close a handle has to come, in pixels. In seconds it depends on the zoom, and should. */
export const SNAP_TOLERANCE_PX = 8

export interface SnapTarget {
  time: number
  kind: SnapKind
  /** What to write beside the line when this one is caught. */
  label: string
  /** The clip a target belongs to, so a handle is not offered its own edges. */
  owner?: string
}

/**
 * Targets in two shapes on purpose. There are dozens of the first kind and they are objects;
 * there are thousands of keyframes and they are numbers. A single list would mean walking ten
 * thousand objects on every move of the mouse.
 */
export interface SnapSet {
  targets: SnapTarget[]
  keyframes: Float64Array
}

export interface SnapResult {
  time: number
  hit: SnapTarget | null
}

export interface SnapInput {
  keyframes: Float64Array
  zones: readonly Zone[]
  gaps: readonly Span[]
  markers: readonly { id: string; time: number; label: string }[]
  clips: readonly { id: string; name: string; in: number; out: number }[]
  playhead: number
}

export function snapSet(input: SnapInput): SnapSet {
  const targets: SnapTarget[] = []

  for (const gap of input.gaps) {
    targets.push({ time: gap.start, kind: 'gap', label: 'gap' })
    targets.push({ time: gap.end, kind: 'gap', label: 'gap' })
  }

  for (const zone of input.zones) {
    const label = zone.height > 0 ? `${zone.height}p` : zone.representation
    targets.push({ time: zone.start, kind: 'zone', label })
    targets.push({ time: zone.end, kind: 'zone', label })
  }

  for (const marker of input.markers) {
    targets.push({ time: marker.time, kind: 'marker', label: marker.label })
  }

  for (const clip of input.clips) {
    targets.push({ time: clip.in, kind: 'clip', label: clip.name, owner: clip.id })
    targets.push({ time: clip.out, kind: 'clip', label: clip.name, owner: clip.id })
  }

  targets.push({ time: input.playhead, kind: 'playhead', label: 'playhead' })
  targets.sort((a, b) => a.time - b.time)

  return { targets, keyframes: input.keyframes }
}

const rank = (kind: SnapKind): number => SNAP_PRIORITY.indexOf(kind)

/** Distances closer than this to each other count as equal, and priority decides. */
const TIE = 1e-9

function nearestKeyframe(keyframes: Float64Array, time: number): number | null {
  if (!keyframes.length) return null

  let lo = 0
  let hi = keyframes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid]! < time) lo = mid + 1
    else hi = mid
  }

  const after = keyframes[lo]
  const before = keyframes[lo - 1]
  if (after === undefined) return before ?? null
  if (before === undefined) return after
  return time - before <= after - time ? before : after
}

/**
 * The time a handle should take, and what it caught on the way.
 *
 * A tolerance of zero is free movement — that is what Alt does — and it is not a special case in
 * the caller: nothing is inside a tolerance of zero.
 */
export function snapTo(time: number, set: SnapSet, tolerance: number, exclude?: string): SnapResult {
  if (!(tolerance > 0)) return { time, hit: null }

  const near: SnapTarget[] = []
  for (const target of set.targets) {
    if (target.owner !== undefined && target.owner === exclude) continue
    if (Math.abs(target.time - time) <= tolerance) near.push(target)
  }

  const keyframe = nearestKeyframe(set.keyframes, time)
  if (keyframe !== null && Math.abs(keyframe - time) <= tolerance) {
    near.push({ time: keyframe, kind: 'keyframe', label: 'keyframe' })
  }

  if (!near.length) return { time, hit: null }

  near.sort((a, b) => {
    const delta = Math.abs(a.time - time) - Math.abs(b.time - time)
    return Math.abs(delta) > TIE ? delta : rank(a.kind) - rank(b.kind)
  })

  const hit = near[0]!
  return { time: hit.time, hit }
}
