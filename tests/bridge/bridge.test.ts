import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { sessionKey } from '../../src/core/session-key'
import type { BridgeToPage, SessionSummary } from '../../src/shared/protocol'

const initBytes = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const seg1Bytes = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))
const seg2Bytes = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00002.m4s'))
/** Фрагмент через один после первого: вместе они дают буфер с разрывом посередине. */
const seg3Bytes = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00003.m4s'))

/**
 * Звуковая дорожка той же фикстуры. Она нужна там, где прогоны должны получиться разной
 * длины: у видеофрагментов длительность одинаковая, и прогон из одного такого фрагмента
 * от прогона из другого не отличить.
 */
const audioInitBytes = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream1.m4s'))
/** Куски звука: 0…1.95, 1.95…3.95, 3.95…5.97, 5.97…6.02 секунды. */
const audioBytes = [1, 2, 3, 4].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/h264/chunk-stream1-0000${n}.m4s`)),
)

/** Слепок байтов: сравнение целых буферов, не заваливающее вывод при расхождении. */
function digest(...parts: Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

/** Байты уходят мосту передачей, то есть отдельным ArrayBuffer, а не видом на фикстуру. */
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer

/** Адрес и заголовок страницы, которая вставила мост. */
const PAGE_URL = 'https://site.example/watch?v=abc'
const PAGE_TITLE = 'Clip — site.example'
const REFERRER = 'https://referrer.example/from'

/**
 * Ключ, под которым реестр держит сессию этой страницы. Адресом он не является никогда:
 * normalizeUrl срезает метки перехода, а к остатку приписываются кодеки и длительность.
 */
const keyFor = (url: string, codecs: string[] = ['avc1']): string =>
  sessionKey({ url, codecs, durationSeconds: Infinity })

/**
 * Второй аргумент postMessage как есть: и строка targetOrigin, и объект опций — законные его
 * формы. Разбирает их targetOriginOf, а храним нетронутым, чтобы форма аргумента не диктовала
 * реализацию.
 */
type Post = { message: unknown; to: unknown }

/** Заказ на скачивание в том виде, в каком мост передаёт его Chrome. */
type Download = { url: string; filename: string }

/** Окно-получатель: мост шлёт ему сообщения, тест смотрит, что именно дошло. */
function receiver() {
  const posts: Post[] = []
  return {
    posts,
    postMessage(message: unknown, to: unknown) {
      posts.push({ message, to })
    },
  }
}

/** Порт из MessageChannel: этим каналом мост отвечает на запрос списка сессий. */
function port() {
  const received: unknown[] = []
  return {
    received,
    postMessage(message: unknown) {
      received.push(message)
    },
  }
}

type Receiver = ReturnType<typeof receiver>
type MessageListener = (event: MessageEvent) => void

/**
 * Что мост отдаёт в ответ на tc:list. Тип берётся из протокола, а не переписывается здесь:
 * иначе набор проверял бы мост против собственного представления о нём, а не против
 * объявленного протокола, и расхождение между ними осталось бы незамеченным.
 */
type Summary = SessionSummary

/** Признак сводки сессии по факту: у postMessage типов нет, проверять приходится значение. */
function isSummary(value: unknown): value is SessionSummary {
  if (typeof value !== 'object' || value === null) return false
  const summary = value as Record<string, unknown>
  return (
    Object.keys(summary).length === 6 &&
    typeof summary.key === 'string' &&
    typeof summary.url === 'string' &&
    typeof summary.title === 'string' &&
    typeof summary.duration === 'number' &&
    typeof summary.bytes === 'number' &&
    typeof summary.runs === 'number'
  )
}

/** Вариант союза BridgeToPage, под который подходит значение; null — не подходит ни под один. */
function variantOf(value: unknown): 'tc:ready' | 'сводки сессий' | null {
  if (Array.isArray(value)) return value.every(isSummary) ? 'сводки сессий' : null
  if (typeof value === 'object' && value !== null) {
    const fields = value as Record<string, unknown>
    if (fields.type === 'tc:ready' && Object.keys(fields).length === 1) return 'tc:ready'
  }
  return null
}

/**
 * Адрес получателя из второго аргумента postMessage: окно принимает и строку targetOrigin,
 * и объект опций с тем же полем. Формы равнозначны, поэтому сверяется извлечённый адрес,
 * а не то, какой из них воспользовался мост.
 */
function targetOriginOf(to: unknown): unknown {
  if (typeof to === 'object' && to !== null) return (to as { targetOrigin?: unknown }).targetOrigin
  return to
}

/**
 * Подменяет окно, в котором живёт мост: слушателя он вешает на window, рукопожатие шлёт
 * window.parent. Родитель, верхняя страница и отправитель здесь разные объекты: только так
 * видно, кому мост на самом деле ответил.
 *
 * Иерархия не выдумана: оба content-скрипта объявлены с all_frames, поэтому мост встаёт и во
 * вложенном фрейме, где window.parent (окно того самого фрейма) и window.top (верхняя
 * страница) — разные окна.
 */
function installWindow(referrer = REFERRER) {
  const listeners: MessageListener[] = []
  const parent = receiver()
  const top = receiver()

  vi.stubGlobal('window', {
    addEventListener(type: string, listener: MessageListener) {
      if (type === 'message') listeners.push(listener)
    },
    parent,
    top,
  })
  // Документ моста живёт на origin расширения; referrer — единственное, что он знает
  // о вставившей его странице до прихода tc:context.
  vi.stubGlobal('document', { referrer })

  /** Начатые скачивания в том виде, в каком мост их заказывает Chrome. */
  const downloads: Download[] = []
  /** Блобы, на которые мост выдал адреса, и снятые адреса — по одному на скачивание. */
  const blobs = new Map<string, Blob>()
  const revoked: string[] = []
  /** Идентификатор скачивания; undefined — Chrome отказал, как при запрете на запись. */
  let downloadId: number | undefined = 1

  // URL остаётся настоящим: его конструктор зовёт ключ сессии на каждом init-сегменте.
  // Дописаны только статические методы блобов, которых в Node нет.
  class TestURL extends URL {
    static createObjectURL(blob: Blob): string {
      const url = `blob:chrome-extension://tailcut/${blobs.size + 1}`
      blobs.set(url, blob)
      return url
    }

    static revokeObjectURL(url: string): void {
      revoked.push(url)
    }
  }
  vi.stubGlobal('URL', TestURL)

  const runtime: { lastError?: { message: string } } = {}
  vi.stubGlobal('chrome', {
    runtime,
    downloads: {
      download(options: Download, done: (id?: number) => void) {
        downloads.push(options)
        runtime.lastError = downloadId === undefined ? { message: 'Download failed' } : undefined
        done(downloadId)
      },
    },
  })

  const deliver = (
    data: unknown,
    options: { from?: Receiver; ports?: ReturnType<typeof port>[] } = {},
  ): Receiver => {
    const from = options.from ?? receiver()
    const event = { data, source: from, ports: options.ports ?? [] }
    for (const listener of listeners) listener(event as unknown as MessageEvent)
    return from
  }

  return {
    parent,
    top,
    deliver,
    /** Спрашивает у моста список сессий тем же способом, что попап: каналом сообщений. */
    list(): Summary[] {
      const reply = port()
      deliver({ type: 'tc:list' }, { ports: [reply] })
      expect(reply.received, 'мост не ответил на запрос списка сессий').toHaveLength(1)
      return reply.received[0] as Summary[]
    },
    /** Отдаёт мосту сегмент так, как его присылает content script. */
    append(bytes: Uint8Array, sourceId = 's1'): void {
      deliver({
        type: 'tc:append',
        sourceId,
        bufferId: 'b1',
        mime: 'video/mp4',
        bytes: buffer(bytes),
      })
    },
    /** Сообщает мосту, на какой странице он стоит. */
    context(url = PAGE_URL, title = PAGE_TITLE): void {
      deliver({ type: 'tc:context', url, title })
    },
    /** Просит мост собрать сессию в файл — так это делает попап через content script. */
    save(key: string): ReturnType<typeof port> {
      const reply = port()
      deliver({ type: 'tc:save', key }, { ports: [reply] })
      return reply
    },
    downloads,
    revoked,
    /** Байты файла, которые мост отдал Chrome на скачивание. */
    async savedBytes(index = 0): Promise<Uint8Array> {
      const started = downloads[index]
      expect(started, 'скачивание не начиналось').toBeDefined()
      const blob = blobs.get(started!.url)
      expect(blob, 'мост отдал Chrome адрес, за которым нет блоба').toBeDefined()
      return new Uint8Array(await blob!.arrayBuffer())
    },
    /** Тип блоба, который мост отдал Chrome. */
    savedType(index = 0): string | undefined {
      return blobs.get(downloads[index]?.url ?? '')?.type
    },
    /** Chrome отказывает в скачивании: запрет на запись, нет места, отмена пользователем. */
    failDownloads(): void {
      downloadId = undefined
    },
  }
}

/** Мост ставит слушателя и здоровается прямо при загрузке модуля. */
async function loadBridge(referrer?: string) {
  const win = installWindow(referrer)
  vi.resetModules()
  await import('../../src/bridge/bridge')
  return win
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('рукопожатие моста', () => {
  it('уходит родительскому окну сразу при загрузке', async () => {
    const win = await loadBridge()

    expect(win.parent.posts.map((p) => p.message)).toEqual([{ type: 'tc:ready' }])
  })

  it('уходит окну своего фрейма, а не верхней странице', async () => {
    const win = await loadBridge()

    // Мост живёт в каждом фрейме страницы, и для плеера, встроенного через iframe, окно
    // фрейма и верхняя страница — разные окна. Рукопожатие, ушедшее наверх, не доходит до
    // того, кто мост и вставил: этот фрейм о мосте так и не узнает.
    expect(win.top.posts, 'рукопожатие ушло верхней странице вместо своего фрейма').toEqual([])
    expect(win.parent.posts.map((p) => p.message)).toEqual([{ type: 'tc:ready' }])
  })

  it('адресовано любому origin: расширение работает на всех сайтах', async () => {
    const win = await loadBridge()

    // Прибитый адрес молча теряет рукопожатие на любой странице, кроме него самого,
    // а страница узнаёт о мосте только из этого сообщения.
    expect(
      targetOriginOf(win.parent.posts[0]?.to),
      'рукопожатие прибито к конкретному адресу',
    ).toBe('*')
  })
})

describe('мост складывает сегменты в реестр сессий', () => {
  it('на пустом реестре отдаёт пустой список', async () => {
    const win = await loadBridge()

    expect(win.list()).toEqual([])
  })

  it('init-сегмент заводит сессию под адресом и заголовком страницы', async () => {
    const win = await loadBridge()
    win.context()

    win.append(initBytes)

    expect(win.list()).toEqual([
      {
        key: keyFor(PAGE_URL),
        url: PAGE_URL,
        title: PAGE_TITLE,
        duration: 0,
        bytes: 0,
        runs: 0,
      },
    ])
  })

  it('медиафрагменты набирают длительность, объём и прогоны', async () => {
    const win = await loadBridge()
    win.context()

    win.append(initBytes)
    win.append(seg1Bytes)
    win.append(seg2Bytes)

    // Фикстура: по две секунды на фрагмент, оба подряд — один прогон на четыре секунды.
    expect(win.list()).toMatchObject([
      { duration: 4, bytes: seg1Bytes.byteLength + seg2Bytes.byteLength, runs: 1 },
    ])
  })

  it('разрыв в буфере виден в сводке: два прогона и длительность без провала', async () => {
    const win = await loadBridge()
    win.context()

    win.append(initBytes)
    win.append(seg1Bytes)
    // Второй фрагмент пропущен: пользователь перемотал вперёд, или вкладку придушили и плеер
    // продолжил догружать уже с новой позиции. Зазор в две секунды — разрыв, а не округление.
    win.append(seg3Bytes)

    // Сводкой попап рисует, что вообще можно вырезать. Один прогон здесь обещал бы
    // непрерывный кусок, которого нет; шесть секунд от начала до конца — материал,
    // которого нет тоже: между 2-й и 4-й секундой в реестре пусто.
    expect(win.list()).toEqual([
      {
        key: keyFor(PAGE_URL),
        url: PAGE_URL,
        title: PAGE_TITLE,
        duration: 4,
        bytes: seg1Bytes.byteLength + seg3Bytes.byteLength,
        runs: 2,
      },
    ])
  })

  it('ключ сессии в сводке — ключ реестра, а не адрес страницы', async () => {
    const win = await loadBridge()
    // Живой адрес почти всегда несёт метки перехода: ?t= с перемотки, utm_ из рассылки.
    const url = `${PAGE_URL}&t=42&utm_source=tg`
    win.context(url, PAGE_TITLE)

    win.append(initBytes)

    const summary = win.list()[0]!

    // key — ручка, которой попап запросит эту сессию у реестра. Адрес страницы ею не
    // является: метки перехода из ключа срезаны, а кодеки в него дописаны, так что
    // запрос по адресу не найдёт ничего и выгружать клип будет нечего.
    expect(summary.key).toBe(keyFor(PAGE_URL))
    expect(summary.url).toBe(url)
  })

  it('до прихода контекста сессия достаётся referrer’у, а не пустому адресу', async () => {
    const win = await loadBridge()

    // Content script присылает контекст сразу после загрузки моста, но сегменты хука идут тем
    // же путём: если он когда-нибудь обгонит контекст, сессия должна остаться узнаваемой.
    win.append(initBytes)

    expect(win.list()).toMatchObject([{ url: REFERRER, title: '' }])
  })

  it('нестроковый контекст приводится к строкам, а не уезжает в сводку как есть', async () => {
    const win = await loadBridge()

    // tc:context мост принимает от кого угодно на странице: адресоваться ему может любой
    // скрипт, а не только наш content script. Полей никто не проверял, поэтому в сводку
    // сессии — то, чем попап её и подписывает — могло бы уехать что угодно вплоть до
    // объекта, который отрисуется в списке как «[object Object]».
    win.deliver({ type: 'tc:context', url: { href: PAGE_URL }, title: 42 })
    win.append(initBytes)

    expect(win.list()).toMatchObject([{ url: '[object Object]', title: '42' }])
  })

  it('сегменты разных источников не сливаются в одну сессию', async () => {
    const win = await loadBridge()
    win.context()

    win.append(initBytes, 's1')
    win.context('https://site.example/watch?v=second', 'Second')
    win.append(initBytes, 's2')
    // Первый плеер продолжает играть: его фрагмент обязан лечь в свою сессию.
    win.append(seg1Bytes, 's1')

    expect(win.list().map((s) => [s.url, s.runs])).toEqual(
      expect.arrayContaining([
        [PAGE_URL, 1],
        ['https://site.example/watch?v=second', 0],
      ]),
    )
  })

  it('свежая сессия идёт в списке первой', async () => {
    vi.useFakeTimers()
    const win = await loadBridge()

    vi.setSystemTime(new Date('2026-08-22T10:00:00Z'))
    win.context(PAGE_URL, 'Первое')
    win.append(initBytes, 's1')

    vi.setSystemTime(new Date('2026-08-22T10:05:00Z'))
    win.context('https://site.example/watch?v=later', 'Второе')
    win.append(initBytes, 's2')

    // Время сессии — часы моста: без него порядок в попапе выродится в порядок вставки.
    expect(win.list().map((s) => s.title)).toEqual(['Второе', 'Первое'])
  })
})

describe('мост и чужие сообщения', () => {
  const foreign: [string, unknown][] = [
    ['tc:source', { type: 'tc:source', sourceId: 's', objectUrl: 'blob:x' }],
    ['tc:drm', { type: 'tc:drm', sourceId: 's' }],
    ['чужой type', { type: 'webpackHotUpdate' }],
    ['null', null],
    ['строку', 'tc:append'],
    ['число', 42],
  ]

  it.each(foreign)('не отвечает на %s и не заводит сессию', async (_name, data) => {
    const win = await loadBridge()
    win.context()

    const sender = win.deliver(data)

    expect(sender.posts, 'мост ответил на сообщение не своего типа').toEqual([])
    expect(win.list()).toEqual([])
  })

  const junk: [string, Uint8Array][] = [
    ['пустой буфер', new Uint8Array(0)],
    ['страницу с ошибкой вместо сегмента', new Uint8Array([60, 33, 100, 111, 99])],
  ]

  it.each(junk)('%s в tc:append не роняет мост', async (_name, bytes) => {
    const win = await loadBridge()
    win.context()

    // Байты приходят с произвольного сайта, а исключение здесь остановило бы приём
    // всего последующего: слушатель у моста один.
    expect(() => win.append(bytes)).not.toThrow()
    win.append(initBytes)

    expect(win.list(), 'мост перестал принимать сегменты после мусора').toHaveLength(1)
  })

  it('запрос списка без канала для ответа не роняет мост', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)

    expect(() => win.deliver({ type: 'tc:list' })).not.toThrow()
    expect(win.list(), 'реестр пострадал от запроса без порта').toHaveLength(1)
  })

  it('ответ на tc:list уходит только в канал, а не в окно-отправитель', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)

    const reply = port()
    const sender = win.deliver({ type: 'tc:list' }, { ports: [reply] })

    // Список сессий — это история просмотра. Ответ в окно раздал бы её любой странице,
    // которая догадается прислать мосту tc:list.
    expect(sender.posts, 'список сессий ушёл в окно страницы').toEqual([])
    expect(reply.received).toHaveLength(1)
  })
})

describe('мост принимает вердикты отсева', () => {
  /** Вердикт в том виде, в каком его шлёт мосту content script. */
  const verdict = (win: ReturnType<typeof installWindow>, sourceId: string, value: string) =>
    win.deliver({ type: 'tc:verdict', sourceId, verdict: value })

  it('отказ стирает набранное отсеянным источником', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')

    verdict(win, 's1', 'reject')

    expect(win.list()).toEqual([])
  })

  it('отказ по одному источнику не трогает сессию соседнего', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')
    win.context('https://site.example/watch?v=second', 'Second')
    win.append(initBytes, 's2')

    // Баннер и настоящий плеер на одной странице: вердикт адресный, и отказ по первому
    // обязан оставить второй в покое.
    verdict(win, 's1', 'reject')

    expect(win.list().map((s) => s.title)).toEqual(['Second'])
  })

  it('повышение защищает сессию от последующего отказа', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')

    verdict(win, 's1', 'promote')
    // Пауза или уход элемента с экрана: запись замирает, накопленное остаётся.
    verdict(win, 's1', 'reject')

    expect(win.list()).toMatchObject([{ runs: 1, duration: 2 }])
  })

  it('ожидание возвращает запись отсеянному источнику', async () => {
    const win = await loadBridge()
    win.context()

    verdict(win, 's1', 'reject')
    win.append(initBytes, 's1')
    expect(win.list(), 'подготовка: после отказа сессии быть не должно').toEqual([])

    verdict(win, 's1', 'hold')
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')

    expect(win.list()).toMatchObject([{ runs: 1 }])
  })

  it('на вердикт мост не отвечает отправителю', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')

    const sender = win.deliver({ type: 'tc:verdict', sourceId: 's1', verdict: 'promote' })

    expect(sender.posts, 'мост ответил на вердикт').toEqual([])
  })
})

describe('BridgeToPage описывает всё, что мост отправляет', () => {
  it('и рукопожатие, и ответ на tc:list укладываются в объявленный союз', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    const reply = port()
    win.deliver({ type: 'tc:list' }, { ports: [reply] })

    // Мост отправляет двумя каналами: окну-родителю и в порт запроса. Оба конца собираются
    // вместе, потому что тип объявлен один на оба: вид сообщения, посланный мимо союза,
    // получателю неизвестен, а следующий читатель протокола о нём попросту не узнает.
    const sent: unknown[] = [...win.parent.posts.map((post) => post.message), ...reply.received]
    expect(sent.map(variantOf), 'мост отправил сообщение, не описанное в BridgeToPage').toEqual([
      'tc:ready',
      'сводки сессий',
    ])
  })

  it('оба варианта берутся из союза, а не из представлений набора о нём', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)

    // Проверка компилятора: присваивание не пройдёт typecheck, если союз потеряет вариант
    // (`BridgeToPage = { type: 'tc:ready' }` — как было до этой правки) или разойдётся со
    // сводкой, которую мост отдаёт на самом деле.
    const handshake: BridgeToPage = { type: 'tc:ready' }
    const list: BridgeToPage = win.list()

    expect([variantOf(handshake), variantOf(list)]).toEqual(['tc:ready', 'сводки сессий'])
  })
})

describe('мост сохраняет накопленное файлом', () => {
  /** Ключ звуковой сессии: у неё прогоны получаются разной длины. */
  const audioKey = keyFor(PAGE_URL, ['mp4a'])

  /** Набирает звуковую сессию из перечисленных кусков; пропущенный кусок даёт разрыв. */
  async function withAudio(...indexes: number[]) {
    const win = await loadBridge()
    win.context()
    win.append(audioInitBytes)
    for (const index of indexes) win.append(audioBytes[index]!)
    return win
  }

  it('отдаёт Chrome init и самый длинный прогон, а не первый попавшийся', async () => {
    // Прогоны 0…1.95 и 3.95…6.02: длиннее второй.
    const win = await withAudio(0, 2, 3)

    win.save(audioKey)

    expect(digest(await win.savedBytes())).toBe(
      digest(audioInitBytes, audioBytes[2]!, audioBytes[3]!),
    )
  })

  it('длинный прогон берётся и когда он не последний', async () => {
    // Прогоны 0…3.95 и 5.97…6.02: длиннее первый. Хвост в полсекунды — обычное дело:
    // плеер догрузил кусочек после перемотки и остановился.
    const win = await withAudio(0, 1, 3)

    win.save(audioKey)

    expect(digest(await win.savedBytes())).toBe(
      digest(audioInitBytes, audioBytes[0]!, audioBytes[1]!),
    )
  })

  it('файл заявлен видео, а не потоком байтов', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    // По типу блоба Chrome выбирает, чем открыть скачанное; application/octet-stream
    // отправил бы клип в «неизвестный файл».
    expect(win.savedType()).toBe('video/mp4')
  })

  it('имя файла — заголовок страницы с расширением mp4', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, 'Ночной эфир')
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    // Заголовок не латиницей — не повод отдать пользователю файл из подчёркиваний.
    expect(win.downloads.map((item) => item.filename)).toEqual(['Ночной эфир.mp4'])
  })

  it('в имени файла не остаётся запрещённых знаков', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, 'A/B: "C" <D> | E?')
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    // Косая черта увела бы файл в подкаталог, двоеточие и звёздочка запрещены Windows.
    expect(win.downloads[0]!.filename).toBe('A B C D E.mp4')
  })

  it('заголовок из одних точек не превращается в скрытый файл', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, '../../.bashrc')
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    // Заголовок задаёт страница, и через имя файла он ведёт прямо в файловую систему:
    // точки с краёв Chrome читает как путь наверх и скачивание отклоняет целиком.
    const filename = win.downloads[0]!.filename
    expect(filename.startsWith('.'), `имя файла начинается с точки: ${filename}`).toBe(false)
    expect(filename).not.toContain('..')
  })

  it('точка и пробел с хвоста имени снимаются перед расширением', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, 'Серия 1.')
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    // Расширение приписывается следом, и хвостовая точка заголовка удваивает разделитель:
    // «Серия 1..mp4». Windows к тому же сама срезает точки и пробелы с конца имени.
    expect(win.downloads[0]!.filename).toBe('Серия 1.mp4')
  })

  it('обрезанный по пробелу длинный заголовок не оставляет пробел перед расширением', async () => {
    const win = await loadBridge()
    // Пробел стоит сотым знаком: срез по пределу длины приходится ровно на него.
    win.context(PAGE_URL, `${'ц'.repeat(99)} и ещё сколько-то слов`)
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    expect(win.downloads[0]!.filename).toBe(`${'ц'.repeat(99)}.mp4`)
  })

  it('страница без заголовка сохраняется под именем расширения', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, '   ')
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    expect(win.downloads[0]!.filename).toBe('tailcut.mp4')
  })

  it('длинный заголовок обрезается до имени, которое примет файловая система', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, 'ц'.repeat(300))
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    expect(win.downloads[0]!.filename.length).toBeLessThanOrEqual(104)
    expect(win.downloads[0]!.filename.endsWith('.mp4')).toBe(true)
  })

  it('о начатом скачивании мост отчитывается в порт запроса', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    const reply = win.save(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: true }])
  })

  it('незнакомый ключ — отказ, а не попытка скачать пустоту', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    // Страницу успели перезагрузить, пока попап был открыт: его ключ указывает в пустоту.
    const reply = win.save('нет такой сессии')

    expect(reply.received).toEqual([{ ok: false }])
    expect(win.downloads, 'мост начал скачивание несуществующей сессии').toEqual([])
  })

  it('сессия из одного init-сегмента — отказ, а не файл без единого кадра', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)

    // Плеер открыл поток и ничего не догрузил: прогонов в карте нет. Самый длинный из них
    // взять неоткуда, и файл вышел бы из одного заголовка.
    const reply = win.save(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: false }])
    expect(win.downloads).toEqual([])
  })

  it('отказ Chrome доезжает до попапа отказом', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    win.failDownloads()

    // Нет места на диске, запрет на запись в каталог загрузок, отмена пользователем.
    const reply = win.save(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: false }])
  })

  it('адрес блоба живёт, пока Chrome читает файл, и снимается потом', async () => {
    vi.useFakeTimers()
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    // Снятый сразу адрес обрывает уже начатое скачивание: Chrome читает блоб не мгновенно.
    vi.advanceTimersByTime(59_000)
    expect(win.revoked, 'адрес блоба снят, пока Chrome ещё читает файл').toEqual([])

    vi.advanceTimersByTime(1_000)
    // А не снятый вовсе держит собранный файл в памяти фрейма до конца жизни страницы.
    expect(win.revoked, 'адрес блоба не снят: файл остался висеть в памяти').toEqual([
      win.downloads[0]!.url,
    ])
  })

  it('после отказа адрес блоба снимается сразу', async () => {
    vi.useFakeTimers()
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    win.failDownloads()

    win.save(keyFor(PAGE_URL))
    vi.advanceTimersByTime(0)

    // Скачивания не будет, читать блоб некому — держать его минуту незачем.
    expect(win.revoked).toEqual([win.downloads[0]!.url])
  })

  it('запрос сохранения без канала для ответа не роняет мост', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    expect(() => win.deliver({ type: 'tc:save', key: keyFor(PAGE_URL) })).not.toThrow()
    expect(win.downloads, 'скачивание не началось').toHaveLength(1)
  })

  it('ответ на tc:save уходит только в канал, а не в окно-отправитель', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    const reply = port()
    const sender = win.deliver({ type: 'tc:save', key: keyFor(PAGE_URL) }, { ports: [reply] })

    // Ответ в окно сказал бы любой странице, что у расширения на неё что-то записано.
    expect(sender.posts, 'ответ на сохранение ушёл в окно страницы').toEqual([])
    expect(reply.received).toEqual([{ ok: true }])
  })
})
