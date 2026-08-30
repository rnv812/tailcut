import { MAIN_FRAME, listTabSessions, type FramedSession } from '../shared/frames'
import {
  clearStorageFull,
  dropSessionRows,
  dropSnapshotRow,
  listSessions,
  listSnapshots,
  markStorageFull,
} from '../shared/history-db'
import { clearStorage } from '../shared/history-opfs'
import { isExtensionToWorker, isTabToExtension } from '../shared/protocol'
import { siteAllows } from '../shared/settings'
import { readSettings } from '../shared/settings-store'
import {
  ORPHAN_GRACE_MS,
  SWEEP_ALARM,
  SWEEP_PERIOD_MINUTES,
  liveIo,
  repair,
  sweep,
} from './sweeper'

/**
 * How often the active tab's badge is recounted. Use an alarm rather than setInterval because the
 * service worker sleeps after about thirty seconds of inactivity and takes its timer with it.
 *
 * Chrome silently raises periods shorter than 30 seconds for packed extensions, while unpacked
 * extensions receive the requested period.
 */
const POLL_INTERVAL_MINUTES = 1 / 6

const BADGE_ALARM = 'tc:badge'

/**
 * Badge label. Four characters fit on the button, so the unit scales with recorded duration from
 * seconds to minutes to hours.
 */
export function formatBadge(seconds: number): string {
  // Under one second there is nothing to save yet, and `0s` would imply otherwise.
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
 * The badge of one tab: how many seconds are on offer, or that nothing is being recorded here.
 *
 * Both states matter: with the mode set to `Off`, or this host
 * on the deny list, an empty badge and a badge over a page with no video on it look exactly the
 * same — and the first of them is a decision the user made and can unmake, while the second is
 * a page with nothing on it.
 *
 * The length is asked of the frames the tab has named and of the main one, and not of every frame
 * as the popup asks: on a page carrying an embedded player the recording lives in the frame of
 * the embed — that frame says so, and it is asked.
 */
async function badgeTextFor(tabId: number): Promise<string> {
  try {
    const [settings, tab] = await Promise.all([readSettings(), chrome.tabs.get(tabId)])
    // An address only where there is one. A chrome:// page, the extension gallery, a tab opened
    // before this extension was installed: `<all_urls>` does not cover them and Chrome hands back
    // a tab with no url at all. `off` there would say the user had switched something off, and
    // what is actually the matter is that there is nothing here to switch off — which is what an
    // empty badge says, and what such a tab gets from the count below anyway.
    if (tab.url && !siteAllows(settings, tab.url)) return 'off'

    const answer = await listTabSessions(tabId, framesToAsk(tabId))
    remember(tabId, answer.sessions)
    return formatBadge(answer.sessions[0]?.duration ?? 0)
  } catch {
    // Reached from two places now, where before there was none: `chrome.tabs.get` refuses over a
    // tab that closed while the poll was running, and everything under `listTabSessions` catches
    // its own failures. `readSettings` is not one of them — it answers the defaults rather than
    // throwing. This is the last place a failure can be answered: a service worker has nobody to
    // hand a rejection to, and an unhandled one goes into the extension's error list and wakes
    // the worker to put it there. Nothing is known about the tab after a failure, and an empty
    // badge is what nothing looks like.
    return ''
  }
}

/** Counts the badge of one tab and puts it on that tab. */
async function recount(tabId: number): Promise<void> {
  const text = await badgeTextFor(tabId)

  // A badge belongs to one tab; other tabs have their own recording or none. The tab may also
  // close while the query is running, leaving nowhere to set the badge.
  await chrome.action.setBadgeText({ tabId, text }).catch(() => undefined)
}

/**
 * The repair, asked for and let go of.
 *
 * Whatever goes wrong inside it is answered here, for the reason badgeTextFor gives: a service
 * worker has nobody to hand a rejection to, and an unhandled one goes into the extension's error
 * list and wakes the worker to put it there. There is nothing to be done about a repair that
 * could not run — the index is believed until the next start, which is when it is checked again.
 */
const repairQuietly = (): void => {
  // The grace is passed rather than left to the default, so that "a file younger than this is not
  // an orphan" is readable here, where the repair is asked for.
  void repair(liveIo(), ORPHAN_GRACE_MS).catch(() => undefined)
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#b7f03f' })
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES })
  chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_PERIOD_MINUTES })
  // An update is a start like any other: the index may name pieces of a build that wrote them
  // differently, and the walk that finds out costs a second, once.
  repairQuietly()
})

// The browser has started. This is the one moment the index is checked against the disk: after a
// crash they disagree, and everything else in the program believes the index.
chrome.runtime.onStartup.addListener(() => {
  repairQuietly()
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SWEEP_ALARM) {
    // Swallowed here for the same reason the repair's failure is: nothing can be done about a
    // pass that would not run, and the next one is a minute away.
    await sweep(liveIo()).catch(() => undefined)
    return
  }

  if (alarm.name !== BADGE_ALARM) return

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = tab?.id
  if (tabId === undefined) return

  await recount(tabId)
})

/**
 * Everything any part of the extension sends the worker arrives here, and two protocols meet in
 * it: a request from another context of the extension (`ExtensionToWorker` — sweep, clear), taken
 * by the branch at the top, and the word a frame says about itself, which the rest of this
 * describes.
 *
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isExtensionToWorker(message)) {
    if (message.type === 'tc:sweep') {
      // A refusal by the browser comes first and separately: it lowers the effective ceiling to
      // below what is occupied, so that the sweep below has something to take, and it writes the
      // refusal into the index — the one place that outlives this worker. That mark is what the
      // settings page and popup use to say "disk full"; until they
      // read it, a refusal is recorded rather than shown, which is still not the silent retry
      // every thirty seconds.
      void (message.full ? markStorageFull(Date.now()) : Promise.resolve())
        .then(() => sweep(liveIo()))
        .catch(() => undefined)
      return false
    }
    // Everything, gone: the files first and the index after, so that a failure halfway leaves
    // orphans for the repair rather than rows promising material that is not there.
    void clearStorage()
      .then(async () => {
        for (const row of await listSessions(Number.MAX_SAFE_INTEGER, true)) {
          await dropSessionRows(row.id)
        }
        for (const row of await listSnapshots()) await dropSnapshotRow(row.id)
        // And the refusal the index remembers, last of all. It is a fact about material that is
        // no longer there: the browser said no over a store that is now empty, and the mark left
        // behind would put "disk full" back over nothing at the next reading of the index. The
        // page hides that banner the moment it asks for the wipe, so the lie would keep until
        // then — see the button in src/options/options.tsx.
        await clearStorageFull()
      })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }

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
