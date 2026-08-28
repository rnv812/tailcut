import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
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

  return (
    <div class="tc-timeline" ref={host} style={{ position: 'relative', width: '100%' }}>
      <canvas ref={canvas} style={{ display: 'block', width: '100%' }} />
    </div>
  )
}
