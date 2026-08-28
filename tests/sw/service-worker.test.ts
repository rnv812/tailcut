import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SessionSummary } from '../../src/shared/protocol'

const summary = (duration: number): SessionSummary => ({
  key: 'https://site.example/watch|avc1|inf',
  url: 'https://site.example/watch',
  title: 'Clip',
  duration,
  bytes: 1_543_210,
  lastAt: 1_700_000_000_000,
})

/** The main frame of a tab, and a frame holding an embedded player. */
const TOP = 0
const EMBED = 4

type Alarm = { name: string; options: unknown }
type BadgeText = { tabId?: number; text: string }
type Sent = { tabId: number; message: unknown; options: unknown }
/** What Chrome puts on a message of a content script: the tab and the frame it came from. */
type Sender = { tab: { id: number }; frameId: number }
type MessageListener = (message: unknown, sender: Sender) => unknown

/**
 * The active tab of a neighbouring window. A user has several windows open, and Chrome lists tabs
 * by window: answering a query without `currentWindow`, the neighbouring window comes before the
 * current one, and its tab ends up first in the list.
 */
const OTHER_WINDOW_TAB = { id: 42 }

/**
 * A background tab of the current window. Answering a query without `active` it comes before the
 * active one: the tabs of one window are listed left to right.
 */
const BACKGROUND_TAB = { id: 5 }

/** What the tab query is narrowed by: exactly the fields the extension uses. */
type QueryInfo = { active?: boolean; currentWindow?: boolean }

/**
 * Replaces chrome for the service worker: it hangs its listeners when the module loads, and the
 * browser calls them later. Here the test calls them — the installation and the alarm going off.
 *
 * The tabs are given as a list: these are the active tabs of the current window. Beside them live
 * a neighbouring window and a background tab — the query has to sift those out itself.
 *
 * A tab answers per frame, not as a whole: both content scripts are declared with all_frames and
 * each frame keeps a registry of its own.
 */
function installChrome(
  options: {
    tabs?: Array<{ id?: number }>
    reply?: unknown
    /** What each frame of the tab answers, by frame number; the reply above is the main frame's. */
    frames?: Record<number, unknown>
  } = {},
) {
  const alarms: Alarm[] = []
  const badgeText: BadgeText[] = []
  const badgeColor: unknown[] = []
  const sent: Sent[] = []
  const installed: Array<() => void> = []
  const alarmFired: Array<(alarm: { name: string }) => Promise<void> | void> = []
  const messaged: MessageListener[] = []
  const tabClosed: Array<(tabId: number) => void> = []
  /** Enumerations of the frames of a tab: what the badge used to pay on every recount. */
  const injections: unknown[] = []

  const tabs = options.tabs ?? [{ id: 7 }]
  const reply: unknown = 'reply' in options ? options.reply : { sessions: [summary(6)] }
  const frames: Record<number, unknown> = options.frames ?? { [TOP]: reply }
  let failure: Error | null = null
  let badgeFailure: Error | null = null

  vi.stubGlobal('chrome', {
    runtime: {
      onInstalled: { addListener: (fn: () => void) => installed.push(fn) },
      onMessage: { addListener: (fn: MessageListener) => messaged.push(fn) },
    },
    scripting: {
      executeScript: async (options: unknown) => {
        injections.push(options)
        return Object.keys(frames).map((id) => ({ frameId: Number(id), result: true }))
      },
    },
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
      query: async (info: QueryInfo = {}) => [
        ...(info.currentWindow ? [] : [OTHER_WINDOW_TAB]),
        ...(info.active ? [] : [BACKGROUND_TAB]),
        ...tabs,
      ],
      sendMessage: async (tabId: number, message: unknown, opts: { frameId?: number } = {}) => {
        sent.push({ tabId, message, options: opts })
        if (failure) throw failure
        return frames[opts.frameId ?? TOP]
      },
      onRemoved: { addListener: (fn: (tabId: number) => void) => tabClosed.push(fn) },
    },
  })

  return {
    alarms,
    badgeText,
    badgeColor,
    sent,
    injections,
    install: () => {
      for (const listener of installed) listener()
    },
    fire: async (name = 'tc:badge') => {
      for (const listener of alarmFired) await listener({ name })
    },
    /**
     * A frame of a tab says it has something recorded in it, the way the content script does.
     *
     * The tab and the frame come from Chrome and not from the message: a page can write neither.
     */
    announce: async (frameId: number, tabId = 7) => {
      for (const listener of messaged) listener({ type: 'tc:recording' }, { tab: { id: tabId }, frameId })
      // The listener answers nothing and counts the badge on its own time; the count is a round
      // trip to the tab, and the test has to let it finish.
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    /** The same, with a message of somebody else's making. */
    announceRaw: async (message: unknown, frameId: number, tabId = 7) => {
      for (const listener of messaged) listener(message, { tab: { id: tabId }, frameId })
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    /** Chrome says the tab is gone. */
    closeTab: (tabId = 7) => {
      for (const listener of tabClosed) listener(tabId)
    },
    /** A page with no content script: sendMessage refuses with "receiving end does not exist". */
    breakTab: () => {
      failure = new Error('Could not establish connection. Receiving end does not exist.')
    },
    /** The tab closed while the poll was running: there is nobody left to badge. */
    breakBadge: () => {
      badgeFailure = new Error('No tab with id: 7.')
    },
  }
}

async function importWorker() {
  vi.resetModules()
  return import('../../src/sw/service-worker')
}

/**
 * The same worker with the road to the tab replaced by a refusal.
 *
 * Everything under badgeTextFor swallows its own errors today, so a failure has to be put there
 * to be answered: what this pins is that the worker survives one, not that one is waiting. A
 * service worker has nobody to hand an unhandled rejection to — the browser writes it into the
 * extension's error list and wakes the worker to do it.
 */
async function importWorkerThatCannotAsk(failure: Error) {
  vi.resetModules()
  vi.doMock('../../src/shared/frames', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/shared/frames')>()),
    listTabSessions: () => Promise.reject(failure),
  }))
  return import('../../src/sw/service-worker')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('../../src/shared/frames')
  vi.resetModules()
})

describe('installation', () => {
  it('paints the badge and sets the alarm that recounts it', async () => {
    const chrome = installChrome()
    await importWorker()

    chrome.install()

    expect(chrome.badgeColor).toEqual([{ color: '#4c8dff' }])
    expect(chrome.alarms).toHaveLength(1)
    expect(chrome.alarms[0]!.name).toBe('tc:badge')
  })

  it('sets a repeating alarm: the recount outlives the sleep of the worker', async () => {
    const chrome = installChrome()
    await importWorker()

    chrome.install()

    // A one-shot alarm (delayInMinutes/when) would set the badge exactly once, and a setInterval
    // would fall asleep with the worker after half a minute of idling.
    const options = chrome.alarms[0]!.options as { periodInMinutes?: number }
    expect(options.periodInMinutes, 'the alarm does not repeat').toBeGreaterThan(0)
    expect(options.periodInMinutes, 'the badge lags the recording by over half a minute').toBeLessThan(
      0.5,
    )
  })
})

describe('recounting the badge', () => {
  it('asks the active tab and badges that tab', async () => {
    const chrome = installChrome()
    await importWorker()

    await chrome.fire()

    expect(chrome.sent).toEqual([
      { tabId: 7, message: { type: 'tc:list' }, options: { frameId: 0 } },
    ])
    // A badge without a tabId is global: the recording of one tab would show on all the others.
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '6s' }])
  })

  it('counts by the active tab of the current window, not of a neighbouring one', async () => {
    const chrome = installChrome()
    await importWorker()

    await chrome.fire()

    // Two windows are open, and a query without currentWindow gives back the active tab of each —
    // somebody else's first. The badge is then counted from somebody else's recording and put on
    // somebody else's tab, while the one the user is sitting on freezes at its previous value.
    expect(chrome.sent.map((item) => item.tabId)).toEqual([7])
    expect(chrome.badgeText.map((item) => item.tabId)).toEqual([7])
  })

  it('leaves an alarm of somebody else alone', async () => {
    const chrome = installChrome()
    await importWorker()

    await chrome.fire('tc:something-else')

    expect(chrome.sent).toEqual([])
    expect(chrome.badgeText).toEqual([])
  })

  it('shows an empty badge on a tab with no recording', async () => {
    const chrome = installChrome({ reply: { sessions: [] } })
    await importWorker()

    await chrome.fire()

    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '' }])
  })

  it('badges the length that would be saved, not the length that was watched', async () => {
    // The badge reads the very summary the popup shows, and `duration` in it is the length of the
    // file "Save all" would write — see summarize(). A session whose material cannot be cut into
    // a clip at all badges nothing, however many megabytes stand behind it.
    const chrome = installChrome({ reply: { sessions: [{ ...summary(0), omits: 'track' as const }] } })
    await importWorker()

    await chrome.fire()

    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '' }])
  })

  it('wipes the badge on a tab with no content script', async () => {
    const chrome = installChrome()
    chrome.breakTab()
    await importWorker()

    await chrome.fire()

    // chrome://, the extension store, a tab older than the installation. Leave the badge as it is
    // and somebody else's time would be showing on it.
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '' }])
  })

  it('sets nothing when there is no active tab', async () => {
    const chrome = installChrome({ tabs: [] })
    await importWorker()

    await chrome.fire()

    expect(chrome.sent).toEqual([])
    expect(chrome.badgeText).toEqual([])
  })

  it('does not fall over on a tab that closed', async () => {
    const chrome = installChrome()
    chrome.breakBadge()
    await importWorker()

    // The tab manages to close while the poll is running: setBadgeText refuses with a promise,
    // and an unhandled rejection would wake the worker with an error message.
    await expect(chrome.fire()).resolves.toBeUndefined()
  })

  it('does not let a failure below it out as an unhandled rejection', async () => {
    const chrome = installChrome()
    await importWorkerThatCannotAsk(new Error('the frames of the tab could not be asked'))

    // Nothing on the way to the tab throws today: every step below has a catch of its own. That
    // is a property of the code under this one and not a promise it can make for itself, and the
    // alarm listener is the last place a rejection can be answered before the browser sees it.
    await expect(chrome.fire()).resolves.toBeUndefined()

    // And the badge says what is known, which after a failure is nothing.
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '' }])
  })

  it('counts a recording that lives in a frame the page only embeds', async () => {
    const chrome = installChrome({
      frames: { [TOP]: { sessions: [] }, [EMBED]: { sessions: [summary(12)] } },
    })
    await importWorker()

    // The frame says it has something; that is how the badge learns of a frame at all.
    await chrome.announce(EMBED)
    await chrome.fire()

    // The badge is the only sign that anything is being recorded at all. On a page carrying an
    // embedded player the recording lives in the frame of the embed, and a badge counted off the
    // top frame alone stayed empty over a tab that had four megabytes of video in it.
    expect(chrome.badgeText.at(-1)).toEqual({ tabId: 7, text: '12s' })
  })

  it('counts a frame the moment it says it has something, without waiting for the alarm', async () => {
    const chrome = installChrome({
      frames: { [TOP]: { sessions: [] }, [EMBED]: { sessions: [summary(12)] } },
    })
    await importWorker()

    await chrome.announce(EMBED)

    // The recording that has just been announced is the news the badge exists for. Left to the
    // alarm it would show up a period later, and a period of nothing over a page that is
    // recording is a period the user has no reason to open the popup in.
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '12s' }])
  })

  it('asks the frames of a crowded page that have something, and the main one, and no others', async () => {
    // A news page: one player, and 153 frames of advertising and analytics around it.
    const frames: Record<number, unknown> = { [TOP]: { sessions: [] }, [EMBED]: { sessions: [summary(12)] } }
    for (let frameId = 100; frameId < 253; frameId++) frames[frameId] = { sessions: [] }

    const chrome = installChrome({ frames })
    await importWorker()

    await chrome.announce(EMBED)
    chrome.sent.length = 0
    chrome.injections.length = 0

    await chrome.fire()

    // Enumerating the frames and asking every one cost 154 injections and 154 messages here, ten
    // seconds apart, on a tab whose recording is one frame — 60 to 90 ms of extension work per
    // recount for a page that mostly has no video in it at all.
    expect(chrome.injections, 'the badge enumerates the frames of the tab again').toEqual([])
    expect(chrome.sent.map((item) => (item.options as { frameId: number }).frameId)).toEqual([
      TOP,
      EMBED,
    ])
    expect(chrome.badgeText.at(-1)).toEqual({ tabId: 7, text: '12s' })
  })

  it('asks the main frame of a tab that has said nothing, and nobody else', async () => {
    const frames: Record<number, unknown> = { [TOP]: { sessions: [summary(6)] } }
    for (let frameId = 100; frameId < 253; frameId++) frames[frameId] = { sessions: [] }

    const chrome = installChrome({ frames })
    await importWorker()

    await chrome.fire()

    // The main frame is asked whether it announced itself or not: it is one message, it is where
    // the player is on nearly every page that has one, and it is the whole answer a worker that
    // has just restarted has — the frames repeat themselves, but one that has stopped recording
    // and gone quiet would not.
    expect(chrome.sent.map((item) => (item.options as { frameId: number }).frameId)).toEqual([TOP])
    expect(chrome.injections).toEqual([])
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '6s' }])
  })

  it('stops asking a frame that has nothing left in it', async () => {
    // The embed answers once and is empty by the next recount: triage evicted its session, or the
    // page replaced the iframe.
    const frames: Record<number, unknown> = { [TOP]: { sessions: [] }, [EMBED]: { sessions: [summary(12)] } }
    const chrome = installChrome({ frames })
    await importWorker()

    await chrome.announce(EMBED)
    frames[EMBED] = { sessions: [] }
    await chrome.fire()
    chrome.sent.length = 0

    await chrome.fire()

    // Kept, the numbers of frames that once recorded would gather for as long as the tab stayed
    // open — a page that opens a player in a fresh frame every few minutes would bring the cost
    // back one frame at a time. It says so again if it has something again.
    expect(chrome.sent.map((item) => (item.options as { frameId: number }).frameId)).toEqual([TOP])
    expect(chrome.badgeText.at(-1)).toEqual({ tabId: 7, text: '' })
  })

  it('forgets the frames of a tab that has closed', async () => {
    const chrome = installChrome({
      frames: { [TOP]: { sessions: [] }, [EMBED]: { sessions: [summary(12)] } },
    })
    await importWorker()

    await chrome.announce(EMBED)
    chrome.closeTab()
    chrome.sent.length = 0

    // The numbers of a closed tab are never asked for again, so nothing breaks without this —
    // but the map would grow by an entry per recording for as long as the browser stayed open.
    await chrome.fire()
    expect(chrome.sent.map((item) => (item.options as { frameId: number }).frameId)).toEqual([TOP])
  })

  it('does not recount a frame it already knows about', async () => {
    const chrome = installChrome({
      frames: { [TOP]: { sessions: [] }, [EMBED]: { sessions: [summary(12)] } },
    })
    await importWorker()

    await chrome.announce(EMBED)
    chrome.sent.length = 0

    // A frame repeats itself every ten seconds so that a worker which restarted learns of it
    // again. Counting the badge on each of those would double what the alarm already pays.
    await chrome.announce(EMBED)
    expect(chrome.sent).toEqual([])
  })

  it('takes no notice of a message that is not one of ours', async () => {
    const chrome = installChrome()
    await importWorker()

    await chrome.announceRaw({ type: 'tc:something-else' }, EMBED)

    expect(chrome.sent).toEqual([])
    expect(chrome.badgeText).toEqual([])
  })

  it('takes the freshest session of the tab', async () => {
    const chrome = installChrome({ reply: { sessions: [summary(12), summary(300)] } })
    await importWorker()

    await chrome.fire()

    // The list comes newest first: on the badge is what is being recorded right now.
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '12s' }])
  })
})

describe('formatBadge', () => {
  it.each([
    [0, ''],
    [0.4, ''],
    // Under a second there is nothing to record, and "0s" on the button would promise otherwise.
    [0.99, ''],
    // The length comes out of a foreign parse, and the number in it is sometimes not a number.
    // The fork is written so that NaN goes to an empty caption: "NaNh" on the button is no
    // caption at all.
    [NaN, ''],
    [1, '1s'],
    [6, '6s'],
    [6.4, '6s'],
    [59, '59s'],
    // Seconds are rounded rather than dropped: a quarter to a minute is already a minute here.
    [59.7, '1m'],
    [60, '1m'],
    [95, '2m'],
    [3599, '60m'],
    [3600, '1h'],
    [7000, '2h'],
  ])('%s seconds → "%s"', async (seconds, expected) => {
    installChrome()
    const { formatBadge } = await importWorker()

    expect(formatBadge(seconds)).toBe(expected)
  })

  it('writes no more than four characters on the badge', async () => {
    installChrome()
    const { formatBadge } = await importWorker()

    // More does not fit on the button: Chrome trims the caption itself, without warning. The
    // upper bound is four days of recording: a buffer in memory does not live longer.
    for (const seconds of [1, 59, 60, 3599, 3600, 36_000, 359_940]) {
      expect(formatBadge(seconds).length, `${seconds} seconds`).toBeLessThanOrEqual(4)
    }
  })
})
