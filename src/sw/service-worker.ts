import { TOP_FRAME, type ExtensionToTab, type SessionSummary } from '../shared/protocol'

/**
 * Как часто пересчитывается бейдж активной вкладки. Через будильник, а не через setInterval:
 * service worker засыпает через полминуты бездействия, и таймер вместе с ним.
 *
 * Упакованному расширению Chrome реже 30 секунд будить себя не даёт и период молча
 * поднимает; распакованному отдаёт запрошенный.
 */
const POLL_INTERVAL_MINUTES = 1 / 6

const BADGE_ALARM = 'tc:badge'

/**
 * Подпись бейджа. На кнопке помещается четыре знака, поэтому единица счёта растёт вместе
 * с записанным: секунды, минуты, часы.
 */
export function formatBadge(seconds: number): string {
  // Меньше секунды — записывать ещё нечего, и «0s» на кнопке обещал бы обратное.
  if (!(seconds >= 1)) return ''

  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.round(total / 60)}m`
  return `${Math.round(total / 3600)}h`
}

/** Спрашивает вкладку о накопленном тем же каналом, что и попап. */
async function badgeTextFor(tabId: number): Promise<string> {
  const request: ExtensionToTab = { type: 'tc:list' }

  try {
    const sessions: SessionSummary[] | undefined = await chrome.tabs.sendMessage(
      tabId,
      request,
      TOP_FRAME,
    )
    return formatBadge(sessions?.[0]?.duration ?? 0)
  } catch {
    // Страница без content script: chrome://, магазин расширений, вкладка старше установки.
    return ''
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#4c8dff' })
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES })
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== BADGE_ALARM) return

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = tab?.id
  if (tabId === undefined) return

  const text = await badgeTextFor(tabId)

  // Бейдж адресный: на других вкладках у расширения своя запись или её нет вовсе. Вкладка
  // к тому же успевает закрыться, пока идёт опрос, — ставить бейдж тогда некому.
  await chrome.action.setBadgeText({ tabId, text }).catch(() => undefined)
})
