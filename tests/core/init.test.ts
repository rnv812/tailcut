import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseInit } from '../../src/core/iso/init'

const h264 = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const vp9 = new Uint8Array(readFileSync('tests/fixtures/vp9/init-stream0.m4s'))
const media = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))

describe('parseInit', () => {
  it('читает видеодорожку H.264', () => {
    const info = parseInit(h264)!
    expect(info).not.toBeNull()
    const video = info.tracks.find((t) => t.kind === 'video')!
    expect(video.codec).toBe('avc1')
    expect(video.width).toBe(320)
    expect(video.height).toBe(240)
    // точные значения, а не «больше нуля»: чужое поле tkhd/mdhd тоже положительно
    expect(video.timescale).toBe(12288)
    expect(video.trackId).toBe(1)
  })

  it('читает видеодорожку VP9 — разбор не заточен под один кодек', () => {
    const video = parseInit(vp9)!.tracks.find((t) => t.kind === 'video')!
    expect(video.codec).toBe('vp09')
    expect(video.timescale).toBe(12288)
    expect(video.trackId).toBe(1)
  })

  it('читает аудиодорожку', () => {
    const audioInit = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream1.m4s'))
    const audio = parseInit(audioInit)!.tracks.find((t) => t.kind === 'audio')!
    expect(audio.codec).toBe('mp4a')
    expect(audio.timescale).toBe(44100)
    expect(audio.trackId).toBe(1)
  })

  it('возвращает null, если moov отсутствует', () => {
    expect(parseInit(media)).toBeNull()
  })
})

// --- Синтетические init-сегменты для случаев, которых нет в фикстурах ---

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))
const u8 = (n: number): Uint8Array => Uint8Array.of(n)
const zeros = (n: number): Uint8Array => new Uint8Array(n)

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

/** Число с фиксированной точкой 16.16 — так записаны width/height в tkhd. */
function fixed1616(value: number): Uint8Array {
  return u32(Math.round(value * 65536))
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

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts)
  return concat(u32(8 + body.byteLength), ascii(type), body)
}

interface TrackSpec {
  /** версия tkhd и mdhd: в v1 времена по 8 байт, поля за ними уезжают вперёд */
  version?: 0 | 1
  trackId: number
  /** handler_type из hdlr: 'vide', 'soun' или любой другой — например 'text' */
  handler: string
  timescale: number
  width?: number
  height?: number
  /** null — stsd не класть вовсе: кодек такой дорожки неизвестен */
  codec?: string | null
  /** готовый stsd вместо собранного по codec — для битых и усечённых боксов */
  stsd?: Uint8Array
}

function tkhd(spec: TrackSpec): Uint8Array {
  const version = spec.version ?? 0
  const time = version === 1 ? zeros(8) : zeros(4)
  const duration = version === 1 ? zeros(8) : zeros(4)
  return box(
    'tkhd',
    u8(version), zeros(3),
    time, time, // creation_time, modification_time
    u32(spec.trackId), zeros(4), // track_ID, reserved
    duration,
    zeros(8), // reserved
    zeros(8), // layer, alternate_group, volume, reserved
    zeros(36), // matrix
    fixed1616(spec.width ?? 0), fixed1616(spec.height ?? 0),
  )
}

function mdhd(spec: TrackSpec): Uint8Array {
  const version = spec.version ?? 0
  const time = version === 1 ? zeros(8) : zeros(4)
  const duration = version === 1 ? zeros(8) : zeros(4)
  return box(
    'mdhd',
    u8(version), zeros(3),
    time, time,
    u32(spec.timescale),
    duration,
    zeros(2), zeros(2), // language, pre_defined
  )
}

function trak(spec: TrackSpec): Uint8Array {
  const codec = spec.codec === undefined ? 'avc1' : spec.codec
  const stsd = spec.stsd ?? (codec === null ? null : box('stsd', zeros(4), u32(1), box(codec, zeros(8))))
  const stbl = stsd === null ? box('stbl') : box('stbl', stsd)
  return box(
    'trak',
    tkhd(spec),
    box(
      'mdia',
      mdhd(spec),
      box('hdlr', zeros(4), zeros(4), ascii(spec.handler), zeros(4)),
      box('minf', stbl),
    ),
  )
}

/** moov, как в init-сегменте: mvhd и дорожки. */
function moov(...traks: Uint8Array[]): Uint8Array {
  return box('moov', box('mvhd', zeros(100)), ...traks)
}

describe('parseInit на синтетических init-сегментах', () => {
  it('округляет дробные размеры 16.16 до целых пикселей', () => {
    // анаморфный кадр: 853.33 в 16.16 — не целое число, .75 обязано уйти вверх
    const init = moov(trak({ trackId: 7, handler: 'vide', timescale: 12800, width: 853.33, height: 479.75 }))
    const video = parseInit(init)!.tracks.find((t) => t.kind === 'video')!
    expect(video.width).toBe(853)
    expect(video.height).toBe(480)
    expect(video.trackId).toBe(7)
  })

  it('читает track_ID и timescale по смещениям версии 1', () => {
    const init = moov(trak({
      version: 1, trackId: 42, handler: 'vide', timescale: 90000, width: 640, height: 360,
    }))
    const video = parseInit(init)!.tracks.find((t) => t.kind === 'video')!
    expect(video.trackId).toBe(42)
    expect(video.timescale).toBe(90000)
    expect(video.width).toBe(640)
    expect(video.height).toBe(360)
  })

  it('перечисляет все дорожки муксированного moov, а не только первую', () => {
    // video и audio в одном moov — так выглядит не-DASH init-сегмент
    const init = parseInit(moov(
      trak({ trackId: 1, handler: 'vide', timescale: 12288, width: 320, height: 240 }),
      trak({ trackId: 2, handler: 'soun', timescale: 44100, codec: 'mp4a' }),
    ))!
    expect(init.tracks).toHaveLength(2)

    const video = init.tracks.find((t) => t.kind === 'video')!
    const audio = init.tracks.find((t) => t.kind === 'audio')!
    // у второй дорожки свои поля, а не скопированные с первой
    expect(video.trackId).toBe(1)
    expect(video.timescale).toBe(12288)
    expect(video.codec).toBe('avc1')
    expect(audio.trackId).toBe(2)
    expect(audio.timescale).toBe(44100)
    expect(audio.codec).toBe('mp4a')
  })

  it('отбрасывает дорожку с усечённым stsd, а не выдаёт кодек из нулевых байтов', () => {
    // тело stsd ровно 8 байт: version+flags и entry_count, sample entry обрезан
    const truncated = trak({
      trackId: 1, handler: 'vide', timescale: 1000, stsd: box('stsd', zeros(4), u32(1)),
    })
    expect(parseInit(moov(truncated))).toBeNull()

    // контроль: тот же конструктор с целым stsd читает настоящий кодек
    const whole = trak({ trackId: 1, handler: 'vide', timescale: 1000, codec: 'avc1' })
    expect(parseInit(moov(whole))!.tracks[0]!.codec).toBe('avc1')
  })

  it('возвращает null, когда moov есть, но пригодных дорожек в нём нет', () => {
    // контроль: тот же конструктор с полноценной дорожкой даёт непустой разбор
    const good = trak({ trackId: 1, handler: 'vide', timescale: 1000, width: 320, height: 240 })
    expect(parseInit(moov(good))!.tracks).toHaveLength(1)

    // moov без trak вовсе
    expect(parseInit(moov())).toBeNull()
    // trak без stsd: кодек неизвестен, дорожка отбрасывается — остаётся пустой список
    const noCodec = trak({ trackId: 1, handler: 'vide', timescale: 1000, codec: null })
    expect(parseInit(moov(noCodec))).toBeNull()
    // дорожка с чужим handler'ом: ни видео, ни звук — тоже не в счёт
    const noKind = trak({ trackId: 1, handler: 'text', timescale: 1000 })
    expect(parseInit(moov(noKind))).toBeNull()
  })
})
