import { describe, expect, it } from 'vitest'
import type { EncodeGeometry } from '../../src/core/encode/codec'
import { EMPTY_PACE, notePace, secondsFor } from '../../src/core/encode/pace'

const picture = (width = 100, height = 50): EncodeGeometry => ({
  width,
  height,
  framerate: 30,
})

describe('the measured encoding pace', () => {
  it('has no estimate before this machine has encoded anything', () => {
    expect(EMPTY_PACE.rates).toEqual({})
    expect(secondsFor(EMPTY_PACE, 'mp4', picture(), 40)).toBeNull()
  })

  it('answers from the rate one finished job actually showed', () => {
    // Twenty 100 × 50 frames in one second are 100,000 pixels a second. Forty more frames of
    // the same size therefore take two seconds, while the other kind of work is still unknown.
    const book = notePace(EMPTY_PACE, 'mp4', picture(), 20, 1_000)

    expect(book.rates.mp4).toBe(100_000)
    expect(secondsFor(book, 'mp4', picture(), 40)).toBe(2)
    expect(secondsFor(book, 'webp', picture(), 40)).toBeNull()
  })

  it('prices the pixels rather than frames alone', () => {
    const book = notePace(EMPTY_PACE, 'mp4', picture(), 20, 1_000)

    expect(secondsFor(book, 'mp4', picture(200, 50), 40)).toBe(4)
  })

  it('averages a second observation without forgetting the other kind of work', () => {
    const first = notePace(EMPTY_PACE, 'mp4', picture(), 20, 1_000)
    const withWebp = notePace(first, 'webp', picture(), 10, 1_000)
    // Forty frames in one second are 200,000 pixels/s. Averaged with the first 100,000, the
    // next thirty frames take one second at 150,000 pixels/s.
    const second = notePace(withWebp, 'mp4', picture(), 40, 1_000)

    expect(second.rates).toEqual({ mp4: 150_000, webp: 50_000 })
    expect(secondsFor(second, 'mp4', picture(), 30)).toBe(1)
  })

  it('ignores an observation with no frames or no elapsed time', () => {
    const book = notePace(EMPTY_PACE, 'mp4', picture(), 20, 1_000)

    expect(notePace(book, 'mp4', picture(), 0, 1_000)).toBe(book)
    expect(notePace(book, 'mp4', picture(), 20, 0)).toBe(book)
  })
})
