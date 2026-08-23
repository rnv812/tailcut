import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * Второй аргумент postMessage: у window.parent это строка targetOrigin, у окна-отправителя —
 * объект опций. Храним как есть, чтобы проверять именно то, что мост передал.
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
 * Подменяет окно, в котором живёт мост: слушателя он вешает на window, рукопожатие шлёт
 * window.parent, а эхо — тому окну, что пришло в event.source. Родитель и отправитель здесь
 * разные объекты: только так видно, кому мост на самом деле ответил.
 */
function installWindow() {
  const listeners: MessageListener[] = []
  const parent = receiver()

  vi.stubGlobal('window', {
    addEventListener(type: string, listener: MessageListener) {
      if (type === 'message') listeners.push(listener)
    },
    parent,
  })

  return {
    parent,
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

  it('адресовано любому origin: расширение работает на всех сайтах', async () => {
    const win = await loadBridge()

    // Прибитый адрес молча теряет рукопожатие на любой странице, кроме него самого,
    // а страница узнаёт о мосте только из этого сообщения.
    expect(win.parent.posts[0]?.to, 'рукопожатие прибито к конкретному адресу').toBe('*')
  })
})

describe('эхо моста на tc:append', () => {
  it.each([7, 4096, 65_536])(
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

    expect(sender.posts[0]?.to).toEqual({ targetOrigin: '*' })
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
