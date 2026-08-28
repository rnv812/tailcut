import { listTabSessions } from '../shared/frames'

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

/**
 * Asks the tab what it has gathered, by the same road the popup takes: every frame of it, and the
 * freshest session of them all at the head of the answer.
 *
 * Every frame and not the top one, because the badge is the only sign that anything is being
 * recorded at all. On a page carrying an embedded player the recording lives in the frame of the
 * embed, and a badge that stayed empty over it would leave the user with no reason to open the
 * popup that now has something to show.
 */
async function badgeTextFor(tabId: number): Promise<string> {
  try {
    const answer = await listTabSessions(tabId)
    return formatBadge(answer.sessions[0]?.duration ?? 0)
  } catch {
    // Every step below has a catch of its own, so nothing reaches this today — and that is a
    // property of the code down there rather than a promise this one can make. Here is the last
    // place a failure can be answered: a service worker has nobody to hand a rejection to, and an
    // unhandled one goes into the extension's error list and wakes the worker to put it there.
    // Nothing is known about the tab after a failure, and an empty badge is what nothing looks
    // like.
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
