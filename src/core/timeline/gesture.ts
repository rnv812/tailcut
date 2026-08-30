import { quantize } from './grid'
import { clipsTop, type ClipBand, type Metrics } from './layout'
import { SNAP_TOLERANCE_PX, snapTo, type SnapSet, type SnapTarget } from './snap'
import { timeToX, wheelPixels, xToTime, zoomFactorOf, type Viewport } from './view'

/**
 * What a movement of the mouse asks the editor to do.
 *
 * The shapes match the corresponding `Action` members: field names and tags are identical, so a
 * gesture is dispatched as it stands and no translation layer sits between
 * the pointer and the reducer. If the two ever drift apart, it is the component that stops
 * compiling — which is the right place to find out.
 */
export type TimelineGesture =
  | { type: 'zoom'; atPx: number; factor: number }
  | { type: 'pan'; dxPx: number }
  | { type: 'seek'; time: number }
  | { type: 'trim'; id: string; edge: 'in' | 'out'; time: number }
  | { type: 'selectClip'; id: string | null }

export interface Surface {
  view: Viewport
  metrics: Metrics
  laneCount: number
  clips: readonly ClipBand[]
  /** Which row each clip is drawn on — the same map the scene was laid out with. */
  rows: Map<string, number>
  /** Frame boundaries: every handle lands on one, snapping or not. */
  frames: Float64Array
  snap: SnapSet
  /** Snapping as the user left it; Alt inverts it for the duration of the movement. */
  snapping: boolean
}

export type DragState =
  | { kind: 'scrub' }
  | { kind: 'pan'; x: number; from: number; moved: boolean }
  | { kind: 'handle'; id: string; edge: 'in' | 'out' }
  | null

export interface GestureResult {
  drag: DragState
  gesture: TimelineGesture | null
  /** What the handle is caught on right now, for the line and the caption. Only trims set it. */
  hint?: SnapTarget | null
}

/** How close to a handle the pointer has to come. Wider than the handle is drawn, on purpose. */
export const HANDLE_GRAB_PX = 6

/** Travel below this is a click with a shaky hand, not a drag. */
export const DRAG_SLOP_PX = 3

const nothing: GestureResult = { drag: null, gesture: null }

export interface WheelInput {
  x: number
  deltaX: number
  deltaY: number
  deltaMode: number
  shift: boolean
}

export function onWheel(input: WheelInput): TimelineGesture | null {
  const dy = wheelPixels(input.deltaY, input.deltaMode)
  const dx = wheelPixels(input.deltaX, input.deltaMode)

  // Shift is the long-standing "scroll sideways" of every browser, and a trackpad sends the
  // sideways swipe as deltaX. Both mean pan; a plain wheel over this surface means zoom.
  if (input.shift) return dy === 0 ? null : { type: 'pan', dxPx: -dy }
  if (Math.abs(dx) > Math.abs(dy)) return { type: 'pan', dxPx: -dx }
  if (dy === 0) return null
  return { type: 'zoom', atPx: input.x, factor: zoomFactorOf(dy) }
}

export interface PointerInput {
  x: number
  y: number
  /** Alt frees a handle from snapping; the pan and the scrub do not look at it. */
  alt: boolean
}

const seekTo = (s: Surface, x: number): TimelineGesture => ({
  type: 'seek',
  time: Math.max(0, xToTime(s.view, x)),
})

/** The row of clips a point is in, or -1 if it is in the space between two rows. */
function rowAt(s: Surface, y: number): number {
  const top = clipsTop(s.metrics, s.laneCount)
  if (y < top) return -1
  const pitch = s.metrics.clipHeight + s.metrics.clipGap
  const row = Math.floor((y - top) / pitch)
  return (y - top) % pitch <= s.metrics.clipHeight ? row : -1
}

export function handleAt(s: Surface, x: number, y: number): { id: string; edge: 'in' | 'out' } | null {
  const row = rowAt(s, y)
  if (row < 0) return null

  for (const clip of s.clips) {
    if ((s.rows.get(clip.id) ?? 0) !== row) continue
    if (Math.abs(x - timeToX(s.view, clip.in)) <= HANDLE_GRAB_PX) return { id: clip.id, edge: 'in' }
    if (Math.abs(x - timeToX(s.view, clip.out)) <= HANDLE_GRAB_PX) return { id: clip.id, edge: 'out' }
  }

  return null
}

export function clipAt(s: Surface, x: number, y: number): ClipBand | null {
  const row = rowAt(s, y)
  if (row < 0) return null
  const time = xToTime(s.view, x)

  for (const clip of s.clips) {
    if ((s.rows.get(clip.id) ?? 0) !== row) continue
    if (time >= clip.in && time <= clip.out) return clip
  }

  return null
}

function trim(s: Surface, drag: { kind: 'handle'; id: string; edge: 'in' | 'out' }, input: PointerInput): GestureResult {
  // Alt inverts the setting rather than switching snapping off: with snapping already off, the
  // key is the way to catch a keyframe for one movement without going back to the checkbox.
  const snapping = input.alt ? !s.snapping : s.snapping
  const tolerance = snapping ? SNAP_TOLERANCE_PX * s.view.scale : 0
  const snapped = snapTo(xToTime(s.view, input.x), s.snap, tolerance, drag.id)
  const time = quantize(s.frames, snapped.time)
  // A target the grid then moved away from is not a target the drag can claim to have caught.
  const hint = snapped.hit && Math.abs(time - snapped.time) < 1e-6 ? snapped.hit : null

  return { drag, gesture: { type: 'trim', id: drag.id, edge: drag.edge, time }, hint }
}

export function onPointerDown(s: Surface, input: PointerInput): GestureResult {
  // The ruler is the scrub bar: pressing it puts the playhead where it was pressed and keeps it
  // under the pointer. Everything below the ruler is material, and dragging material moves it.
  if (input.y < s.metrics.rulerHeight) {
    return { drag: { kind: 'scrub' }, gesture: seekTo(s, input.x) }
  }

  if (input.y >= clipsTop(s.metrics, s.laneCount)) {
    const handle = handleAt(s, input.x, input.y)
    // Grabbing selects: the inspector has to be showing the clip whose edge is moving.
    if (handle) return { drag: { kind: 'handle', ...handle }, gesture: { type: 'selectClip', id: handle.id } }
    return { drag: null, gesture: { type: 'selectClip', id: clipAt(s, input.x, input.y)?.id ?? null } }
  }

  return { drag: { kind: 'pan', x: input.x, from: input.x, moved: false }, gesture: null }
}

export function onPointerMove(s: Surface, drag: DragState, input: PointerInput): GestureResult {
  if (!drag) return nothing
  if (drag.kind === 'scrub') return { drag, gesture: seekTo(s, input.x) }
  if (drag.kind === 'handle') return trim(s, drag, input)

  const moved = drag.moved || Math.abs(input.x - drag.from) >= DRAG_SLOP_PX
  return {
    drag: { kind: 'pan', x: input.x, from: drag.from, moved },
    gesture: { type: 'pan', dxPx: input.x - drag.x },
  }
}

export function onPointerUp(s: Surface, drag: DragState, input: PointerInput): GestureResult {
  // A press on the material that went nowhere was a click, and a click on the timeline means
  // "put the playhead here" — the same thing the ruler does, without stealing the drag.
  if (drag && drag.kind === 'handle') return { drag: null, gesture: null, hint: null }
  if (drag && drag.kind === 'pan' && !drag.moved) return { drag: null, gesture: seekTo(s, input.x) }
  return nothing
}
