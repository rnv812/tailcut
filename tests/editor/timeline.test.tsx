// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from 'preact'
import { Timeline } from '../../src/editor/timeline/timeline'
import type { Lane } from '../../src/core/timeline/lanes'
import { METRICS, sceneHeight } from '../../src/core/timeline/layout'

const lanes: Lane[] = [
  { kind: 'video', runs: [{ start: 0, end: 60 }], gaps: [], zones: [] },
]

interface Call {
  op: string
  args: number[]
  text?: string
}

let calls: Call[] = []

/** The recording context every canvas of the test gets: happy-dom has no 2d context of its own. */
function installContext(): void {
  const context = {
    fillStyle: '',
    font: '',
    textBaseline: 'alphabetic',
    fillRect: (...args: number[]) => calls.push({ op: 'fillRect', args }),
    fillText: (text: string, ...args: number[]) => calls.push({ op: 'fillText', args, text }),
    clearRect: (...args: number[]) => calls.push({ op: 'clearRect', args }),
    setTransform: (...args: number[]) => calls.push({ op: 'setTransform', args }),
  }
  // Cast whole: getContext is declared as five overloads, and a stub that answers one of them is
  // not assignable to the lot of them.
  HTMLCanvasElement.prototype.getContext = (() =>
    context) as unknown as HTMLCanvasElement['getContext']
}

/** happy-dom measures every element as zero; the host is given a width to report. */
function installWidth(width: number): void {
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width, height: 0, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, toJSON: () => ({}) }) as DOMRect
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

let host: HTMLDivElement

beforeEach(() => {
  calls = []
  installContext()
  installWidth(900)
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  render(null, host)
  host.remove()
  vi.unstubAllGlobals()
})

const props = () => ({
  lanes,
  clips: [],
  markers: [],
  view: { start: 0, scale: 0.05, widthPx: 900 },
  playhead: 3,
  fps: 25,
  onResize: () => {},
})

describe('Timeline', () => {
  it('paints the scene into the canvas on mount', async () => {
    render(<Timeline {...props()} />, host)
    await nextFrame()

    const first = calls.find((call) => call.op === 'fillRect')
    expect(first!.args).toEqual([0, 0, 900, expect.any(Number)])
    expect(calls.filter((call) => call.op === 'fillRect').length).toBeGreaterThan(3)
  })

  it('sizes the canvas by the device pixel ratio', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    render(<Timeline {...props()} />, host)
    await nextFrame()

    const canvas = host.querySelector('canvas')!
    expect(canvas.width).toBe(1800)
    expect(calls.some((call) => call.op === 'setTransform' && call.args[0] === 2)).toBe(true)
  })

  it('paints once per frame however many times the props change', async () => {
    // Zooming sends a burst of wheel events; a paint per event is a paint per event wasted.
    const height = sceneHeight(METRICS, 1, 1)
    render(<Timeline {...props()} />, host)
    render(<Timeline {...props()} playhead={4} />, host)
    render(<Timeline {...props()} playhead={5} />, host)
    await nextFrame()

    // The background is the only fill as wide as the scene and as tall as it.
    const backgrounds = calls.filter(
      (call) => call.op === 'fillRect' && call.args[2] === 900 && call.args[3] === height,
    )
    expect(backgrounds).toHaveLength(1)
  })

  it('reports the width of its host on mount', async () => {
    const widths: number[] = []
    render(<Timeline {...props()} onResize={(width) => widths.push(width)} />, host)
    await nextFrame()

    expect(widths).toEqual([900])
  })

  it('survives a canvas with no 2d context', async () => {
    HTMLCanvasElement.prototype.getContext = () => null
    render(<Timeline {...props()} />, host)
    await nextFrame()

    expect(host.querySelector('canvas')).not.toBeNull()
  })
})
