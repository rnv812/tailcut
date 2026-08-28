import { describe, it, expect } from 'vitest'
import {
  MIN_LABEL_PX,
  MIN_TICK_PX,
  tickLabel,
  tickSteps,
  ticks,
  timeToX,
  viewEnd,
  xToTime,
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
