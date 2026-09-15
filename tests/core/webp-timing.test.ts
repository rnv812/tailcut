import { describe, expect, it } from 'vitest'
import {
  WEBP_FPS,
  WEBP_QUALITY,
  frameDurations,
  keptForRate,
  webpGeometry,
} from '../../src/core/webp/timing'

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

describe('animated WebP timing', () => {
  it('uses custom resolution and frame rate while preserving proportions and source limits', () => {
    expect(webpGeometry({ width: 1920, height: 1080 }, 60, { maxSide: 1280, fps: 30 }))
      .toEqual({ width: 1280, height: 720, framerate: 30 })
    expect(webpGeometry({ width: 1080, height: 1920 }, 24, { maxSide: 1920, fps: 60 }))
      .toEqual({ width: 1080, height: 1920, framerate: 24 })
    expect(webpGeometry({ width: 320, height: 180 }, 10, { maxSide: 1920, fps: 30 }))
      .toEqual({ width: 320, height: 180, framerate: 10 })
  })

  it('rejects invalid settings before allocating an export surface', () => {
    for (const maxSide of [0, -1, 12.5, NaN, Infinity, 16384]) {
      expect(() => webpGeometry({ width: 100, height: 100 }, 30, { maxSide, fps: 15 })).toThrow()
    }
    for (const fps of [0, -1, NaN, Infinity, 61]) {
      expect(() => webpGeometry({ width: 100, height: 100 }, 30, { maxSide: 640, fps })).toThrow()
    }
  })
  it('keeps every frame of material recorded below the ceiling and preserves its ten seconds', () => {
    const kept = keptForRate(100, 10, WEBP_FPS)
    const ticks = kept.map((index) => index)

    expect(kept).toEqual(Array.from({ length: 100 }, (_, index) => index))
    expect(sum(frameDurations(ticks, 100, 10))).toBe(10_000)
  })

  it('thins thirty-frame material to fifteen without shortening it', () => {
    const kept = keptForRate(300, 30, WEBP_FPS)
    const ticks = kept.map((index) => index)

    expect(kept).toHaveLength(150)
    expect(keptForRate(8, 30, WEBP_FPS)).toEqual([0, 2, 4, 6])
    expect(sum(frameDurations(ticks, 300, 30))).toBe(10_000)
  })

  it('uses cumulative boundary rounding over a full minute at either source rate', () => {
    const atThirty = Array.from({ length: 1_800 }, (_, index) => index)
    const atFifteen = Array.from({ length: 900 }, (_, index) => index)

    expect(sum(frameDurations(atThirty, 1_800, 30))).toBe(60_000)
    expect(sum(frameDurations(atFifteen, 900, 15))).toBe(60_000)
  })

  it('takes uneven durations from frame ticks and ignores a non-zero origin', () => {
    expect(frameDurations([900, 1_000, 2_500], 3_000, 1_000)).toEqual([100, 1_500, 500])
    expect(frameDurations([0, 1, 2], 3, 30)).toEqual([33, 34, 33])
  })

  it('never repeats a chosen frame or chooses outside the material', () => {
    for (let frames = 1; frames <= 400; frames++) {
      for (const sourceFps of [1, 10, 15, 24, 30, 60, 120]) {
        const kept = keptForRate(frames, sourceFps, WEBP_FPS)

        expect(kept[0], `${frames} frames at ${sourceFps} fps starts outside`).toBeGreaterThanOrEqual(0)
        expect(kept.at(-1), `${frames} frames at ${sourceFps} fps ends outside`).toBeLessThan(frames)
        expect(new Set(kept).size, `${frames} frames at ${sourceFps} fps repeats a frame`).toBe(
          kept.length,
        )
        expect(
          kept.every((value, index) => index === 0 || value > kept[index - 1]!),
          `${frames} frames at ${sourceFps} fps is not increasing`,
        ).toBe(true)
      }
    }
  })

  it('does not enlarge a crop already below the animation cap', () => {
    expect(webpGeometry({ width: 320, height: 180 }, 30)).toEqual({
      width: 320,
      height: 180,
      framerate: WEBP_FPS,
    })
  })

  it('fits a large crop under the cap without changing its shape', () => {
    expect(webpGeometry({ width: 1920, height: 1080 }, 30)).toEqual({
      width: 640,
      height: 360,
      framerate: WEBP_FPS,
    })
    expect(webpGeometry({ width: 1078, height: 1920 }, 30)).toEqual({
      width: 359,
      height: 640,
      framerate: WEBP_FPS,
    })
  })

  it('does not claim a rate faster than the material and falls back only for zero', () => {
    expect(webpGeometry({ width: 640, height: 360 }, 10).framerate).toBe(10)
    expect(webpGeometry({ width: 640, height: 360 }, 30).framerate).toBe(WEBP_FPS)
    expect(webpGeometry({ width: 640, height: 360 }, 0).framerate).toBe(WEBP_FPS)
  })

  it('uses the measured lossy quality below the lossless switch', () => {
    expect(WEBP_QUALITY).toBe(0.75)
    expect(WEBP_QUALITY).toBeLessThan(1)
  })
})
