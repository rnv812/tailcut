import { describe, it, expect, afterEach, vi } from 'vitest'
import { BRIDGE_PATH } from '../../src/shared/protocol'

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const BRIDGE_URL = `${EXTENSION_ORIGIN}/${BRIDGE_PATH}`

/** Куда браузер ведёт вставленный фрейм, у которого адрес ещё не задан. */
const BLANK = 'about:blank'

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

function installDom() {
  const created: FakeElement[] = []
  const appended: FakeElement[] = []
  const messageListeners: Array<(event: MessageEvent) => void> = []

  // Окно страницы: content script слушает на нём сообщения хука и по нему же отличает
  // своё окно от чужого.
  const pageWindow = {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') messageListeners.push(listener)
    },
  }
  vi.stubGlobal('window', pageWindow)

  vi.stubGlobal('document', {
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
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}` },
  })

  return {
    created,
    appended,
    pageWindow,
    /**
     * Доставляет сообщение слушателю content script'а. Обработчик асинхронный — ждёт мост,
     * поэтому после доставки очередь микрозадач надо дать разобрать.
     */
    deliverMessage: async (data: unknown, source: unknown = pageWindow): Promise<void> => {
      for (const listener of messageListeners) listener({ data, source } as MessageEvent)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
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
    expect(dom.created[0]!.posted).toEqual([
      { message: append(buffer), transfer: [buffer] },
    ])
  })

  it('служебные сообщения уходят без списка передачи', async () => {
    const dom = await withBridge()
    const message = { type: 'tc:source', sourceId: 's1', objectUrl: 'blob:https://site.example/x' }

    await dom.deliverMessage(message)

    expect(dom.created[0]!.posted).toEqual([{ message, transfer: undefined }])
  })

  it('чужие сообщения в мост не уходят', async () => {
    const dom = await withBridge()

    // На живых страницах в окно летят сообщения сборщиков, аналитики и рекламы.
    await dom.deliverMessage({ type: 'webpackHotUpdate' })
    await dom.deliverMessage(null)
    await dom.deliverMessage('tc:append')

    expect(dom.created[0]!.posted).toEqual([])
  })

  it('сообщение не из окна страницы игнорируется', async () => {
    const dom = await withBridge()

    // Источник — не наше окно: так выглядит сообщение из вложенного фрейма или от самого моста.
    // Приняв его, content script гонял бы чужие байты по кругу.
    await dom.deliverMessage(append(bytes()), { name: 'другое окно' })

    expect(dom.created[0]!.posted).toEqual([])
  })
})
