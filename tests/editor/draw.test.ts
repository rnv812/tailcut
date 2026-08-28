import { describe, it, expect } from 'vitest'
import { PALETTE, paintScene, truncate, type Painter } from '../../src/editor/timeline/draw'
import type { Scene } from '../../src/core/timeline/layout'

interface Call {
  op: 'fillRect' | 'fillText'
  style: string
  args: number[]
  text?: string
}

/**
 * A painter that writes down what it was asked to do. `Painter` is six members of the real
 * context and nothing more, which is what lets the whole of the drawing be checked without a
 * browser: what a canvas would show is decided here, and whether a canvas shows it is decided
 * by the Playwright spec.
 */
function recorder(): { painter: Painter; calls: Call[] } {
  const calls: Call[] = []
  const painter: Painter = {
    fillStyle: '',
    font: '',
    textBaseline: 'alphabetic',
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ op: 'fillRect', style: String(painter.fillStyle), args: [x, y, w, h] })
    },
    fillText(text: string, x: number, y: number) {
      calls.push({ op: 'fillText', style: String(painter.fillStyle), args: [x, y], text })
    },
    clearRect() {},
  }
  return { painter, calls }
}

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
    const { painter, calls } = recorder()
    paintScene(painter, scene({ rects: [{ kind: 'gap', x: 0, y: 30, width: 10, height: 10 }] }))

    expect(calls[0]).toEqual({ op: 'fillRect', style: PALETTE.background, args: [0, 0, 200, 100] })
    expect(calls[1]).toEqual({ op: 'fillRect', style: PALETTE.ruler, args: [0, 0, 200, 24] })
    expect(calls[2]!.style).toBe(PALETTE.fill.gap)
  })

  it('paints every rect in the colour of its kind', () => {
    const { painter, calls } = recorder()
    paintScene(
      painter,
      scene({
        rects: [
          { kind: 'run-video', x: 0, y: 24, width: 100, height: 40 },
          { kind: 'run-audio', x: 0, y: 70, width: 100, height: 40 },
          { kind: 'playhead', x: 50, y: 0, width: 1, height: 100 },
        ],
      }),
    )

    const painted = calls.filter((call) => call.op === 'fillRect').map((call) => call.style)
    expect(painted).toEqual([
      PALETTE.background,
      PALETTE.ruler,
      PALETTE.fill['run-video'],
      PALETTE.fill['run-audio'],
      PALETTE.fill.playhead,
    ])
  })

  it('paints a major tick taller than a minor one', () => {
    const { painter, calls } = recorder()
    paintScene(painter, scene({ ticks: [{ x: 10, major: false }, { x: 20, major: true, label: '0:10' }] }))

    const rects = calls.filter((call) => call.op === 'fillRect')
    const minor = rects[2]!
    const major = rects[3]!
    expect(minor.args[3]).toBeLessThan(major.args[3]!)
    expect(minor.style).toBe(PALETTE.tick)
    expect(major.style).toBe(PALETTE.tickMajor)
  })

  it('paints the labels after every rect, so nothing is painted over them', () => {
    const { painter, calls } = recorder()
    paintScene(
      painter,
      scene({
        ticks: [{ x: 20, major: true, label: '0:10' }],
        rects: [{ kind: 'clip', x: 0, y: 60, width: 120, height: 18, label: 'Clip one' }],
      }),
    )

    const firstText = calls.findIndex((call) => call.op === 'fillText')
    const lastRect = calls.map((call) => call.op).lastIndexOf('fillRect')
    expect(firstText).toBeGreaterThan(lastRect)
    expect(calls.filter((call) => call.op === 'fillText').map((call) => call.text)).toEqual([
      '0:10',
      'Clip one',
    ])
  })

  it('says nothing on a rect too narrow for a name', () => {
    const { painter, calls } = recorder()
    paintScene(painter, scene({ rects: [{ kind: 'clip', x: 0, y: 60, width: 20, height: 18, label: 'Clip one' }] }))

    expect(calls.some((call) => call.op === 'fillText')).toBe(false)
  })

  it('writes the caption of a snap although its line is one pixel wide', () => {
    const { painter, calls } = recorder()
    paintScene(
      painter,
      scene({ rects: [{ kind: 'snap', x: 120, y: 0, width: 1, height: 100, label: 'keyframe' }] }),
    )
    const text = calls.find((call) => call.op === 'fillText')!

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
    const { painter, calls } = recorder()
    paintScene(
      painter,
      scene({
        rects: [
          { kind: 'clip', x: 0, y: 60, width: 20, height: 18, label: 'Narrow' },
          { kind: 'clip', x: 40, y: 60, width: 120, height: 18, label: 'Wide' },
        ],
      }),
    )
    const texts = calls.filter((call) => call.op === 'fillText')

    expect(texts.map((call) => call.text)).toEqual(['Wide'])
    expect(texts[0]!.style).toBe(PALETTE.clipLabel)
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
