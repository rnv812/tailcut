import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SessionSummary } from '../../src/shared/protocol'

const summary = (duration: number): SessionSummary => ({
  key: 'https://site.example/watch|avc1|inf',
  url: 'https://site.example/watch',
  title: 'Clip',
  duration,
  bytes: 1_543_210,
  runs: 1,
})

type Alarm = { name: string; options: unknown }
type BadgeText = { tabId?: number; text: string }
type Sent = { tabId: number; message: unknown; options: unknown }

/**
 * Подменяет chrome для service worker: слушатели он вешает при загрузке модуля, а зовёт их
 * потом браузер. Тест их и зовёт — установку и срабатывание будильника.
 */
function installChrome(options: { tabs?: Array<{ id?: number }>; reply?: unknown } = {}) {
  const alarms: Alarm[] = []
  const badgeText: BadgeText[] = []
  const badgeColor: unknown[] = []
  const sent: Sent[] = []
  const installed: Array<() => void> = []
  const alarmFired: Array<(alarm: { name: string }) => Promise<void> | void> = []

  const tabs = options.tabs ?? [{ id: 7 }]
  const reply: unknown = 'reply' in options ? options.reply : [summary(6)]
  let failure: Error | null = null
  let badgeFailure: Error | null = null

  vi.stubGlobal('chrome', {
    runtime: { onInstalled: { addListener: (fn: () => void) => installed.push(fn) } },
    alarms: {
      create: (name: string, opts: unknown) => alarms.push({ name, options: opts }),
      onAlarm: {
        addListener: (fn: (alarm: { name: string }) => Promise<void>) => alarmFired.push(fn),
      },
    },
    action: {
      setBadgeBackgroundColor: (arg: unknown) => badgeColor.push(arg),
      setBadgeText: async (arg: BadgeText) => {
        if (badgeFailure) throw badgeFailure
        badgeText.push(arg)
      },
    },
    tabs: {
      query: async () => tabs,
      sendMessage: async (tabId: number, message: unknown, opts: unknown) => {
        sent.push({ tabId, message, options: opts })
        if (failure) throw failure
        return reply
      },
    },
  })

  return {
    alarms,
    badgeText,
    badgeColor,
    sent,
    install: () => {
      for (const listener of installed) listener()
    },
    fire: async (name = 'tc:badge') => {
      for (const listener of alarmFired) await listener({ name })
    },
    /** Страница без content script: sendMessage отказывает «receiving end does not exist». */
    breakTab: () => {
      failure = new Error('Could not establish connection. Receiving end does not exist.')
    },
    /** Вкладка закрылась, пока шёл опрос: бейдж ставить уже некому. */
    breakBadge: () => {
      badgeFailure = new Error('No tab with id: 7.')
    },
  }
}

async function importWorker() {
  vi.resetModules()
  return import('../../src/sw/service-worker')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('установка', () => {
  it('красит бейдж и заводит будильник пересчёта', async () => {
    const chrome = installChrome()
    await importWorker()

    chrome.install()

    expect(chrome.badgeColor).toEqual([{ color: '#4c8dff' }])
    expect(chrome.alarms).toHaveLength(1)
    expect(chrome.alarms[0]!.name).toBe('tc:badge')
  })

  it('будильник периодический: пересчёт переживает сон воркера', async () => {
    const chrome = installChrome()
    await importWorker()

    chrome.install()

    // Одноразовый будильник (delayInMinutes/when) поставил бы бейдж ровно один раз, а
    // setInterval уснул бы вместе с воркером через полминуты бездействия.
    const options = chrome.alarms[0]!.options as { periodInMinutes?: number }
    expect(options.periodInMinutes, 'будильник не повторяется').toBeGreaterThan(0)
    expect(options.periodInMinutes, 'бейдж отстаёт от записи больше чем на полминуты').toBeLessThan(
      0.5,
    )
  })
})

describe('пересчёт бейджа', () => {
  it('спрашивает активную вкладку и ставит бейдж ей', async () => {
    const chrome = installChrome()
    await importWorker()

    await chrome.fire()

    expect(chrome.sent).toEqual([
      { tabId: 7, message: { type: 'tc:list' }, options: { frameId: 0 } },
    ])
    // Бейдж без tabId — общий: запись одной вкладки светилась бы на всех остальных.
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '6s' }])
  })

  it('чужой будильник не трогает', async () => {
    const chrome = installChrome()
    await importWorker()

    await chrome.fire('tc:something-else')

    expect(chrome.sent).toEqual([])
    expect(chrome.badgeText).toEqual([])
  })

  it('на вкладке без записи бейдж пуст', async () => {
    const chrome = installChrome({ reply: [] })
    await importWorker()

    await chrome.fire()

    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '' }])
  })

  it('на вкладке без content script бейдж стирается', async () => {
    const chrome = installChrome()
    chrome.breakTab()
    await importWorker()

    await chrome.fire()

    // chrome://, магазин расширений, вкладка старше установки. Оставь бейдж как есть —
    // на ней светилось бы чужое время.
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '' }])
  })

  it('без активной вкладки ничего не ставит', async () => {
    const chrome = installChrome({ tabs: [] })
    await importWorker()

    await chrome.fire()

    expect(chrome.sent).toEqual([])
    expect(chrome.badgeText).toEqual([])
  })

  it('закрывшаяся вкладка не роняет обработчик', async () => {
    const chrome = installChrome()
    chrome.breakBadge()
    await importWorker()

    // Вкладка успевает закрыться, пока идёт опрос: setBadgeText отказывает промисом,
    // и непойманный отказ разбудил бы воркер сообщением об ошибке.
    await expect(chrome.fire()).resolves.toBeUndefined()
  })

  it('берёт самую свежую сессию вкладки', async () => {
    const chrome = installChrome({ reply: [summary(12), summary(300)] })
    await importWorker()

    await chrome.fire()

    // Список приходит от свежих к старым: на бейдже то, что пишется прямо сейчас.
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '12s' }])
  })
})

describe('formatBadge', () => {
  it.each([
    [0, ''],
    [0.4, ''],
    // Меньше секунды писать нечего, а «0s» на кнопке обещал бы записанное.
    [0.99, ''],
    [1, '1s'],
    [6, '6s'],
    [6.4, '6s'],
    [59, '59s'],
    [60, '1m'],
    [95, '2m'],
    [3599, '60m'],
    [3600, '1h'],
    [7000, '2h'],
  ])('%s секунд → «%s»', async (seconds, expected) => {
    installChrome()
    const { formatBadge } = await importWorker()

    expect(formatBadge(seconds)).toBe(expected)
  })

  it('не пишет на бейдже больше четырёх знаков', async () => {
    installChrome()
    const { formatBadge } = await importWorker()

    // Больше на кнопке не помещается: Chrome обрезает подпись сам, без предупреждения.
    // Верхняя граница — четверо суток записи: дольше буфер в памяти не живёт.
    for (const seconds of [1, 59, 60, 3599, 3600, 36_000, 359_940]) {
      expect(formatBadge(seconds).length, `${seconds} секунд`).toBeLessThanOrEqual(4)
    }
  })
})
