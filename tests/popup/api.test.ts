import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SessionSummary } from '../../src/shared/protocol'

const PAGE_URL = 'https://site.example/watch?v=abc'

const summary: SessionSummary = {
  key: 'https://site.example/watch|avc1|inf',
  url: PAGE_URL,
  title: 'Clip — site.example',
  duration: 6,
  bytes: 1_543_210,
  runs: 1,
}

/** Что попап отправил вкладке: сообщение и адресат внутри неё. */
type Sent = { tabId: number; message: unknown; options: unknown }

/**
 * Активная вкладка соседнего окна. Окон у пользователя бывает несколько, а вкладки Chrome
 * перечисляет по окнам: в ответ на запрос без `currentWindow` соседнее окно попадает раньше
 * текущего, и первой в списке оказывается его вкладка.
 */
const OTHER_WINDOW_TAB = { id: 42 }

/**
 * Вкладка текущего окна на заднем плане. В ответ на запрос без `active` она попадает
 * раньше активной: вкладки одного окна перечисляются слева направо.
 */
const BACKGROUND_TAB = { id: 5 }

/** Чем ограничен запрос вкладок: ровно те поля, которыми пользуется расширение. */
type QueryInfo = { active?: boolean; currentWindow?: boolean }

/**
 * Подменяет chrome для попапа. Вкладки заданы списком: это активные вкладки текущего окна,
 * первую из них и отдаёт chrome.tabs.query. Рядом с ними живут соседнее окно и вкладка на
 * заднем плане — их запрос обязан отсеять сам. Ответ вкладки задаётся отдельно: вкладка
 * может и не ответить вовсе (нет content script), и тогда sendMessage отказывает промисом.
 */
function installChrome(options: { tabs?: Array<{ id?: number }>; reply?: unknown } = {}) {
  const sent: Sent[] = []
  let tabs = options.tabs ?? [{ id: 7 }]
  let reply: unknown = 'reply' in options ? options.reply : [summary]
  let failure: Error | null = null

  vi.stubGlobal('chrome', {
    tabs: {
      query: async (info: QueryInfo = {}) => [
        ...(info.currentWindow ? [] : [OTHER_WINDOW_TAB]),
        ...(info.active ? [] : [BACKGROUND_TAB]),
        ...tabs,
      ],
      sendMessage: async (tabId: number, message: unknown, opts: unknown) => {
        sent.push({ tabId, message, options: opts })
        if (failure) throw failure
        return reply
      },
    },
  })

  return {
    sent,
    /** Пользователь переключил вкладку, пока попап открыт. */
    switchTo: (id: number | undefined) => {
      tabs = [{ id }]
    },
    /** Страница без content script: sendMessage отказывает «receiving end does not exist». */
    breakTab: () => {
      failure = new Error('Could not establish connection. Receiving end does not exist.')
    },
    setReply: (value: unknown) => {
      reply = value
    },
  }
}

/** Модуль помнит вкладку между вызовами, поэтому каждому тесту нужен свежий импорт. */
async function importApi() {
  vi.resetModules()
  return import('../../src/popup/api')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listSessions', () => {
  it('отдаёт сводки, которые прислала вкладка', async () => {
    installChrome()
    const { listSessions } = await importApi()

    expect(await listSessions()).toEqual([summary])
  })

  it('спрашивает активную вкладку и только её главный фрейм', async () => {
    const chrome = installChrome()
    const { listSessions } = await importApi()

    await listSessions()

    // Без frameId Chrome разошлёт запрос по всем фреймам страницы, и ответит тот, кто успел
    // первым: на странице с рекламными фреймами это чужой пустой список.
    expect(chrome.sent).toEqual([{ tabId: 7, message: { type: 'tc:list' }, options: { frameId: 0 } }])
  })

  it('берёт активную вкладку текущего окна, а не соседнего', async () => {
    const chrome = installChrome()
    const { listSessions } = await importApi()

    await listSessions()

    // Окон открыто два, и запрос без currentWindow вернёт активную вкладку каждого —
    // первой чужую. Попап тогда покажет сводку вкладки из другого окна и по «Save all»
    // сохранит её сессию, а не ту, на которую пользователь смотрит.
    expect(chrome.sent.map((item) => item.tabId)).toEqual([7])
  })

  it('на вкладке без content script отдаёт пустой список', async () => {
    const chrome = installChrome()
    chrome.breakTab()
    const { listSessions } = await importApi()

    // chrome://, магазин расширений, вкладка старше установки. Непойманный отказ оставил бы
    // попап в «Loading…» навсегда.
    expect(await listSessions()).toEqual([])
  })

  it('на пустой ответ вкладки отдаёт пустой список', async () => {
    const chrome = installChrome()
    chrome.setReply(undefined)
    const { listSessions } = await importApi()

    // Так отвечает Chrome, когда слушателя нет вовсе, а канал закрылся без ответа.
    expect(await listSessions()).toEqual([])
  })

  it('без активной вкладки не тревожит никого', async () => {
    const chrome = installChrome({ tabs: [] })
    const { listSessions } = await importApi()

    expect(await listSessions()).toEqual([])
    expect(chrome.sent).toEqual([])
  })

  it('вкладку без идентификатора считает отсутствующей', async () => {
    // У вкладки devtools и у предзагруженной страницы id может не быть вовсе.
    const chrome = installChrome({ tabs: [{}] })
    const { listSessions } = await importApi()

    expect(await listSessions()).toEqual([])
    expect(chrome.sent).toEqual([])
  })
})

describe('saveAll', () => {
  it('просит вкладку сохранить сессию по её ключу', async () => {
    const chrome = installChrome()
    const { saveAll } = await importApi()

    await saveAll(summary.key)

    expect(chrome.sent).toEqual([
      { tabId: 7, message: { type: 'tc:save', key: summary.key }, options: { frameId: 0 } },
    ])
  })

  it('уходит той вкладке, у которой попап взял список', async () => {
    const chrome = installChrome()
    const { listSessions, saveAll } = await importApi()

    await listSessions()
    // Активная вкладка успевает смениться под открытым попапом. Спроси попап её заново —
    // и «Save all» сохранил бы чужую сессию или не сохранил ничего.
    chrome.switchTo(9)
    await saveAll(summary.key)

    expect(chrome.sent.map((item) => item.tabId)).toEqual([7, 7])
  })

  it('на вкладке без content script не бросает', async () => {
    const chrome = installChrome()
    chrome.breakTab()
    const { saveAll } = await importApi()

    // Вкладку закрыли или увели со страницы: непойманный отказ ушёл бы в консоль попапа.
    await expect(saveAll(summary.key)).resolves.toBeUndefined()
  })

  it('без активной вкладки не тревожит никого', async () => {
    const chrome = installChrome({ tabs: [] })
    const { saveAll } = await importApi()

    await saveAll(summary.key)

    expect(chrome.sent).toEqual([])
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [6, '0:06'],
    [6.4, '0:06'],
    [59.6, '1:00'],
    [65, '1:05'],
    [600, '10:00'],
    [3661, '61:01'],
  ])('%s секунд → %s', async (seconds, expected) => {
    installChrome()
    const { formatDuration } = await importApi()

    expect(formatDuration(seconds)).toBe(expected)
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 KB'],
    [1024, '1 KB'],
    [700_000, '684 KB'],
    [1_048_576, '1.0 MB'],
    [1_543_210, '1.5 MB'],
    [1_073_741_824, '1024.0 MB'],
  ])('%s байт → %s', async (bytes, expected) => {
    installChrome()
    const { formatBytes } = await importApi()

    expect(formatBytes(bytes)).toBe(expected)
  })
})

describe('hostOf', () => {
  it.each([
    ['https://site.example/watch?v=abc', 'site.example'],
    ['https://site.example:8443/watch', 'site.example:8443'],
    // Мост живёт на origin расширения и до первого tc:context знает только referrer,
    // а его может не быть вовсе: заголовок сессии тогда есть, адреса нет.
    ['', ''],
    ['не адрес', ''],
  ])('%s → %s', async (url, expected) => {
    installChrome()
    const { hostOf } = await importApi()

    expect(hostOf(url)).toBe(expected)
  })
})
