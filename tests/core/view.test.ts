import { describe, it, expect } from 'vitest'
import {
  FIT_MARGIN_PX,
  FRAME_PX,
  MIN_LABEL_PX,
  MIN_TICK_PX,
  clampView,
  fitAll,
  fitRange,
  panBy,
  tickLabel,
  tickSteps,
  ticks,
  timeToX,
  viewEnd,
  wheelPixels,
  xToTime,
  zoomAt,
  zoomFactorOf,
  zoomLimits,
  zoomToward,
  type ViewBounds,
  type Viewport,
} from '../../src/core/timeline/view'

/** Three minutes across 1200 pixels — the view the editor opens on. */
const wide: Viewport = { start: 0, scale: 180 / 1200, widthPx: 1200 }
/** One frame across forty pixels at 25 fps — the deepest the editor zooms. */
const deep: Viewport = { start: 61.2, scale: 1 / 25 / 40, widthPx: 1200 }

describe('time and pixels', () => {
  it('maps time to pixels through seconds per pixel', () => {
    expect(timeToX(wide, 0)).toBe(0)
    expect(timeToX(wide, 90)).toBe(600)
    expect(timeToX({ ...wide, start: 90 }, 90)).toBe(0)
  })

  it('xToTime is the inverse of timeToX', () => {
    for (const time of [0, 0.04, 17.5, 179.96]) {
      expect(xToTime(wide, timeToX(wide, time))).toBeCloseTo(time, 12)
      expect(xToTime(deep, timeToX(deep, time))).toBeCloseTo(time, 12)
    }
  })

  it('viewEnd is the time at the right edge', () => {
    expect(viewEnd(wide)).toBeCloseTo(180, 12)
    expect(viewEnd({ ...wide, start: 60 })).toBeCloseTo(240, 12)
  })
})

describe('tickSteps', () => {
  it('minor ticks are never denser than MIN_TICK_PX', () => {
    for (const scale of [0.0001, 0.001, 0.01, 0.15, 1, 5]) {
      const steps = tickSteps({ ...wide, scale }, 25)
      expect(steps.minor / scale).toBeGreaterThanOrEqual(MIN_TICK_PX)
    }
  })

  it('labelled ticks are never denser than MIN_LABEL_PX', () => {
    for (const scale of [0.0001, 0.001, 0.01, 0.15, 1, 5]) {
      const steps = tickSteps({ ...wide, scale }, 25)
      expect(steps.major / scale).toBeGreaterThanOrEqual(MIN_LABEL_PX)
    }
  })

  it('the major step is a whole multiple of the minor one', () => {
    // Otherwise the labels stand between the ticks they label.
    for (const scale of [0.0001, 0.001, 0.01, 0.15, 1, 5]) {
      const { minor, major } = tickSteps({ ...wide, scale }, 25)
      expect(Math.abs(major / minor - Math.round(major / minor))).toBeLessThan(1e-9)
    }
  })

  it('at frame zoom the minor step is one frame', () => {
    expect(tickSteps(deep, 25).minor).toBeCloseTo(1 / 25, 12)
    // And at 30 fps, whose frame is not a round number and stands nowhere on the ladder: asked
    // only for a round step the ruler would take 0.04 s here and count frames it never touches.
    expect(tickSteps(deep, 30).minor).toBeCloseTo(1 / 30, 12)
  })

  it('with no frame rate the ladder is used all the way down', () => {
    expect(tickSteps(deep, 0).minor).toBeGreaterThan(0)
    expect(tickSteps(deep, 0).minor / deep.scale).toBeGreaterThanOrEqual(MIN_TICK_PX)
  })

  it('on the widest view the step is a minute or more', () => {
    expect(tickSteps({ start: 0, scale: 3600 / 1200, widthPx: 1200 }, 25).major).toBeGreaterThanOrEqual(60)
  })
})

describe('ticks', () => {
  it('start at zero and never run before the material', () => {
    const marks = ticks({ ...wide, start: -10 }, 25)
    expect(marks[0]!.time).toBe(0)
  })

  it('cover the whole width', () => {
    const marks = ticks(wide, 25)
    expect(marks[marks.length - 1]!.time).toBeGreaterThan(viewEnd(wide) - tickSteps(wide, 25).minor)
  })

  it('mark the labelled ones as major', () => {
    const { major } = tickSteps(wide, 25)
    for (const mark of ticks(wide, 25)) {
      expect(mark.major).toBe(Math.abs(mark.time / major - Math.round(mark.time / major)) < 1e-6)
    }
    expect(ticks(wide, 25).some((mark) => mark.major)).toBe(true)
  })

  it('are bounded by the width however deep the zoom', () => {
    for (const view of [wide, deep, { ...deep, scale: 1e-6 }]) {
      expect(ticks(view, 25).length).toBeLessThanOrEqual(view.widthPx / MIN_TICK_PX + 2)
    }
  })

  it('a viewport of no width or no scale draws nothing', () => {
    expect(ticks({ start: 0, scale: 0, widthPx: 1200 }, 25)).toEqual([])
    expect(ticks({ start: 0, scale: 0.1, widthPx: 0 }, 25)).toEqual([])
  })
})

describe('tickLabel', () => {
  it('shows minutes and seconds on a step of a second or more', () => {
    expect(tickLabel(83, 1, 25)).toBe('1:23')
    expect(tickLabel(0, 30, 25)).toBe('0:00')
  })

  it('shows hours once the material is that long', () => {
    expect(tickLabel(3723, 60, 25)).toBe('1:02:03')
  })

  it('shows the frame on a step under a second', () => {
    expect(tickLabel(83.24, 0.2, 25)).toBe('1:23:06')
  })

  it('never labels a frame with the frame rate itself', () => {
    // 24.999 s at 25 fps is frame 0 of the twenty-fifth second, not frame 25 of the twenty-fourth.
    expect(tickLabel(24.9999, 0.2, 25)).toBe('0:25:00')
  })

  it('with no frame rate falls back to seconds', () => {
    expect(tickLabel(83.24, 0.2, 0)).toBe('1:23')
  })
})

describe('zoom and pan', () => {
  const bounds: ViewBounds = { duration: 180, fps: 25 }
  const middle: Viewport = { start: 60, scale: 0.05, widthPx: 1200 }

  it('keeps the time under the pointer where it was', () => {
    const before = xToTime(middle, 300)
    const zoomed = zoomAt(middle, 300, 0.8, bounds)

    expect(zoomed.scale).toBeCloseTo(0.04, 12)
    expect(xToTime(zoomed, 300)).toBeCloseTo(before, 12)
  })

  it('a hundred notches in and a hundred back return the very same viewport', () => {
    const factor = Math.exp(-0.02)
    let view = middle
    for (let i = 0; i < 100; i++) view = zoomAt(view, 300, factor, bounds)
    expect(view.scale).toBeLessThan(middle.scale / 2)
    for (let i = 0; i < 100; i++) view = zoomAt(view, 300, 1 / factor, bounds)

    expect(Math.abs(view.scale - middle.scale)).toBeLessThan(1e-9)
    expect(Math.abs(view.start - middle.start)).toBeLessThan(1e-9)
  })

  it('goes no deeper than one frame across FRAME_PX', () => {
    let view = middle
    for (let i = 0; i < 500; i++) view = zoomAt(view, 600, 0.9, bounds)

    expect(view.scale).toBeCloseTo(1 / 25 / FRAME_PX, 12)
    expect(zoomLimits(bounds, 1200).min).toBeCloseTo(1 / 25 / FRAME_PX, 12)
    // At the limit a zoom is a no-op, and a no-op hands the very object back: rebuilding it out
    // of the same numbers would both repaint for nothing and let the anchor drift a bit a turn.
    expect(zoomAt(view, 600, 0.9, bounds)).toBe(view)
  })

  it('never shows more than the material', () => {
    let view = middle
    for (let i = 0; i < 500; i++) view = zoomAt(view, 600, 1.1, bounds)

    expect(view.scale).toBeCloseTo(180 / 1200, 12)
    expect(view.start).toBe(0)
  })

  it('holds the playhead while it is on the screen', () => {
    const zoomed = zoomToward(middle, 75, 0.5, bounds)

    expect(timeToX(zoomed, 75)).toBeCloseTo(timeToX(middle, 75), 9)
  })

  it('falls back to the middle of the screen when the playhead is not on it', () => {
    const zoomed = zoomToward(middle, 5, 0.5, bounds)

    expect(xToTime(zoomed, 600)).toBeCloseTo(xToTime(middle, 600), 9)
  })

  it('pans against the drag: dragging the material right shows earlier time', () => {
    expect(panBy(middle, 200, bounds).start).toBeCloseTo(60 - 200 * 0.05, 12)
    expect(panBy(middle, -200, bounds).start).toBeCloseTo(60 + 200 * 0.05, 12)
  })

  it('cannot be panned out of the material', () => {
    expect(panBy(middle, 100_000, bounds).start).toBe(0)
    // 1200 px at 0.05 s/px is a minute of material: the last minute is as far as it goes.
    expect(panBy(middle, -100_000, bounds).start).toBeCloseTo(120, 12)
  })

  it('fits a range on the screen with a margin on both sides', () => {
    const fitted = fitRange(middle, { start: 30, end: 40 }, bounds)

    expect(timeToX(fitted, 30)).toBeCloseTo(FIT_MARGIN_PX, 6)
    expect(timeToX(fitted, 40)).toBeCloseTo(1200 - FIT_MARGIN_PX, 6)
  })

  it('fits a range too short for the deepest zoom without breaking the limit', () => {
    const fitted = fitRange(middle, { start: 30, end: 30.001 }, bounds)

    expect(fitted.scale).toBeCloseTo(zoomLimits(bounds, 1200).min, 12)
    // The zoom stopped at the limit, and the margin is still the margin: a range that turned
    // out smaller than the screen can show does not slide to the left edge because of it.
    expect(timeToX(fitted, 30)).toBeCloseTo(FIT_MARGIN_PX, 6)
  })

  it('fits the whole material edge to edge', () => {
    const fitted = fitAll(middle, bounds)

    expect(fitted.start).toBe(0)
    expect(fitted.scale).toBeCloseTo(180 / 1200, 12)
  })

  it('clampView gives the same object back when nothing had to move', () => {
    // Identity is what lets the reducer answer "nothing changed" without comparing fields.
    expect(clampView(middle, bounds)).toBe(middle)
  })

  it('pulls a viewport that outgrew its limits back inside them', () => {
    // Nothing on the way in touches the scale except this, so nothing else can catch a viewport
    // kept from a narrower window: 0.05 s/px across 6000 px is five minutes of three of material.
    const wider = clampView({ ...middle, widthPx: 6000 }, bounds)

    expect(wider.scale).toBeCloseTo(180 / 6000, 12)
    expect(wider.start).toBe(0)
    // A session with no material yet: the ceiling of the pan is below its floor, and the view
    // still may not begin before zero.
    expect(clampView(middle, { duration: 0, fps: 25 }).start).toBe(0)
  })

  it('turns lines and pages of a wheel into pixels', () => {
    expect(wheelPixels(3, 0)).toBe(3)
    expect(wheelPixels(3, 1)).toBe(3 * 16)
    expect(wheelPixels(1, 2)).toBe(400)
  })

  it('opposite notches of the wheel cancel exactly', () => {
    expect(zoomFactorOf(120) * zoomFactorOf(-120)).toBeCloseTo(1, 15)
    expect(zoomFactorOf(-120)).toBeLessThan(1)
    expect(zoomFactorOf(0)).toBe(1)
  })
})
