import { describe, it, expect } from 'vitest'
import { METRICS } from '../../src/core/timeline/layout'
import {
  DRAG_SLOP_PX,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  type Surface,
} from '../../src/core/timeline/gesture'
import { zoomFactorOf, type Viewport } from '../../src/core/timeline/view'

const view: Viewport = { start: 0, scale: 0.05, widthPx: 1200 }
const surface: Surface = { view, metrics: METRICS, laneCount: 2 }

const wheel = (overrides: Partial<Parameters<typeof onWheel>[0]> = {}) =>
  onWheel({ x: 300, deltaX: 0, deltaY: 0, deltaMode: 0, shift: false, ...overrides })

/** A point inside the first lane: below the ruler, above the clip rows. */
const inLane = { x: 300, y: METRICS.rulerHeight + 10, alt: false }
const inRuler = { x: 200, y: 6, alt: false }

describe('onWheel', () => {
  it('zooms toward the pointer', () => {
    expect(wheel({ deltaY: -120 })).toEqual({ type: 'zoom', atPx: 300, factor: zoomFactorOf(-120) })
  })

  it('zooms out on a wheel the other way', () => {
    const gesture = wheel({ deltaY: 120 })

    expect(gesture).toMatchObject({ type: 'zoom' })
    expect((gesture as { factor: number }).factor).toBeGreaterThan(1)
  })

  it('pans instead when shift is held', () => {
    expect(wheel({ deltaY: -120, shift: true })).toEqual({ type: 'pan', dxPx: 120 })
  })

  it('pans on a horizontal wheel', () => {
    // A trackpad swipe: the horizontal delta wins whenever it is the larger one.
    expect(wheel({ deltaX: 90, deltaY: 10 })).toEqual({ type: 'pan', dxPx: -90 })
  })

  it('turns lines and pages into pixels before deciding', () => {
    expect(wheel({ deltaY: -3, deltaMode: 1 })).toEqual({
      type: 'zoom',
      atPx: 300,
      factor: zoomFactorOf(-48),
    })
  })

  it('says nothing about a wheel that did not move', () => {
    expect(wheel({})).toBeNull()
    expect(wheel({ shift: true })).toBeNull()
  })
})

describe('pointer', () => {
  it('scrubs on a press in the ruler', () => {
    const result = onPointerDown(surface, inRuler)

    expect(result.gesture).toEqual({ type: 'seek', time: 10 })
    expect(result.drag).toEqual({ kind: 'scrub' })
  })

  it('keeps scrubbing while the pointer is dragged along the ruler', () => {
    const down = onPointerDown(surface, inRuler)
    const move = onPointerMove(surface, down.drag, { ...inRuler, x: 400 })

    expect(move.gesture).toEqual({ type: 'seek', time: 20 })
    expect(move.drag).toEqual({ kind: 'scrub' })
  })

  it('starts a pan on a press in a lane and says nothing yet', () => {
    const result = onPointerDown(surface, inLane)

    expect(result.gesture).toBeNull()
    expect(result.drag).toEqual({ kind: 'pan', x: 300, from: 300, moved: false })
  })

  it('pans by the pixels travelled since the last move', () => {
    const down = onPointerDown(surface, inLane)
    const first = onPointerMove(surface, down.drag, { ...inLane, x: 340 })
    const second = onPointerMove(surface, first.drag, { ...inLane, x: 350 })

    expect(first.gesture).toEqual({ type: 'pan', dxPx: 40 })
    expect(second.gesture).toEqual({ type: 'pan', dxPx: 10 })
  })

  it('a press and a release without travel is a seek', () => {
    const down = onPointerDown(surface, inLane)
    const move = onPointerMove(surface, down.drag, { ...inLane, x: 300 + DRAG_SLOP_PX - 1 })
    const up = onPointerUp(surface, move.drag, { ...inLane, x: 300 + DRAG_SLOP_PX - 1 })

    // 302 px at 0.05 s/px: 302 × 0.05 is 15.100000000000001 in binary, so the seek is compared
    // as the number it is and not as the decimal it prints to.
    expect(up.gesture).toMatchObject({ type: 'seek' })
    expect((up.gesture as { time: number }).time).toBeCloseTo(15.1, 12)
    expect(up.drag).toBeNull()
  })

  it('a release after a real drag seeks nowhere', () => {
    const down = onPointerDown(surface, inLane)
    const move = onPointerMove(surface, down.drag, { ...inLane, x: 500 })
    const up = onPointerUp(surface, move.drag, { ...inLane, x: 500 })

    expect(up.gesture).toBeNull()
    expect(up.drag).toBeNull()
  })

  it('a release of a scrub seeks nowhere either', () => {
    const down = onPointerDown(surface, inRuler)

    expect(onPointerUp(surface, down.drag, inRuler).gesture).toBeNull()
  })

  it('ignores a move that belongs to no drag', () => {
    expect(onPointerMove(surface, null, inLane)).toEqual({ drag: null, gesture: null })
    expect(onPointerUp(surface, null, inLane)).toEqual({ drag: null, gesture: null })
  })

  it('never seeks before the material', () => {
    expect(onPointerDown(surface, { ...inRuler, x: -40 }).gesture).toEqual({ type: 'seek', time: 0 })
  })
})
