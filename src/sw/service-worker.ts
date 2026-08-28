import { MAIN_FRAME, listTabSessions, type FramedSession } from '../shared/frames'
import { isTabToExtension } from '../shared/protocol'

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
 * Which frames of which tabs have something recorded in them, as those frames last said.
 *
 * The badge is counted out of the registries of a tab's frames, and a tab keeps one per frame.
 * Asking all of them meant enumerating them first and then a message apiece: measured on a news
 * page carrying 154 frames, 154 injections and 154 messages every ten seconds — 60 to 90 ms of
 * extension work, on a page with no video anywhere in it. The recount has to cost what a tab has
 * recorded, not what it has frames.
 *
 * So the frames that record say so of their own accord (see FrameRecording), and this is what
 * they have said. It is a cache and not a record: nothing here is authoritative, every recount
 * replaces it with what the tab actually answered, and a frame missing from it costs no more than
 * a recount that reaches it one period late.
 *
 * It lives in memory, which is to say it lives until the worker is next restarted. That is why
 * the frames repeat themselves, and why the main frame is asked whether it announced itself or
 * not: a worker that has just come back knows nothing, and the main frame is where the player is
 * on nearly every page that has one.
 */
const recordingFrames = new Map<number, Set<number>>()

/**
 * The frames of a tab the badge asks: the main one, and every one that said it has something.
 *
 * The main frame always. It is one message, it is the frame the player is in on nearly every page
 * that has a player of its own, and it is the answer to a worker whose memory is empty — after a
 * restart there is nothing else to go on, and a badge that waited for the next announcement would
 * be blank over a recording that had stopped growing.
 */
function framesToAsk(tabId: number): number[] {
  const frames = new Set<number>([MAIN_FRAME])
  for (const frameId of recordingFrames.get(tabId) ?? []) frames.add(frameId)
  return [...frames].sort((a, b) => a - b)
}

/**
 * Replaces what was remembered of a tab with what its frames have just answered.
 *
 * Announcements only ever add, and a frame that has lost its session — evicted by triage, or
 * navigated away under an embed — would otherwise be asked for as long as the tab stayed open. A
 * page that opens a player in a fresh frame every few minutes would gather those by the hundred,
 * and the cost this whole mechanism removes would come back one frame at a time.
 *
 * A frame that was asked and answered nothing is dropped, and if it has something again it says
 * so again: that is what the repetition is for.
 */
function remember(tabId: number, sessions: readonly FramedSession[]): void {
  const answered = new Set(sessions.map((session) => session.frameId))
  if (answered.size) recordingFrames.set(tabId, answered)
  else recordingFrames.delete(tabId)
}

/**
 * Asks the tab what it has gathered and gives back the freshest session's length as a caption.
 *
 * Not every frame of it, as the popup asks: those the tab has named, and the main one. The badge
 * is the only sign that anything is being recorded at all, and on a page carrying an embedded
 * player the recording lives in the frame of the embed — that frame says so, and it is asked.
 */
async function badgeTextFor(tabId: number): Promise<string> {
  try {
    const answer = await listTabSessions(tabId, framesToAsk(tabId))
    remember(tabId, answer.sessions)
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

/** Counts the badge of one tab and puts it on that tab. */
async function recount(tabId: number): Promise<void> {
  const text = await badgeTextFor(tabId)

  // Бейдж адресный: на других вкладках у расширения своя запись или её нет вовсе. Вкладка
  // к тому же успевает закрыться, пока идёт опрос, — ставить бейдж тогда некому.
  await chrome.action.setBadgeText({ tabId, text }).catch(() => undefined)
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

  await recount(tabId)
})

/**
 * A frame of a tab says it has something recorded in it.
 *
 * Chrome signs the message with where it came from, so the frame is the frame that sent it and
 * not one a page has named: `sender.tab.id` and `sender.frameId` are the browser's word, and a
 * page cannot write either. That is the whole of the trust this needs — the worst a page could do
 * by sending it is have its own frame asked for a list it answers honestly.
 *
 * A frame already known is only written down; the alarm is a few seconds away and will count it.
 * One nobody knew about is counted at once: the recording it has just announced is the news the
 * badge exists for, and a period of silence over it is a period the user has no reason to open
 * the popup. Whichever tab it is in, active or not — a badge is set per tab, and one counted now
 * is one already right when the user comes back to that tab.
 */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!isTabToExtension(message)) return false

  const tabId = sender.tab?.id
  const frameId = sender.frameId
  if (tabId === undefined || frameId === undefined) return false

  let frames = recordingFrames.get(tabId)
  if (!frames) recordingFrames.set(tabId, (frames = new Set<number>()))
  if (frames.has(frameId)) return false

  frames.add(frameId)
  void recount(tabId)

  // Nothing is answered, and the channel must not be held open: a listener that returned true
  // would leave the sender waiting on a reply that never comes.
  return false
})

// A tab that has gone takes what was known about its frames with it. Nothing breaks without this
// — the numbers of a closed tab are never asked for again — but the map would grow by an entry
// per recording for as long as the browser stayed open.
chrome.tabs.onRemoved.addListener((tabId) => {
  recordingFrames.delete(tabId)
})
