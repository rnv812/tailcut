import type { Metrics } from './layout'
import { wheelPixels, xToTime, zoomFactorOf, type Viewport } from './view'

/**
 * What a movement of the mouse asks the editor to do.
 *
 * The shapes are the shapes of the matching members of `Action` (Task 10): the field names and the
 * tag are the same, so a gesture is dispatched as it stands and no translation layer sits between
 * the pointer and the reducer. If the two ever drift apart, it is the component that stops
 * compiling — which is the right place to find out.
 */
export type TimelineGesture =
  | { type: 'zoom'; atPx: number; factor: number }
  | { type: 'pan'; dxPx: number }
  | { type: 'seek'; time: number }

/** Everything the pointer has to be resolved against. Rebuilt per event; holds no state. */
export interface Surface {
  view: Viewport
  metrics: Metrics
  laneCount: number
}

export interface WheelInput {
  x: number
  deltaX: number
  deltaY: number
  deltaMode: number
  shift: boolean
}

export interface PointerInput {
  x: number
  y: number
  /** Alt frees a handle from snapping (Task 9); the pan and the scrub do not look at it. */
  alt: boolean
}

export type DragState =
  | { kind: 'scrub' }
  | { kind: 'pan'; x: number; from: number; moved: boolean }
  | null

export interface GestureResult {
  drag: DragState
  gesture: TimelineGesture | null
}

/** Travel below this is a click with a shaky hand, not a drag. */
export const DRAG_SLOP_PX = 3

const nothing: GestureResult = { drag: null, gesture: null }

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

const seekTo = (s: Surface, x: number): TimelineGesture => ({
  type: 'seek',
  time: Math.max(0, xToTime(s.view, x)),
})

export function onPointerDown(s: Surface, input: PointerInput): GestureResult {
  // The ruler is the scrub bar: pressing it puts the playhead where it was pressed and keeps it
  // under the pointer. Everything below the ruler is material, and dragging material moves it.
  if (input.y < s.metrics.rulerHeight) {
    return { drag: { kind: 'scrub' }, gesture: seekTo(s, input.x) }
  }
  return { drag: { kind: 'pan', x: input.x, from: input.x, moved: false }, gesture: null }
}

export function onPointerMove(s: Surface, drag: DragState, input: PointerInput): GestureResult {
  if (!drag) return nothing
  if (drag.kind === 'scrub') return { drag, gesture: seekTo(s, input.x) }

  const moved = drag.moved || Math.abs(input.x - drag.from) >= DRAG_SLOP_PX
  return {
    drag: { kind: 'pan', x: input.x, from: drag.from, moved },
    gesture: { type: 'pan', dxPx: input.x - drag.x },
  }
}

export function onPointerUp(s: Surface, drag: DragState, input: PointerInput): GestureResult {
  // A press on the material that went nowhere was a click, and a click on the timeline means
  // "put the playhead here" — the same thing the ruler does, without stealing the drag.
  if (drag && drag.kind === 'pan' && !drag.moved) return { drag: null, gesture: seekTo(s, input.x) }
  return nothing
}
