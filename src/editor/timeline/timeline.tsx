import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import {
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  type DragState,
  type GestureResult,
  type Surface,
  type TimelineGesture,
} from '../../core/timeline/gesture'
import type { Lane } from '../../core/timeline/lanes'
import {
  METRICS,
  layoutScene,
  type ClipBand,
  type MarkerPin,
  type Metrics,
} from '../../core/timeline/layout'
import type { Viewport } from '../../core/timeline/view'
import { PALETTE, paintScene } from './draw'

export interface TimelineProps {
  lanes: Lane[]
  clips: ClipBand[]
  markers: MarkerPin[]
  view: Viewport
  playhead: number
  fps: number
  metrics?: Metrics
  /** The width of the drawing area, in CSS pixels: the viewport is stored, so the owner keeps it. */
  onResize: (widthPx: number) => void
  /** Everything the pointer decides, decided in one place; the component only relays it. */
  onGesture: (gesture: TimelineGesture) => void
}

export function Timeline(props: TimelineProps) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const frame = useRef(0)
  const measured = useRef(-1)
  // The paint runs a frame after the render that asked for it, by which time the props it closed
  // over would be stale; it reads the latest ones instead.
  const latest = useRef(props)
  latest.current = props

  const paint = (): void => {
    frame.current = 0
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return

    const current = latest.current
    const metrics = current.metrics ?? METRICS
    const scene = layoutScene(current.view, metrics, {
      lanes: current.lanes,
      clips: current.clips,
      markers: current.markers,
      playhead: current.playhead,
      fps: current.fps,
    })

    const ratio = globalThis.devicePixelRatio || 1
    const width = Math.round(scene.width * ratio)
    const height = Math.round(scene.height * ratio)
    // Assigning either dimension clears the canvas, so it is done only when it changed.
    if (element.width !== width) element.width = width
    if (element.height !== height) element.height = height
    element.style.height = `${scene.height}px`

    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    paintScene(context, scene, PALETTE)
  }

  const schedule = (): void => {
    if (!frame.current) frame.current = requestAnimationFrame(paint)
  }

  // No dependency list: every render asks for a paint, and the rAF collapses a burst of them
  // into one. A wheel spin delivers a dozen events per frame and must cost one paint.
  useLayoutEffect(() => {
    schedule()
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  })

  useEffect(() => {
    const element = host.current
    if (!element) return
    // Only a change is reported: a ResizeObserver fires its first observation on its own, and a
    // report per observation would push a viewport of the same width through the reducer twice.
    const measure = (): void => {
      const width = Math.round(element.getBoundingClientRect().width)
      if (width === measured.current) return
      measured.current = width
      latest.current.onResize(width)
    }
    measure()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const drag = useRef<DragState>(null)

  const surface = (): Surface => ({
    view: latest.current.view,
    metrics: latest.current.metrics ?? METRICS,
    laneCount: latest.current.lanes.length,
  })

  // The listeners are put on by hand rather than through JSX for two reasons: the wheel has to be
  // non-passive to be able to stop the page from scrolling, and a drag has to keep working after
  // the pointer leaves the canvas, which means the window and not the element. They go on in a
  // layout effect, with the paint and not a frame behind it: a canvas that is on the screen and
  // deaf to the wheel is a canvas the first spin of it scrolls the page instead.
  useLayoutEffect(() => {
    const element = canvas.current
    if (!element) return

    const pointerAt = (event: MouseEvent): { x: number; y: number; alt: boolean } => {
      const box = element.getBoundingClientRect()
      return { x: event.clientX - box.left, y: event.clientY - box.top, alt: event.altKey }
    }

    const apply = (result: GestureResult): void => {
      drag.current = result.drag
      if (result.gesture) latest.current.onGesture(result.gesture)
    }

    const move = (event: MouseEvent): void => apply(onPointerMove(surface(), drag.current, pointerAt(event)))

    const release = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }

    const up = (event: MouseEvent): void => {
      apply(onPointerUp(surface(), drag.current, pointerAt(event)))
      release()
    }

    const down = (event: MouseEvent): void => {
      if (event.button !== 0) return
      apply(onPointerDown(surface(), pointerAt(event)))
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }

    const wheel = (event: WheelEvent): void => {
      const box = element.getBoundingClientRect()
      const gesture = onWheel({
        x: event.clientX - box.left,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        shift: event.shiftKey,
      })
      if (!gesture) return
      event.preventDefault()
      latest.current.onGesture(gesture)
    }

    element.addEventListener('wheel', wheel, { passive: false })
    element.addEventListener('pointerdown', down)
    return () => {
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('pointerdown', down)
      release()
    }
  }, [])

  return (
    <div class="tc-timeline" ref={host} style={{ position: 'relative', width: '100%' }}>
      <canvas ref={canvas} style={{ display: 'block', width: '100%' }} />
    </div>
  )
}
