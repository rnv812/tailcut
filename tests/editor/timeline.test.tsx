// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from 'preact'
import { Timeline } from '../../src/editor/timeline/timeline'
import type { Hover } from '../../src/core/timeline/hover'
import type { Lane } from '../../src/core/timeline/lanes'
import { METRICS, rowTop, sceneHeight } from '../../src/core/timeline/layout'
import { snapSet } from '../../src/core/timeline/snap'
import { PALETTE } from '../../src/editor/timeline/draw'

const lanes: Lane[] = [
  { kind: 'video', runs: [{ start: 0, end: 60 }], gaps: [], zones: [] },
]

interface Call {
  op: string
  args: number[]
  text?: string
  style?: string
}

let calls: Call[] = []
const hovers: Array<Hover | null> = []

/** The recording context every canvas of the test gets: happy-dom has no 2d context of its own. */
function installContext(): void {
  const context = {
    fillStyle: '',
    font: '',
    textBaseline: 'alphabetic',
    fillRect: (...args: number[]) => calls.push({ op: 'fillRect', args, style: String(context.fillStyle) }),
    fillText: (text: string, ...args: number[]) =>
      calls.push({ op: 'fillText', args, text, style: String(context.fillStyle) }),
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

/**
 * A frame, and the turn after it on which preact runs the effects of that render.
 *
 * `useLayoutEffect` runs during the render and `useEffect` does not: preact flushes it from a
 * `setTimeout` scheduled inside its own frame callback, one turn later than the paint. A test
 * that waits for the frame alone sees the canvas but not the measurement, and passes only when
 * a neighbouring test happens to have left a timer running.
 */
const afterEffects = async (): Promise<void> => {
  await nextFrame()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

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
  hovers.length = 0
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
  frames: new Float64Array(),
  snap: { targets: [], keyframes: new Float64Array() },
  snapping: true,
  onResize: () => {},
  onGesture: () => {},
  onHover: (hover: Hover | null) => hovers.push(hover),
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
    // The bitmap and its CSS box name the same 900 logical pixels. A percentage here lets the
    // parent stretch a stale 1200 px opening bitmap to whatever width the editor happens to have,
    // blurring the ruler and making the point under the mouse a different point in the scene.
    expect(canvas.style.width).toBe('900px')
    expect(calls.some((call) => call.op === 'setTransform' && call.args[0] === 2)).toBe(true)
  })

  it('converts a point in a scaled CSS box into the canvas logical width', () => {
    installWidth(450)
    const gestures: unknown[] = []
    render(<Timeline {...props()} onGesture={(gesture) => gestures.push(gesture)} />, host)

    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(press(100, METRICS.rulerHeight - 2))

    // The scene is 900 logical pixels wide but the staged CSS box is half that width. A hundred
    // CSS pixels is therefore x=200 in the scene, which is ten seconds at 0.05 s/px.
    expect(gestures).toEqual([{ type: 'seek', time: 10 }])
  })

  it('moves a DOM playhead with the render instead of waiting for the canvas frame', async () => {
    render(<Timeline {...props()} />, host)
    await nextFrame()
    // It has one owner. Leaving the old line in the bitmap would show two playheads between the
    // synchronous DOM move and the next deferred scene paint.
    expect(calls.some((call) => call.style === PALETTE.fill.playhead)).toBe(false)
    calls.length = 0

    render(<Timeline {...props()} playhead={5} />, host)

    const playhead = host.querySelector<HTMLElement>('[data-testid="timeline-playhead"]')!
    expect(playhead).not.toBeNull()
    expect(playhead.style.left).toBe('100px')
    // The canvas repaint is deliberately still pending. The moving line is a DOM pixel, so the
    // user sees the new frame now and no old canvas line remains beside it for one refresh.
    expect(calls.some((call) => call.style === PALETTE.fill.playhead)).toBe(false)
  })

  it('exposes the visible time window to accessibility and integration checks', () => {
    render(<Timeline {...props()} />, host)

    const timeline = host.querySelector<HTMLElement>('.tc-timeline')!
    expect(timeline.dataset.viewStart).toBe('0')
    expect(timeline.dataset.viewScale).toBe('0.05')
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
    await afterEffects()

    expect(widths).toEqual([900])
  })

  it('reports a width once however many times it is observed', async () => {
    // The observation this stages is one happy-dom never delivers: its ResizeObserver takes the
    // callback and never calls it — measured with a probe, zero calls in 50 ms — so the double
    // report the component guards against cannot arise in this environment on its own. What a
    // real observer does is deliver a first observation the moment `observe` is called, on top
    // of the measurement the effect has just taken by hand; the extra rounds below stand for a
    // resize that moved something else and left the width where it was.
    const fired: (() => void)[] = []
    class StagedObserver {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        fired.push(this.callback)
        this.callback()
      }
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', StagedObserver)

    const widths: number[] = []
    render(<Timeline {...props()} onResize={(width) => widths.push(width)} />, host)
    await afterEffects()
    for (const fire of fired) fire()

    // One report, not three: a viewport of the same width pushed through the reducer again is a
    // render of the whole editor for a screen that did not change.
    expect(widths).toEqual([900])

    // And the guard is a guard and not a lid: a width that really changed is reported.
    installWidth(640)
    for (const fire of fired) fire()

    expect(widths).toEqual([900, 640])
  })

  it('survives a canvas with no 2d context', async () => {
    HTMLCanvasElement.prototype.getContext = () => null
    render(<Timeline {...props()} />, host)
    await nextFrame()

    expect(host.querySelector('canvas')).not.toBeNull()
  })

  it('turns a vertical wheel over the canvas into a horizontal time pan', () => {
    const gestures: unknown[] = []
    render(<Timeline {...props()} onGesture={(gesture) => gestures.push(gesture)} />, host)

    const canvas = host.querySelector('canvas')!
    const event = new WheelEvent('wheel', { deltaY: -120, cancelable: true })
    // In a browser a wheel event is a MouseEvent and carries the pointer with it; happy-dom's
    // descends from UIEvent and has no position at all. The component reads clientX, so the test
    // gives the event one rather than letting the wheel arrive from nowhere.
    Object.defineProperty(event, 'clientX', { value: ORIGIN.x + 300 })
    canvas.dispatchEvent(event)

    expect(gestures).toEqual([{ type: 'pan', dxPx: 120 }])
    // Without this the page scrolls under the timeline as well as moving through time.
    expect(event.defaultPrevented).toBe(true)
  })

  it('turns Alt plus a vertical wheel into a zoom at the pointer', () => {
    const gestures: unknown[] = []
    render(<Timeline {...props()} onGesture={(gesture) => gestures.push(gesture)} />, host)

    const canvas = host.querySelector('canvas')!
    const event = new WheelEvent('wheel', { deltaY: -120, altKey: true, cancelable: true })
    Object.defineProperty(event, 'clientX', { value: ORIGIN.x + 300 })
    Object.defineProperty(event, 'altKey', { value: true })
    canvas.dispatchEvent(event)

    expect(gestures).toEqual([{ type: 'zoom', atPx: 300, factor: expect.any(Number) }])
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves a wheel event alone when it has no movement to handle', () => {
    const gestures: unknown[] = []
    render(<Timeline {...props()} onGesture={(gesture) => gestures.push(gesture)} />, host)

    const event = new WheelEvent('wheel', { cancelable: true })
    host.querySelector('canvas')!.dispatchEvent(event)

    expect(gestures).toEqual([])
    expect(event.defaultPrevented).toBe(false)
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

  it('draws the snap line while a handle is being dragged', async () => {
    const clips = [{ id: 'c1', name: 'One', in: 5, out: 10, selected: true }]
    const frames = Float64Array.from({ length: 121 }, (_, i) => i * 0.5)
    const snap = snapSet({
      keyframes: Float64Array.from([8]),
      zones: [],
      gaps: [],
      markers: [],
      clips,
      playhead: 0,
    })
    const gestures: unknown[] = []
    render(
      <Timeline
        {...props()}
        clips={clips}
        frames={frames}
        snap={snap}
        onGesture={(gesture) => gestures.push(gesture)}
      />,
      host,
    )
    await nextFrame()
    calls.length = 0

    // The out handle sits at 10 s, that is 200 px at 0.05 s/px; 8 s is 160 px.
    const canvas = host.querySelector('canvas')!
    const y = rowTop(METRICS, 1, 0) + 9
    canvas.dispatchEvent(press(200, y))
    window.dispatchEvent(at('pointermove', 163, y))
    await nextFrame()

    // The keyframe caught it: the trim is at 8 s and not at the 8.15 s the pointer stands on.
    expect(gestures).toEqual([
      { type: 'selectClip', id: 'c1' },
      { type: 'trim', id: 'c1', edge: 'out', time: 8 },
    ])
    // The colour alone says nothing: a caught handle is painted in the same amber as the line
    // and the caption. So the line is looked for by what makes it a line — one pixel wide, the
    // whole scene tall, standing at the target — and the caption by what it says.
    const height = sceneHeight(METRICS, 1, 1)
    const line = calls.filter(
      (call) =>
        call.op === 'fillRect' &&
        call.style === PALETTE.fill.snap &&
        call.args[2] === 1 &&
        call.args[3] === height,
    )
    expect(line).toHaveLength(1)
    expect(line[0]!.args[0]).toBe(160)
    const caption = calls.filter((call) => call.op === 'fillText' && call.text === 'keyframe')
    expect(caption).toHaveLength(1)
    expect(caption[0]!.style).toBe(PALETTE.snapLabel)

    // And the handle under the hand is drawn as the one that caught it. This is the other half
    // of the wire: the component is what knows which handle is being dragged, and a scene never
    // told would stand the line beside a handle painted as though it were free.
    const caught = calls.filter(
      (call) =>
        call.op === 'fillRect' &&
        call.style === PALETTE.fill['handle-snapped'] &&
        call.args[2] === METRICS.handleWidth &&
        call.args[3] === METRICS.clipHeight,
    )
    expect(caught).toHaveLength(1)
    // At 10 s and not at the 8 s it caught: the trim is a gesture the owner of the clips applies,
    // and this test does not apply it. Of the two handles of the clip it is the one that was
    // taken hold of — the in handle at 5 s is painted in the ordinary colour.
    expect(caught[0]!.args[0]).toBe(200 - Math.floor(METRICS.handleWidth / 2))

    // And the line goes with the hand: a caption left on the canvas would name a target that
    // nothing is being dragged onto any more.
    calls.length = 0
    window.dispatchEvent(at('pointerup', 163, y))
    await nextFrame()

    expect(calls.some((call) => call.style === PALETTE.fill.snap)).toBe(false)
    expect(calls.some((call) => call.text === 'keyframe')).toBe(false)
  })

  it('reports where the pointer is, once a frame', async () => {
    render(<Timeline {...props()} />, host)
    await nextFrame()
    hovers.length = 0

    const canvas = host.querySelector('canvas')!
    // A pointer worth its price reports faster than the screen redraws; three moves inside one
    // frame have to cost one report, and it has to be the last of them.
    canvas.dispatchEvent(at('pointermove', 100, 40))
    canvas.dispatchEvent(at('pointermove', 200, 40))
    canvas.dispatchEvent(at('pointermove', 300, 40))
    await nextFrame()

    expect(hovers).toHaveLength(1)
    // 300 px into the canvas, and not the 340 px into the page the event carries: what is
    // reported is a place in the material, and the strip does not start at the edge of the tab.
    expect(hovers[0]!.xPx).toBe(300)
    // 0.05 s a pixel at the opening scale of the stand.
    expect(hovers[0]!.time).toBeCloseTo(15, 9)
  })

  it('drops the report it had scheduled when it is taken off the page', async () => {
    render(<Timeline {...props()} />, host)
    await nextFrame()
    hovers.length = 0

    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(at('pointermove', 300, 40))
    render(null, host)
    await nextFrame()

    // The report is a frame behind the pointer, and a timeline can leave the page inside that
    // frame — a clip closed, a panel swapped. A report that lands afterwards asks for a seek on
    // behalf of a strip nobody is looking at any more.
    expect(hovers).toEqual([])
  })

  it('has nothing to show while a handle is being dragged, and nothing once the pointer leaves', async () => {
    const clips = [{ id: 'c1', name: 'One', in: 5, out: 10, selected: true }]
    const frames = Float64Array.from({ length: 121 }, (_, i) => i * 0.5)
    render(<Timeline {...props()} clips={clips} frames={frames} />, host)
    await nextFrame()

    // The out handle of the clip, at 10 s and so at 200 px: the same grip the snap test takes.
    const canvas = host.querySelector('canvas')!
    const y = rowTop(METRICS, 1, 0) + 9
    canvas.dispatchEvent(press(200, y))
    hovers.length = 0
    canvas.dispatchEvent(at('pointermove', 240, y))
    await nextFrame()
    expect(hovers).toEqual([null])

    window.dispatchEvent(at('pointerup', 240, y))
    hovers.length = 0
    canvas.dispatchEvent(at('pointerleave', 240, y))
    await nextFrame()
    expect(hovers).toEqual([null])
  })
})
