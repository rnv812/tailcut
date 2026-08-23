import { describe, it, expect, afterEach, vi } from 'vitest'
import { BRIDGE_PATH } from '../../src/shared/protocol'

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const BRIDGE_URL = `${EXTENSION_ORIGIN}/${BRIDGE_PATH}`

/** Куда браузер ведёт вставленный фрейм, у которого адрес ещё не задан. */
const BLANK = 'about:blank'

/** Страница, на которой стоит content script: её адрес и заголовок уходят мосту. */
const PAGE_URL = 'https://site.example/watch?v=abc'
const PAGE_TITLE = 'Clip — site.example'
const CONTEXT = { type: 'tc:context', url: PAGE_URL, title: PAGE_TITLE }

/**
 * Минимальный элемент: content script трогает только эти свойства. Фрейм при этом ходит по
 * адресам как в браузере: пока он вне документа, присвоение src ничего не грузит; вставка
 * начинает загрузку текущего адреса — а у фрейма без адреса это about:blank; присвоение src
 * уже вставленному фрейму начинает ещё одну загрузку. Каждая заканчивается своим load.
 */
function fakeElement(tagName: string) {
  const listeners: Record<string, Array<() => void>> = {}
  const attributes: Record<string, string> = {}
  /** Начатые и ещё не отработавшие load навигации, в порядке начала. */
  const pending: string[] = []
  /** Что content script отправил в документ фрейма. */
  const posted: Array<{ message: unknown; transfer: unknown }> = []
  let attached = false
  let src = ''

  return {
    tagName,
    posted,
    contentWindow: {
      postMessage: (message: unknown, _targetOrigin: string, transfer?: unknown) => {
        posted.push({ message, transfer })
      },
    },
    dataset: {} as Record<string, string>,
    style: { cssText: '' },
    attributes,
    pending,
    /** Адрес, чью загрузку фрейм уже отработал; до первого load — пусто. */
    loaded: '',
    get src(): string {
      return src
    },
    set src(value: string) {
      src = value
      if (attached) pending.push(value)
    },
    /** Вставка в документ: с этого момента фрейм грузит то, что стоит в его src. */
    attach: () => {
      attached = true
      pending.push(src || BLANK)
    },
    setAttribute: (name: string, value: string) => {
      attributes[name] = value
    },
    addEventListener: (type: string, listener: () => void) => {
      ;(listeners[type] ??= []).push(listener)
    },
    fire: (type: string) => {
      for (const listener of listeners[type] ?? []) listener()
    },
  }
}

type FakeElement = ReturnType<typeof fakeElement>

/**
 * Минимальный <video>: наблюдатель читает только перечисленное здесь. По умолчанию — баннер
 * (беззвучное зациклённое превью без панели управления), которому положен отказ.
 */
function fakeVideo(overrides: Record<string, unknown> = {}) {
  const rect = { width: 160, height: 90, top: 0, left: 0, bottom: 90, right: 160 }
  return {
    src: 'blob:banner',
    currentSrc: 'blob:banner',
    muted: true,
    volume: 1,
    loop: true,
    controls: false,
    paused: false,
    ended: false,
    readyState: 4,
    isConnected: true,
    mediaKeys: null,
    getBoundingClientRect: () => rect,
    ...overrides,
  }
}

function installDom() {
  const created: FakeElement[] = []
  const appended: FakeElement[] = []
  const messageListeners: Array<(event: MessageEvent) => void> = []
  /** Элементы <video> страницы: наблюдатель находит их через document.querySelectorAll. */
  const videos: ReturnType<typeof fakeVideo>[] = []
  /** Часы наблюдателя: время двигает tick(), а не очередь таймеров. */
  let now = 0

  // Настоящим остаётся только setTimeout: на нём держатся ожидания микрозадач ниже.
  // Опрос наблюдателя идёт по setInterval, и тесту нужно решать самому, когда он сработает.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe(): void {}
    },
  )

  // Окно страницы: content script слушает на нём сообщения хука и по нему же отличает
  // своё окно от чужого.
  const pageWindow = {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') messageListeners.push(listener)
    },
  }
  vi.stubGlobal('window', pageWindow)
  vi.stubGlobal('location', { href: PAGE_URL })

  vi.stubGlobal('document', {
    title: PAGE_TITLE,
    visibilityState: 'visible',
    querySelectorAll: () => videos,
    createElement: (tagName: string) => {
      const element = fakeElement(tagName)
      created.push(element)
      return element
    },
    documentElement: {
      appendChild: (element: FakeElement) => {
        appended.push(element)
        element.attach()
        return element
      },
    },
  })
  /** Слушатели chrome.runtime.onMessage: их зовёт попап и service worker, а не страница. */
  const tabRequestListeners: Array<
    (message: unknown, sender: unknown, sendResponse: (reply: unknown) => void) => boolean
  > = []

  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`,
      onMessage: {
        addListener: (listener: (typeof tabRequestListeners)[number]) =>
          tabRequestListeners.push(listener),
      },
    },
  })

  return {
    created,
    appended,
    pageWindow,
    videos,
    /** Прогоняет один опрос наблюдателя и даёт разобрать очередь микрозадач. */
    tick: async (): Promise<void> => {
      now += 500
      vi.advanceTimersByTime(500)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    /**
     * Доставляет сообщение слушателю content script'а. Обработчик асинхронный — ждёт мост,
     * поэтому после доставки очередь микрозадач надо дать разобрать.
     */
    deliverMessage: async (data: unknown, source: unknown = pageWindow): Promise<void> => {
      for (const listener of messageListeners) listener({ data, source } as MessageEvent)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    /**
     * Что ушло в документ моста помимо контекста страницы: его мост получает при загрузке,
     * отдельно от пересылки, и в проверках пересылки только мешает. Что он вообще уходит,
     * проверяет describe «контекст страницы».
     */
    forwarded: (): Array<{ message: unknown; transfer: unknown }> =>
      created.flatMap((element) =>
        element.posted.filter(
          (post) => (post.message as { type?: unknown } | null)?.type !== 'tc:context',
        ),
      ),
    /**
     * Доставляет запрос расширения — так его присылает попап и service worker. Отдаёт то,
     * что слушатель ответил синхронно (true держит канал ответа открытым), и накопленные
     * ответы, ушедшие в sendResponse.
     */
    askTab: (message: unknown) => {
      const answers: unknown[] = []
      const kept = tabRequestListeners.map((listener) =>
        listener(message, { id: EXTENSION_ORIGIN }, (reply) => answers.push(reply)),
      )
      return { answers, kept }
    },
    /** Порты, которые content script передал мосту вместе с запросами расширения. */
    portsToBridge: (): MessagePort[] =>
      created
        .flatMap((element) => element.posted)
        .flatMap((post) => (Array.isArray(post.transfer) ? post.transfer : []))
        .filter((item): item is MessagePort => item instanceof MessagePort),
    /** Адреса, которые фреймы уже начали грузить и ещё не отработали. */
    pendingLoads: (): string[] => created.flatMap((element) => element.pending),
    /** Отрабатывает ближайшую навигацию: браузер шлёт load по каждой, about:blank включая. */
    deliverLoad: (): string => {
      const element = created.find((candidate) => candidate.pending.length > 0)
      if (!element) throw new Error('ни один фрейм не начинал загрузку')
      element.loaded = element.pending.shift()!
      element.fire('load')
      return element.loaded
    },
  }
}

/** Импорт сам вставляет мост: в модуле есть вызов ensureBridge() на верхнем уровне. */
async function importContent() {
  vi.resetModules()
  return import('../../src/page/content')
}

/** Разбирает cssText в набор объявлений, чтобы не привязываться к порядку свойств. */
function declarations(cssText: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of cssText.split(';')) {
    if (!part.trim()) continue
    const colon = part.indexOf(':')
    out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim()
  }
  return out
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ensureBridge', () => {
  it('вставляет фрейм со страницей моста при загрузке модуля', async () => {
    const dom = installDom()
    await importContent()

    expect(dom.created).toHaveLength(1)
    const iframe = dom.created[0]!
    expect(iframe.tagName).toBe('iframe')
    // Адрес строится из той же константы, что и в коде: здесь проверяется путь до неё —
    // chrome.runtime.getURL от BRIDGE_PATH. Что сама константа указывает на существующий
    // и объявленный в манифесте файл, проверяет tests/build/dist.test.ts.
    expect(iframe.src).toBe(BRIDGE_URL)
    expect(iframe.dataset.tailcut).toBe('bridge')
    expect(iframe.attributes['aria-hidden']).toBe('true')
    expect(dom.appended).toEqual([iframe])
  })

  it('на повторные вызовы отдаёт тот же промис и не плодит фреймы', async () => {
    const dom = installDom()
    const { ensureBridge } = await importContent()

    const first = ensureBridge()
    const second = ensureBridge()

    expect(second).toBe(first)
    expect(dom.created).toHaveLength(1)
    expect(dom.appended).toHaveLength(1)
  })

  it('объявляет фрейм невидимым и без размера', async () => {
    const dom = installDom()
    await importContent()

    expect(declarations(dom.created[0]!.style.cssText)).toMatchObject({
      position: 'fixed',
      width: '0',
      height: '0',
      border: '0',
      visibility: 'hidden',
      'pointer-events': 'none',
    })
  })

  it('резолвится фреймом только после его загрузки', async () => {
    const dom = installDom()
    const { ensureBridge } = await importContent()

    let settled: unknown = null
    const pending = ensureBridge().then((iframe) => {
      settled = iframe
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBeNull()

    dom.deliverLoad()
    await pending
    expect(settled).toBe(dom.created[0])
  })

  it('отдаёт фрейм, загрузивший страницу моста, а не пустую страницу перед ней', async () => {
    const dom = installDom()
    const { ensureBridge } = await importContent()

    let loadedAtResolve: unknown = null
    const pending = ensureBridge().then((iframe) => {
      loadedAtResolve = (iframe as unknown as FakeElement).loaded
    })

    // Фрейм, вставленный раньше присвоения src, успевает сходить на about:blank, и слушатель
    // с { once: true } срабатывает на ней. Потребитель промиса получил бы фрейм без моста:
    // postMessage в такой contentWindow пропадает молча, без ошибки и без адресата.
    dom.deliverLoad()
    await pending

    expect(loadedAtResolve, 'промис отдал фрейм до загрузки моста').toBe(BRIDGE_URL)
    expect(dom.pendingLoads(), 'фрейм ходил куда-то помимо страницы моста').toEqual([])
  })
})

describe('пересылка сообщений хука в мост', () => {
  const bytes = () => new ArrayBuffer(8)
  const append = (buffer: ArrayBuffer) => ({
    type: 'tc:append',
    sourceId: 's1',
    bufferId: 'b1',
    mime: 'video/mp4',
    bytes: buffer,
  })

  /** Поднимает content script с уже загруженным мостом и отдаёт его окружение. */
  async function withBridge() {
    const dom = installDom()
    await importContent()
    dom.deliverLoad()
    return dom
  }

  it('отдаёт сегмент мосту передачей буфера, а не копией', async () => {
    const dom = await withBridge()
    const buffer = bytes()

    await dom.deliverMessage(append(buffer))

    // Копия на этом участке стоила бы лишнего прохода по каждому сегменту.
    expect(dom.forwarded()).toEqual([{ message: append(buffer), transfer: [buffer] }])
  })

  it('служебные сообщения уходят без списка передачи', async () => {
    const dom = await withBridge()
    const message = { type: 'tc:source', sourceId: 's1', objectUrl: 'blob:https://site.example/x' }

    await dom.deliverMessage(message)

    expect(dom.forwarded()).toEqual([{ message, transfer: undefined }])
  })

  it('чужие сообщения в мост не уходят', async () => {
    const dom = await withBridge()

    // На живых страницах в окно летят сообщения сборщиков, аналитики и рекламы.
    await dom.deliverMessage({ type: 'webpackHotUpdate' })
    await dom.deliverMessage(null)
    await dom.deliverMessage('tc:append')

    expect(dom.forwarded()).toEqual([])
  })

  it('сообщение не из окна страницы игнорируется', async () => {
    const dom = await withBridge()

    // Источник — не наше окно: так выглядит сообщение из вложенного фрейма или от самого моста.
    // Приняв его, content script гонял бы чужие байты по кругу.
    await dom.deliverMessage(append(bytes()), { name: 'другое окно' })

    expect(dom.forwarded()).toEqual([])
  })
})

describe('контекст страницы для моста', () => {
  it('уходит мосту сразу после его загрузки', async () => {
    const dom = installDom()
    await importContent()

    // До load мост ещё не выполнил свой скрипт: сообщение, отправленное раньше, пропало бы
    // молча — без слушателя и без ошибки.
    expect(dom.created[0]!.posted, 'контекст ушёл в мост до его загрузки').toEqual([])

    dom.deliverLoad()

    // Заголовок и адрес страницы: на origin расширения мост ни того, ни другого не знает.
    expect(dom.created[0]!.posted).toEqual([{ message: CONTEXT, transfer: undefined }])
  })

  it('уходит раньше первого пересланного сегмента', async () => {
    const dom = installDom()
    await importContent()
    dom.deliverLoad()

    await dom.deliverMessage({
      type: 'tc:append',
      sourceId: 's1',
      bufferId: 'b1',
      mime: 'video/mp4',
      bytes: new ArrayBuffer(8),
    })

    // Порядок здесь и есть суть: сессия заводится первым init-сегментом, и адрес с
    // заголовком должны быть у моста к этому моменту, иначе сессия родится безымянной.
    expect(
      dom.created[0]!.posted.map((post) => (post.message as { type: string }).type),
      'сегмент обогнал контекст страницы',
    ).toEqual(['tc:context', 'tc:append'])
  })
})

describe('вердикт отбора', () => {
  /** Поднимает content script с уже загруженным мостом и отдаёт его окружение. */
  async function withBridge() {
    const dom = installDom()
    await importContent()
    dom.deliverLoad()
    return dom
  }

  it('уходит мосту с идентификатором того потока, чей элемент его получил', async () => {
    const dom = await withBridge()
    dom.videos.push(fakeVideo())

    // Связку потока с адресом изолированный мир узнаёт из сообщения хука — того самого,
    // которое он же пересылает мосту.
    await dom.deliverMessage({ type: 'tc:source', sourceId: 's1', objectUrl: 'blob:banner' })
    await dom.tick()

    expect(dom.forwarded()).toEqual([
      {
        message: { type: 'tc:source', sourceId: 's1', objectUrl: 'blob:banner' },
        transfer: undefined,
      },
      { message: { type: 'tc:verdict', sourceId: 's1', verdict: 'reject' }, transfer: undefined },
    ])
  })

  it('связка потока с адресом запоминается, не дожидаясь моста', async () => {
    const dom = installDom()
    await importContent()
    dom.videos.push(fakeVideo())

    // Хук отдаёт адрес из createObjectURL на document_start — мост в этот момент ещё грузится,
    // и первый опрос наблюдателя вполне успевает пройти до его загрузки. Отложи изолированный
    // мир запоминание адреса до готовности моста — вердикт этого опроса остался бы без
    // адресата и пропал бы вовсе.
    await dom.deliverMessage({ type: 'tc:source', sourceId: 's1', objectUrl: 'blob:banner' })
    await dom.tick()

    dom.deliverLoad()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dom.forwarded().map((post) => post.message)).toContainEqual({
      type: 'tc:verdict',
      sourceId: 's1',
      verdict: 'reject',
    })
  })

  it('по элементу с незнакомым адресом мосту не уходит', async () => {
    const dom = await withBridge()
    dom.videos.push(fakeVideo({ src: 'blob:someone-else', currentSrc: 'blob:someone-else' }))

    await dom.deliverMessage({ type: 'tc:source', sourceId: 's1', objectUrl: 'blob:banner' })
    await dom.tick()

    // Вердикт без адресата стёр бы в реестре чужую сессию — первую попавшуюся.
    expect(dom.forwarded().map((post) => (post.message as { type: string }).type)).toEqual([
      'tc:source',
    ])
  })

  it('по запросу ключей отменяет запись и настоящему плееру', async () => {
    const dom = await withBridge()
    const player = fakeVideo({
      src: 'blob:player',
      currentSrc: 'blob:player',
      muted: false,
      loop: false,
      controls: true,
      getBoundingClientRect: () => ({
        width: 640,
        height: 360,
        top: 0,
        left: 0,
        bottom: 360,
        right: 640,
      }),
    })
    dom.videos.push(player)

    await dom.deliverMessage({ type: 'tc:source', sourceId: 's1', objectUrl: 'blob:player' })
    await dom.tick()
    expect(
      dom.forwarded().map((post) => (post.message as { type: string }).type),
      'подготовка: до запроса ключей отказывать плееру не за что',
    ).toEqual(['tc:source'])

    await dom.deliverMessage({ type: 'tc:drm', sourceId: 'page' })
    await dom.tick()

    expect(dom.forwarded().at(-1)).toEqual({
      message: { type: 'tc:verdict', sourceId: 's1', verdict: 'reject' },
      transfer: undefined,
    })
  })
})

describe('запросы попапа и service worker', () => {
  /** Поднимает content script с уже загруженным мостом и отдаёт его окружение. */
  async function withBridge() {
    const dom = installDom()
    await importContent()
    dom.deliverLoad()
    return dom
  }

  /** Отвечает за мост в тот порт, который content script ему передал. */
  async function replyFromBridge(dom: ReturnType<typeof installDom>, reply: unknown) {
    const [port] = dom.portsToBridge()
    expect(port, 'content script не передал мосту канал для ответа').toBeDefined()
    port!.postMessage(reply)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const summary = {
    key: 'https://site.example/watch|avc1|inf',
    url: PAGE_URL,
    title: PAGE_TITLE,
    duration: 6,
    bytes: 1543,
    runs: 1,
  }

  it('запрос списка уходит мосту вместе с каналом для ответа', async () => {
    const dom = await withBridge()

    const { kept } = dom.askTab({ type: 'tc:list' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dom.forwarded().map((post) => post.message)).toEqual([{ type: 'tc:list' }])
    expect(dom.portsToBridge(), 'мосту не с чем ответить').toHaveLength(1)
    // Канал ответа Chrome закрывает, как только слушатель вернул не true, — попап получил
    // бы undefined ещё до того, как мост увидел запрос.
    expect(kept, 'слушатель не удержал канал ответа').toEqual([true])
  })

  it('ответ моста доезжает до спросившего', async () => {
    const dom = await withBridge()

    const { answers } = dom.askTab({ type: 'tc:list' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await replyFromBridge(dom, [summary])

    expect(answers).toEqual([[summary]])
  })

  it('запрос сохранения уходит мосту тем же путём', async () => {
    const dom = await withBridge()

    const { answers, kept } = dom.askTab({ type: 'tc:save', key: summary.key })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await replyFromBridge(dom, { ok: true })

    expect(dom.forwarded().map((post) => post.message)).toEqual([
      { type: 'tc:save', key: summary.key },
    ])
    expect(kept).toEqual([true])
    expect(answers).toEqual([{ ok: true }])
  })

  it('запрос, пришедший до загрузки моста, доходит до него после', async () => {
    const dom = installDom()
    await importContent()

    // Попап открывают когда угодно, в том числе на странице, где мост ещё грузится.
    const { kept } = dom.askTab({ type: 'tc:list' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dom.forwarded(), 'запрос ушёл в незагруженный фрейм').toEqual([])
    expect(kept).toEqual([true])

    dom.deliverLoad()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dom.forwarded().map((post) => post.message)).toEqual([{ type: 'tc:list' }])
  })

  it('чужое сообщение расширения мосту не уходит и канал не держит', async () => {
    const dom = await withBridge()

    // Слушателей у chrome.runtime.onMessage несколько на всё расширение: удержи этот
    // канал чужого запроса — ответ настоящего адресата уже никуда не уйдёт.
    const { kept } = dom.askTab({ type: 'tc:ping' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(kept).toEqual([false])
    expect(dom.forwarded()).toEqual([])
  })
})
