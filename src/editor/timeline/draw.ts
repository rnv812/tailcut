import { MIN_LABEL_WIDTH_PX, type RectKind, type Scene } from '../../core/timeline/layout'

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
  fill: Record<RectKind, string>
}

export const PALETTE: Palette = {
  background: '#14161a',
  ruler: '#1b1e24',
  tick: '#3a4048',
  tickMajor: '#66707c',
  tickLabel: '#98a2ae',
  clipLabel: '#f2f5f8',
  snapLabel: '#ffd479',
  fill: {
    'run-video': '#2f6f9f',
    'run-audio': '#2f8f6f',
    gap: '#0b0d10',
    zone: '#405060',
    'zone-edge': '#c8973a',
    clip: '#4a5563',
    'clip-selected': '#e0a33c',
    handle: '#c9d3de',
    'handle-snapped': '#ffd479',
    snap: '#ffd479',
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
