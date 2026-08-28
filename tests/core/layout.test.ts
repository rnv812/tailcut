import { describe, it, expect } from 'vitest'
import type { Lane } from '../../src/core/timeline/lanes'
import {
  METRICS,
  MIN_BAND_PX,
  clipsTop,
  firstVisible,
  laneTop,
  layoutScene,
  packRows,
  rowTop,
  sceneHeight,
  type ClipBand,
  type Rect,
  type SceneInput,
  type WaveformInput,
} from '../../src/core/timeline/layout'
import type { Viewport } from '../../src/core/timeline/view'

const view: Viewport = { start: 0, scale: 0.1, widthPx: 1000 } // 100 seconds across 1000 px

const lanes: Lane[] = [
  {
    kind: 'video',
    runs: [
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ],
    gaps: [{ start: 40, end: 60 }],
    // Three zones, and the last of them does not touch the one before it: the recording stopped
    // at 40 and came back at 60 at a third quality, so 720p ends where the material ends and
    // 1080p starts where it resumes. A zone is broken only by a change of the init segment
    // (lanes.ts, Task 7) — the hole itself splits nothing, which is why 480p→720p at 20 is the
    // one switch here that a line is drawn for and 720p→1080p across the hole is not.
    zones: [
      { start: 0, end: 20, representation: '480p', codec: 'avc1', width: 854, height: 480 },
      { start: 20, end: 40, representation: '720p', codec: 'avc1', width: 1280, height: 720 },
      { start: 60, end: 100, representation: '1080p', codec: 'avc1', width: 1920, height: 1080 },
    ],
  },
  {
    kind: 'audio',
    runs: [{ start: 0, end: 100 }],
    gaps: [],
    zones: [{ start: 0, end: 100, representation: 'aac', codec: 'mp4a', width: 0, height: 0 }],
  },
]

const clip = (id: string, start: number, end: number, selected = false): ClipBand => ({
  id,
  name: `Clip ${id}`,
  in: start,
  out: end,
  selected,
})

const input = (overrides: Partial<SceneInput> = {}): SceneInput => ({
  lanes,
  clips: [],
  markers: [],
  playhead: 10,
  fps: 25,
  ...overrides,
})

const of = (rects: Rect[], kind: Rect['kind']): Rect[] => rects.filter((rect) => rect.kind === kind)

describe('firstVisible', () => {
  const spans = [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
    { start: 40, end: 50 },
  ]

  it('finds the first span the viewport touches', () => {
    expect(firstVisible(spans, 0)).toBe(0)
    expect(firstVisible(spans, 15)).toBe(1)
    expect(firstVisible(spans, 25)).toBe(1)
  })

  it('skips a span that ends exactly at the edge', () => {
    expect(firstVisible(spans, 10)).toBe(1)
  })

  it('is past the end when everything is behind', () => {
    expect(firstVisible(spans, 100)).toBe(3)
    expect(firstVisible([], 5)).toBe(0)
  })
})

describe('layoutScene', () => {
  it('is as tall as the ruler, the lanes and the clip rows', () => {
    const scene = layoutScene(view, METRICS, input())

    expect(scene.width).toBe(1000)
    expect(scene.rulerHeight).toBe(METRICS.rulerHeight)
    expect(scene.height).toBe(sceneHeight(METRICS, 2, 1))
    expect(laneTop(METRICS, 1)).toBeGreaterThan(laneTop(METRICS, 0))
    expect(clipsTop(METRICS, 2)).toBeGreaterThan(laneTop(METRICS, 1))
  })

  it('draws a run as a band on its own lane', () => {
    const scene = layoutScene(view, METRICS, input())
    const runs = of(scene.rects, 'run-video')

    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ x: 0, width: 400, y: laneTop(METRICS, 0) })
    expect(runs[1]).toMatchObject({ x: 600, width: 400 })
    expect(of(scene.rects, 'run-audio')).toHaveLength(1)
    expect(of(scene.rects, 'run-audio')[0]!.y).toBe(laneTop(METRICS, 1))
  })

  it('draws a gap between the runs', () => {
    const gaps = of(layoutScene(view, METRICS, input()).rects, 'gap')

    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ x: 400, width: 200 })
  })

  it('keeps a band narrower than a pixel visible', () => {
    // A quarter of a second of dropped material at the widest zoom is 0.02 px. Rounded away it
    // would leave the timeline claiming a continuous recording that is not continuous.
    const narrow: Lane[] = [
      {
        kind: 'video',
        runs: [
          { start: 0, end: 50 },
          { start: 50.02, end: 100 },
        ],
        gaps: [{ start: 50, end: 50.02 }],
        zones: [],
      },
    ]
    const gaps = of(layoutScene(view, METRICS, input({ lanes: narrow })).rects, 'gap')

    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.width).toBe(MIN_BAND_PX)
  })

  it('leaves out what the viewport does not touch', () => {
    const scene = layoutScene({ start: 70, scale: 0.01, widthPx: 1000 }, METRICS, input())

    expect(of(scene.rects, 'gap')).toHaveLength(0)
    expect(of(scene.rects, 'run-video')).toHaveLength(1)
    for (const rect of scene.rects) {
      expect(rect.x).toBeLessThanOrEqual(scene.width + 1)
      expect(rect.x + rect.width).toBeGreaterThanOrEqual(-1)
    }
  })

  it('clips a band that starts before the viewport to its left edge', () => {
    const scene = layoutScene({ start: 30, scale: 0.01, widthPx: 1000 }, METRICS, input())

    expect(of(scene.rects, 'run-video')[0]!.x).toBe(-1)
  })

  it('draws a zone boundary only where the quality actually changes', () => {
    const scene = layoutScene(view, METRICS, input())
    const edges = of(scene.rects, 'zone-edge')

    // 200 px is 20 s, where 480p becomes 720p with the recording running: a switch one can see
    // happen. The other two starts of a zone are not switches. 0 is the start of the material
    // and nothing precedes it; 60 s — 600 px — is the far side of the hole at 40–60, and what
    // separates 1080p from 720p there is twenty seconds of nothing, not a line.
    expect(edges.map((edge) => edge.x)).toEqual([200])
    expect(of(scene.rects, 'zone')).toHaveLength(4)
  })

  it('packs overlapping clips into rows and leaves the rest on one', () => {
    const clips = [clip('a', 0, 30), clip('b', 20, 50), clip('c', 60, 80)]
    const rows = packRows(clips)

    expect(rows.get('a')).toBe(0)
    expect(rows.get('b')).toBe(1)
    expect(rows.get('c')).toBe(0)

    const scene = layoutScene(view, METRICS, input({ clips }))
    expect(scene.rows).toBe(2)
    expect(of(scene.rects, 'clip')).toHaveLength(3)
    expect(of(scene.rects, 'clip')[1]!.y).toBe(rowTop(METRICS, 2, 1))
  })

  it('gives the selected clip its own kind', () => {
    const scene = layoutScene(view, METRICS, input({ clips: [clip('a', 0, 30, true)] }))

    expect(of(scene.rects, 'clip')).toHaveLength(0)
    expect(of(scene.rects, 'clip-selected')[0]).toMatchObject({ id: 'a', label: 'Clip a' })
  })

  it('a clip too narrow for its name carries no label', () => {
    const scene = layoutScene(view, METRICS, input({ clips: [clip('a', 0, 1)] }))

    expect(of(scene.rects, 'clip')[0]!.label).toBeUndefined()
  })

  it('draws the playhead across the whole scene and only when it is in view', () => {
    const scene = layoutScene(view, METRICS, input({ playhead: 50 }))
    const playhead = of(scene.rects, 'playhead')[0]!

    expect(playhead).toMatchObject({ x: 500, y: 0, width: 1, height: scene.height })
    expect(of(layoutScene(view, METRICS, input({ playhead: 500 })).rects, 'playhead')).toHaveLength(0)
  })

  it('draws a marker as a pin in the ruler and a line down the scene', () => {
    const scene = layoutScene(view, METRICS, input({ markers: [{ id: 'm1', time: 20, label: 'M1' }] }))
    const pins = of(scene.rects, 'marker')

    expect(pins).toHaveLength(2)
    expect(pins[0]).toMatchObject({ x: 200, y: 0, height: METRICS.markerHeight, id: 'm1' })
    // The line hangs off the bottom of the pin and stops at the foot of the scene: given the
    // whole height it would run twelve pixels past it, which a canvas hides and a scrollable
    // one would not.
    expect(pins[1]).toMatchObject({
      x: 200,
      y: METRICS.markerHeight,
      height: scene.height - METRICS.markerHeight,
    })
  })

  it('carries the ticks with the labels of the major ones', () => {
    const scene = layoutScene(view, METRICS, input())

    expect(scene.ticks.length).toBeGreaterThan(4)
    expect(scene.ticks.every((tick) => tick.x >= 0 && tick.x <= scene.width)).toBe(true)
    expect(scene.ticks.filter((tick) => tick.major).every((tick) => Boolean(tick.label))).toBe(true)
    expect(scene.ticks.filter((tick) => !tick.major).every((tick) => tick.label === undefined)).toBe(true)
  })

  it('gives every clip a handle at each end', () => {
    const scene = layoutScene(view, METRICS, input({ clips: [clip('a', 10, 30)] }))
    const handles = of(scene.rects, 'handle')

    expect(handles).toHaveLength(2)
    expect(handles[0]).toMatchObject({ id: 'a', width: METRICS.handleWidth })
    // Centred on the edge: half the handle hangs outside the clip, which is what makes it
    // grabbable when two clips meet edge to edge.
    expect(handles[0]!.x).toBe(100 - Math.floor(METRICS.handleWidth / 2))
    expect(handles[1]!.x).toBe(300 - Math.floor(METRICS.handleWidth / 2))

    // A clip out of sight brings none: two rects at minus five thousand for every clip ever
    // cut is the cost of laying out what nobody is looking at.
    const away = layoutScene(view, METRICS, input({ clips: [clip('a', 500, 600)] }))

    expect(of(away.rects, 'handle')).toHaveLength(0)
  })

  it('draws the handle being dragged onto a target as caught', () => {
    const scene = layoutScene(
      view,
      METRICS,
      input({
        clips: [clip('a', 10, 30)],
        active: { id: 'a', edge: 'out' },
        snap: { time: 30, kind: 'keyframe', label: 'keyframe' },
      }),
    )

    expect(of(scene.rects, 'handle')).toHaveLength(1)
    expect(of(scene.rects, 'handle-snapped')[0]).toMatchObject({ id: 'a', x: 300 - 3 })

    // Dragged and catching nothing is not caught: under Alt the handle keeps its own colour all
    // the way, and the colour is the whole of what says a target was found.
    const free = layoutScene(
      view,
      METRICS,
      input({ clips: [clip('a', 10, 30)], active: { id: 'a', edge: 'out' } }),
    )

    expect(of(free.rects, 'handle-snapped')).toHaveLength(0)
  })

  it('leaves the handles of the other clips alone while one of them is caught', () => {
    // The caught colour belongs to the edge under the hand, not to the clip and not to the
    // moment: a whole timeline lighting up would say nothing about where the line came from.
    const scene = layoutScene(
      view,
      METRICS,
      input({
        clips: [clip('a', 10, 30), clip('b', 40, 60)],
        active: { id: 'a', edge: 'out' },
        snap: { time: 30, kind: 'keyframe', label: 'keyframe' },
      }),
    )

    expect(of(scene.rects, 'handle-snapped')).toHaveLength(1)
    expect(of(scene.rects, 'handle').map((rect) => rect.id)).toEqual(['a', 'b', 'b'])
  })

  it('runs the snap line the height of the scene and labels it', () => {
    const scene = layoutScene(
      view,
      METRICS,
      input({ snap: { time: 40, kind: 'gap', label: 'gap' } }),
    )
    const line = of(scene.rects, 'snap')[0]!

    expect(line).toMatchObject({ x: 400, y: 0, width: 1, height: scene.height, label: 'gap' })
  })

  it('draws no snap line when nothing is caught', () => {
    expect(of(layoutScene(view, METRICS, input()).rects, 'snap')).toHaveLength(0)
  })
})

describe('layoutScene: the wave', () => {
  const sound = (values: number[], start = 0): WaveformInput => ({
    peaks: [{ start, min: Int8Array.from(values, (v) => -v), max: Int8Array.from(values) }],
    covered: start + values.length / 100,
  })

  const lanes: Lane[] = [
    { kind: 'video', runs: [{ start: 0, end: 10 }], gaps: [], zones: [] },
    { kind: 'audio', runs: [{ start: 0, end: 10 }], gaps: [], zones: [] },
  ]

  const view: Viewport = { start: 0, scale: 0.01, widthPx: 1000 }

  it('puts the wave over the audio lane and nowhere else', () => {
    const scene = layoutScene(view, METRICS, {
      lanes,
      clips: [],
      markers: [],
      playhead: 0,
      fps: 25,
      peaks: sound(Array.from({ length: 1000 }, () => 100)),
    })

    const band = scene.waveform!
    expect(band.y).toBe(laneTop(METRICS, 1))
    expect(band.height).toBe(METRICS.laneHeight - METRICS.zoneHeight)
    expect(band.mid).toBe(band.y + band.height / 2)
    expect(band.min.length).toBe(1000)
    expect(band.max[0]).toBe(100)
  })

  it('says in pixels where the reading has got to', () => {
    // Four seconds of ten read: at a hundredth of a second a pixel that is 400 px in.
    const scene = layoutScene(view, METRICS, {
      lanes,
      clips: [],
      markers: [],
      playhead: 0,
      fps: 25,
      peaks: sound(Array.from({ length: 400 }, () => 60)),
    })

    expect(scene.waveform!.pendingFromPx).toBe(400)
    expect(scene.waveform!.max[399]).toBe(60)
    expect(scene.waveform!.max[400]).toBe(0)
  })

  it('has no wave when the recording has no sound and none when none was asked for', () => {
    const picture = [lanes[0]!]
    const withSound = { lanes: picture, clips: [], markers: [], playhead: 0, fps: 25, peaks: sound([50]) }

    expect(layoutScene(view, METRICS, withSound).waveform).toBeNull()
    expect(
      layoutScene(view, METRICS, { lanes, clips: [], markers: [], playhead: 0, fps: 25 }).waveform,
    ).toBeNull()
  })
})
