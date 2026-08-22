import type { Chunk, Run } from '../../shared/types'

/** Зазор меньше этого считаем следствием округления, а не разрывом. */
const GAP_TOLERANCE_SECONDS = 0.05

/** Совпадение начал с такой точностью означает тот же самый кусок. */
const SAME_CHUNK_TOLERANCE_SECONDS = 0.001

export class PtsMap {
  /** Всегда отсортирован по start. */
  private chunks: Chunk[] = []

  insert(chunk: Chunk): void {
    if (chunk.end <= chunk.start) return

    const at = this.lowerBound(chunk.start)

    // Тот же участок мог прийти повторно с микросдвигом начала в любую сторону:
    // такой близнец стоит либо на найденной позиции, либо непосредственно перед ней.
    for (const i of [at - 1, at]) {
      const existing = this.chunks[i]
      if (!existing) continue
      if (Math.abs(existing.start - chunk.start) >= SAME_CHUNK_TOLERANCE_SECONDS) continue
      // Оставляем более длинный вариант.
      if (chunk.end > existing.end) this.chunks[i] = chunk
      return
    }

    this.chunks.splice(at, 0, chunk)
  }

  runs(): Run[] {
    const runs: Run[] = []

    for (const chunk of this.chunks) {
      const last = runs[runs.length - 1]
      if (last && chunk.start - last.end <= GAP_TOLERANCE_SECONDS) {
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
    // Куски могут перекрываться, поэтому самый дальний конец не обязательно
    // у последнего по началу.
    let end = first.end
    for (const c of this.chunks) if (c.end > end) end = c.end
    return { start: first.start, end }
  }

  /**
   * Оставляет окно вокруг текущей позиции: всё прошлое дальше windowSeconds
   * выбрасывается, загруженное наперёд сохраняется целиком.
   */
  evict(windowSeconds: number, currentTime: number): void {
    const cutoff = currentTime - windowSeconds
    this.chunks = this.chunks.filter((c) => c.end > cutoff)
  }

  /** Индекс первого куска с началом не меньше заданного. */
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
