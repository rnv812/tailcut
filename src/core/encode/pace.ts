import type { EncodeGeometry } from './codec'

/**
 * How fast this machine has actually encoded, and nothing else.
 *
 * Deliberately empty at the start. The measurements taken while writing this program were taken
 * in a sandbox with no GPU at all; seeding this from them would put a number on screen that is
 * wrong by more than a factor of two in a direction nobody can predict — too slow on the machine
 * with hardware, too fast on the one without. So the first clip of a tab shows no time at all and
 * says why, and every clip after it is estimated from the one before.
 */
export interface PaceBook {
  /** Pixels a second, per kind of work. */
  rates: Record<string, number>
}

export const EMPTY_PACE: PaceBook = { rates: {} }

const kindKey = (kind: 'mp4' | 'webp'): string => kind

/** What one finished job says about this machine. Pixels, because geometry varies and frames do not. */
export function notePace(
  book: PaceBook,
  kind: 'mp4' | 'webp',
  g: EncodeGeometry,
  frames: number,
  ms: number,
): PaceBook {
  if (frames <= 0 || ms <= 0) return book
  const rate = (frames * g.width * g.height) / (ms / 1000)
  const key = kindKey(kind)
  const known = book.rates[key]
  // A running mean of two, not a replacement: one clip on a busy machine should not throw the
  // estimate of the next, and one clip on an idle machine should not make a promise either.
  return { rates: { ...book.rates, [key]: known ? (known + rate) / 2 : rate } }
}

/** Seconds this many frames of this size should take — null until the machine has shown anything. */
export function secondsFor(
  book: PaceBook,
  kind: 'mp4' | 'webp',
  g: EncodeGeometry,
  frames: number,
): number | null {
  const rate = book.rates[kindKey(kind)]
  if (!rate) return null
  return (frames * g.width * g.height) / rate
}
