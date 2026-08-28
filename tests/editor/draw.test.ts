import { describe, it, expect } from 'vitest'
import { PALETTE, paintScene, truncate, type Painter } from '../../src/editor/timeline/draw'
import type { RectKind, Scene, WaveformBand } from '../../src/core/timeline/layout'

interface Call {
  args: number[]
  style: string
  text?: string
}

/**
 * Paints a scene into a recording context and hands back what was asked of the canvas.
 *
 * `Painter` is six members of the real context and nothing more, which is what lets the whole of
 * the drawing be checked without a browser: what a canvas would show is decided here, and whether
 * a canvas shows it is decided by the Playwright specs.
 */
const paint = (scene: Scene): { calls: Call[] } => {
  const calls: Call[] = []
  const context = {
    fillStyle: '',
    font: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillRect: (...args: number[]) => calls.push({ args, style: String(context.fillStyle) }),
    fillText: (text: string, ...args: number[]) =>
      calls.push({ args, text, style: String(context.fillStyle) }),
    clearRect: () => {},
  }

  paintScene(context as unknown as Painter, scene)
  return { calls }
}

/**
 * A call that carries a text is a `fillText` and one that does not is a `fillRect`; these two say
 * which is meant, rather than leaving `text === undefined` in every assertion that wants one kind.
 */
const boxes = (calls: Call[]): Call[] => calls.filter((call) => call.text === undefined)
const labels = (calls: Call[]): Call[] => calls.filter((call) => call.text !== undefined)

const scene = (overrides: Partial<Scene> = {}): Scene => ({
  width: 200,
  height: 100,
  rulerHeight: 24,
  rows: 1,
  rects: [],
  ticks: [],
  ...overrides,
})

describe('paintScene', () => {
  it('paints the background and the ruler before anything else', () => {
    const { calls } = paint(scene({ rects: [{ kind: 'gap', x: 0, y: 30, width: 10, height: 10 }] }))

    expect(calls[0]).toEqual({ style: PALETTE.background, args: [0, 0, 200, 100] })
    expect(calls[1]).toEqual({ style: PALETTE.ruler, args: [0, 0, 200, 24] })
    expect(calls[2]!.style).toBe(PALETTE.fill.gap)
  })

  it('paints every rect in the colour of its kind', () => {
    const { calls } = paint(
      scene({
        rects: [
          { kind: 'run-video', x: 0, y: 24, width: 100, height: 40 },
          { kind: 'run-audio', x: 0, y: 70, width: 100, height: 40 },
          { kind: 'playhead', x: 50, y: 0, width: 1, height: 100 },
        ],
      }),
    )

    expect(boxes(calls).map((call) => call.style)).toEqual([
      PALETTE.background,
      PALETTE.ruler,
      PALETTE.fill['run-video'],
      PALETTE.fill['run-audio'],
      PALETTE.fill.playhead,
    ])
  })

  it('paints a major tick taller than a minor one', () => {
    const { calls } = paint(
      scene({ ticks: [{ x: 10, major: false }, { x: 20, major: true, label: '0:10' }] }),
    )

    const rects = boxes(calls)
    const minor = rects[2]!
    const major = rects[3]!
    expect(minor.args[3]).toBeLessThan(major.args[3]!)
    expect(minor.style).toBe(PALETTE.tick)
    expect(major.style).toBe(PALETTE.tickMajor)
  })

  it('paints the labels after every rect, so nothing is painted over them', () => {
    const { calls } = paint(
      scene({
        ticks: [{ x: 20, major: true, label: '0:10' }],
        rects: [{ kind: 'clip', x: 0, y: 60, width: 120, height: 18, label: 'Clip one' }],
      }),
    )

    const firstText = calls.findIndex((call) => call.text !== undefined)
    const lastRect = calls.map((call) => call.text === undefined).lastIndexOf(true)
    expect(firstText).toBeGreaterThan(lastRect)
    expect(labels(calls).map((call) => call.text)).toEqual(['0:10', 'Clip one'])
  })

  it('says nothing on a rect too narrow for a name', () => {
    const { calls } = paint(
      scene({ rects: [{ kind: 'clip', x: 0, y: 60, width: 20, height: 18, label: 'Clip one' }] }),
    )

    expect(labels(calls)).toEqual([])
  })

  it('writes the caption of a snap although its line is one pixel wide', () => {
    const { calls } = paint(
      scene({ rects: [{ kind: 'snap', x: 120, y: 0, width: 1, height: 100, label: 'keyframe' }] }),
    )
    const text = labels(calls)[0]!

    expect(text.text).toBe('keyframe')
    expect(text.style).toBe(PALETTE.snapLabel)
    // Beside the line and not over it, and just under the ruler rather than at the foot of the
    // line: the caption belongs to the handle, which is what the eye is following.
    expect(text.args[0]).toBeGreaterThan(120)
    expect(text.args[1]).toBeGreaterThan(24)
    expect(text.args[1]).toBeLessThan(50)
  })

  it('still says nothing beside a clip too narrow, and says it in the clip colour', () => {
    // The caption of a snap is the one label that ignores the width; a narrow clip stays quiet,
    // and a wide one is written in its own colour and not in the colour of a caught target.
    const { calls } = paint(
      scene({
        rects: [
          { kind: 'clip', x: 0, y: 60, width: 20, height: 18, label: 'Narrow' },
          { kind: 'clip', x: 40, y: 60, width: 120, height: 18, label: 'Wide' },
        ],
      }),
    )
    const texts = labels(calls)

    expect(texts.map((call) => call.text)).toEqual(['Wide'])
    expect(texts[0]!.style).toBe(PALETTE.clipLabel)
  })
})

describe('paintScene: the wave', () => {
  const band = (over: Partial<WaveformBand> = {}): WaveformBand => ({
    x: 0,
    y: 100,
    width: 4,
    height: 40,
    mid: 120,
    min: Int8Array.from([-127, -64, 0, 0]),
    max: Int8Array.from([127, 64, 0, 0]),
    pendingFromPx: 2,
    ...over,
  })

  const scene = (waveform: WaveformBand | null): Scene => ({
    width: 4,
    height: 200,
    rulerHeight: 24,
    rows: 1,
    rects: [{ kind: 'run-audio', x: 0, y: 100, width: 4, height: 40 }],
    ticks: [],
    waveform,
  })

  it('draws a column a pixel from the middle of the band outwards', () => {
    const { calls } = paint(scene(band()))
    const columns = calls.filter((call) => call.style === PALETTE.wave)

    expect(columns).toHaveLength(2)
    // Half the band less a pixel is 19, so full scale runs 101…139 around a middle of 120.
    expect(columns[0]!.args).toEqual([0, 101, 1, 38])
    // Half of full scale: 120 − 19 · 64/127 = 110.43, and a height of 19 either side of it.
    expect(columns[1]!.args).toEqual([1, 110, 1, 19])
  })

  it('draws the stretch that has not been read yet as a quiet line', () => {
    const { calls } = paint(scene(band()))
    const pending = calls.filter((call) => call.style === PALETTE.wavePending)

    // Two columns past the reading, each a line of silence a pixel high: the lane reads as sound
    // not yet counted rather than as sound that is not there.
    expect(pending.map((call) => call.args)).toEqual([
      [2, 120, 1, 1],
      [3, 120, 1, 1],
    ])
  })

  it('draws the wave over what belongs to the lane and under everything else', () => {
    // One rect of every kind there is, each at an x of its own — two kinds share a colour, and
    // the place is what tells their calls apart. The wave lies inside the lane, so the lane and
    // its markings go under it and everything a person reads across it goes over: a clip covered
    // by the wave, or a wave covered by a quality zone, is the whole of what this pins.
    const kinds = Object.keys(PALETTE.fill) as RectKind[]
    const ofLane: RectKind[] = ['run-video', 'run-audio', 'gap', 'zone', 'zone-edge']
    const xOf = (kind: RectKind): number => kinds.indexOf(kind) * 10

    const every = scene(band())
    every.rects = kinds.map((kind) => ({ kind, x: xOf(kind), y: 100, width: 4, height: 40 }))
    const { calls } = paint(every)

    const wave = calls.findIndex((call) => call.style === PALETTE.wave)
    const at = (kind: RectKind): number =>
      calls.findIndex((call) => call.style === PALETTE.fill[kind] && call.args[0] === xOf(kind))

    expect(wave).toBeGreaterThan(0)
    expect(kinds.filter((kind) => at(kind) < 0)).toEqual([])
    expect(kinds.filter((kind) => at(kind) < wave)).toEqual(ofLane)
    expect(kinds.filter((kind) => at(kind) > wave)).toEqual(kinds.filter((kind) => !ofLane.includes(kind)))
  })

  it('paints nothing extra when there is no wave', () => {
    const { calls } = paint(scene(null))
    expect(calls.some((call) => call.style === PALETTE.wave)).toBe(false)
  })
})

describe('truncate', () => {
  it('leaves a short text alone', () => {
    expect(truncate('short', 200)).toBe('short')
  })

  it('cuts a long one with an ellipsis', () => {
    const cut = truncate('a very long clip name indeed', 60)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.length).toBeLessThan('a very long clip name indeed'.length)
  })

  it('never returns an empty string, and never a longer one', () => {
    // A width of nothing still has to say something — a clip band a pixel wide is drawn without
    // a label, but `truncate` is asked for one wherever a caller decides the width is enough —
    // and what it says has to be shorter than what it was handed. Cutting to fit in zero pixels
    // by slicing one character off the end gives 'nam…', which is a label that grew.
    expect(truncate('name', 0)).toBe('n…')
    expect(truncate('name', 0).length).toBeLessThan('name'.length)
  })
})
