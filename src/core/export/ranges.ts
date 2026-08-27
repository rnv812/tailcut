import type { Located } from '../../shared/types'
import type { ExportPlan } from './plan'

/**
 * Turning the ranges a plan names into the reads that fetch them.
 *
 * A clip of a plain file is a few thousand samples, each a range of a few hundred to a few
 * thousand bytes, and asking for them one by one would be a few thousand requests. They do not
 * need to be: an mp4 interleaves its tracks, so the samples of one continuous clip lie in one
 * continuous stretch of the mdat with nothing between them but each other. Sorted and merged,
 * the ordinary clip comes out as a single read.
 *
 * What is left between them on a file that holds a third track — a second language, a subtitle
 * stream — are holes of a few kilobytes. Those are bridged rather than stepped around, because a
 * request costs more than the bytes do: see MAX_BRIDGED_GAP.
 */

/**
 * The largest hole worth downloading rather than making a second request for.
 *
 * A request costs a round trip. Ordinary latency to a CDN is of the order of fifty to a hundred
 * milliseconds, and a stream that has warmed up moves several megabytes a second — so a hundred
 * milliseconds buys something like a quarter of a megabyte of transfer. Below that the bytes are
 * cheaper than the round trip; above it the request is. This is that crossing point, and it is
 * the whole of the arithmetic.
 */
export const MAX_BRIDGED_GAP = 256 * 1024

/**
 * The largest single read.
 *
 * Not a network limit but a memory one: every read is answered as one buffer and every buffer is
 * held until the file is written, so an unbroken clip of two gigabytes would be asked for in one
 * piece. Thirty-two megabytes keeps a long save to a handful of reads while leaving each of them
 * a size a tab can hold.
 */
export const MAX_READ_BYTES = 32 * 1024 * 1024

export interface ReadOptions {
  maxGap?: number
  maxRead?: number
}

/** Every range a plan names, in ascending order of address. */
export function planRanges(plan: ExportPlan): Located[] {
  const ranges: Located[] = []
  for (const track of plan.tracks) for (const sample of track.samples) ranges.push(sample.source)

  return ranges.sort((a, b) => a.at - b.at)
}

/**
 * The reads that cover every one of those ranges: few and large rather than many and small.
 *
 * The ranges may arrive in any order and may overlap — two samples addressing one stretch is
 * unusual but not forbidden, and a plan that repeated a range would otherwise fetch it twice.
 * What comes back is ascending, disjoint, and covers every byte asked for.
 */
export function readsFor(ranges: readonly Located[], options: ReadOptions = {}): Located[] {
  const maxGap = options.maxGap ?? MAX_BRIDGED_GAP
  const maxRead = Math.max(1, options.maxRead ?? MAX_READ_BYTES)

  const sorted = [...ranges]
    .filter((range) => range.length > 0)
    .sort((a, b) => a.at - b.at || a.length - b.length)

  const reads: Located[] = []

  for (const range of sorted) {
    const last = reads[reads.length - 1]
    const end = range.at + range.length

    if (last) {
      const finish = last.at + last.length
      // Merged when what stands between them is smaller than a request, and only while the read
      // stays a size worth answering in one piece.
      if (range.at - finish <= maxGap && end - last.at <= maxRead) {
        if (end > finish) last.length = end - last.at
        continue
      }
    }

    reads.push({ at: range.at, length: range.length })
  }

  return reads
}
