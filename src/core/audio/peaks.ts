/**
 * Buckets a second the peaks are kept at: ten milliseconds each.
 *
 * A timeline a thousand pixels wide showing ten seconds is exactly a bucket a pixel, and every
 * wider view folds down from the same store. Three minutes is 18 000 buckets — 36 KB in two
 * Int8Arrays, against 144 KB in floats and 69 MB in the PCM they came from. A byte is enough: the
 * wave is drawn into a strip forty pixels high.
 */
export const BUCKETS_PER_SECOND = 100

export interface Peaks {
  /** Media time of the first bucket, always on a bucket boundary. */
  start: number
  /** One byte a bucket, −127…127: the quietest and the loudest sample that fell into it. */
  min: Int8Array
  max: Int8Array
}

export interface Columns {
  min: Int8Array
  max: Int8Array
}

const FULL = 127
const HALF_BUCKET = 1 / BUCKETS_PER_SECOND / 2

const quantise = (value: number): number => {
  const scaled = Math.round(value * FULL)
  return scaled > FULL ? FULL : scaled < -FULL ? -FULL : scaled
}

export const peaksEnd = (peaks: Peaks): number => peaks.start + peaks.min.length / BUCKETS_PER_SECOND

/**
 * Folds decoded sound into buckets as it arrives, and never holds the sound.
 *
 * It is fed inside the decoder's output callback, and the AudioData is closed on the way out of
 * that callback, so the PCM of a run never exists as a whole. Slices are taken while a run is
 * being read, which is what puts the wave on the screen a third of a frame after the editor opens
 * instead of a second later.
 */
export class PeakBuilder {
  private at: number
  private readonly perBucket: number
  private readonly mins: number[] = []
  private readonly maxes: number[] = []
  private low = 0
  private high = 0
  private inBucket = 0

  constructor(sampleRate: number, start: number) {
    // Every builder begins on a whole bucket, so the peaks of two runs lie on one grid and
    // merging them is concatenation rather than resampling.
    this.at = Math.floor(start * BUCKETS_PER_SECOND) / BUCKETS_PER_SECOND
    this.perBucket = Math.max(1, Math.round((sampleRate > 0 ? sampleRate : 48_000) / BUCKETS_PER_SECOND))
  }

  /** Media time the next bucket will be stamped with. */
  get start(): number {
    return this.at
  }

  /** Seconds of closed buckets waiting to be taken. The open bucket is not one of them. */
  get pending(): number {
    return this.mins.length / BUCKETS_PER_SECOND
  }

  /** One decoded block, planar. Every channel has to hold at least `frameCount` samples. */
  push(channels: readonly Float32Array[], frameCount: number): void {
    for (let frame = 0; frame < frameCount; frame++) {
      for (const channel of channels) {
        const value = channel[frame]!
        if (value < this.low) this.low = value
        if (value > this.high) this.high = value
      }
      if (++this.inBucket >= this.perBucket) this.close()
    }
  }

  /**
   * The closed buckets so far. The open one stays open, which is what keeps the grid whole across
   * a slice; the builder starts again where these peaks end.
   */
  take(): Peaks {
    const peaks: Peaks = {
      start: this.at,
      min: Int8Array.from(this.mins),
      max: Int8Array.from(this.maxes),
    }
    this.at = peaksEnd(peaks)
    this.mins.length = 0
    this.maxes.length = 0
    return peaks
  }

  /** The rest of the run, the part-filled bucket at the end of it included. */
  finish(): Peaks {
    if (this.inBucket) this.close()
    return this.take()
  }

  private close(): void {
    this.mins.push(quantise(this.low))
    this.maxes.push(quantise(this.high))
    this.low = 0
    this.high = 0
    this.inBucket = 0
  }
}

const joins = (left: Peaks, right: Peaks): boolean =>
  Math.abs(peaksEnd(left) - right.start) < HALF_BUCKET

function concat(left: Peaks, right: Peaks): Peaks {
  const min = new Int8Array(left.min.length + right.min.length)
  min.set(left.min)
  min.set(right.min, left.min.length)

  const max = new Int8Array(left.max.length + right.max.length)
  max.set(left.max)
  max.set(right.max, left.max.length)

  return { start: left.start, min, max }
}

/**
 * Adds a slice to what is drawn, joining it to whatever it continues.
 *
 * The list stays one entry per stretch of sound: the drawing walks it per repaint, and a
 * three-minute recording that arrived in thirty-six slices must not cost thirty-six scans.
 */
export function mergePeaks(into: Peaks[], add: Peaks): Peaks[] {
  if (!add.min.length) return into

  const ordered = [...into, add].sort((a, b) => a.start - b.start)
  const joined: Peaks[] = []

  for (const piece of ordered) {
    const last = joined[joined.length - 1]
    if (last && joins(last, piece)) joined[joined.length - 1] = concat(last, piece)
    else joined.push(piece)
  }

  return joined
}

function pieceAt(peaks: readonly Peaks[], time: number): Peaks | null {
  for (const piece of peaks) {
    if (time >= piece.start && time < peaksEnd(piece)) return piece
  }
  return null
}

/**
 * The envelope of a stretch of material, one column a pixel.
 *
 * Work is proportional to the buckets the viewport covers and not to what was recorded: an hour
 * of material folded into a thousand columns reads 360 000 bytes, which is a third of a
 * millisecond, and nothing in between is allocated.
 */
export function peakColumns(
  peaks: readonly Peaks[],
  from: number,
  to: number,
  columns: number,
): Columns {
  const min = new Int8Array(Math.max(0, columns))
  const max = new Int8Array(Math.max(0, columns))
  if (min.length === 0 || !(to > from)) return { min, max }

  const secondsPerColumn = (to - from) / columns

  if (secondsPerColumn * BUCKETS_PER_SECOND < 1) {
    // Zoomed in past one bucket a column: every column reads the bucket it stands in, so the wave
    // draws as steps rather than as a comb with gaps between the buckets.
    for (let column = 0; column < min.length; column++) {
      const time = from + (column + 0.5) * secondsPerColumn
      const piece = pieceAt(peaks, time)
      if (!piece) continue
      const bucket = Math.floor((time - piece.start) * BUCKETS_PER_SECOND)
      min[column] = piece.min[bucket] ?? 0
      max[column] = piece.max[bucket] ?? 0
    }
    return { min, max }
  }

  // Columns a second, multiplied in — not seconds a column, divided by. The two are the same
  // arithmetic and not the same answer: 0.3 / 0.1 is 2.9999999999999996 in doubles, so bucket
  // thirty of a second folded into ten columns landed in column two, and every tenth column of
  // the wave took its neighbour's peak instead of its own.
  const columnsPerSecond = columns / (to - from)

  for (const piece of peaks) {
    if (peaksEnd(piece) <= from || piece.start >= to) continue

    const first = Math.max(0, Math.floor((from - piece.start) * BUCKETS_PER_SECOND))
    const last = Math.min(piece.min.length - 1, Math.ceil((to - piece.start) * BUCKETS_PER_SECOND))

    for (let bucket = first; bucket <= last; bucket++) {
      const column = Math.floor((piece.start + bucket / BUCKETS_PER_SECOND - from) * columnsPerSecond)
      if (column < 0 || column >= min.length) continue

      const low = piece.min[bucket]!
      const high = piece.max[bucket]!
      if (low < min[column]!) min[column] = low
      if (high > max[column]!) max[column] = high
    }
  }

  return { min, max }
}
