import { describe, it, expect, afterEach, vi } from 'vitest'

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

type Receiver = ReturnType<typeof receiver>
type MessageListener = (event: MessageEvent) => void

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
 * window.parent, а эхо — тому окну, что пришло в event.source. Родитель, верхняя страница и
 * отправитель здесь разные объекты: только так видно, кому мост на самом деле ответил.
 *
 * Иерархия не выдумана: оба content-скрипта объявлены с all_frames, поэтому мост встаёт и во
 * вложенном фрейме, где window.parent (окно того самого фрейма) и window.top (верхняя
 * страница) — разные окна.
 */
function installWindow() {
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

  return {
    parent,
    top,
    /** Доставляет мосту сообщение от указанного окна и отдаёт это окно для проверок. */
    deliver(data: unknown, from: Receiver = receiver()): Receiver {
      for (const listener of listeners) listener({ data, source: from } as unknown as MessageEvent)
      return from
    },
  }
}

/** Мост ставит слушателя и здоровается прямо при загрузке модуля. */
async function loadBridge() {
  const win = installWindow()
  vi.resetModules()
  await import('../../src/bridge/bridge')
  return win
}

const append = (bytes: ArrayBuffer) => ({
  type: 'tc:append',
  sourceId: 's',
  bufferId: 'b',
  mime: 'video/mp4',
  bytes,
})

afterEach(() => {
  vi.unstubAllGlobals()
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

describe('эхо моста на tc:append', () => {
  // Нулевая длина в списке не для полноты: appendBuffer с пустым буфером легален, изредка
  // приходит от плееров, и молчание моста на нём потеряло бы сообщение целиком.
  it.each([0, 7, 4096, 65_536])(
    'подтверждает ровно длину пришедшего буфера (%i байт)',
    async (size) => {
      const win = await loadBridge()
      const bytes = new ArrayBuffer(size)

      const sender = win.deliver(append(bytes))

      // Длина — единственное свидетельство, что буфер доехал с содержимым: константа вместо
      // чтения byteLength означала бы, что мост до самих байтов не дотянулся.
      expect(sender.posts.map((p) => p.message)).toEqual([{ type: 'tc:echo', length: size }])
    },
  )

  it('уходит окну-отправителю, а не родителю моста', async () => {
    const win = await loadBridge()

    const sender = win.deliver(append(new ArrayBuffer(32)))

    expect(sender.posts, 'отправитель не получил подтверждения').toHaveLength(1)
    expect(
      win.parent.posts.map((p) => p.message),
      'эхо ушло родителю вместо того, кто прислал байты',
    ).toEqual([{ type: 'tc:ready' }])
  })

  it('адресовано любому origin: страница-отправитель может быть какой угодно', async () => {
    const win = await loadBridge()

    const sender = win.deliver(append(new ArrayBuffer(32)))

    expect(targetOriginOf(sender.posts[0]?.to)).toBe('*')
  })
})

describe('мост и чужие сообщения', () => {
  const foreign: [string, unknown][] = [
    ['tc:source', { type: 'tc:source', sourceId: 's', objectUrl: 'blob:x' }],
    ['tc:drm', { type: 'tc:drm', sourceId: 's' }],
    ['чужой type', { type: 'webpackHotUpdate' }],
    ['null', null],
    ['строку', 'tc:append'],
  ]

  it.each(foreign)('не отвечает на %s и не падает', async (_name, data) => {
    const win = await loadBridge()

    const sender = win.deliver(data)

    expect(sender.posts, 'мост ответил на сообщение не своего типа').toEqual([])
  })
})
