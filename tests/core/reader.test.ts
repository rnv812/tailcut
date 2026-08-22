import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { topLevelBoxes, findBox, childBoxes, boxBody } from '../../src/core/iso/reader'

const init = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const seg = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))

describe('topLevelBoxes', () => {
  it('находит ftyp и moov в init-сегменте', () => {
    const types = topLevelBoxes(init).map((b) => b.type)
    expect(types).toContain('ftyp')
    expect(types).toContain('moov')
  })

  it('находит moof и mdat в медиасегменте', () => {
    const types = topLevelBoxes(seg).map((b) => b.type)
    expect(types).toContain('moof')
    expect(types).toContain('mdat')
  })

  it('размеры боксов покрывают файл без дыр', () => {
    const boxes = topLevelBoxes(init)
    expect(boxes.length).toBeGreaterThan(1)

    // непрерывность, а не только суммарный объём: дыра, скомпенсированная
    // перекрытием, даёт ту же сумму, но разбор при этом уже врёт
    expect(boxes[0]!.start).toBe(0)
    for (let i = 1; i < boxes.length; i++) {
      const prev = boxes[i - 1]!
      expect(boxes[i]!.start).toBe(prev.start + prev.size)
    }
    const last = boxes[boxes.length - 1]!
    expect(last.start + last.size).toBe(init.byteLength)

    const covered = boxes.reduce((sum, b) => sum + b.size, 0)
    expect(covered).toBe(init.byteLength)
  })
})

describe('findBox', () => {
  it('спускается по вложенному пути', () => {
    const mdhd = findBox(init, ['moov', 'trak', 'mdia', 'mdhd'])
    expect(mdhd).not.toBeNull()
    expect(mdhd!.size).toBeGreaterThan(8)
  })

  it('возвращает null для отсутствующего пути', () => {
    expect(findBox(init, ['moov', 'nope'])).toBeNull()
  })

  it('обрывается на отсутствующем непоследнем звене, не проваливаясь дальше', () => {
    // trak существует внутри moov, но добраться до него можно только через
    // moov: путь через несуществующий промежуточный контейнер обязан дать null
    const moov = topLevelBoxes(init).find((b) => b.type === 'moov')!
    expect(childBoxes(init, moov).map((b) => b.type)).toContain('trak')
    expect(findBox(init, ['moov', 'nope', 'trak'])).toBeNull()
  })

  it('возвращает null, когда отсутствует первое звено пути', () => {
    // moov лежит на верхнем уровне, но путь начинается не с него —
    // пропускать несовпавшее звено и искать следующее на том же уровне нельзя
    expect(topLevelBoxes(init).map((b) => b.type)).toContain('moov')
    expect(findBox(init, ['nope', 'moov'])).toBeNull()
  })

  it('возвращает лист пути, а не пройденный контейнер', () => {
    const moov = topLevelBoxes(init).find((b) => b.type === 'moov')!
    const mdhd = findBox(init, ['moov', 'trak', 'mdia', 'mdhd'])!
    expect(mdhd.type).toBe('mdhd')
    // лист лежит строго внутри контейнера, через который к нему спускались
    expect(mdhd.start).toBeGreaterThan(moov.start)
    expect(mdhd.start + mdhd.size).toBeLessThanOrEqual(moov.start + moov.size)
    expect(mdhd.size).toBeLessThan(moov.size)

    const tfhd = findBox(seg, ['moof', 'traf', 'tfhd'])!
    expect(tfhd.type).toBe('tfhd')
  })

  it('для пути из одного шага отдаёт сам верхнеуровневый бокс', () => {
    const moov = topLevelBoxes(init).find((b) => b.type === 'moov')!
    expect(findBox(init, ['moov'])).toEqual(moov)
  })
})

describe('childBoxes', () => {
  it('перечисляет дорожки внутри moov', () => {
    const moov = topLevelBoxes(init).find((b) => b.type === 'moov')!
    const traks = childBoxes(init, moov).filter((b) => b.type === 'trak')
    expect(traks.length).toBeGreaterThanOrEqual(1)
  })

  it('не разбирает содержимое листового бокса как боксы', () => {
    // полезная нагрузка mdat случайно похожа на заголовки боксов — потомков там нет
    const mdat = topLevelBoxes(seg).find((b) => b.type === 'mdat')!
    expect(mdat.size).toBeGreaterThan(mdat.headerSize)
    expect(childBoxes(seg, mdat)).toEqual([])

    const mdhd = findBox(init, ['moov', 'trak', 'mdia', 'mdhd'])!
    expect(mdhd.size).toBeGreaterThan(mdhd.headerSize)
    expect(childBoxes(init, mdhd)).toEqual([])
  })
})

// --- Синтетические буферы для случаев, которых нет в фикстурах ---

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

function u64(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

const text = (data: Uint8Array): string => String.fromCharCode(...data)

describe('boxBody', () => {
  it('срезает заголовок ftyp и отдаёт тело целиком', () => {
    const ftyp = topLevelBoxes(init).find((b) => b.type === 'ftyp')!
    const body = boxBody(init, ftyp)
    expect(body.byteLength).toBe(ftyp.size - ftyp.headerSize)
    // первые четыре байта тела ftyp — major brand, а не тип бокса
    expect(text(body.subarray(0, 4))).toBe('iso5')
  })

  it('тело контейнера начинается с заголовка первого потомка', () => {
    const moov = topLevelBoxes(init).find((b) => b.type === 'moov')!
    const body = boxBody(init, moov)
    const first = childBoxes(init, moov)[0]!
    expect(body.byteLength).toBe(moov.size - moov.headerSize)
    expect(new DataView(body.buffer, body.byteOffset).getUint32(0)).toBe(first.size)
    expect(text(body.subarray(4, 8))).toBe(first.type)
  })

  it('учитывает 64-битный заголовок', () => {
    const buf = concat(u32(1), ascii('mdat'), u64(24), ascii('PAYLOAD!'))
    const box = topLevelBoxes(buf)[0]!
    expect(text(boxBody(buf, box))).toBe('PAYLOAD!')
  })
})

describe('64-битный размер', () => {
  it('читает largesize и заголовок в 16 байт', () => {
    const buf = concat(u32(1), ascii('mdat'), u64(24), ascii('PAYLOAD!'))
    const boxes = topLevelBoxes(buf)
    expect(boxes).toEqual([{ type: 'mdat', start: 0, size: 24, headerSize: 16 }])
  })

  it('пропускает бокс с обрезанным 64-битным заголовком', () => {
    const buf = concat(u32(1), ascii('mdat'), u32(0))
    expect(topLevelBoxes(buf)).toEqual([])
  })
})

describe('размер 0 — бокс до конца диапазона', () => {
  it('растягивает верхнеуровневый бокс до конца буфера', () => {
    const buf = concat(u32(0), ascii('mdat'), ascii('12345678'))
    const boxes = topLevelBoxes(buf)
    expect(boxes).toEqual([{ type: 'mdat', start: 0, size: 16, headerSize: 8 }])
    expect(text(boxBody(buf, boxes[0]!))).toBe('12345678')
  })

  it('растягивает вложенный бокс до конца родителя, а не буфера', () => {
    const traf = concat(u32(0), ascii('traf'), ascii('abcdefgh'))
    const moof = concat(u32(8 + traf.byteLength), ascii('moof'), traf)
    const buf = concat(moof, u32(8), ascii('free'))
    const parent = topLevelBoxes(buf).find((b) => b.type === 'moof')!
    expect(childBoxes(buf, parent)).toEqual([
      { type: 'traf', start: 8, size: 16, headerSize: 8 },
    ])
  })
})

describe('граница обхода', () => {
  it('читает бокс, занимающий ровно последние восемь байт', () => {
    const buf = concat(u32(16), ascii('mdat'), ascii('12345678'), u32(8), ascii('free'))
    const boxes = topLevelBoxes(buf)
    expect(boxes.map((b) => b.type)).toEqual(['mdat', 'free'])
    expect(boxes[1]).toEqual({ type: 'free', start: 16, size: 8, headerSize: 8 })
  })
})

describe('контейнер moof', () => {
  it('перечисляет traf внутри moof', () => {
    const moof = topLevelBoxes(seg).find((b) => b.type === 'moof')!
    expect(childBoxes(seg, moof).map((b) => b.type)).toContain('traf')
  })

  it('спускается в боксы фрагмента через traf', () => {
    const traf = findBox(seg, ['moof', 'traf'])!
    expect(traf.type).toBe('traf')

    const leaves = ['tfhd', 'tfdt', 'trun']
    const children = childBoxes(seg, traf)
    expect(children.map((b) => b.type)).toEqual(leaves)

    // каждый лист — ровно тот бокс, который лежит в traf под этим типом,
    // а не просто «что-то ненулевое»
    expect(leaves.map((type) => findBox(seg, ['moof', 'traf', type]))).toEqual(children)

    // и все они плотно заполняют тело traf
    let at = traf.start + traf.headerSize
    for (const box of children) {
      expect(box.start).toBe(at)
      expect(box.size).toBeGreaterThan(box.headerSize)
      at += box.size
    }
    expect(at).toBe(traf.start + traf.size)
  })
})

describe('битые размеры', () => {
  it('не отдаёт бокс, объявивший размер больше буфера', () => {
    // объявлено 32 байта, доступно 16 — тело такого бокса ещё не дошло
    const buf = concat(u32(32), ascii('mdat'), ascii('ABCDEFGH'))
    expect(buf.byteLength).toBe(16)
    expect(topLevelBoxes(buf)).toEqual([])
  })

  it('не отдаёт потомка, вылезающего за конец родителя', () => {
    const traf = concat(u32(32), ascii('traf'), ascii('abcdefgh'))
    const moof = concat(u32(8 + traf.byteLength), ascii('moof'), traf)
    const buf = concat(moof, u32(8), ascii('free'))
    const parent = topLevelBoxes(buf).find((b) => b.type === 'moof')!
    expect(parent.size).toBe(24)
    // traf объявляет 32 байта, но внутри родителя их всего 16
    expect(childBoxes(buf, parent)).toEqual([])
  })

  it('обрезает потомка по концу родителя, даже когда тот влезает в буфер', () => {
    // traf заявляет 24 байта: внутри moof для него есть только 16,
    // но до конца буфера — 32, так что проверка по буферу его бы пропустила
    const traf = concat(u32(24), ascii('traf'), ascii('abcdefgh'))
    const moof = concat(u32(8 + traf.byteLength), ascii('moof'), traf)
    const buf = concat(moof, u32(16), ascii('free'), ascii('SIBLING!'))
    expect(topLevelBoxes(buf).map((b) => b.type)).toEqual(['moof', 'free'])
    const parent = topLevelBoxes(buf)[0]!
    expect(parent.size).toBe(24)
    expect(parent.start + parent.headerSize + 24).toBeLessThanOrEqual(buf.byteLength)
    expect(childBoxes(buf, parent)).toEqual([])
  })

  it('не отдаёт бокс, размер которого меньше заголовка', () => {
    const buf = concat(u32(4), ascii('mdat'), u32(8), ascii('free'))
    expect(topLevelBoxes(buf)).toEqual([])
  })

  it('не отдаёт 64-битный бокс с largesize меньше заголовка', () => {
    // largesize==8 при 16-байтном заголовке: тело отрицательной длины
    const buf = concat(u32(1), ascii('mdat'), u64(8), ascii('PAYLOAD!'))
    expect(topLevelBoxes(buf)).toEqual([])
  })

  it('завершает обход на 64-битном боксе с largesize 0', () => {
    // size==1, largesize==0: размер меньше 16-байтного заголовка, сдвига нет.
    // Обход обязан оборваться на проверке size < headerSize — иначе offset
    // остался бы на месте и цикл стал бы вечным.
    const buf = concat(u32(1), ascii('mdat'), u64(0), ascii('PAYLOAD!'))
    expect(topLevelBoxes(buf)).toEqual([])
  })
})

describe('контейнер с 64-битным заголовком', () => {
  it('перечисляет потомков, начиная с parent.start + 16', () => {
    const traf = concat(u32(16), ascii('traf'), ascii('abcdefgh'))
    const moof = concat(u32(1), ascii('moof'), u64(16 + traf.byteLength), traf)
    const parent = topLevelBoxes(moof)[0]!
    expect(parent).toEqual({ type: 'moof', start: 0, size: 32, headerSize: 16 })
    expect(childBoxes(moof, parent)).toEqual([
      { type: 'traf', start: 16, size: 16, headerSize: 8 },
    ])
  })
})

describe('срез с ненулевым byteOffset', () => {
  // moof лежит не в начале подлежащего ArrayBuffer: перед ним — правдоподобный
  // мусор, который сам читается как пара боксов. Смещения обязаны отсчитываться
  // от начала среза, иначе размеры берутся из чужого места и разбор тихо врёт.
  const junk = concat(u32(8), ascii('free'), u32(8), ascii('skip'))
  const traf = concat(u32(16), ascii('traf'), ascii('abcdefgh'))
  const moof = concat(u32(8 + traf.byteLength), ascii('moof'), traf)
  const standalone = concat(moof, u32(8), ascii('free'))
  const padded = concat(junk, standalone)
  const slice = padded.subarray(junk.byteLength)

  it('топ-уровень среза совпадает с самостоятельным буфером', () => {
    expect(slice.byteOffset).toBe(16)
    expect(standalone.byteOffset).toBe(0)
    expect([...slice]).toEqual([...standalone])

    expect(topLevelBoxes(slice)).toEqual(topLevelBoxes(standalone))
    expect(topLevelBoxes(slice)).toEqual([
      { type: 'moof', start: 0, size: 24, headerSize: 8 },
      { type: 'free', start: 24, size: 8, headerSize: 8 },
    ])
  })

  it('потомки внутри среза совпадают с самостоятельным буфером', () => {
    const parent = topLevelBoxes(standalone).find((b) => b.type === 'moof')!
    expect(childBoxes(slice, parent)).toEqual(childBoxes(standalone, parent))
    expect(childBoxes(slice, parent)).toEqual([
      { type: 'traf', start: 8, size: 16, headerSize: 8 },
    ])
  })

  it('тело контейнера из boxBody разбирается как самостоятельный буфер', () => {
    const moovBox = topLevelBoxes(init).find((b) => b.type === 'moov')!
    const body = boxBody(init, moovBox)
    expect(body.byteOffset).toBe(moovBox.start + moovBox.headerSize)
    expect(body.byteOffset).toBeGreaterThan(0)

    // та же последовательность байт, но в начале собственного буфера
    const detached = new Uint8Array(body)
    expect(detached.byteOffset).toBe(0)

    expect(topLevelBoxes(body)).toEqual(topLevelBoxes(detached))
    // это ровно потомки moov, пересчитанные в координаты тела
    expect(topLevelBoxes(body)).toEqual(
      childBoxes(init, moovBox).map((b) => ({ ...b, start: b.start - body.byteOffset })),
    )

    const trakInBody = topLevelBoxes(body).find((b) => b.type === 'trak')!
    expect(childBoxes(body, trakInBody)).toEqual(childBoxes(detached, trakInBody))
    expect(childBoxes(body, trakInBody).map((b) => b.type)).toEqual(
      childBoxes(init, findBox(init, ['moov', 'trak'])!).map((b) => b.type),
    )
  })
})
