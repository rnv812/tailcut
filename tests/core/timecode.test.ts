import { describe, it, expect } from 'vitest'
import { formatTimecode, parseTimecode, timecodeRate } from '../../src/core/timeline/timecode'

describe('timecodeRate', () => {
  it('counts a fractional rate as a whole one, the way every timecode does', () => {
    expect(timecodeRate(24_000 / 1_001)).toBe(24)
    expect(timecodeRate(29.97)).toBe(30)
  })

  it('substitutes a nonsensical rate instead of turning the timecode into NaN', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(timecodeRate(bad)).toBe(25)
    }
  })
})

describe('formatTimecode', () => {
  it('spells out hours, minutes, seconds and the frame', () => {
    expect(formatTimecode(0, 24)).toBe('00:00:00:00')
    expect(formatTimecode(83.5, 24)).toBe('00:01:23:12')
    expect(formatTimecode(3_723.25, 24)).toBe('01:02:03:06')
  })

  it('never lets the frame field reach the rate', () => {
    // 0.999 of a second at 24 is the twenty-third frame, not the twenty-fourth.
    expect(formatTimecode(0.999, 24)).toBe('00:00:00:23')
    expect(formatTimecode(0.9999999, 24)).toBe('00:00:00:23')

    // A nanosecond under a whole second is that second — the same slack that puts a time on the
    // frame boundary it stands on. Counting the seconds and the frames apart would answer it with
    // a frame field of 24, which is a timecode no clock shows.
    expect(formatTimecode(1 - 1e-9, 24)).toBe('00:00:01:00')
  })

  it('shows the frame a time stands exactly on, whatever the arithmetic left behind', () => {
    // `10 + 1/25` is not the double the literal `10.04` is, and taking the leftover of a second
    // apart put nearly half of all frame boundaries one frame low: a playhead sitting on frame
    // 251 read 00:00:10:00, and a field that spelled it out and read it back moved by nothing.
    expect(formatTimecode(10 + 1 / 25, 25)).toBe('00:00:10:01')

    for (let frame = 0; frame < 25; frame++) {
      const shown = String(frame).padStart(2, '0')
      expect(formatTimecode(83 + frame / 25, 25), `frame ${frame}`).toBe(`00:01:23:${shown}`)
    }
  })

  it('counts a fractional rate at its whole one', () => {
    expect(formatTimecode(83.5, 24_000 / 1_001)).toBe('00:01:23:12')
  })

  it('turns a negative and a non-number into a zero timecode rather than rubbish', () => {
    expect(formatTimecode(-3, 24)).toBe('00:00:00:00')
    expect(formatTimecode(Number.NaN, 24)).toBe('00:00:00:00')
  })
})

describe('parseTimecode', () => {
  it('reads a full timecode', () => {
    expect(parseTimecode('00:01:23:12', 24)).toBeCloseTo(83.5, 6)
    expect(parseTimecode('01:02:03:06', 24)).toBeCloseTo(3_723.25, 6)
  })

  it('reads minutes and seconds, the quickest thing anybody types', () => {
    expect(parseTimecode('1:23', 24)).toBe(83)
  })

  it('reads hours, minutes and seconds with no frame', () => {
    expect(parseTimecode('0:01:23', 24)).toBe(83)
  })

  it('reads a bare number as seconds, fraction and letter and all', () => {
    expect(parseTimecode('83', 24)).toBe(83)
    expect(parseTimecode('83.5', 24)).toBe(83.5)
    expect(parseTimecode('83.5s', 24)).toBe(83.5)
    expect(parseTimecode(' 83.5 s ', 24)).toBe(83.5)
  })

  it('refuses a frame past the rate instead of carrying into the next second', () => {
    expect(parseTimecode('00:00:01:24', 24)).toBeNull()
    expect(parseTimecode('00:00:01:23', 24)).toBeCloseTo(1 + 23 / 24, 6)
  })

  it('refuses minutes and seconds past sixty', () => {
    expect(parseTimecode('00:60:00:00', 24)).toBeNull()
    expect(parseTimecode('00:00:60:00', 24)).toBeNull()
    expect(parseTimecode('60:00', 24)).toBeNull()
  })

  it('answers rubbish with null and not with zero: zero would move the playhead', () => {
    for (const bad of ['', '   ', 'abc', '1:2:3:4:5', '-5', '1::2', '00:0a:00:00']) {
      expect(parseTimecode(bad, 24), `«${bad}» parsed as something`).toBeNull()
    }
  })

  it('allows a fraction only in the last field, and only when that field is seconds', () => {
    expect(parseTimecode('1:23.5', 24)).toBeNull()
    expect(parseTimecode('1.5:23', 24)).toBeNull()
  })
})
