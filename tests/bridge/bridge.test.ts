import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { sessionKey } from '../../src/core/session-key'
import type { BridgeToPage, SessionSummary } from '../../src/shared/protocol'

const initBytes = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const seg1Bytes = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))
const seg2Bytes = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00002.m4s'))
/** Фрагмент через один после первого: вместе они дают буфер с разрывом посередине. */
const seg3Bytes = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00003.m4s'))

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
