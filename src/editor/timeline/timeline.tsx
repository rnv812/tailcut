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
import type { Hover } from '../../core/timeline/hover'
import type { Lane } from '../../core/timeline/lanes'
import {
  METRICS,
  layoutScene,
  packRows,
  sceneHeight,
  type ClipBand,
  type MarkerPin,
  type Metrics,
  type WaveformInput,
} from '../../core/timeline/layout'
import type { SnapSet, SnapTarget } from '../../core/timeline/snap'
import { timeToX, viewEnd, xToTime, type Viewport } from '../../core/timeline/view'
import { PALETTE, paintScene } from './draw'

export interface TimelineProps {
  lanes: Lane[]
  clips: ClipBand[]
  markers: MarkerPin[]
  view: Viewport
  playhead: number
  fps: number
  /** Frame boundaries of the picture; handles and the playhead land on them. */
  frames: Float64Array
  snap: SnapSet
  snapping: boolean
  /** Peaks of the sound as far as they are known; the wave grows while the editor is open. */
  peaks?: WaveformInput
  metrics?: Metrics
  /** The width of the drawing area, in CSS pixels: the viewport is stored, so the owner keeps it. */
  onResize: (widthPx: number) => void
  /** Everything the pointer decides, decided in one place; the component only relays it. */
  onGesture: (gesture: TimelineGesture) => void
  /** Where the pointer stands over the strip; null when it has left or a drag is under way. */
  onHover?: (hover: Hover | null) => void
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
  // Neither of these goes into the document: they live exactly as long as the button is held,
  // and everything that lives in the state is a selector and a repaint of the panels beside it.
  const hint = useRef<SnapTarget | null>(null)
  const active = useRef<{ id: string; edge: 'in' | 'out' } | null>(null)

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
      // The playhead is the one part that changes for every presented video frame. It lives in
      // the DOM below so it moves with the render instead of waiting behind this deferred paint.
      playhead: Number.NEGATIVE_INFINITY,
      fps: current.fps,
      snap: hint.current,
      active: active.current,
      peaks: current.peaks,
    })

    // Change the CSS and backing widths together. A percentage width lets the parent stretch a
    // stale opening bitmap before the resize action has made its round trip through the store;
    // besides blurring the ruler, that makes the pixels the scene was laid out in differ from the
    // pixels the pointer reports.
    element.style.width = `${scene.width}px`

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
    clips: latest.current.clips,
    rows: packRows(latest.current.clips),
    frames: latest.current.frames,
    snap: latest.current.snap,
    snapping: latest.current.snapping,
  })

  // The listeners are put on by hand rather than through JSX for two reasons: the wheel has to be
  // non-passive to be able to stop the page from scrolling, and a drag has to keep working after
  // the pointer leaves the canvas, which means the window and not the element. They go on in a
  // layout effect, with the paint and not a frame behind it: a canvas that is on the screen and
  // deaf to the wheel is a canvas the first spin of it scrolls the page instead.
  useLayoutEffect(() => {
    const element = canvas.current
    if (!element) return

    const xAt = (event: MouseEvent): { css: number; logical: number } => {
      const box = element.getBoundingClientRect()
      const css = event.clientX - box.left
      const logical = box.width > 0 ? css * latest.current.view.widthPx / box.width : css
      return { css, logical }
    }

    const pointerAt = (event: MouseEvent): { x: number; y: number; alt: boolean } => {
      const box = element.getBoundingClientRect()
      return {
        x: xAt(event).logical,
        y: event.clientY - box.top,
        alt: event.altKey,
      }
    }

    const apply = (result: GestureResult): void => {
      drag.current = result.drag
      if (result.hint !== undefined) hint.current = result.hint
      active.current = result.drag?.kind === 'handle' ? { id: result.drag.id, edge: result.drag.edge } : null
      if (result.gesture) latest.current.onGesture(result.gesture)
      // The hint is not a prop, so a change of it would otherwise never reach the canvas.
      schedule()
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

    let hoverFrame = 0
    let hovering: Hover | null = null

    const reportHover = (): void => {
      hoverFrame = 0
      latest.current.onHover?.(hovering)
    }

    // A pointer reports faster than the screen redraws, and every report of it costs a seek at
    // the other end. One a frame, and the last position wins.
    const scheduleHover = (next: Hover | null): void => {
      hovering = next
      if (!hoverFrame) hoverFrame = requestAnimationFrame(reportHover)
    }

    const hover = (event: MouseEvent): void => {
      if (drag.current) {
        scheduleHover(null)
        return
      }
      const x = xAt(event)
      // The tooltip is positioned in the CSS box; media time is read in the logical scene.
      scheduleHover({ xPx: x.css, time: xToTime(latest.current.view, x.logical) })
    }

    const leave = (): void => scheduleHover(null)

    const wheel = (event: WheelEvent): void => {
      const gesture = onWheel({
        x: xAt(event).logical,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        alt: event.altKey,
      })
      if (!gesture) return
      event.preventDefault()
      latest.current.onGesture(gesture)
    }

    element.addEventListener('wheel', wheel, { passive: false })
    element.addEventListener('pointerdown', down)
    element.addEventListener('pointermove', hover)
    element.addEventListener('pointerleave', leave)
    return () => {
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('pointerdown', down)
      element.removeEventListener('pointermove', hover)
      element.removeEventListener('pointerleave', leave)
      if (hoverFrame) cancelAnimationFrame(hoverFrame)
      release()
    }
  }, [])

  const metrics = props.metrics ?? METRICS
  const rows = packRows(props.clips)
  const rowCount = rows.size ? Math.max(...rows.values()) + 1 : 1
  const playheadVisible =
    props.playhead >= props.view.start && props.playhead <= viewEnd(props.view)
  const playheadX = Math.round(timeToX(props.view, props.playhead))

  return (
    <div class="tc-timeline" ref={host} style={{ position: 'relative', width: '100%' }}>
      <canvas ref={canvas} style={{ display: 'block' }} />
      {playheadVisible && (
        <span
          data-testid="timeline-playhead"
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: `${playheadX}px`,
            top: '0',
            width: '1px',
            height: `${sceneHeight(metrics, props.lanes.length, rowCount)}px`,
            background: PALETTE.fill.playhead,
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />
      )}
    </div>
  )
}
