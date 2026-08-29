import { describe, it, expect } from 'vitest'
import { formatBytes, formatDuration, formatSeconds } from '../../src/shared/format'

/**
 * The numbers three surfaces show. The popup's own table (tests/popup/api.test.ts) walks the
 * short lengths and the small weights through the re-export; what is walked here is what the
 * settings page brought: an hour of material, a gigabyte of disk, and a length said in words.
 */

describe('formatDuration', () => {
  it.each([
    [3599, '59:59'],
    // An hour is where the clock grows a field. Without it a two-hour recording reads "120:00",
    // which is a number of minutes nobody counts in.
    [3600, '1:00:00'],
    [3661, '1:01:01'],
    [7325, '2:02:05'],
    [36_000, '10:00:00'],
    // Nothing is ever shown as a negative length: a span measured against a clock that moved
    // backwards is zero seconds of material, not minus one.
    [-5, '0:00'],
  ])('%s seconds → %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected)
  })
})

describe('formatSeconds', () => {
  it.each([
    [0, '0 s'],
    [15, '15 s'],
    [59, '59 s'],
    [60, '1 min'],
    // Minutes are rounded and not truncated: 100 seconds is nearer two minutes than one, and a
    // control that said "1 min" for it would be describing a different setting.
    [100, '2 min'],
    // The buffer of §7.4 by default, and the label beside its slider.
    [180, '3 min'],
    [1_800, '30 min'],
    [3_540, '59 min'],
    [3_600, '1 h'],
    [3_660, '1 h 1 min'],
    [5_400, '1 h 30 min'],
    [-5, '0 s'],
  ])('%s seconds → %s', (seconds, expected) => {
    expect(formatSeconds(seconds)).toBe(expected)
  })
})

describe('formatBytes', () => {
  it.each([
    // The megabyte/gigabyte border is binary, exactly as the kilobyte/megabyte one is: a byte
    // short of 1024 MB is still megabytes.
    [1024 ** 3 - 1, '1024.0 MB'],
    [1024 ** 3, '1.00 GB'],
    [2 * 1024 ** 3, '2.00 GB'],
    // The ceiling of §7.4, written there as 4 GB. Shown as 4.29 GB it would be answering a
    // question nobody asked.
    [4 * 1024 ** 3, '4.00 GB'],
    [64 * 1024 ** 3, '64.00 GB'],
    // A weight is never negative, and `-0 KB` is not the way to say that: rounding a byte below
    // zero gives exactly that string, so the floor has to be pinned by a number that shows.
    [-2_000_000, '0 KB'],
  ])('%s bytes → %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})
