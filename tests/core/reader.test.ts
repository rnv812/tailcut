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
})

describe('childBoxes', () => {
  it('перечисляет дорожки внутри moov', () => {
    const moov = topLevelBoxes(init).find((b) => b.type === 'moov')!
    const traks = childBoxes(init, moov).filter((b) => b.type === 'trak')
    expect(traks.length).toBeGreaterThanOrEqual(1)
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
    expect(findBox(seg, ['moof', 'traf', 'tfhd'])).not.toBeNull()
    expect(findBox(seg, ['moof', 'traf', 'tfdt'])).not.toBeNull()
    expect(findBox(seg, ['moof', 'traf', 'trun'])).not.toBeNull()
  })
})
