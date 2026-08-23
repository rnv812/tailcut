import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SessionStore } from '../../src/bridge/session-store'
import { sessionKey } from '../../src/core/session-key'

const init = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const seg1 = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))
const seg2 = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00002.m4s'))
/** Звук того же потока: свой init со своим кодеком (mp4a) и своим timescale. */
const audioInit = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream1.m4s'))
/** Тот же ролик в другом кодеке: так выглядит смена представления при смене качества. */
const vp9Init = new Uint8Array(readFileSync('tests/fixtures/vp9/init-stream0.m4s'))
const vp9Seg = new Uint8Array(readFileSync('tests/fixtures/vp9/chunk-stream0-00001.m4s'))

const page = { sourceId: 's1', url: 'https://site.example/watch?v=abc', title: 'Clip', now: 1000 }

// --- Сборка синтетических сегментов ---
// Фикстуры ffmpeg однодорожечные, поэтому выбор дорожки под фрагмент (и запасной путь,
// когда trackId ни с чем не сошёлся) приходится собирать вручную. Муксованный fMP4 —
// одна дорожка видео и одна звука в общем init'е — раскладка вполне обычная.

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

const chars = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))
const zeros = (count: number): number[] => new Array<number>(count).fill(0)

/** Бокс: четыре байта размера, четыре байта типа, тело. */
function box(type: string, ...parts: number[][]): number[] {
  const body = parts.flat()
  return [...u32(8 + body.length), ...chars(type), ...body]
}

/** trak с полями ровно на тех смещениях, где их читает parseInit. */
function trak(trackId: number, timescale: number, handler: string, codec: string): number[] {
  return box(
    'trak',
    // tkhd v0: version+flags, времена, track_id, хвост до matrix, matrix, width, height
    box('tkhd', zeros(12), u32(trackId), zeros(24), zeros(36), u32(320 * 65536), u32(240 * 65536)),
    box(
      'mdia',
      // mdhd v0: version+flags, времена, timescale, duration+language+pre_defined
      box('mdhd', zeros(12), u32(timescale), zeros(8)),
      // hdlr: version+flags, pre_defined, handler_type, reserved
      box('hdlr', zeros(8), chars(handler), zeros(12)),
      // stsd: version+flags, entry_count, sample entry — его тип и есть кодек
      box('minf', box('stbl', box('stsd', zeros(4), u32(1), box(codec, zeros(8))))),
    ),
  )
}

/** Муксованный init: видео с одним timescale, звук с другим. */
const muxedInit = new Uint8Array(
  box('moov', ...[trak(1, 1000, 'vide', 'avc1'), trak(2, 8000, 'soun', 'mp4a')]),
)

/** moof, у которого длительность лежит в tfhd: trun отдаёт только число сэмплов. */
function moof(trackId: number, baseTime: number, samples: number, sampleDuration: number) {
  return new Uint8Array(
    box(
      'moof',
      box(
        'traf',
        // tfhd с флагом default_sample_duration (0x08)
        box('tfhd', u32(0x08), u32(trackId), u32(sampleDuration)),
        box('tfdt', u32(0), u32(baseTime)),
        box('trun', u32(0), u32(samples)),
      ),
    ),
  )
}

describe('SessionStore', () => {
  it('создаёт сессию по init-сегменту', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.info.tracks[0]!.codec).toBe('avc1')
  })

  it('укладывает фрагменты в карту по времени медиа', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })
    store.append({ ...page, bytes: seg2 })

    const session = store.list()[0]!
    expect(session.map.runs()).toHaveLength(1)
    expect(session.map.duration()).toBeGreaterThan(3)
  })

  it('фрагмент без init игнорируется, а не роняет разбор', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: seg1 })
    expect(store.list()).toHaveLength(0)
  })

  it('перезагрузка страницы сливается в ту же сессию', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    // новый источник, тот же адрес с меткой времени
    store.append({ ...page, sourceId: 's2', url: page.url + '&t=30', bytes: init, now: 2000 })
    store.append({ ...page, sourceId: 's2', bytes: seg2, now: 2000 })

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.map.runs()[0]!.chunks).toHaveLength(2)
  })

  it('другое видео заводит отдельную сессию', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({
      ...page,
      sourceId: 's2',
      url: 'https://site.example/watch?v=other',
      bytes: init,
    })

    expect(store.list()).toHaveLength(2)
  })

  it('list отдаёт свежие первыми', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init, now: 1000 })
    store.append({
      ...page,
      sourceId: 's2',
      url: 'https://site.example/watch?v=b',
      bytes: init,
      now: 5000,
    })

    expect(store.list()[0]!.url).toContain('v=b')
  })
})

describe('SessionStore: что попадает в сессию', () => {
  it('запоминает init-сегмент целиком: без него собрать файл нечем', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    expect(store.list()[0]!.initBytes).toEqual(init)
  })

  it('сам init в карту не ложится', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // Init — заголовок дорожки, а не участок времени: попав в карту, он занял бы место
    // и уехал бы в файл вторым экземпляром.
    expect(store.list()[0]!.map.runs()).toEqual([])
    expect(store.list()[0]!.map.totalBytes()).toBe(0)
  })

  it('переносит адрес и заголовок страницы в сессию', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // Попап показывает сессии этими двумя строками, и берутся они у той страницы,
    // которая прислала байты.
    expect(store.list()[0]).toMatchObject({ url: page.url, title: 'Clip' })
  })

  it('кладёт в карту сами байты фрагмента и его времена в секундах', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })
    store.append({ ...page, bytes: seg2 })

    // Фикстура: timescale 12288, по 24576 тактов на фрагмент — ровно две секунды каждый.
    // Точные времена, а не «больше нуля»: разделить на timescale забыли бы незаметно.
    expect(store.list()[0]!.map.runs()).toEqual([
      {
        start: 0,
        end: 4,
        chunks: [
          { start: 0, end: 2, bytes: seg1 },
          { start: 2, end: 4, bytes: seg2 },
        ],
      },
    ])
  })

  it('ключ сессии — тот же, что считает sessionKey', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // Длительность на этом этапе неизвестна, поэтому в ключе стоит «эфир»: сессия
    // склеивается по адресу и кодекам.
    const expected = sessionKey({ url: page.url, codecs: ['avc1'], durationSeconds: Infinity })
    expect(store.list()[0]!.key).toBe(expected)
    expect(store.get(expected)).toBe(store.list()[0])
  })

  it('get не выдумывает сессию по неизвестному ключу', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    expect(store.get('нет такого ключа')).toBeUndefined()
  })

  it('другой кодек на том же адресе — отдельная сессия', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, sourceId: 's2', bytes: audioInit })

    // Ключ считается по адресу и кодекам: звук и видео одного адреса — разный материал,
    // и в одну карту их складывать нечем.
    expect(store.list()).toHaveLength(2)
    expect(store.list().map((s) => s.info.tracks[0]!.codec).sort()).toEqual(['avc1', 'mp4a'])
  })
})

describe('SessionStore: чужие и битые данные', () => {
  it('фрагмент неизвестного источника никуда не ложится', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // Источник, чей init не приходил: на странице второй плеер, а его начало мы пропустили.
    // Свалить его сегменты в единственную открытую сессию значило бы перемешать два потока.
    store.append({ ...page, sourceId: 's2', bytes: seg1 })

    expect(store.list()[0]!.map.runs()).toEqual([])
  })

  const junk: [string, Uint8Array][] = [
    ['пустой буфер', new Uint8Array(0)],
    ['обрывок заголовка', new Uint8Array([0, 0, 0, 4])],
    ['текст вместо боксов', new Uint8Array(chars('<!doctype html><title>404'))],
    ['бокс, обещающий больше, чем прислали', new Uint8Array([...u32(4096), ...chars('moov')])],
  ]

  it.each(junk)('%s не роняет разбор и не заводит сессию', (_name, bytes) => {
    const store = new SessionStore()

    // Байты приходят с произвольного сайта: разбор обязан молча отбросить непонятное.
    expect(() => store.append({ ...page, bytes })).not.toThrow()
    expect(store.list()).toEqual([])
  })

  it('мусор не портит уже открытую сессию', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })
    store.append({ ...page, bytes: new Uint8Array([...u32(12), ...chars('free'), 0, 0, 0, 0]) })
    store.append({ ...page, bytes: seg2 })

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.map.runs()[0]!.chunks).toHaveLength(2)
  })
})

describe('SessionStore: выбор дорожки под фрагмент', () => {
  const muxedPage = { ...page, url: 'https://site.example/watch?v=muxed' }

  it('времена считаются по timescale своей дорожки, а не первой попавшейся', () => {
    const store = new SessionStore()
    store.append({ ...muxedPage, bytes: muxedInit })
    // Звуковая дорожка: trackId 2, timescale 8000. По видеодорожке (timescale 1000)
    // тот же фрагмент уехал бы на 16-ю секунду вместо второй.
    store.append({ ...muxedPage, bytes: moof(2, 16_000, 2, 4_000) })

    expect(store.list()[0]!.map.runs()).toEqual([
      { start: 2, end: 3, chunks: [{ start: 2, end: 3, bytes: expect.any(Uint8Array) }] },
    ])
  })

  it('фрагмент с незнакомым trackId укладывается по первой дорожке, а не выбрасывается', () => {
    const store = new SessionStore()
    store.append({ ...muxedPage, bytes: muxedInit })
    // Часть упаковщиков нумерует дорожки в moof по-своему. Выбросить такой фрагмент
    // значило бы потерять весь поток; первая дорожка — разумное приближение.
    store.append({ ...muxedPage, bytes: moof(7, 3_000, 1, 1_000) })

    expect(store.list()[0]!.map.span()).toEqual({ start: 3, end: 4 })
  })
})

describe('SessionStore: время жизни сессии', () => {
  it('свежий фрагмент поднимает сессию в списке', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init, now: 1000 })
    store.append({
      ...page,
      sourceId: 's2',
      url: 'https://site.example/watch?v=b',
      bytes: init,
      now: 2000,
    })
    store.append({ ...page, bytes: seg1, now: 3000 })

    // Порядок в попапе — по последнему пришедшему байту, а не по рождению сессии:
    // смотрят сейчас первую, хотя завели её раньше.
    expect(store.list()[0]!.url).toContain('v=abc')
  })

  it('новый init того же источника уводит следующие сегменты в новую сессию', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    // Смена качества: плеер дописывает новый init в тот же SourceBuffer, и всё, что идёт
    // после, принадлежит уже новому представлению. Оставь источник привязанным к первой
    // сессии — материал двух разных кодеков смешался бы в одной карте.
    store.append({ ...page, bytes: vp9Init })
    store.append({ ...page, bytes: vp9Seg })

    const chunksByCodec = Object.fromEntries(
      store.list().map((s) => [s.info.tracks[0]!.codec, s.map.runs().flatMap((r) => r.chunks)]),
    )
    expect(chunksByCodec).toEqual({ avc1: [expect.anything()], vp09: [expect.anything()] })
  })

  it('слияние не переписывает время рождения сессии', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init, now: 1000 })
    store.append({ ...page, sourceId: 's2', url: page.url + '&t=30', bytes: init, now: 5000 })

    expect(store.list()[0]).toMatchObject({ createdAt: 1000, lastSeenAt: 5000 })
  })

  it('evictAll подрезает карты всех сессий, а не только первой', () => {
    const store = new SessionStore()
    const second = { ...page, sourceId: 's2', url: 'https://site.example/watch?v=b' }

    for (const source of [page, second]) {
      store.append({ ...source, bytes: init })
      store.append({ ...source, bytes: seg1 })
      store.append({ ...source, bytes: seg2 })
    }

    // Окно в секунду вокруг четвёртой: первый фрагмент (0–2) за границей, второй (2–4) нет.
    store.evictAll(1, 4)

    expect(store.list().map((s) => s.map.span())).toEqual([
      { start: 2, end: 4 },
      { start: 2, end: 4 },
    ])
  })
})
