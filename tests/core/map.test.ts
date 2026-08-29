import { describe, it, expect } from 'vitest'
import { PtsMap, continuesRun, GAP_TOLERANCE_SECONDS } from '../../src/core/timeline/map'
import type { Chunk } from '../../src/shared/types'

const chunk = (start: number, end: number, size = 10, fill = 0): Chunk => ({
  start,
  end,
  bytes: new Uint8Array(size).fill(fill),
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

  it('расхождение начал ровно в допуск — это уже разные куски', () => {
    // Допуск 0.001 задан строгим включением: совпадением считается расхождение
    // МЕНЬШЕ него. 0.001 - 0 в double даёт ровно константу, так что граница честная.
    const later = new PtsMap()
    later.insert(chunk(0, 2))
    later.insert(chunk(0.001, 2))

    const earlier = new PtsMap()
    earlier.insert(chunk(0.001, 2))
    earlier.insert(chunk(0, 2))

    for (const map of [later, earlier]) {
      expect(map.runs()).toHaveLength(1)
      expect(map.runs()[0]!.chunks.map((c) => c.start)).toEqual([0, 0.001])
      expect(map.totalBytes()).toBe(20)
    }
  })

  it('сдвиг начала чуть меньше допуска — это всё ещё тот же кусок', () => {
    // Нижний край допуска: 0.000999 в double строго меньше 0.001, так что
    // близнец обязан склеиться. Вместе с тестом на расхождение ровно в допуск
    // это запирает константу в щели (0.000999, 0.001] — ужать её незаметно
    // уже нельзя, а ужатая перестаёт узнавать близнецов.
    const later = new PtsMap()
    later.insert(chunk(0, 2))
    later.insert(chunk(0.000999, 2))

    const earlier = new PtsMap()
    earlier.insert(chunk(0.000999, 2))
    earlier.insert(chunk(0, 2))

    for (const map of [later, earlier]) {
      expect(map.runs()).toHaveLength(1)
      expect(map.runs()[0]!.chunks).toHaveLength(1)
      expect(map.totalBytes()).toBe(10)
    }
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

  it('близнец той же длины не подменяет уже сохранённые байты', () => {
    // При переключении качества тот же участок приходит заново из другого
    // представления. Замена оправдана только удлинением: иначе в карте
    // окажутся байты чужого представления под теми же границами.
    const exact = new PtsMap()
    exact.insert(chunk(10, 12, 10, 1))
    exact.insert(chunk(10, 12, 10, 2))

    const shifted = new PtsMap()
    shifted.insert(chunk(10, 12, 10, 1))
    shifted.insert(chunk(10.0005, 12, 10, 2))

    for (const map of [exact, shifted]) {
      const kept = map.runs()[0]!.chunks
      expect(kept).toHaveLength(1)
      expect(kept[0]!.start).toBe(10)
      expect([...kept[0]!.bytes]).toEqual(Array(10).fill(1))
      expect(map.totalBytes()).toBe(10)
    }
  })

  it('кусок нулевой или отрицательной длительности игнорируется', () => {
    const map = new PtsMap()
    map.insert(chunk(5, 5))
    map.insert(chunk(5, 4))

    expect(map.runs()).toEqual([])
    expect(map.totalBytes()).toBe(0)
    expect(map.span()).toBeNull()
  })

  it('answers whether it took the chunk: the history writes down only what it took', () => {
    const map = new PtsMap()

    // Material the map did not hold, and a longer variant of what it now does: something on the
    // map changed both times, so both belong on the disk.
    expect(map.insert(chunk(0, 2, 10))).toBe(true)
    expect(map.insert(chunk(0, 3, 15))).toBe(true)

    // A second viewing of the same stretch (§6.3) — plainly and with the microscopic shift of
    // the start a site gives it. The map keeps what it had, and a copy of those bytes has no
    // business going to the disk or being counted in the length of the session twice.
    expect(map.insert(chunk(0, 3, 15))).toBe(false)
    expect(map.insert(chunk(0.0005, 3, 15))).toBe(false)

    // And nothing at all of a chunk that lasts no time.
    expect(map.insert(chunk(5, 5))).toBe(false)
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

  it('после разрыва прогон продолжает набираться из следующих кусков', () => {
    // Продолжение меряется по последнему прогону, а не по первому: иначе
    // после прыжка вперёд каждый кусок становится отдельным прогоном, и
    // непрерывный участок разваливается на куски при сборке клипа.
    // duration() такую поломку не видит — сумма длительностей та же.
    const map = new PtsMap()
    map.insert(chunk(0, 2))
    map.insert(chunk(2, 4))
    map.insert(chunk(20, 22))
    map.insert(chunk(22, 24))
    map.insert(chunk(24, 26))
    map.insert(chunk(26, 28))

    const runs = map.runs()
    expect(runs).toHaveLength(2)
    expect(runs[0]!.start).toBe(0)
    expect(runs[0]!.end).toBe(4)
    expect(runs[0]!.chunks.map((c) => c.start)).toEqual([0, 2])
    expect(runs[1]!.start).toBe(20)
    expect(runs[1]!.end).toBe(28)
    expect(runs[1]!.chunks.map((c) => c.start)).toEqual([20, 22, 24, 26])
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

  it('зазор ровно в допуск ещё не разрыв', () => {
    // Единственный способ получить в double разность ровно 0.05 — брать времена
    // у самого нуля: 0.11 - 0.06 === 0.05, тогда как 2.05 - 2 уже нет.
    expect(0.11 - 0.06).toBe(GAP_TOLERANCE_SECONDS)

    const map = new PtsMap()
    map.insert(chunk(0.01, 0.06))
    map.insert(chunk(0.11, 0.5))

    const runs = map.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.end).toBe(0.5)
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
  it('оставляет материал впереди позиции — он загружен наперёд', () => {
    const map = new PtsMap()
    for (let t = 0; t < 20; t += 2) map.insert(chunk(t, t + 2))

    map.evict(6, 10)

    // Отсечка ровно currentTime - windowSeconds = 4: уцелевает всё, что кончается
    // позже неё, то есть куски с 4 по 18 включительно — восемь штук.
    expect(map.span()).toEqual({ start: 4, end: 20 })
    expect(map.totalBytes()).toBe(80)
    expect(map.runs()[0]!.chunks.map((c) => c.start)).toEqual([4, 6, 8, 10, 12, 14, 16, 18])
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


describe('continuesRun', () => {
  it('включает границу допуска и отсекает всё, что за ней', () => {
    expect(continuesRun(0, 0.049)).toBe(true)
    expect(continuesRun(0, GAP_TOLERANCE_SECONDS)).toBe(true)
    expect(continuesRun(0, 0.051)).toBe(false)
  })

  it('перекрытие и стык — тоже продолжение прогона', () => {
    expect(continuesRun(2, 2)).toBe(true)
    expect(continuesRun(2, 1.5)).toBe(true)
  })

  it('заметный зазор рвёт прогон', () => {
    expect(continuesRun(2, 2.5)).toBe(false)
  })
})
