import { describe, it, expect } from 'vitest'
import {
  BUCKETS_PER_SECOND,
  PeakBuilder,
  mergePeaks,
  peakColumns,
  peaksEnd,
  type Peaks,
} from '../../src/core/audio/peaks'

const RATE = 48_000
const PER_BUCKET = RATE / BUCKETS_PER_SECOND

/**
 * A tone that steps up a hundredth of full scale every bucket: bucket b runs at (b + 1) / 100.
 *
 * Samples alternate in sign rather than following a sine. A sine's extreme falls between two
 * samples, so the rounding of the peak would be a property of the sampling rate and not of the
 * code under test, and the expectations below would have to be copied out of a run.
 */
const stepping = (buckets: number): Float32Array =>
  Float32Array.from({ length: buckets * PER_BUCKET }, (_, i) => {
    const level = (Math.floor(i / PER_BUCKET) + 1) / 100
    return i % 2 ? -level : level
  })

describe('PeakBuilder', () => {
  it('folds a second of sound into a hundred buckets', () => {
    const builder = new PeakBuilder(RATE, 0)
    builder.push([stepping(100)], 100 * PER_BUCKET)
    const peaks = builder.finish()

    expect(peaks.start).toBe(0)
    expect(peaks.min.length).toBe(100)
    expect(peaksEnd(peaks)).toBe(1)
    expect(peaks.max[0]).toBe(1)
    expect(peaks.max[49]).toBe(64)
    expect(peaks.max[99]).toBe(127)
    // Math.round takes a half upwards, so the negative side of the same level rounds inwards:
    // 63.5 becomes 64 and −63.5 becomes −63. Written down because it looks like an off-by-one.
    expect(peaks.min[49]).toBe(-63)
    expect(peaks.min[99]).toBe(-127)
  })

  it('emits whole buckets only, so the slices of one run line up', () => {
    const builder = new PeakBuilder(RATE, 2)
    builder.push([stepping(51)], 50 * PER_BUCKET + 137)

    const slice = builder.take()
    expect(slice.start).toBe(2)
    expect(slice.min.length).toBe(50)
    // The open bucket is not cut short. A take that closed it would move the start of every
    // later bucket by a fraction, and thirty-six slices of a three-minute run would end with the
    // wave a third of a bucket out of step with the picture.
    expect(builder.start).toBe(2.5)
    expect(builder.pending).toBe(0)

    builder.push([stepping(1)], PER_BUCKET - 137)
    const rest = builder.finish()
    expect(rest.start).toBe(2.5)
    expect(rest.min.length).toBe(1)
    // The bucket carries what went into it before the take: 0.51 of full scale, not 0.01.
    expect(rest.max[0]).toBe(65)
  })

  it('counts whole buckets as they close, so a slice can be asked for by length', () => {
    const builder = new PeakBuilder(RATE, 0)
    builder.push([stepping(30)], 30 * PER_BUCKET)
    expect(builder.pending).toBeCloseTo(0.3, 9)
    builder.take()
    expect(builder.pending).toBe(0)
  })

  it('takes the loudest of every channel', () => {
    const builder = new PeakBuilder(RATE, 0)
    builder.push([new Float32Array(PER_BUCKET).fill(0.1), new Float32Array(PER_BUCKET).fill(-0.8)], PER_BUCKET)
    const peaks = builder.finish()

    expect(peaks.max[0]).toBe(13)
    expect(peaks.min[0]).toBe(-102)
  })

  it('clamps what came in past full scale instead of wrapping it round', () => {
    // An Int8Array takes 3 * 127 as −125 without a word, and the wave would spike downwards at
    // exactly the loudest place in the material.
    const builder = new PeakBuilder(RATE, 0)
    builder.push([new Float32Array(PER_BUCKET).fill(3)], PER_BUCKET)
    builder.push([new Float32Array(PER_BUCKET).fill(-3)], PER_BUCKET)
    const peaks = builder.finish()

    expect([...peaks.max]).toEqual([127, 0])
    expect([...peaks.min]).toEqual([0, -127])
  })

  it('starts on a bucket boundary whatever time it was handed', () => {
    expect(new PeakBuilder(RATE, 2.007).start).toBe(2)
    expect(new PeakBuilder(RATE, 2.019).start).toBeCloseTo(2.01, 9)
  })
})

/** min mirrors max, so one array of numbers describes a slice. */
const peaks = (start: number, values: number[]): Peaks => ({
  start,
  min: Int8Array.from(values, (value) => -value),
  max: Int8Array.from(values),
})

describe('mergePeaks', () => {
  it('joins slices that touch into one', () => {
    const merged = mergePeaks(mergePeaks([], peaks(0, [1, 2])), peaks(0.02, [3]))

    expect(merged).toHaveLength(1)
    expect([...merged[0]!.max]).toEqual([1, 2, 3])
  })

  it('keeps slices with a hole between them apart, in time order', () => {
    const merged = mergePeaks(mergePeaks([], peaks(5, [4])), peaks(0, [1]))

    expect(merged.map((piece) => piece.start)).toEqual([0, 5])
  })

  it('gives back the list itself when there is nothing to add', () => {
    const before = mergePeaks([], peaks(0, [1]))

    expect(mergePeaks(before, { start: 3, min: new Int8Array(0), max: new Int8Array(0) })).toBe(before)
  })
})

describe('peakColumns', () => {
  /** One second: bucket b is b + 1 loud. */
  const second = peaks(0, Array.from({ length: 100 }, (_, b) => b + 1))

  it('folds the buckets of a column into its loudest', () => {
    const columns = peakColumns([second], 0, 1, 10)

    expect([...columns.max]).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    expect([...columns.min]).toEqual([-10, -20, -30, -40, -50, -60, -70, -80, -90, -100])
  })

  it('reads only the stretch the viewport shows', () => {
    const columns = peakColumns([second], 0.5, 0.6, 10)

    expect([...columns.max]).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60])
  })

  it('repeats a bucket rather than leaving holes when a column is shorter than one', () => {
    // Zoomed past ten milliseconds a pixel there is not a bucket for every column, and a column
    // left at zero would draw the wave as a comb.
    const columns = peakColumns([second], 0.5, 0.52, 8)

    expect([...columns.max]).toEqual([51, 51, 51, 51, 52, 52, 52, 52])
  })

  it('leaves the hole between two stretches silent', () => {
    const columns = peakColumns([peaks(0, [50]), peaks(1, [50])], 0, 2, 4)

    expect([...columns.max]).toEqual([50, 0, 50, 0])
  })

  it('answers an empty request with silence rather than a throw', () => {
    expect([...peakColumns([], 0, 1, 4).max]).toEqual([0, 0, 0, 0])
    expect(peakColumns([second], 0, 0, 4).max.length).toBe(4)
    expect(peakColumns([second], 0, 1, 0).max.length).toBe(0)
  })
})
