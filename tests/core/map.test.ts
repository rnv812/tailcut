import { describe, it, expect } from 'vitest'
import { PtsMap, continuesRun, GAP_TOLERANCE_SECONDS } from '../../src/core/timeline/map'
import type { Chunk } from '../../src/shared/types'

const chunk = (start: number, end: number, size = 10, fill = 0): Chunk => ({
  start,
  end,
  bytes: new Uint8Array(size).fill(fill),
})

describe('PtsMap.insert', () => {
  it('keeps chunks in media-time order rather than arrival order', () => {
    const map = new PtsMap()
    map.insert(chunk(4, 6))
    map.insert(chunk(0, 2))
    map.insert(chunk(2, 4))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.chunks.map((c) => c.start)).toEqual([0, 2, 4])
  })

  it('does not duplicate a rewatched chunk', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(0, 2))
    map.insert(chunk(0, 2))

    expect(map.runs()[0]!.chunks).toHaveLength(1)
    expect(map.totalBytes()).toBe(10)
  })

  it('inserts a backward seek into a missing interval', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(6, 8))
    map.insert(chunk(2, 4))
    map.insert(chunk(4, 6))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.start).toBe(0)
    expect(runs[0]!.end).toBe(8)
  })

  it('does not create a gap for a chunk that partially overlaps its neighbor', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 4))
    map.insert(chunk(2, 6))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.start).toBe(0)
    expect(runs[0]!.end).toBe(6)
    // Overlap is not a reason to discard bytes: assembly needs both chunks.
    expect(runs[0]!.chunks).toHaveLength(2)
    expect(map.totalBytes()).toBe(20)
  })

  it('handles partial overlap identically in reverse arrival order', () => {
    const map = new PtsMap()
    map.insert(chunk(2, 6))
    map.insert(chunk(0, 4))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.chunks.map((c) => c.start)).toEqual([0, 2])
    expect(runs[0]!.end).toBe(6)
    expect(map.span()).toEqual({ start: 0, end: 6 })
  })

  it('does not shorten accumulated material when one chunk is contained in another', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 10))
    map.insert(chunk(2, 4))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.end).toBe(10)
    expect(map.span()).toEqual({ start: 0, end: 10 })
    expect(map.duration()).toBe(10)
  })

  it('treats a microscopic start shift in either direction as the same chunk', () => {
    const earlier = new PtsMap()
    earlier.insert(chunk(10, 12))
    earlier.insert(chunk(9.9995, 12))

    const later = new PtsMap()
    later.insert(chunk(10, 12))
    later.insert(chunk(10.0005, 12))

    expect(earlier.runs()[0]!.chunks).toHaveLength(1)
    expect(earlier.totalBytes()).toBe(10)
    expect(later.runs()[0]!.chunks).toHaveLength(1)
    expect(later.totalBytes()).toBe(10)
  })

  it('treats starts separated by exactly the tolerance as different chunks', () => {
    // The 0.001 tolerance is strict: only a difference smaller than it is a match. In double
    // precision 0.001 - 0 equals the constant exactly, so this tests the boundary directly.
    const later = new PtsMap()
    later.insert(chunk(0, 2))
    later.insert(chunk(0.001, 2))

    const earlier = new PtsMap()
    earlier.insert(chunk(0.001, 2))
    earlier.insert(chunk(0, 2))

    for (const map of [later, earlier]) {
      expect(map.runs()).toHaveLength(1)
      expect(map.runs()[0]!.chunks.map((c) => c.start)).toEqual([0, 0.001])
      expect(map.totalBytes()).toBe(20)
    }
  })

  it('treats a start shift just below the tolerance as the same chunk', () => {
    // In double precision 0.000999 is strictly below 0.001, so the twin must merge. Together with
    // the exact-boundary test, this pins the constant inside (0.000999, 0.001]. Shrinking it would
    // stop recognizing twins and could no longer pass unnoticed.
    const later = new PtsMap()
    later.insert(chunk(0, 2))
    later.insert(chunk(0.000999, 2))

    const earlier = new PtsMap()
    earlier.insert(chunk(0.000999, 2))
    earlier.insert(chunk(0, 2))

    for (const map of [later, earlier]) {
      expect(map.runs()).toHaveLength(1)
      expect(map.runs()[0]!.chunks).toHaveLength(1)
      expect(map.totalBytes()).toBe(10)
    }
  })

  it('keeps the longer of two versions of the same chunk', () => {
    const grows = new PtsMap()
    grows.insert(chunk(0, 2, 10))
    grows.insert(chunk(0, 3, 15))

    const shrinks = new PtsMap()
    shrinks.insert(chunk(0, 3, 15))
    shrinks.insert(chunk(0, 2, 10))

    expect(grows.span()).toEqual({ start: 0, end: 3 })
    expect(grows.totalBytes()).toBe(15)
    expect(shrinks.span()).toEqual({ start: 0, end: 3 })
    expect(shrinks.totalBytes()).toBe(15)
  })

  it('does not replace stored bytes with an equal-length twin', () => {
    // A quality switch can deliver the same interval again from another representation. Replacement
    // is justified only when it extends the interval, or the map would store another representation's
    // bytes under the same boundaries.
    const exact = new PtsMap()
    exact.insert(chunk(10, 12, 10, 1))
    exact.insert(chunk(10, 12, 10, 2))

    const shifted = new PtsMap()
    shifted.insert(chunk(10, 12, 10, 1))
    shifted.insert(chunk(10.0005, 12, 10, 2))

    for (const map of [exact, shifted]) {
      const kept = map.runs()[0]!.chunks
      expect(kept).toHaveLength(1)
      expect(kept[0]!.start).toBe(10)
      expect([...kept[0]!.bytes]).toEqual(Array(10).fill(1))
      expect(map.totalBytes()).toBe(10)
    }
  })

  it('ignores chunks with zero or negative duration', () => {
    const map = new PtsMap()
    map.insert(chunk(5, 5))
    map.insert(chunk(5, 4))

    expect(map.runs()).toEqual([])
    expect(map.totalBytes()).toBe(0)
    expect(map.span()).toBeNull()
  })

  it('answers whether it took the chunk: the history writes down only what it took', () => {
    const map = new PtsMap()

    // Material the map did not hold, and a longer variant of what it now does: something on the
    // map changed both times, so both belong on the disk.
    expect(map.insert(chunk(0, 2, 10))).toBe(true)
    expect(map.insert(chunk(0, 3, 15))).toBe(true)

    // A second viewing of the same stretch, plainly and with the microscopic shift of
    // the start a site gives it. The map keeps what it had, and a copy of those bytes has no
    // business going to the disk or being counted in the length of the session twice.
    expect(map.insert(chunk(0, 3, 15))).toBe(false)
    expect(map.insert(chunk(0.0005, 3, 15))).toBe(false)

    // And nothing at all of a chunk that lasts no time.
    expect(map.insert(chunk(5, 5))).toBe(false)
  })
})

describe('PtsMap.runs', () => {
  it('creates and exposes a gap after a forward seek', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(2, 4))
    map.insert(chunk(20, 22))

    const runs = map.runs()
    expect(runs).toHaveLength(2)
    expect(runs[0]!.start).toBe(0)
    expect(runs[0]!.end).toBe(4)
    expect(runs[1]!.start).toBe(20)
    expect(runs[1]!.end).toBe(22)
  })

  it('extends the new run with subsequent chunks after a gap', () => {
    // Continuity is measured from the last run rather than the first. Otherwise every chunk after
    // a forward seek becomes a separate run and clip assembly breaks a continuous interval apart.
    // duration() cannot detect that failure because the sum of durations stays unchanged.
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(2, 4))
    map.insert(chunk(20, 22))
    map.insert(chunk(22, 24))
    map.insert(chunk(24, 26))
    map.insert(chunk(26, 28))

    const runs = map.runs()
    expect(runs).toHaveLength(2)
    expect(runs[0]!.start).toBe(0)
    expect(runs[0]!.end).toBe(4)
    expect(runs[0]!.chunks.map((c) => c.start)).toEqual([0, 2])
    expect(runs[1]!.start).toBe(20)
    expect(runs[1]!.end).toBe(28)
    expect(runs[1]!.chunks.map((c) => c.start)).toEqual([20, 22, 24, 26])
  })

  it('does not treat a microscopic rounding gap as a break', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(2.004, 4))

    expect(map.runs()).toHaveLength(1)
  })

  it('treats a visible half-second gap as a break', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(2.5, 4.5))

    const runs = map.runs()
    expect(runs).toHaveLength(2)
    expect(runs[0]!.end).toBe(2)
    expect(runs[1]!.start).toBe(2.5)
  })

  it('does not break a run for a gap exactly at the tolerance', () => {
    // The reliable way to get exactly 0.05 in double precision is near zero:
    // 0.11 - 0.06 === 0.05, while 2.05 - 2 does not.
    expect(0.11 - 0.06).toBe(GAP_TOLERANCE_SECONDS)

    const map = new PtsMap()
    map.insert(chunk(0.01, 0.06))
    map.insert(chunk(0.11, 0.5))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.end).toBe(0.5)
  })

  it('sums runs in duration without counting gaps', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(20, 22))

    expect(map.duration()).toBe(4)
    expect(map.span()).toEqual({ start: 0, end: 22 })
  })
})

describe('PtsMap.evict', () => {
  it('keeps material ahead of the position because it was buffered in advance', () => {
    const map = new PtsMap()
    for (let t = 0; t < 20; t += 2) map.insert(chunk(t, t + 2))

    map.evict(6, 10)

    // The cutoff is currentTime - windowSeconds = 4. Everything ending later survives, which is
    // the eight chunks from 4 through 18 inclusive.
    expect(map.span()).toEqual({ start: 4, end: 20 })
    expect(map.totalBytes()).toBe(80)
    expect(map.runs()[0]!.chunks.map((c) => c.start)).toEqual([4, 6, 8, 10, 12, 14, 16, 18])
  })

  it('keeps a chunk that crosses the window boundary in full', () => {
    const map = new PtsMap()
    for (let t = 0; t < 20; t += 2) map.insert(chunk(t, t + 2))

    // At position 19 with a six-second window, the boundary falls inside the 12–14 chunk.
    map.evict(6, 19)

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.chunks.map((c) => c.start)).toEqual([12, 14, 16, 18])
    expect(map.totalBytes()).toBe(40)
  })

  it('drops a chunk that ends exactly at the window boundary', () => {
    const map = new PtsMap()
    for (let t = 0; t < 20; t += 2) map.insert(chunk(t, t + 2))

    map.evict(6, 18)

    expect(map.span()).toEqual({ start: 12, end: 20 })
    expect(map.totalBytes()).toBe(40)
  })

  it('does not fail on an empty map', () => {
    const map = new PtsMap()
    map.evict(6, 0)
    expect(map.runs()).toEqual([])
    expect(map.span()).toBeNull()
  })
})


describe('continuesRun', () => {
  it('includes the tolerance boundary and cuts off everything beyond it', () => {
    expect(continuesRun(0, 0.049)).toBe(true)
    expect(continuesRun(0, GAP_TOLERANCE_SECONDS)).toBe(true)
    expect(continuesRun(0, 0.051)).toBe(false)
  })

  it('treats overlap and adjacency as continuation of a run', () => {
    expect(continuesRun(2, 2)).toBe(true)
    expect(continuesRun(2, 1.5)).toBe(true)
  })

  it('breaks a run at a visible gap', () => {
    expect(continuesRun(2, 2.5)).toBe(false)
  })
})
