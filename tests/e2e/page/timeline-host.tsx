import { render } from 'preact'
import { useState } from 'preact/hooks'
import type { Lane, Span, Zone } from '../../../src/core/timeline/lanes'
import { METRICS, layoutScene, packRows, rowTop, type ClipBand, type MarkerPin } from '../../../src/core/timeline/layout'
import { snapSet } from '../../../src/core/timeline/snap'
import { frameGrid } from '../../../src/core/timeline/grid'
import { fitAll, panBy, zoomAt, type ViewBounds, type Viewport } from '../../../src/core/timeline/view'
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

const BOUNDS: ViewBounds = { duration: DURATION, fps: 25 }

/**
 * Every width the component has reported, in order.
 *
 * A `ResizeObserver` delivers a first observation of its own the moment it is given an element,
 * on top of the measurement the component takes by hand when it mounts — behaviour a test in
 * happy-dom has to stage, because the observer there never calls back at all. Here it is real,
 * and the list is how the test says the same width is not pushed through twice.
 */
const RESIZES: number[] = []

/** Frames of 1/25 s inside the runs. */
const FPS = 25
const PTS = LANES[0]!.runs.flatMap((run) => {
  const count = Math.round((run.end - run.start) * FPS)
  return Array.from({ length: count }, (_, i) => run.start + i / FPS)
})
const FRAMES = frameGrid({
  pts: Float64Array.from(PTS),
  durations: Float64Array.from({ length: PTS.length }, () => 1 / FPS),
})
/**
 * A keyframe every two seconds, thirteen frames into the second and never on the second itself.
 *
 * The offset is the whole point of the stand for snapping. Quality switches every second here,
 * so a keyframe standing on a whole second shares its instant with a zone boundary — and a tie
 * goes to the boundary by priority (snap.ts), which leaves the keyframe unable to win anywhere
 * and the branch that looks for it unexercised. Thirteen frames is 0.52 s: clear of the zones,
 * clear of the markers and the clips, and still exactly on the frame grid, which a caught
 * target has to be or the grid pulls the handle off it and the catch does not count.
 */
const KEYFRAME_FRAME = 13
const KEYFRAMES = Float64Array.from(
  LANES[0]!.runs.flatMap((run) => {
    const count = Math.round((run.end - run.start) * FPS)
    const times: number[] = []
    for (let i = KEYFRAME_FRAME; i < count; i += 2 * FPS) times.push(run.start + i / FPS)
    return times
  }),
)

const SEGMENTS =
  LANES.reduce((total, lane) => total + lane.runs.length + lane.gaps.length + lane.zones.length, 0) +
  CLIPS.length +
  MARKERS.length

function Host() {
  const [view, setView] = useState<Viewport>({ start: 0, scale: DURATION / 1200, widthPx: 1200 })
  const [clips, setClips] = useState<ClipBand[]>(CLIPS)
  const set = snapSet({
    keyframes: KEYFRAMES,
    zones: LANES[0]!.zones,
    gaps: LANES[0]!.gaps,
    markers: MARKERS,
    clips,
    playhead: 61.2,
  })

  const shared = globalThis as unknown as Record<string, unknown>
  shared.tcView = () => view
  shared.tcSetView = (next: Viewport) => setView(next)
  shared.tcTimeAt = (x: number) => view.start + x * view.scale
  shared.tcFit = () => setView((current) => fitAll(current, BOUNDS))
  shared.tcPalette = PALETTE
  shared.tcSegments = SEGMENTS
  shared.tcResizes = RESIZES
  shared.tcLanes = LANES
  shared.tcClips = () => clips
  shared.tcXAt = (time: number) => (time - view.start) / view.scale
  shared.tcHandle = (id: string, edge: 'in' | 'out') => {
    const clip = clips.find((candidate) => candidate.id === id)!
    const row = packRows(clips).get(id) ?? 0
    return {
      x: ((edge === 'in' ? clip.in : clip.out) - view.start) / view.scale,
      y: rowTop(METRICS, LANES.length, row) + METRICS.clipHeight / 2,
    }
  }
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
      clips={clips}
      markers={MARKERS}
      view={view}
      playhead={61.2}
      fps={25}
      frames={FRAMES}
      snap={set}
      snapping
      onResize={(widthPx) => {
        RESIZES.push(widthPx)
        setView((current) => ({ ...current, widthPx }))
      }}
      onGesture={(gesture) => {
        if (gesture.type === 'zoom') {
          setView((current) => zoomAt(current, gesture.atPx, gesture.factor, BOUNDS))
        }
        if (gesture.type === 'pan') setView((current) => panBy(current, gesture.dxPx, BOUNDS))
        if (gesture.type === 'trim') {
          setClips((current) =>
            current.map((clip) =>
              clip.id !== gesture.id
                ? clip
                : gesture.edge === 'in'
                  ? { ...clip, in: gesture.time }
                  : { ...clip, out: gesture.time },
            ),
          )
        }
        if (gesture.type === 'selectClip') {
          setClips((current) => current.map((clip) => ({ ...clip, selected: clip.id === gesture.id })))
        }
      }}
    />
  )
}

render(<Host />, document.getElementById('root')!)
