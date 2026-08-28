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

/**
 * The corner the canvas is measured at.
 *
 * Not the origin of the page: the timeline sits under a header and beside an inspector, and a
 * pointer position that is not translated into the canvas lands minutes away in the material.
 */
const ORIGIN = { x: 40, y: 10 }

/** happy-dom measures every element as zero; the host is given a box to report. */
function installWidth(width: number): void {
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      width,
      height: 0,
      x: ORIGIN.x,
      y: ORIGIN.y,
      top: ORIGIN.y,
      left: ORIGIN.x,
      right: ORIGIN.x + width,
      bottom: ORIGIN.y,
      toJSON: () => ({}),
    }) as DOMRect
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/** A mouse event at a point of the canvas, turned into the page coordinates the browser sends. */
const at = (type: string, x: number, y: number, button = 0): MouseEvent =>
  new MouseEvent(type, {
    clientX: ORIGIN.x + x,
    clientY: ORIGIN.y + y,
    button,
    bubbles: true,
  })

const press = (x: number, y: number, button = 0): MouseEvent => at('pointerdown', x, y, button)

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
  onGesture: () => {},
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

  it('turns a wheel over the canvas into a zoom at the pointer', () => {
    const gestures: unknown[] = []
    render(<Timeline {...props()} onGesture={(gesture) => gestures.push(gesture)} />, host)

    const canvas = host.querySelector('canvas')!
    const event = new WheelEvent('wheel', { deltaY: -120, cancelable: true })
    // In a browser a wheel event is a MouseEvent and carries the pointer with it; happy-dom's
    // descends from UIEvent and has no position at all. The component reads clientX, so the test
    // gives the event one rather than letting the wheel arrive from nowhere.
    Object.defineProperty(event, 'clientX', { value: ORIGIN.x + 300 })
    canvas.dispatchEvent(event)

    expect(gestures).toEqual([{ type: 'zoom', atPx: 300, factor: expect.any(Number) }])
    // Without this the page scrolls under the timeline and Ctrl+wheel zooms the whole tab.
    expect(event.defaultPrevented).toBe(true)
  })

  it('turns a drag across a lane into a pan', () => {
    const gestures: unknown[] = []
    render(<Timeline {...props()} onGesture={(gesture) => gestures.push(gesture)} />, host)

    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(press(100, 60))
    window.dispatchEvent(at('pointermove', 150, 60))
    window.dispatchEvent(at('pointerup', 150, 60))

    expect(gestures).toEqual([{ type: 'pan', dxPx: 50 }])
  })

  it('turns a click without travel into a seek', () => {
    const gestures: unknown[] = []
    render(<Timeline {...props()} onGesture={(gesture) => gestures.push(gesture)} />, host)

    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(press(100, 60))
    window.dispatchEvent(at('pointerup', 100, 60))

    // 100 px into the canvas at 0.05 s/px, and not 140 px into the page: the seek is where the
    // material was clicked, whatever the timeline has above it and to the left of it.
    expect(gestures).toEqual([{ type: 'seek', time: 5 }])
  })

  it('lets a right-click alone', () => {
    const gestures: unknown[] = []
    render(<Timeline {...props()} onGesture={(gesture) => gestures.push(gesture)} />, host)

    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(press(100, 60, 2))
    window.dispatchEvent(at('pointermove', 200, 60))

    // The context menu belongs to the page: grabbing the material on a right button would pan it
    // behind the menu that is opening over it.
    expect(gestures).toEqual([])
  })

  it('lets go of the window when it is taken off the page', () => {
    const gestures: unknown[] = []
    render(<Timeline {...props()} onGesture={(gesture) => gestures.push(gesture)} />, host)
    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(press(100, 60))
    render(null, host)

    // A listener left on the window after the editor is gone keeps the whole component alive —
    // and goes on answering the mouse for a timeline that is not on the page any more.
    window.dispatchEvent(at('pointermove', 400, 60))
    window.dispatchEvent(at('pointerup', 400, 60))

    expect(gestures).toEqual([])
  })
})
