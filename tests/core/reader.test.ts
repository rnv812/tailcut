import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { topLevelBoxes, findBox, childBoxes } from '../../src/core/iso/reader'

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
