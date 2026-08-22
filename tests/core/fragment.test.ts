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

/** moof с mfhd и произвольным набором дочерних боксов за ним. */
function moofWith(children: number[]): Uint8Array {
  return new Uint8Array(box('moof', [...box('mfhd', [...u32(0), ...u32(1)]), ...children]))
}

function moof(traf: number[]): Uint8Array {
  return moofWith(box('traf', traf))
}

describe('parseFragment', () => {
  it('читает начало и длительность первого фрагмента', () => {
    // Фикстура детерминирована: 48 сэмплов по 512 тактов из tfhd.
    const f = parseFragment(seg1)!
    expect(f).not.toBeNull()
    expect(f.trackId).toBe(1)
    expect(f.baseMediaDecodeTime).toBe(0)
    expect(f.duration).toBe(24576)
  })

  it('второй фрагмент начинается там, где кончился первый', () => {
    const a = parseFragment(seg1)!
    const b = parseFragment(seg2)!
    expect(b.baseMediaDecodeTime).toBe(a.baseMediaDecodeTime + a.duration)
    expect(b.baseMediaDecodeTime).toBe(24576)
  })

  it('длительность в секундах равна длине сегмента', () => {
    const timescale = parseInit(init)!.tracks[0]!.timescale
    expect(timescale).toBe(12288)
    const seconds = parseFragment(seg1)!.duration / timescale
    expect(seconds).toBe(2)
  })

  it('возвращает null для init-сегмента', () => {
    expect(parseFragment(init)).toBeNull()
  })

  it('возвращает null для moof без traf', () => {
    // Внутри moof один mfhd: разбирать нечего, нулевой фрагмент не годится.
    expect(parseFragment(moofWith([]))).toBeNull()
  })

  it('возвращает null, когда в traf есть tfhd, но нет tfdt', () => {
    const tfhd = box('tfhd', [...u32(0x000008), ...u32(1), ...u32(512)])
    const trun = box('trun', [...u32(0x000001), ...u32(4), ...u32(100)])
    expect(parseFragment(moof([...tfhd, ...trun]))).toBeNull()
  })

  it('возвращает null, когда в traf есть tfdt, но нет tfhd', () => {
    const tfdt = box('tfdt', [...u32(0), ...u32(1000)])
    const trun = box('trun', [...u32(0x000101), ...u32(2), ...u32(100), ...u32(50), ...u32(50)])
    expect(parseFragment(moof([...tfdt, ...trun]))).toBeNull()
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

  it('даёт нулевую длительность, когда её нет ни в tfhd, ни в trun', () => {
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(4), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(77)])
    const trun = box('trun', [
      ...u32(0x000201), ...u32(3), ...u32(100), ...u32(500), ...u32(500), ...u32(500),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]))!
    expect(f.baseMediaDecodeTime).toBe(77)
    expect(f.duration).toBe(0)
  })

  it('не теряет последнюю запись trun, упирающуюся в конец бокса', () => {
    // trun только с длительностями: запись 4 байта, тело кончается ровно на
    // границе последней записи.
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(9), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(500)])
    const trun = box('trun', [
      ...u32(0x000100), ...u32(4), ...u32(10), ...u32(20), ...u32(30), ...u32(40),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]))!
    expect(f.trackId).toBe(9)
    expect(f.baseMediaDecodeTime).toBe(500)
    expect(f.duration).toBe(100)
  })

  it('не читает за концом усечённого trun', () => {
    // sample_count обещает пять записей, в теле бокса их две.
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(6), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(200)])
    const trun = box('trun', [...u32(0x000100), ...u32(5), ...u32(10), ...u32(20)])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]))!
    expect(f.baseMediaDecodeTime).toBe(200)
    expect(f.duration).toBe(30)
  })

  it('учитывает ширину sample_flags в записи trun', () => {
    // trun: sample_duration | sample_flags, запись 8 байт.
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(2), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(64)])
    const entry = (duration: number) => [...u32(duration), ...u32(0x02000000)]
    const trun = box('trun', [
      ...u32(0x000500), ...u32(3), ...entry(90), ...entry(110), ...entry(300),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]))!
    expect(f.trackId).toBe(2)
    expect(f.baseMediaDecodeTime).toBe(64)
    expect(f.duration).toBe(500)
  })

  it('берёт первый traf муксированного moof и не смешивает дорожки', () => {
    // Поведение по плану: фрагмент описывает одну дорожку, вторая молча
    // пропускается, а не складывается в ту же длительность.
    const trafOf = (trackId: number, sampleDuration: number, base: number) =>
      box('traf', [
        ...box('tfhd', [...u32(0x000008), ...u32(trackId), ...u32(sampleDuration)]),
        ...box('tfdt', [...u32(0), ...u32(base)]),
        ...box('trun', [...u32(0x000001), ...u32(4), ...u32(100)]),
      ])

    const f = parseFragment(moofWith([...trafOf(1, 512, 0), ...trafOf(2, 1024, 8)]))!
    expect(f.trackId).toBe(1)
    expect(f.baseMediaDecodeTime).toBe(0)
    expect(f.duration).toBe(2048)
  })
})
