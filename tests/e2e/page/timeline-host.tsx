import { render } from 'preact'
import { useState } from 'preact/hooks'
import type { Lane, Span, Zone } from '../../../src/core/timeline/lanes'
import { METRICS, layoutScene, type ClipBand, type MarkerPin } from '../../../src/core/timeline/layout'
import type { Viewport } from '../../../src/core/timeline/view'
import { PALETTE, paintScene } from '../../../src/editor/timeline/draw'
import { Timeline } from '../../../src/editor/timeline/timeline'

/**
 * Three minutes, a hole every fifteen seconds, a change of quality every second.
 *
 * A switch a second is what a page does on a connection that cannot make up its mind, and it is
 * the heaviest thing the timeline ever has to draw: every zone is a band plus a boundary.
 */
const DURATION = 180
/** Two seconds, not one and a half: a run has to start on a whole second, or the frame grid of
 *  the second run is offset by half a second and no keyframe of the stand sits on a frame. */
const HOLE = 2
const SWITCH = 1

function material(kind: 'video' | 'audio'): Lane {
  const runs: Span[] = []
  const zones: Zone[] = []
  let start = 0

  while (start < DURATION) {
    const end = Math.min(DURATION, start + 15)
    runs.push({ start, end })
    for (let t = start; t < end; t += SWITCH) {
      const high = Math.round(t / SWITCH) % 2 === 0
      zones.push({
        start: t,
        end: Math.min(end, t + SWITCH),
        representation: high ? '720p' : '480p',
        codec: kind === 'audio' ? 'mp4a' : 'avc1',
        width: high ? 1280 : 854,
        height: kind === 'audio' ? 0 : high ? 720 : 480,
      })
    }
    start = end + HOLE
  }

  const gaps: Span[] = runs.slice(1).map((run, i) => ({ start: runs[i]!.end, end: run.start }))
  return { kind, runs, gaps, zones }
}

const LANES: Lane[] = [material('video'), material('audio')]
const CLIPS: ClipBand[] = Array.from({ length: 24 }, (_, i) => ({
  id: `c${i}`,
  name: `Clip ${i + 1}`,
  in: i * 7,
  out: i * 7 + 9,
  selected: i === 3,
}))
const MARKERS: MarkerPin[] = Array.from({ length: 12 }, (_, i) => ({
  id: `m${i}`,
  time: i * 14 + 3,
  label: `M${i + 1}`,
}))

const SEGMENTS =
  LANES.reduce((total, lane) => total + lane.runs.length + lane.gaps.length + lane.zones.length, 0) +
  CLIPS.length +
  MARKERS.length

function Host() {
  const [view, setView] = useState<Viewport>({ start: 0, scale: DURATION / 1200, widthPx: 1200 })

  const shared = globalThis as unknown as Record<string, unknown>
  shared.tcView = () => view
  shared.tcSetView = (next: Viewport) => setView(next)
  shared.tcPalette = PALETTE
  shared.tcSegments = SEGMENTS
  shared.tcLanes = LANES
  /**
   * Times of laying the scene out and painting it, over a sweep of zoom. The component adds one
   * canvas and no other node, so these two calls are the whole per-frame cost of the timeline.
   */
  shared.tcBench = (steps: number): number[] => {
    const canvas = document.querySelector('canvas')!
    const context = canvas.getContext('2d')!
    const input = { lanes: LANES, clips: CLIPS, markers: MARKERS, playhead: 61.2, fps: 25 }
    const times: number[] = []

    for (let i = 0; i < steps; i++) {
      const measured: Viewport = {
        start: (i % 40) * 1.5,
        scale: (DURATION / 1200) * Math.pow(0.94, i % 60),
        widthPx: 1200,
      }
      const started = performance.now()
      paintScene(context, layoutScene(measured, METRICS, input), PALETTE)
      times.push(performance.now() - started)
    }

    return times
  }

  return (
    <Timeline
      lanes={LANES}
      clips={CLIPS}
      markers={MARKERS}
      view={view}
      playhead={61.2}
      fps={25}
      onResize={(widthPx) => setView((current) => ({ ...current, widthPx }))}
    />
  )
}

render(<Host />, document.getElementById('root')!)
