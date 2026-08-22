import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseFragment } from '../../src/core/iso/fragment'
import { parseInit } from '../../src/core/iso/init'

const init = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const seg1 = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))
const seg2 = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00002.m4s'))

// --- Сборка синтетических moof ---
// Фикстуры ffmpeg держат длительности только в tfhd (default_sample_duration),
// поэтому ветку «длительности лежат в trun» приходится собирать вручную.

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function u64(n: number): number[] {
  return [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)]
}

/** Бокс: четыре байта размера, четыре байта типа, тело. */
function box(type: string, body: number[]): number[] {
  return [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body]
}

function moof(traf: number[]): Uint8Array {
  return new Uint8Array(box('moof', [...box('mfhd', [...u32(0), ...u32(1)]), ...box('traf', traf)]))
}

describe('parseFragment', () => {
  it('читает начало и длительность первого фрагмента', () => {
    const f = parseFragment(seg1)!
    expect(f).not.toBeNull()
    expect(f.baseMediaDecodeTime).toBe(0)
    expect(f.duration).toBeGreaterThan(0)
  })

  it('второй фрагмент начинается там, где кончился первый', () => {
    const a = parseFragment(seg1)!
    const b = parseFragment(seg2)!
    expect(b.baseMediaDecodeTime).toBe(a.baseMediaDecodeTime + a.duration)
  })

  it('длительность в секундах близка к длине сегмента', () => {
    const timescale = parseInit(init)!.tracks[0]!.timescale
    const seconds = parseFragment(seg1)!.duration / timescale
    expect(seconds).toBeGreaterThan(1.5)
    expect(seconds).toBeLessThan(2.5)
  })

  it('возвращает null для init-сегмента', () => {
    expect(parseFragment(init)).toBeNull()
  })

  it('складывает длительности сэмплов из всех trun', () => {
    // tfhd без default_sample_duration: длительности обязаны браться из trun.
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(7), ...u32(0x01010000)])
    // tfdt версии 0: время в 32 битах.
    const tfdt = box('tfdt', [...u32(0), ...u32(1000)])
    // trun: data_offset | first_sample_flags | duration | size | cts.
    const entry = (duration: number) => [...u32(duration), ...u32(500), ...u32(0)]
    const trunFlags = 0x000b05
    const trunA = box('trun', [
      ...u32(trunFlags), ...u32(3), ...u32(100), ...u32(0x02000000),
      ...entry(100), ...entry(150), ...entry(250),
    ])
    const trunB = box('trun', [
      ...u32(trunFlags), ...u32(2), ...u32(200), ...u32(0x02000000),
      ...entry(300), ...entry(400),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trunA, ...trunB]))!
    expect(f.trackId).toBe(7)
    expect(f.baseMediaDecodeTime).toBe(1000)
    expect(f.duration).toBe(1200)
  })

  it('берёт длительность из tfhd, когда trun её не несёт', () => {
    // tfhd: base_data_offset | sample_description_index | default_sample_duration.
    const tfhd = box('tfhd', [
      ...u32(0x0000000b), ...u32(3), ...u64(1234), ...u32(1), ...u32(1024),
    ])
    const tfdt = box('tfdt', [...u32(0x01000000), ...u64(4096)])
    // trun: data_offset | size, длительностей нет.
    const trun = box('trun', [
      ...u32(0x000201), ...u32(5), ...u32(100),
      ...u32(500), ...u32(500), ...u32(500), ...u32(500), ...u32(500),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]))!
    expect(f.trackId).toBe(3)
    expect(f.baseMediaDecodeTime).toBe(4096)
    expect(f.duration).toBe(5120)
  })
})
