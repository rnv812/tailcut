import { describe, it, expect, afterEach, vi } from 'vitest'

const MIME = 'video/mp4; codecs="avc1.4d401e"'
/** Звуковая дорожка: у любого DASH/HLS-потока она живёт своим SourceBuffer на том же MediaSource. */
const AUDIO_MIME = 'audio/mp4; codecs="mp4a.40.2"'

/** FNV-1a, 32 бита: сравниваем содержимое, а не длину — кусок памяти той же длины не пройдёт. */
function digest(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return `${bytes.byteLength}:${hash}`
}

/** Узнаваемый узор вместо настоящего сегмента: разбором здесь никто не занимается. */
function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index++) bytes[index] = (index * 31 + 7) & 0xff
  return bytes
}

function segment(length: number): ArrayBuffer {
  const buffer = new ArrayBuffer(length)
  new Uint8Array(buffer).set(pattern(length))
  return buffer
}

/** Снимок данных в момент вызова: после отсоединения буфера прочитать их уже не выйдет. */
function snapshot(data: BufferSource): { byteLength: number; digest: string } {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
    : new Uint8Array(data).slice()
  return { byteLength: bytes.byteLength, digest: digest(bytes) }
}

type Posted = {
  /** Сообщение в том виде, в каком его получил бы адресат. */
  message: Record<string, unknown>
  /** Сколько объектов ушло списком передачи. */
  transferred: number
  /** Был ли в списке передачи сам буфер сегмента: без него на каждый сегмент ложится копия. */
  transfersBytes: boolean
}

/** Что откатить после теста помимо подменённых глобалей. */
const cleanups: Array<() => void> = []

/**
 * Поддельный реалм страницы: окно, URL, MediaSource, SourceBuffer и navigator. Хук правит
 * прототипы на верхнем уровне модуля, поэтому классы заводятся заново на каждую установку —
 * иначе следующий импорт обернул бы уже обёрнутое.
 *
 * `eme: false` — страница без EME: на http Chrome не отдаёт navigator.requestMediaKeySystemAccess.
 */
function installPage(options: { eme?: boolean } = {}) {
  const posted: Posted[] = []
  const emeCalls: Array<{ keySystem: string; configs: unknown; thisArg: unknown }> = []

  class FakeSourceBuffer {
    readonly appended: Array<{ byteLength: number; digest: string }> = []
    /**
     * Чем браузер ответит на дописку вместо неё самой. Исключения из appendBuffer — штатная
     * работа MSE: QuotaExceededError на полном буфере, InvalidStateError на дописке во время
     * update. Настоящий appendBuffer бросает до того, как что-либо примет.
     */
    failWith: unknown = null
    constructor(readonly mime: string) {}
    appendBuffer(data: BufferSource): void {
      if (this.failWith !== null) throw this.failWith
      this.appended.push(snapshot(data))
    }
  }

  class FakeMediaSource {
    readonly buffers: FakeSourceBuffer[] = []
    addSourceBuffer(mime: string): FakeSourceBuffer {
      const sourceBuffer = new FakeSourceBuffer(mime)
      this.buffers.push(sourceBuffer)
      return sourceBuffer
    }
  }

  let urlCounter = 0

  vi.stubGlobal('window', {
    postMessage(message: unknown, _targetOrigin: string, transfer: Transferable[] = []): void {
      const bytes = (message as { bytes?: unknown }).bytes
      posted.push({
        transferred: transfer.length,
        transfersBytes: transfer.length === 1 && transfer[0] === bytes,
        // Настоящая семантика передачи: перечисленные буферы у отправителя отсоединяются.
        message: structuredClone(message, { transfer }) as Record<string, unknown>,
      })
    },
  })

  // URL целиком подменять нельзя: он нужен самому окружению как конструктор. Меняется только
  // createObjectURL — то, что оборачивает хук; пришедший до подмены вид восстанавливается после.
  const pristine = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (): string => `blob:https://site.example/${++urlCounter}`,
  })
  cleanups.push(() => {
    if (pristine) Object.defineProperty(URL, 'createObjectURL', pristine)
    else delete (URL as { createObjectURL?: unknown }).createObjectURL
  })

  vi.stubGlobal('MediaSource', FakeMediaSource)
  vi.stubGlobal('SourceBuffer', FakeSourceBuffer)

  const navigatorStub: Record<string, unknown> = { userAgent: 'test' }
  if (options.eme !== false) {
    navigatorStub.requestMediaKeySystemAccess = function (
      this: unknown,
      keySystem: string,
      configs: unknown,
    ) {
      emeCalls.push({ keySystem, configs, thisArg: this })
      return Promise.resolve({ keySystem })
    }
  }
  vi.stubGlobal('navigator', navigatorStub)

  return {
    posted,
    emeCalls,
    MediaSource: FakeMediaSource,
    SourceBuffer: FakeSourceBuffer,
    /** Сообщения одного типа в порядке отправки. */
    of: (type: string): Posted[] => posted.filter((item) => item.message.type === type),
  }
}

/** Импорт сам ставит обёртки: в модуле только код верхнего уровня. */
async function importHook(): Promise<void> {
  vi.resetModules()
  await import('../../src/page/main-hook')
}

/** Хук отправляет из микрозадачи; даём очереди разобраться. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Ловит то, что обёртка бросила из микрозадачи: туда вызывающий не заглядывает, и без ловушки
 * такая поломка выглядела бы просто ошибкой в консоли страницы.
 */
async function trapAsyncErrors(body: () => Promise<void>): Promise<unknown[]> {
  const errors: unknown[] = []
  const trap = (error: unknown): void => {
    errors.push(error)
  }
  process.on('uncaughtException', trap)
  try {
    await body()
  } finally {
    process.off('uncaughtException', trap)
  }
  return errors
}

/** Заводит источник как плеер: адрес из createObjectURL уходит в video.src. */
function openSource(page: ReturnType<typeof installPage>) {
  const mediaSource = new page.MediaSource()
  const objectUrl = URL.createObjectURL(mediaSource as unknown as MediaSource)
  return { mediaSource, objectUrl, sourceBuffer: mediaSource.addSourceBuffer(MIME) }
}

/** Идентификаторы, с которыми сообщение ушло наружу: ими мост различает потоки и дорожки. */
const labelsOf = (item: Posted) => ({
  sourceId: String(item.message.sourceId),
  bufferId: String(item.message.bufferId),
  mime: String(item.message.mime),
})

afterEach(() => {
  vi.unstubAllGlobals()
  while (cleanups.length) cleanups.pop()!()
})

describe('копия сегмента', () => {
  it('не отсоединяет буфер страницы: голый ArrayBuffer дописывается повторно', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    // Плееры дописывают именно голый ArrayBuffer (`(await fetch(url)).arrayBuffer()`), и тот же
    // буфер идёт в дело второй раз, когда кеш сегментов дописывает его после перемотки. Отдай
    // обёртка наружу сам буфер страницы, передача мосту отсоединила бы его: повторный
    // appendBuffer штатно резолвит updateend, не дописав ничего, и плеер молча встаёт.
    const buffer = segment(829)
    const expected = digest(new Uint8Array(buffer))

    sourceBuffer.appendBuffer(buffer)
    await flush()

    expect(buffer.byteLength, 'буфер страницы отсоединён отправкой мосту').toBe(829)

    sourceBuffer.appendBuffer(buffer)
    await flush()

    // Оба раза плеер получил свои байты целиком, и оба раза мост получил их копию.
    expect(sourceBuffer.appended).toEqual([
      { byteLength: 829, digest: expected },
      { byteLength: 829, digest: expected },
    ])
    expect(
      page.of('tc:append').map((item) => digest(new Uint8Array(item.message.bytes as ArrayBuffer))),
    ).toEqual([expected, expected])
  })

  it('снимается по окну вида, а не по всему буферу под ним', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    const padded = new Uint8Array(64 + 11)
    padded.set(pattern(64), 7)
    const view = new Uint8Array(padded.buffer, 7, 64)
    const expected = digest(pattern(64))

    sourceBuffer.appendBuffer(view)
    // MSE копирует данные синхронно, и плеер вправе сразу пустить свой буфер в переработку.
    // Отложи обёртка копирование до микрозадачи — до моста доехал бы мусор.
    padded.fill(0xff)
    await flush()

    expect(
      page.of('tc:append').map((item) => digest(new Uint8Array(item.message.bytes as ArrayBuffer))),
    ).toEqual([expected])
    expect(padded.byteLength, 'буфер под видом отсоединён отправкой мосту').toBe(75)
  })

  it('снимается из DataView: appendBuffer принимает любой ArrayBufferView', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    // appendBuffer по спецификации принимает BufferSource, то есть любой ArrayBufferView, а не
    // только Uint8Array. DataView — самый опасный из них: свойства length у него нет вовсе,
    // и копирование через `.set(data)` перенесло бы ноль байтов. Мост получил бы буфер нужной
    // длины из одних нулей — молча, без единой ошибки, и разбор боксов увидел бы пустоту.
    const padded = new Uint8Array(64 + 11)
    padded.set(pattern(64), 7)
    const view = new DataView(padded.buffer, 7, 64)
    const expected = digest(pattern(64))

    sourceBuffer.appendBuffer(view)
    await flush()

    expect(
      page.of('tc:append').map((item) => digest(new Uint8Array(item.message.bytes as ArrayBuffer))),
    ).toEqual([expected])
  })

  it('снимается из типизированного массива шире байта побайтово, а не поэлементно', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    // Int16Array — тот же законный BufferSource. Здесь ошибочное `.set(data)` не промолчит,
    // а исказит: Uint8Array.set копирует элементы источника, то есть 16-битные значения
    // усечёт до байта и заполнит только половину копии. Сегмент нужен побайтово — как он
    // лежит в памяти, а не как его разметил вызывающий.
    const bytes = pattern(64)
    const holder = new Uint8Array(8 + 64)
    holder.set(bytes, 8)
    // Смещение кратно размеру элемента: иначе конструктор Int16Array бросит RangeError.
    const view = new Int16Array(holder.buffer, 8, 32)
    const expected = digest(bytes)

    sourceBuffer.appendBuffer(view)
    await flush()

    expect(view.byteLength, 'подготовка: вид должен покрывать все 64 байта').toBe(64)
    expect(
      page.of('tc:append').map((item) => digest(new Uint8Array(item.message.bytes as ArrayBuffer))),
    ).toEqual([expected])
  })

  it('уходит мосту списком передачи, а не копией', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    sourceBuffer.appendBuffer(segment(128))
    await flush()

    // Копия на этом участке стоила бы лишнего прохода по каждому сегменту.
    const append = page.of('tc:append')
    expect(append).toHaveLength(1)
    expect({
      transferred: append[0]!.transferred,
      transfersBytes: append[0]!.transfersBytes,
    }).toEqual({ transferred: 1, transfersBytes: true })
  })
})

describe('чужой SourceBuffer', () => {
  it('проходит насквозь, не роняя обёртку', async () => {
    const page = installPage()
    await importHook()

    // Так выглядит вызов из другого реалма: объект есть, а записи о нём в этом реалме нет —
    // например, SourceBuffer из кадра about:blank, куда хук не попал.
    const foreign = new page.SourceBuffer(MIME)
    const buffer = segment(32)

    const errors = await trapAsyncErrors(async () => {
      foreign.appendBuffer(buffer)
      await flush()
    })

    expect(errors, 'обёртка бросила на SourceBuffer без записи').toEqual([])
    expect(page.posted, 'о чужом буфере отправлять нечего: ни источника, ни дорожки').toEqual([])
    expect(foreign.appended).toEqual([snapshot(buffer)])
  })
})

describe('EME', () => {
  const config = { initDataTypes: ['keyids'], videoCapabilities: [{ contentType: MIME }] }

  it('не трогает запрос ключевой системы вовсе', async () => {
    const page = installPage()
    const original = navigator.requestMediaKeySystemAccess
    await importHook()

    const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [
      config as MediaKeySystemConfiguration,
    ])

    // Раньше хук оборачивал этот метод, и любое обращение к нему — включая отклонённый зонд
    // возможностей — снимало запись со всей страницы. На статье edition.cnn.com таких зондов
    // было шестнадцать на полутора секундах, поток при этом шёл без единого бокса шифрования, и
    // настоящее видео 367x648, которое смотрели сорок секунд, терялось целиком.
    //
    // Обращение к EME — это намерение, а не материал. Защиту расширение читает в самих байтах
    // (src/core/container.ts) и слышит от элемента событием `encrypted`; спрашивать браузера
    // страница вольна сколько угодно.
    expect(
      navigator.requestMediaKeySystemAccess,
      'хук всё ещё подменяет метод страницы',
    ).toBe(original)
    expect(page.posted, 'о запросе ключевой системы отправлять нечего').toEqual([])
    expect(page.emeCalls).toEqual([
      { keySystem: 'org.w3.clearkey', configs: [config], thisArg: navigator },
    ])
    expect(access.keySystem).toBe('org.w3.clearkey')
  })

  it('на странице без EME не подсовывает метод, которого у браузера нет', async () => {
    const page = installPage({ eme: false })
    await importHook()

    // Расширение объявлено на <all_urls>, а на http-странице Chrome не отдаёт этот метод.
    // Плееры (shaka, dash.js, hls.js) сперва проверяют наличие, потом зовут: подсунутая обёртка
    // выдумала бы возможность, которой у браузера нет, и вызов упал бы уже внутри неё.
    expect(
      typeof navigator.requestMediaKeySystemAccess,
      'хук объявил EME там, где браузер его не даёт',
    ).toBe('undefined')
    expect(page.posted).toEqual([])
  })
})

describe('идентификаторы', () => {
  it('видео и звук одного MediaSource различаются bufferId', async () => {
    const page = installPage()
    await importHook()

    // Ровно то, что делает любой DASH/HLS-плеер: один MediaSource, два SourceBuffer — дорожка
    // видео и дорожка звука. bufferId существует ровно затем, чтобы мост их различал: с общим
    // значением обе дорожки уезжают мосту как одна и склеиваются в кашу.
    const { mediaSource, sourceBuffer: video } = openSource(page)
    const audio = mediaSource.addSourceBuffer(AUDIO_MIME)

    video.appendBuffer(segment(64))
    audio.appendBuffer(segment(48))
    video.appendBuffer(segment(96))
    await flush()

    const seen = page.of('tc:append').map(labelsOf)
    expect(seen.map((item) => item.mime)).toEqual([MIME, AUDIO_MIME, MIME])
    expect(
      new Set(seen.map((item) => item.sourceId)).size,
      'дорожки одного MediaSource — один источник',
    ).toBe(1)
    expect(seen[2]!.bufferId, 'сегменты одной дорожки разъехались по bufferId').toBe(
      seen[0]!.bufferId,
    )
    expect(
      seen[1]!.bufferId,
      'звук уехал под тем же bufferId, что видео: различать дорожки на мосту нечем',
    ).not.toBe(seen[0]!.bufferId)
  })

  it('два MediaSource страницы различаются sourceId', async () => {
    const page = installPage()
    await importHook()

    // Второй MediaSource на странице — штатное дело: плеер пересоздаёт его при смене качества
    // и при перезапуске, да и двух <video> на странице никто не запрещал.
    const first = openSource(page)
    const second = openSource(page)

    first.sourceBuffer.appendBuffer(segment(64))
    second.sourceBuffer.appendBuffer(segment(48))
    await flush()

    const sources = page.of('tc:source').map((item) => ({
      sourceId: String(item.message.sourceId),
      objectUrl: String(item.message.objectUrl),
    }))
    expect(
      sources.map((item) => item.objectUrl),
      'подготовка: у источников должны быть разные адреса',
    ).toEqual([first.objectUrl, second.objectUrl])
    expect(
      sources[1]!.sourceId,
      'два независимых потока уехали под одним sourceId: мост сольёт их в один',
    ).not.toBe(sources[0]!.sourceId)

    const seen = page.of('tc:append').map(labelsOf)
    expect(seen.map((item) => item.sourceId)).toEqual([
      sources[0]!.sourceId,
      sources[1]!.sourceId,
    ])
    expect(seen[1]!.bufferId, 'дорожки разных источников уехали под одним bufferId').not.toBe(
      seen[0]!.bufferId,
    )
  })
})

describe('прозрачность appendBuffer', () => {
  it('исключение от браузера доходит до плеера, а не съедается обёрткой', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    // QuotaExceededError — обычная работа MSE, а не экзотика: именно по нему плеер чистит
    // buffered-диапазоны и дописывает сегмент заново. Съеденное обёрткой исключение оставляет
    // его без сигнала — он не эвиктит и молча встаёт.
    const quota = new DOMException('buffer full', 'QuotaExceededError')
    sourceBuffer.failWith = quota

    let thrown: unknown = '(обёртка ничего не бросила)'
    try {
      sourceBuffer.appendBuffer(segment(64))
    } catch (error) {
      thrown = error
    }
    await flush()

    expect(thrown, 'обёртка съела исключение appendBuffer').toBe(quota)
  })
})

describe('синхронный путь плеера', () => {
  it('отправка уходит в микрозадачу, а не в вызов appendBuffer', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    sourceBuffer.appendBuffer(segment(256))

    // Structured clone и отсоединение буфера — не работа синхронного пути: позови обёртка send
    // прямо здесь, они легли бы в вызов плеера на каждый сегмент.
    expect(page.of('tc:append'), 'обёртка отправила сообщение прямо в вызове плеера').toEqual([])
    expect(sourceBuffer.appended, 'подготовка: плеер получает свои байты сразу').toHaveLength(1)

    // Микрозадача, а не таймер: очередь разбирается до возврата в цикл событий, и мост получает
    // сегмент в том же тике.
    await Promise.resolve()
    await Promise.resolve()

    expect(page.of('tc:append'), 'отправка отложена дальше микрозадачи').toHaveLength(1)
  })
})
