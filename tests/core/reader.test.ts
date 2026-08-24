import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { topLevelBoxes, findBox, childBoxes, boxBody, boxesIn } from '../../src/core/iso/reader'

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

  it('возвращает null для пустого пути', () => {
    // пустой путь не называет ни одного бокса, поэтому возвращать нечего:
    // верхний уровень непуст, и отдать его первый бокс было бы соблазнительно,
    // но такой ответ не соответствовал бы ни одному запрошенному звену
    const top = topLevelBoxes(init)
    expect(top.length).toBeGreaterThan(0)
    expect(top[0]!.type).toBe('ftyp')
    expect(findBox(init, [])).toBeNull()
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

  it('читает 64-битный бокс с пустым телом, занимающий ровно последние 16 байт', () => {
    // largesize == 16: тело пустое, шестнадцатибайтный заголовок упирается
    // в конец диапазона. Байт для заголовка ровно столько, сколько нужно,
    // значит бокс обязан быть разобран, а не отброшен как обрезанный
    const buf = concat(u32(16), ascii('mdat'), ascii('12345678'), u32(1), ascii('free'), u64(16))
    expect(buf.byteLength).toBe(32)
    const boxes = topLevelBoxes(buf)
    expect(boxes.map((b) => b.type)).toEqual(['mdat', 'free'])
    expect(boxes[1]).toEqual({ type: 'free', start: 16, size: 16, headerSize: 16 })
    expect(boxBody(buf, boxes[1]!).byteLength).toBe(0)
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

describe('набор контейнерных типов', () => {
  // Список закреплён здесь целиком и намеренно продублирован: удаление любого
  // типа из набора в reader.ts обязано ронять этот тест, а не тихо сужать
  // область спуска. Фикстуры покрывают лишь часть типов, поэтому боксы
  // синтетические — важен сам факт спуска, а не реальное содержимое.
  const containers = [
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'dinf',
  ]

  // бокс `type`, внутри которого лежит единственный потомок free размером 16
  const withChild = (type: string): Uint8Array => {
    const child = concat(u32(16), ascii('free'), ascii('12345678'))
    return concat(u32(8 + child.byteLength), ascii(type), child)
  }

  it.each(containers)('childBoxes спускается внутрь %s', (type) => {
    const buf = withChild(type)
    const parent = topLevelBoxes(buf)[0]!
    expect(parent).toEqual({ type, start: 0, size: 24, headerSize: 8 })
    expect(childBoxes(buf, parent)).toEqual([
      { type: 'free', start: 8, size: 16, headerSize: 8 },
    ])
    // и путь через этот контейнер доводит до потомка
    expect(findBox(buf, [type, 'free'])).toEqual({
      type: 'free', start: 8, size: 16, headerSize: 8,
    })
  })

  it.each(['ftyp', 'udta', 'mdat', 'mdhd'])('не спускается внутрь %s', (type) => {
    // набор — белый список: та же раскладка байт под неконтейнерным типом
    // потомков давать не должна
    const buf = withChild(type)
    const parent = topLevelBoxes(buf)[0]!
    expect(parent.size).toBe(24)
    expect(childBoxes(buf, parent)).toEqual([])
    expect(findBox(buf, [type, 'free'])).toBeNull()
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

  it('не отдаёт бокс, которому не хватает ровно одного байта', () => {
    // объявлено 16 байт, доступно 15 — тело неполно ровно на байт. Тело либо
    // целиком в диапазоне, либо бокса нет: допуск «почти влезает» отдал бы
    // бокс, чей последний байт лежит уже за границей разбираемых данных
    const buf = concat(u32(16), ascii('mdat'), ascii('1234567'))
    expect(buf.byteLength).toBe(15)
    expect(topLevelBoxes(buf)).toEqual([])

    // стоит дописать недостающий байт — и тот же бокс разбирается целиком
    const full = concat(buf, ascii('8'))
    expect(full.byteLength).toBe(16)
    expect(topLevelBoxes(full)).toEqual([
      { type: 'mdat', start: 0, size: 16, headerSize: 8 },
    ])
    expect(text(boxBody(full, topLevelBoxes(full)[0]!))).toBe('12345678')
  })

  it('не отдаёт потомка, которому не хватает ровно одного байта до конца родителя', () => {
    // traf объявляет 17 байт, внутри moof доступно 16. Недостающий байт в
    // буфере есть — он лежит сразу за родителем, но принадлежит уже не ему
    const traf = concat(u32(17), ascii('traf'), ascii('abcdefgh'))
    const moof = concat(u32(8 + traf.byteLength), ascii('moof'), traf)
    const buf = concat(moof, u32(8), ascii('free'))
    const parent = topLevelBoxes(buf)[0]!
    expect(parent).toEqual({ type: 'moof', start: 0, size: 24, headerSize: 8 })
    expect(parent.start + parent.headerSize + 17).toBeLessThanOrEqual(buf.byteLength)
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

describe('одноимённые боксы на одном уровне', () => {
  it('findBox отдаёт первый из одноимённых потомков', () => {
    const first = concat(u32(16), ascii('trak'), ascii('FIRST!!!'))
    const second = concat(u32(24), ascii('trak'), ascii('SECOND!!SECOND!!'))
    const buf = concat(
      u32(8 + first.byteLength + second.byteLength), ascii('moov'), first, second,
    )

    const children = childBoxes(buf, topLevelBoxes(buf)[0]!)
    expect(children).toEqual([
      { type: 'trak', start: 8, size: 16, headerSize: 8 },
      { type: 'trak', start: 24, size: 24, headerSize: 8 },
    ])

    // спор одноимённых потомков разрешает порядок: берётся первый по буферу
    const found = findBox(buf, ['moov', 'trak'])!
    expect(found).toEqual(children[0])
    expect(text(boxBody(buf, found))).toBe('FIRST!!!')
  })

  it('findBox спускается в первый из одноимённых верхнеуровневых боксов', () => {
    const moofWith = (payload: string): Uint8Array =>
      concat(u32(24), ascii('moof'), u32(16), ascii('traf'), ascii(payload))
    const buf = concat(moofWith('FIRST!!!'), moofWith('SECOND!!'))

    const top = topLevelBoxes(buf)
    expect(top).toEqual([
      { type: 'moof', start: 0, size: 24, headerSize: 8 },
      { type: 'moof', start: 24, size: 24, headerSize: 8 },
    ])

    expect(findBox(buf, ['moof'])).toEqual(top[0])
    // и путь дальше идёт внутрь первого, а не последнего
    const traf = findBox(buf, ['moof', 'traf'])!
    expect(traf).toEqual({ type: 'traf', start: 8, size: 16, headerSize: 8 })
    expect(text(boxBody(buf, traf))).toBe('FIRST!!!')
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

  it('не заглядывает за конец среза, за которым в буфере остался хвост', () => {
    // вид, какой приходит из appendBuffer: окно посреди большого буфера,
    // байты есть и до него, и после. Граница обхода — конец самого вида;
    // взятая по остатку буфера, она увела бы разбор в чужие байты за срезом
    const tail = concat(u32(16), ascii('mdat'), ascii('TAILTAIL'))
    const whole = concat(junk, standalone, tail)
    const middle = whole.subarray(junk.byteLength, junk.byteLength + standalone.byteLength)

    expect(middle.byteOffset).toBe(junk.byteLength)
    expect(middle.byteOffset).toBeGreaterThan(0)
    expect(middle.byteOffset + middle.byteLength).toBeLessThan(middle.buffer.byteLength)
    expect([...middle]).toEqual([...standalone])

    expect(topLevelBoxes(middle)).toEqual(topLevelBoxes(standalone))
    expect(topLevelBoxes(middle)).toEqual([
      { type: 'moof', start: 0, size: 24, headerSize: 8 },
      { type: 'free', start: 24, size: 8, headerSize: 8 },
    ])
    // хвостовой mdat лежит за окном и в разбор попасть не должен
    expect(topLevelBoxes(middle).map((b) => b.type)).not.toContain('mdat')
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

describe('boxesIn', () => {
  it('reads the boxes of a range whose parent is not a container', () => {
    // stsd is a full box: four bytes of version and flags, four of entry count, and only then the
    // sample entries. It is not in the container list and cannot be — the eight bytes in front of
    // its children would be read as a box header — so childBoxes hands back nothing for it.
    const stsd = findBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!
    expect(childBoxes(init, stsd)).toEqual([])

    const entries = boxesIn(init, stsd.start + stsd.headerSize + 8, stsd.start + stsd.size)
    expect(entries.map((b) => b.type)).toEqual(['avc1'])
    expect(entries[0]!.size).toBe(170)

    // The same for the sample entry itself: a fixed run of fields, then the boxes describing the
    // codec. Eighty-six bytes in for a picture — see src/core/iso/entry.ts.
    const entry = entries[0]!
    const children = boxesIn(init, entry.start + 86, entry.start + entry.size)
    expect(children.map((b) => b.type)).toEqual(['avcC', 'pasp', 'btrt'])
  })

  it('stops at the end of the range and not at the end of the buffer', () => {
    const stsd = findBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!
    const entry = boxesIn(init, stsd.start + stsd.headerSize + 8, stsd.start + stsd.size)[0]!
    const avcC = boxesIn(init, entry.start + 86, entry.start + entry.size)[0]!

    // A range that ends one byte short of the pasp behind the avcC yields the avcC alone: the box
    // that does not fit is dropped rather than half-read.
    const narrow = boxesIn(init, entry.start + 86, avcC.start + avcC.size + 15)
    expect(narrow.map((b) => b.type)).toEqual(['avcC'])

    // An empty range and a backwards one are both nothing, not a throw.
    expect(boxesIn(init, 8, 8)).toEqual([])
    expect(boxesIn(init, 32, 8)).toEqual([])
  })
})
