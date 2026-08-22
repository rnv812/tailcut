import { describe, it, expect } from 'vitest'
import { PtsMap } from '../../src/core/timeline/map'
import type { Chunk } from '../../src/shared/types'

const chunk = (start: number, end: number, size = 10): Chunk => ({
  start,
  end,
  bytes: new Uint8Array(size),
})

describe('PtsMap.insert', () => {
  it('держит куски в порядке времени медиа, а не поступления', () => {
    const map = new PtsMap()
    map.insert(chunk(4, 6))
    map.insert(chunk(0, 2))
    map.insert(chunk(2, 4))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.chunks.map((c) => c.start)).toEqual([0, 2, 4])
  })

  it('повторный просмотр не создаёт дубликата', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(0, 2))
    map.insert(chunk(0, 2))

    expect(map.runs()[0]!.chunks).toHaveLength(1)
    expect(map.totalBytes()).toBe(10)
  })

  it('прыжок назад на пропущенное встаёт в середину', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(6, 8))
    map.insert(chunk(2, 4))
    map.insert(chunk(4, 6))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.start).toBe(0)
    expect(runs[0]!.end).toBe(8)
  })

  it('кусок, частично перекрывающий соседа, не создаёт разрыв', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 4))
    map.insert(chunk(2, 6))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.start).toBe(0)
    expect(runs[0]!.end).toBe(6)
    // Перекрытие — не повод выбрасывать байты: оба куска понадобятся при сборке.
    expect(runs[0]!.chunks).toHaveLength(2)
    expect(map.totalBytes()).toBe(20)
  })

  it('частичное перекрытие в обратном порядке поступления даёт то же самое', () => {
    const map = new PtsMap()
    map.insert(chunk(2, 6))
    map.insert(chunk(0, 4))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.chunks.map((c) => c.start)).toEqual([0, 2])
    expect(runs[0]!.end).toBe(6)
    expect(map.span()).toEqual({ start: 0, end: 6 })
  })

  it('кусок целиком внутри соседа не укорачивает накопленное', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 10))
    map.insert(chunk(2, 4))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.end).toBe(10)
    expect(map.span()).toEqual({ start: 0, end: 10 })
    expect(map.duration()).toBe(10)
  })

  it('микросдвиг начала в любую сторону — тот же кусок, а не новый', () => {
    const earlier = new PtsMap()
    earlier.insert(chunk(10, 12))
    earlier.insert(chunk(9.9995, 12))

    const later = new PtsMap()
    later.insert(chunk(10, 12))
    later.insert(chunk(10.0005, 12))

    expect(earlier.runs()[0]!.chunks).toHaveLength(1)
    expect(earlier.totalBytes()).toBe(10)
    expect(later.runs()[0]!.chunks).toHaveLength(1)
    expect(later.totalBytes()).toBe(10)
  })

  it('из двух вариантов одного куска остаётся более длинный', () => {
    const grows = new PtsMap()
    grows.insert(chunk(0, 2, 10))
    grows.insert(chunk(0, 3, 15))

    const shrinks = new PtsMap()
    shrinks.insert(chunk(0, 3, 15))
    shrinks.insert(chunk(0, 2, 10))

    expect(grows.span()).toEqual({ start: 0, end: 3 })
    expect(grows.totalBytes()).toBe(15)
    expect(shrinks.span()).toEqual({ start: 0, end: 3 })
    expect(shrinks.totalBytes()).toBe(15)
  })

  it('кусок нулевой или отрицательной длительности игнорируется', () => {
    const map = new PtsMap()
    map.insert(chunk(5, 5))
    map.insert(chunk(5, 4))

    expect(map.runs()).toEqual([])
    expect(map.totalBytes()).toBe(0)
    expect(map.span()).toBeNull()
  })
})

describe('PtsMap.runs', () => {
  it('прыжок вперёд создаёт разрыв, и он виден', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(2, 4))
    map.insert(chunk(20, 22))

    const runs = map.runs()
    expect(runs).toHaveLength(2)
    expect(runs[0]!.start).toBe(0)
    expect(runs[0]!.end).toBe(4)
    expect(runs[1]!.start).toBe(20)
    expect(runs[1]!.end).toBe(22)
  })

  it('микрозазор от округления не считается разрывом', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(2.004, 4))

    expect(map.runs()).toHaveLength(1)
  })

  it('заметный зазор в полсекунды — это разрыв', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(2.5, 4.5))

    const runs = map.runs()
    expect(runs).toHaveLength(2)
    expect(runs[0]!.end).toBe(2)
    expect(runs[1]!.start).toBe(2.5)
  })

  it('duration складывает прогоны и не учитывает разрыв', () => {
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(20, 22))

    expect(map.duration()).toBe(4)
    expect(map.span()).toEqual({ start: 0, end: 22 })
  })
})

describe('PtsMap.evict', () => {
  it('выбрасывает то, что дальше окна от текущей позиции', () => {
    const map = new PtsMap()
    for (let t = 0; t < 20; t += 2) map.insert(chunk(t, t + 2))

    map.evict(6, 18)

    expect(map.span()!.start).toBeGreaterThanOrEqual(12)
    expect(map.span()!.end).toBe(20)
  })

  it('оставляет материал впереди позиции — он загружен наперёд', () => {
    const map = new PtsMap()
    for (let t = 0; t < 20; t += 2) map.insert(chunk(t, t + 2))

    map.evict(6, 10)

    const span = map.span()!
    expect(span.end).toBe(20)
    expect(span.start).toBeGreaterThanOrEqual(4)
  })

  it('кусок, пересекающий границу окна, остаётся целиком', () => {
    const map = new PtsMap()
    for (let t = 0; t < 20; t += 2) map.insert(chunk(t, t + 2))

    // Позиция 19 с окном 6 секунд: граница приходится на середину куска 12–14.
    map.evict(6, 19)

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.chunks.map((c) => c.start)).toEqual([12, 14, 16, 18])
    expect(map.totalBytes()).toBe(40)
  })

  it('кусок, кончающийся ровно на границе окна, уходит', () => {
    const map = new PtsMap()
    for (let t = 0; t < 20; t += 2) map.insert(chunk(t, t + 2))

    map.evict(6, 18)

    expect(map.span()).toEqual({ start: 12, end: 20 })
    expect(map.totalBytes()).toBe(40)
  })

  it('на пустой карте не падает', () => {
    const map = new PtsMap()
    map.evict(6, 0)
    expect(map.runs()).toEqual([])
    expect(map.span()).toBeNull()
  })
})
