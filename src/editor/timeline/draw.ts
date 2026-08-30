import { MIN_LABEL_WIDTH_PX, type RectKind, type Scene, type WaveformBand } from '../../core/timeline/layout'

/**
 * As much of a canvas context as the drawing uses.
 *
 * A real `CanvasRenderingContext2D` satisfies it, and so does a dozen lines of recording in a
 * test — which is the point: what the timeline shows is then a question answered in node, and
 * the browser is left to answer only whether a canvas obeys.
 */
export type Painter = Pick<
  CanvasRenderingContext2D,
  'fillRect' | 'fillText' | 'clearRect' | 'fillStyle' | 'font' | 'textBaseline'
>

export interface Palette {
  background: string
  ruler: string
  tick: string
  tickMajor: string
  tickLabel: string
  clipLabel: string
  snapLabel: string
  /** The wave itself, and the base line under the stretch that has not been read yet. */
  wave: string
  wavePending: string
  fill: Record<RectKind, string>
}

export const PALETTE: Palette = {
  background: '#17181f',
  ruler: '#1d1f27',
  tick: '#414550',
  tickMajor: '#777b86',
  tickLabel: '#a8abb4',
  clipLabel: '#f6f5f8',
  snapLabel: '#d9ff88',
  wave: '#7ddd9e',
  wavePending: '#31513d',
  fill: {
    'run-video': '#2f6f9f',
    'run-audio': '#2f8f6f',
    gap: '#0b0d10',
    zone: '#405060',
    'zone-edge': '#efbd65',
    clip: '#4a5563',
    'clip-selected': '#b7f03f',
    handle: '#f6f5f8',
    'handle-snapped': '#efbd65',
    snap: '#d9ff88',
    marker: '#b06cd6',
    playhead: '#e8503a',
  },
}

export const FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace'

/**
 * Width of a character of FONT, in pixels.
 *
 * Measured once rather than asked for on every label: `measureText` is the one call in this file
 * that would need a real canvas, and a monospaced face makes the answer arithmetic.
 */
export const CHAR_PX = 6.6

export function truncate(text: string, widthPx: number): string {
  const fits = Math.floor(widthPx / CHAR_PX)
  if (text.length <= fits) return text
  return `${text.slice(0, Math.max(1, fits - 1))}…`
}

const MINOR_TICK_PX = 4
const TICK_LABEL_BASELINE = 12

/**
 * The envelope, a column a pixel, from the middle of the band outwards.
 *
 * A column of silence is still a line: a lane that goes blank where the sound is quiet reads as
 * material that is missing. Past `pendingFromPx` there are no peaks yet, and the same line is
 * drawn in the quieter colour — that is the whole of the progress indication, and the measurement
 * says it is enough: the wave fills in left to right in under a second.
 */
export function paintWaveform(p: Painter, band: WaveformBand, palette: Palette): void {
  const half = band.height / 2 - 1

  const column = (at: number): void => {
    const top = band.mid - ((band.max[at] ?? 0) / 127) * half
    const bottom = band.mid - ((band.min[at] ?? 0) / 127) * half
    p.fillRect(band.x + at, Math.round(top), 1, Math.max(1, Math.round(bottom - top)))
  }

  p.fillStyle = palette.wave
  for (let at = 0; at < band.pendingFromPx && at < band.width; at++) column(at)

  p.fillStyle = palette.wavePending
  for (let at = Math.max(0, band.pendingFromPx); at < band.width; at++) column(at)
}

/** What belongs to a lane, and therefore goes under the wave rather than over it. */
const LANE_KINDS: ReadonlySet<RectKind> = new Set([
  'run-video',
  'run-audio',
  'gap',
  'zone',
  'zone-edge',
])

export function paintScene(p: Painter, scene: Scene, palette: Palette = PALETTE): void {
  p.fillStyle = palette.background
  p.fillRect(0, 0, scene.width, scene.height)
  p.fillStyle = palette.ruler
  p.fillRect(0, 0, scene.width, scene.rulerHeight)

  for (const tick of scene.ticks) {
    const height = tick.major ? scene.rulerHeight - 8 : MINOR_TICK_PX
    p.fillStyle = tick.major ? palette.tickMajor : palette.tick
    p.fillRect(tick.x, scene.rulerHeight - height, 1, height)
  }

  for (const rect of scene.rects) {
    if (!LANE_KINDS.has(rect.kind)) continue
    p.fillStyle = palette.fill[rect.kind]
    p.fillRect(rect.x, rect.y, rect.width, rect.height)
  }

  // The wave lies inside the sound lane, so it is painted after the lane and before everything
  // that has to stay readable across it: the playhead, the handles, the markers, the clips.
  if (scene.waveform) paintWaveform(p, scene.waveform, palette)

  for (const rect of scene.rects) {
    if (LANE_KINDS.has(rect.kind)) continue
    p.fillStyle = palette.fill[rect.kind]
    p.fillRect(rect.x, rect.y, rect.width, rect.height)
  }

  // Text last and in one pass: a clip drawn after its neighbour would otherwise paint over the
  // neighbour's name, and the timeline would lose a label whenever two ranges overlap.
  p.font = FONT
  p.textBaseline = 'alphabetic'
  p.fillStyle = palette.tickLabel
  for (const tick of scene.ticks) {
    if (tick.label) p.fillText(tick.label, tick.x + 3, TICK_LABEL_BASELINE)
  }

  for (const rect of scene.rects) {
    if (!rect.label) continue
    // A snap line is a pixel wide and still has to say what it caught; a clip band that narrow
    // has nothing to say that would fit.
    const snap = rect.kind === 'snap'
    if (!snap && rect.width < MIN_LABEL_WIDTH_PX) continue
    p.fillStyle = snap ? palette.snapLabel : palette.clipLabel
    const baseline = snap ? scene.rulerHeight + 13 : rect.y + rect.height - 5
    p.fillText(snap ? rect.label : truncate(rect.label, rect.width - 8), rect.x + 5, baseline)
  }
}
