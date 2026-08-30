import type { Chunk, Run } from '../../shared/types'

/** A smaller gap is treated as rounding error rather than a discontinuity. */
export const GAP_TOLERANCE_SECONDS = 0.05

/**
 * Whether a chunk continues the current run. The boundary is inclusive: a gap exactly equal to
 * the tolerance is still rounding error. This is separate from runs() because media timestamp
 * subtraction rarely lands on the exact boundary, while the boundary itself still needs a test.
 */
export function continuesRun(lastEnd: number, start: number): boolean {
  return start - lastEnd <= GAP_TOLERANCE_SECONDS
}

/**
 * Starts this close together identify the same chunk.
 *
 * Exported because the history joins the same pieces by the same rule a second time, over the
 * rows of the index rather than over the material (`historyIndexOf` in `src/core/history/index.ts`):
 * two frames writing one video write their own copy of the overlap, and the reader opened over
 * the pieces must see what the map of a live session sees. A second constant of the same value
 * would be a rule that holds until somebody moves one of the two.
 */
export const SAME_CHUNK_TOLERANCE_SECONDS = 0.001

export class PtsMap {
  /** Always sorted by start. */
  private chunks: Chunk[] = []

  /**
   * Inserts a chunk into the map and reports whether the map accepted it.
   *
   * The history writer needs the result because a replay produces an overlapping interval that
   * the map rejects. Without this answer the same material would be written and counted twice.
   * Replacing an existing chunk with a longer version also counts as accepted because the map now
   * contains different material that must be written.
   */
  insert(chunk: Chunk): boolean {
    if (chunk.end <= chunk.start) return false

    const at = this.lowerBound(chunk.start)

    // The same interval may arrive again with a tiny start shift in either direction, so its
    // duplicate is either at the insertion point or immediately before it.
    for (const i of [at - 1, at]) {
      const existing = this.chunks[i]
      if (!existing) continue
      if (Math.abs(existing.start - chunk.start) >= SAME_CHUNK_TOLERANCE_SECONDS) continue
      // Keep the longer version.
      if (chunk.end > existing.end) {
        this.chunks[i] = chunk
        return true
      }
      return false
    }

    this.chunks.splice(at, 0, chunk)
    return true
  }

  runs(): Run[] {
    const runs: Run[] = []

    for (const chunk of this.chunks) {
      const last = runs[runs.length - 1]
      if (last && continuesRun(last.end, chunk.start)) {
        last.end = Math.max(last.end, chunk.end)
        last.chunks.push(chunk)
      } else {
        runs.push({ start: chunk.start, end: chunk.end, chunks: [chunk] })
      }
    }

    return runs
  }

  totalBytes(): number {
    let total = 0
    for (const c of this.chunks) total += c.bytes.byteLength
    return total
  }

  duration(): number {
    let total = 0
    for (const run of this.runs()) total += run.end - run.start
    return total
  }

  span(): { start: number; end: number } | null {
    const first = this.chunks[0]
    if (!first) return null
    // Chunks may overlap, so the furthest end need not belong to the latest start.
    let end = first.end
    for (const c of this.chunks) if (c.end > end) end = c.end
    return { start: first.start, end }
  }

  /**
   * Keeps a window behind the current position: older history beyond `windowSeconds` is evicted,
   * while material buffered ahead is preserved in full.
   */
  evict(windowSeconds: number, currentTime: number): void {
    const cutoff = currentTime - windowSeconds
    this.chunks = this.chunks.filter((c) => c.end > cutoff)
  }

  /** Index of the first chunk whose start is at least the requested value. */
  private lowerBound(start: number): number {
    let lo = 0
    let hi = this.chunks.length

    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.chunks[mid]!.start < start) lo = mid + 1
      else hi = mid
    }

    return lo
  }
}
