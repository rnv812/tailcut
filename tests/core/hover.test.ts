import { describe, it, expect } from 'vitest'
import { THUMB_MARGIN_PX, THUMB_WIDTH_PX, tooltipLeft } from '../../src/core/timeline/hover'

describe('tooltipLeft', () => {
  it('centres the box on the pointer', () => {
    expect(tooltipLeft(500, 1_000, THUMB_WIDTH_PX)).toBe(500 - THUMB_WIDTH_PX / 2)
  })

  it('keeps the box inside the strip at either end', () => {
    expect(tooltipLeft(10, 1_000, THUMB_WIDTH_PX)).toBe(THUMB_MARGIN_PX)
    expect(tooltipLeft(995, 1_000, THUMB_WIDTH_PX)).toBe(1_000 - THUMB_WIDTH_PX - THUMB_MARGIN_PX)
  })

  it('centres what cannot be kept inside a strip narrower than itself', () => {
    // A dragged-in window, or a very deep inspector. Nothing sensible is possible here; what must
    // not happen is a negative offset that puts the box half off the screen.
    expect(tooltipLeft(50, 100, THUMB_WIDTH_PX)).toBe(0)
  })

  it('takes the margin as an argument, because a marker pin wants a tighter one', () => {
    expect(tooltipLeft(0, 1_000, 100, 0)).toBe(0)
    expect(tooltipLeft(1_000, 1_000, 100, 0)).toBe(900)
  })
})
