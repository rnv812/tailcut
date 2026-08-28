import { peakColumns, type Peaks } from '../audio/peaks'
import type { Lane, Span, Zone } from './lanes'
import { continuesRun } from './map'
import type { SnapTarget } from './snap'
import { tickLabel, tickSteps, ticks, timeToX, viewEnd, type Viewport } from './view'

/** Heights of the parts of the timeline, in CSS pixels. */
export interface Metrics {
  rulerHeight: number
  laneHeight: number
  laneGap: number
  /** The strip of quality zones along the bottom of a lane. */
  zoneHeight: number
  clipHeight: number
  clipGap: number
  clipsTopGap: number
  markerHeight: number
  /** Width of the grab tab at each end of a clip. */
  handleWidth: number
}

export const METRICS: Metrics = {
  rulerHeight: 24,
  laneHeight: 48,
  laneGap: 6,
  zoneHeight: 5,
  clipHeight: 18,
  clipGap: 3,
  clipsTopGap: 8,
  markerHeight: 12,
  handleWidth: 7,
}

/** A band that would round away to nothing is drawn a pixel wide instead. */
export const MIN_BAND_PX = 1
/** Below this width a clip carries no name: two letters and an ellipsis say less than nothing. */
export const MIN_LABEL_WIDTH_PX = 44

export type RectKind =
  | 'run-video'
  | 'run-audio'
  | 'gap'
  | 'zone'
  | 'zone-edge'
  | 'clip'
  | 'clip-selected'
  | 'handle'
  | 'handle-snapped'
  | 'marker'
  | 'snap'
  | 'playhead'

export interface Rect {
  kind: RectKind
  x: number
  y: number
  width: number
  height: number
  /** Identifier of what the rect stands for, where there is one: a clip, a marker, a zone. */
  id?: string
  label?: string
}

export interface TickMark {
  x: number
  major: boolean
  label?: string
}

/** A clip as the timeline needs it. `Clip` of the edit model satisfies it with `selected` added. */
export interface ClipBand {
  id: string
  name: string
  in: number
  out: number
  selected: boolean
}

/** A marker as the timeline needs it; `Marker` of the edit model satisfies it as it stands. */
export interface MarkerPin {
  id: string
  time: number
  label: string
}

export interface WaveformInput {
  peaks: readonly Peaks[]
  /** Media time the reading has got to; past it the lane is drawn as not yet known. */
  covered: number
}

export interface WaveformBand {
  x: number
  y: number
  width: number
  height: number
  /** The line of silence: the middle of the band. */
  mid: number
  /** One column a pixel, already folded to the width of the strip. */
  min: Int8Array
  max: Int8Array
  /** Where the stretch that has not been read yet begins, in pixels. */
  pendingFromPx: number
}

export interface SceneInput {
  lanes: readonly Lane[]
  clips: readonly ClipBand[]
  markers: readonly MarkerPin[]
  playhead: number
  fps: number
  /** The handle under the pointer right now, drawn apart from the rest. */
  active?: { id: string; edge: 'in' | 'out' } | null
  /** What that handle is caught on: a line and a word beside it. */
  snap?: SnapTarget | null
  /** Peaks of the sound, as far as they have been computed. Absent while there are none. */
  peaks?: WaveformInput
}

/** Everything to be painted, in pixels, in painting order. */
export interface Scene {
  width: number
  height: number
  rulerHeight: number
  /** How many rows of clips the scene needed. */
  rows: number
  rects: Rect[]
  ticks: TickMark[]
  /** The wave over the audio lane; null when there is no sound lane or no peaks yet. */
  waveform?: WaveformBand | null
}

export function laneTop(m: Metrics, index: number): number {
  return m.rulerHeight + index * (m.laneHeight + m.laneGap)
}

export function clipsTop(m: Metrics, laneCount: number): number {
  return laneTop(m, laneCount) + m.clipsTopGap
}

export function rowTop(m: Metrics, laneCount: number, row: number): number {
  return clipsTop(m, laneCount) + row * (m.clipHeight + m.clipGap)
}

export function sceneHeight(m: Metrics, laneCount: number, rows: number): number {
  return rowTop(m, laneCount, Math.max(1, rows)) + m.clipsTopGap
}

/**
 * Index of the first span the viewport can touch: the first whose end is past `time`.
 *
 * Spans have to be in time order and not overlap, which runs, gaps and zones are. Hundreds of
 * segments are the normal case and every wheel notch relays them all out, so the search is the
 * difference between work proportional to what is on the screen and work proportional to
 * everything ever recorded.
 */
export function firstVisible(spans: readonly Span[], time: number): number {
  let lo = 0
  let hi = spans.length

  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid]!.end <= time) lo = mid + 1
    else hi = mid
  }

  return lo
}

/**
 * Which row each clip is drawn on. Ranges are allowed to overlap (§9.3), and two clips on one row
 * would draw over each other; the first free row is picked greedily in time order.
 */
export function packRows(clips: readonly ClipBand[]): Map<string, number> {
  const ends: number[] = []
  const rows = new Map<string, number>()

  for (const clip of [...clips].sort((a, b) => a.in - b.in || a.out - b.out)) {
    let row = ends.findIndex((end) => end <= clip.in)
    if (row < 0) {
      row = ends.length
      ends.push(clip.out)
    } else {
      ends[row] = Math.max(ends[row]!, clip.out)
    }
    rows.set(clip.id, row)
  }

  return rows
}

function band(
  v: Viewport,
  span: Span,
  y: number,
  height: number,
  kind: RectKind,
  extra?: { id?: string; label?: string },
): Rect {
  // Clamped to just outside the drawing area: a run an hour long would otherwise carry a
  // coordinate of minus a hundred thousand into the canvas for no gain.
  const x0 = Math.max(-1, Math.round(timeToX(v, span.start)))
  const x1 = Math.min(v.widthPx + 1, Math.round(timeToX(v, span.end)))
  return { kind, x: x0, y, width: Math.max(MIN_BAND_PX, x1 - x0), height, ...extra }
}

function forEachVisible<T extends Span>(
  spans: readonly T[],
  from: number,
  to: number,
  fn: (span: T, index: number) => void,
): void {
  for (let i = firstVisible(spans, from); i < spans.length; i++) {
    const span = spans[i]!
    if (span.start >= to) break
    fn(span, i)
  }
}

function waveformBand(v: Viewport, m: Metrics, top: number, input: WaveformInput): WaveformBand {
  const height = m.laneHeight - m.zoneHeight
  const width = Math.max(0, Math.round(v.widthPx))
  const { min, max } = peakColumns(input.peaks, v.start, viewEnd(v), width)
  const pending = Math.round(timeToX(v, input.covered))

  return {
    x: 0,
    y: top,
    width,
    height,
    mid: top + height / 2,
    min,
    max,
    pendingFromPx: pending < 0 ? 0 : pending > width ? width : pending,
  }
}

export function layoutScene(v: Viewport, m: Metrics, input: SceneInput): Scene {
  const from = v.start
  const to = viewEnd(v)
  const rects: Rect[] = []

  const rows = packRows(input.clips)
  const rowCount = rows.size ? Math.max(...rows.values()) + 1 : 1
  const laneCount = input.lanes.length
  const height = sceneHeight(m, laneCount, rowCount)

  input.lanes.forEach((lane, index) => {
    const top = laneTop(m, index)
    const bodyHeight = m.laneHeight - m.zoneHeight
    const runKind: RectKind = lane.kind === 'audio' ? 'run-audio' : 'run-video'

    forEachVisible(lane.runs, from, to, (run) => rects.push(band(v, run, top, bodyHeight, runKind)))
    forEachVisible(lane.gaps, from, to, (gap) => rects.push(band(v, gap, top, bodyHeight, 'gap')))

    forEachVisible(lane.zones, from, to, (zone: Zone, i) => {
      rects.push(
        band(v, zone, top + bodyHeight, m.zoneHeight, 'zone', {
          id: zone.representation,
          label: zone.height > 0 ? `${zone.height}p` : zone.codec,
        }),
      )
      // A boundary is a switch of quality one can see happen, not the start of a zone: the first
      // zone of the material has nothing before it, and a zone that begins on the far side of a
      // hole is separated from the previous one by the hole rather than by a line. Nor is one
      // drawn where it cannot be seen: a zone reaching in from the left of the screen started
      // off it, and its line is a coordinate of minus five thousand handed to the canvas for a
      // pixel nobody looks at.
      const previous = lane.zones[i - 1]
      if (previous && zone.start >= from && continuesRun(previous.end, zone.start)) {
        rects.push({
          kind: 'zone-edge',
          x: Math.round(timeToX(v, zone.start)),
          y: top,
          width: 1,
          height: m.laneHeight,
        })
      }
    })
  })

  // Clips are allowed to overlap, so the binary search does not apply to them; there are dozens
  // of them at most and the scan is over before it starts.
  for (const clip of input.clips) {
    if (clip.out <= from || clip.in >= to) continue
    const row = rows.get(clip.id) ?? 0
    const rect = band(
      v,
      { start: clip.in, end: clip.out },
      rowTop(m, laneCount, row),
      m.clipHeight,
      clip.selected ? 'clip-selected' : 'clip',
      { id: clip.id },
    )
    if (rect.width >= MIN_LABEL_WIDTH_PX) rect.label = clip.name
    rects.push(rect)
  }

  for (const clip of input.clips) {
    if (clip.out <= from || clip.in >= to) continue
    const row = rows.get(clip.id) ?? 0
    const y = rowTop(m, laneCount, row)
    for (const edge of ['in', 'out'] as const) {
      const time = edge === 'in' ? clip.in : clip.out
      const caught = input.snap && input.active?.id === clip.id && input.active.edge === edge
      rects.push({
        kind: caught ? 'handle-snapped' : 'handle',
        x: Math.round(timeToX(v, time)) - Math.floor(m.handleWidth / 2),
        y,
        width: m.handleWidth,
        height: m.clipHeight,
        id: clip.id,
      })
    }
  }

  for (const marker of input.markers) {
    if (marker.time < from || marker.time > to) continue
    const x = Math.round(timeToX(v, marker.time))
    rects.push({ kind: 'marker', x, y: 0, width: 3, height: m.markerHeight, id: marker.id, label: marker.label })
    rects.push({ kind: 'marker', x, y: m.markerHeight, width: 1, height: height - m.markerHeight, id: marker.id })
  }

  if (input.snap) {
    rects.push({
      kind: 'snap',
      x: Math.round(timeToX(v, input.snap.time)),
      y: 0,
      width: 1,
      height,
      label: input.snap.label,
    })
  }

  if (input.playhead >= from && input.playhead <= to) {
    rects.push({
      kind: 'playhead',
      x: Math.round(timeToX(v, input.playhead)),
      y: 0,
      width: 1,
      height,
    })
  }

  const { major } = tickSteps(v, input.fps)
  const marks: TickMark[] = ticks(v, input.fps).map((tick) => ({
    x: Math.round(timeToX(v, tick.time)),
    major: tick.major,
    label: tick.major ? tickLabel(tick.time, major, input.fps) : undefined,
  }))

  const soundLane = input.lanes.findIndex((lane) => lane.kind === 'audio')
  const waveform =
    input.peaks && soundLane >= 0 ? waveformBand(v, m, laneTop(m, soundLane), input.peaks) : null

  return { width: v.widthPx, height, rulerHeight: m.rulerHeight, rows: rowCount, rects, ticks: marks, waveform }
}
