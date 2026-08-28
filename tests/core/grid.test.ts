import { describe, it, expect } from 'vitest'
import {
  boundaryIndexAt,
  boundaryTime,
  frameGrid,
  nearestBoundary,
  quantize,
  shiftBy,
} from '../../src/core/timeline/grid'

/**
 * Half-second frames with a hole between 2 and 5. Half a second is not a frame rate anybody
 * shoots at; it is a grid, and a grid of round numbers is a grid whose arithmetic can be read.
 */
const grid = Float64Array.from([0, 0.5, 1, 1.5, 2, 5, 5.5, 6])
const empty = new Float64Array()

describe('frameGrid', () => {
  it('is every frame start plus the end of the last frame of a run', () => {
    // Two runs: three frames from 0 and two from 5. The end of a run is a boundary too, or an
    // out point could never take in the last frame of the material.
    const built = frameGrid({
      pts: Float64Array.from([0, 0.5, 1, 5, 5.5]),
      durations: Float64Array.from([0.5, 0.5, 0.5, 0.5, 0.5]),
    })

    expect([...built]).toEqual([0, 0.5, 1, 1.5, 5, 5.5, 6])
  })

  it('does not double a boundary when one frame ends where the next begins', () => {
    const built = frameGrid({
      pts: Float64Array.from([0, 0.04]),
      durations: Float64Array.from([0.04, 0.04]),
    })

    expect(built).toHaveLength(3)
  })

  it('does not double one when a frame time repeats either', () => {
    // A sample that carries the presentation time of the one before it is what a seam between
    // two segments can hand over. A doubled boundary would be a step to nowhere: shiftBy would
    // walk a frame forwards and stand where it was.
    const built = frameGrid({
      pts: Float64Array.from([0, 0.25, 0.25, 0.5]),
      durations: Float64Array.from([0.25, 0.25, 0.25, 0.25]),
    })

    expect([...built]).toEqual([0, 0.25, 0.5, 0.75])
    expect(shiftBy(built, 0.25, 1)).toBe(0.5)
  })
})

describe('boundaries', () => {
  it('the boundary at a time is the frame showing then', () => {
    expect(boundaryIndexAt(grid, 1.2)).toBe(2)
    expect(boundaryIndexAt(grid, 1.5)).toBe(3)
  })

  it('clamps to the ends', () => {
    expect(boundaryIndexAt(grid, -10)).toBe(0)
    expect(boundaryIndexAt(grid, 99)).toBe(7)
    expect(boundaryTime(grid, -3)).toBe(0)
    expect(boundaryTime(grid, 99)).toBe(6)
  })

  it('quantize goes to the nearer boundary', () => {
    expect(quantize(grid, 1.2)).toBe(1)
    expect(quantize(grid, 1.3)).toBe(1.5)
    expect(nearestBoundary(grid, 1.3)).toBe(3)
  })

  it('quantize never lands inside a gap', () => {
    // There is no frame between 2 and 5, so a time in the hole belongs to the near edge of it.
    expect(quantize(grid, 3.4)).toBe(2)
    expect(quantize(grid, 3.6)).toBe(5)
  })

  it('shiftBy walks whole frames', () => {
    expect(shiftBy(grid, 1, 2)).toBe(2)
    expect(shiftBy(grid, 1.5, -2)).toBe(0.5)
  })

  it('shiftBy crosses a gap in a single step', () => {
    expect(shiftBy(grid, 2, 1)).toBe(5)
    expect(shiftBy(grid, 5, -1)).toBe(2)
  })

  it('shiftBy from between the boundaries starts at the one before', () => {
    expect(shiftBy(grid, 1.2, 1)).toBe(1.5)
  })

  it('shiftBy stops at the ends of the material', () => {
    expect(shiftBy(grid, 0, -5)).toBe(0)
    expect(shiftBy(grid, 6, 5)).toBe(6)
  })

  it('an empty grid changes nothing', () => {
    expect(quantize(empty, 3.3)).toBe(3.3)
    expect(shiftBy(empty, 3.3, 4)).toBe(3.3)
    expect(boundaryTime(empty, 0)).toBe(0)
  })
})
