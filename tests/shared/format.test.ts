import { describe, it, expect } from 'vitest'
import { formatBytes, formatDuration, formatSeconds, formatWhen } from '../../src/shared/format'

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
    // The default buffer size and the label beside its slider.
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
    // The 4 GB storage ceiling. Showing 4.29 GB would answer a
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

/**
 * When something was last watched, in the words a row of the history says it in.
 *
 * The clock is given rather than taken: `Date.now()` in a test would make the table depend on the
 * minute it runs in. The moments are built by the local constructor, because the answer past a
 * week is a calendar date and a date is read in the reader's own time zone.
 */
describe('formatWhen', () => {
  const NOW = new Date(2026, 7, 29, 15, 0, 0).getTime()
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  it.each([
    [NOW, 'just now'],
    [NOW - 30_000, 'just now'],
    // A clock that moved backwards under a row already written: it happened, and it did not
    // happen in the future.
    [NOW + 5 * MINUTE, 'just now'],
    [NOW - MINUTE, '1 min ago'],
    [NOW - 45 * MINUTE, '45 min ago'],
    [NOW - HOUR, '1 h ago'],
    [NOW - 23 * HOUR, '23 h ago'],
    // Past a day the count is of days and not of hours: "26 h ago" is a number the reader has to
    // divide, and the row has one line to say it in.
    [NOW - 26 * HOUR, 'Yesterday'],
    [NOW - 3 * DAY, '3 days ago'],
    [NOW - 6 * DAY, '6 days ago'],
    // Past a week the elapsed time stops being the useful answer and the date starts: a recording
    // of the twenty-second is looked for by the day it was made.
    [NOW - 7 * DAY, '22 Aug'],
    [new Date(2026, 0, 3, 9, 0, 0).getTime(), '3 Jan'],
    // Another year, said out loud: "31 Dec" of a year ago reads as this December otherwise.
    [new Date(2025, 11, 31, 20, 0, 0).getTime(), '31 Dec 2025'],
    // A row whose moment was never written: nothing at all rather than a date in 1970.
    [0, ''],
  ])('%s → %s', (at, expected) => {
    expect(formatWhen(at, NOW)).toBe(expected)
  })

  it('rounds elapsed minutes down to completed minutes', () => {
    expect(formatWhen(NOW - 90_000, NOW)).toBe('1 min ago')
  })
})
