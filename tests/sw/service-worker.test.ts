import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { SessionSummary } from '../../src/shared/protocol'
import { ORPHAN_GRACE_MS, SWEEP_ALARM } from '../../src/sw/sweeper'

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
type MessageListener = (
  message: unknown,
  sender: Sender,
  sendResponse: (answer: unknown) => void,
) => unknown

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
    /**
     * The address chrome.tabs.get gives for the tab; `null` — a tab that answers without one.
     *
     * Chrome hands back a url only where the extension may read it: `<all_urls>` covers http and
     * https and nothing else, so a chrome:// page or the extension gallery arrives with the field
     * missing altogether.
     */
    url?: string | null
    /** What is stored under the settings key; nothing — the defaults of §7.4. */
    settings?: unknown
  } = {},
) {
  const alarms: Alarm[] = []
  const badgeText: BadgeText[] = []
  const badgeColor: unknown[] = []
  const sent: Sent[] = []
  const installed: Array<() => void> = []
  const started: Array<() => void> = []
  const alarmFired: Array<(alarm: { name: string }) => Promise<void> | void> = []
  const messaged: MessageListener[] = []
  const tabClosed: Array<(tabId: number) => void> = []
  /** Enumerations of the frames of a tab: what the badge used to pay on every recount. */
  const injections: unknown[] = []

  const tabs = options.tabs ?? [{ id: 7 }]
  const reply: unknown = 'reply' in options ? options.reply : { sessions: [summary(6)] }
  const frames: Record<number, unknown> = options.frames ?? { [TOP]: reply }
  const address = options.url === undefined ? 'https://site.example/watch' : options.url
  let failure: Error | null = null
  let badgeFailure: Error | null = null
  let tabGone: Error | null = null

  vi.stubGlobal('chrome', {
    runtime: {
      onInstalled: { addListener: (fn: () => void) => installed.push(fn) },
      onStartup: { addListener: (fn: () => void) => started.push(fn) },
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
    storage: {
      local: {
        get: async (key: string) =>
          options.settings === undefined ? {} : { [key]: options.settings },
      },
    },
    tabs: {
      get: async (id: number) => {
        if (tabGone) throw tabGone
        return { id, ...(address === null ? {} : { url: address }) }
      },
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
    /** The browser has started: the one moment the index is checked against the disk. */
    start: () => {
      for (const listener of started) listener()
    },
    /**
     * A message from another context of the extension — the popup, the writer in a frame —
     * rather than from a content script announcing itself.
     *
     * Gives back what the listener answered and whether it held the channel open to answer late,
     * because those are two different promises to the sender: `true` says a reply is coming, and
     * a sender awaiting one that never comes is the port closing under it.
     */
    ask: async (message: unknown) => {
      let answer: unknown
      let held = false
      const reply = (value: unknown) => {
        answer = value
      }
      for (const listener of messaged) {
        if (listener(message, { tab: { id: 7 }, frameId: TOP }, reply) === true) held = true
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      return { answer, held }
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
      for (const listener of messaged) {
        listener({ type: 'tc:recording' }, { tab: { id: tabId }, frameId }, () => undefined)
      }
      // The listener answers nothing and counts the badge on its own time; the count is a round
      // trip to the tab, and the test has to let it finish.
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    /** The same, with a message of somebody else's making. */
    announceRaw: async (message: unknown, frameId: number, tabId = 7) => {
      for (const listener of messaged) listener(message, { tab: { id: tabId }, frameId }, () => undefined)
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
    /** The same tab, gone one step earlier: chrome.tabs.get refuses to say anything about it. */
    breakTabLookup: () => {
      tabGone = new Error('No tab with id: 7.')
    },
  }
}

/**
 * What the worker asked of the sweeper and of the index, in the order it asked.
 *
 * The service worker is wiring and nothing else: what sweeping and repairing actually do is
 * settled in tests/sw/sweeper.test.ts against fakes of the disk. Here the two are replaced
 * outright, because the real ones open IndexedDB and walk OPFS, and neither exists in a runner —
 * and because the order is the thing worth pinning. A refusal by the browser has to lower the
 * ceiling *before* the sweep, or the pass it starts finds nothing over a ceiling nobody reached.
 */
const asked = {
  log: [] as string[],
  repairs: [] as number[],
  /** What sweeping or repairing refuses with; null — it works. */
  fail: null as Error | null,
}

const SESSION_ROWS = [{ id: 'kept' }, { id: 'gone' }]
const SNAPSHOT_ROWS = [{ id: 'snap' }]

/**
 * The sweeper and the index, replaced. `liveIo` gives back nothing at all: the doubles below
 * never look at it, and the real one would reach for IndexedDB the moment it was built.
 */
function mockStorage() {
  vi.doMock('../../src/sw/sweeper', () => ({
    SWEEP_ALARM,
    SWEEP_PERIOD_MINUTES: 1,
    ORPHAN_GRACE_MS,
    liveIo: () => ({}),
    sweep: async () => {
      asked.log.push('sweep')
      if (asked.fail) throw asked.fail
      return { freed: 0, sessions: 0, pieces: 0, snapshots: 0 }
    },
    repair: async (_io: unknown, graceMs: number) => {
      asked.log.push('repair')
      asked.repairs.push(graceMs)
      if (asked.fail) throw asked.fail
      return { rows: 0, orphans: 0 }
    },
  }))

  vi.doMock('../../src/shared/history-db', () => ({
    markStorageFull: async (now: number) => void asked.log.push(`full:${now > 0}`),
    listSessions: async () => SESSION_ROWS,
    listSnapshots: async () => SNAPSHOT_ROWS,
    dropSessionRows: async (id: string) => void asked.log.push(`drop:${id}`),
    dropSnapshotRow: async (id: string) => void asked.log.push(`drop-snapshot:${id}`),
    clearStorageFull: async () => void asked.log.push('clear-full'),
  }))

  vi.doMock('../../src/shared/history-opfs', () => ({
    clearStorage: async () => void asked.log.push('clear'),
  }))
}

async function importWorker() {
  vi.resetModules()
  mockStorage()
  return import('../../src/sw/service-worker')
}

/** Runs `work` with an ear on rejections nobody caught, and gives back what escaped. */
async function looseRejections(work: () => void): Promise<unknown[]> {
  const loose: unknown[] = []
  const listen = (reason: unknown) => loose.push(reason)
  process.on('unhandledRejection', listen)
  try {
    work()
    // An unhandled rejection is reported at the end of the turn the promise was rejected in, so
    // the turn has to be let go of first.
    await new Promise((resolve) => setTimeout(resolve, 10))
  } finally {
    process.off('unhandledRejection', listen)
  }
  return loose
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
  mockStorage()
  vi.doMock('../../src/shared/frames', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/shared/frames')>()),
    listTabSessions: () => Promise.reject(failure),
  }))
  return import('../../src/sw/service-worker')
}

beforeEach(() => {
  asked.log = []
  asked.repairs = []
  asked.fail = null
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('../../src/shared/frames')
  vi.doUnmock('../../src/sw/sweeper')
  vi.doUnmock('../../src/shared/history-db')
  vi.doUnmock('../../src/shared/history-opfs')
  vi.resetModules()
})

describe('installation', () => {
  it('paints the badge and sets the alarm that recounts it', async () => {
    const chrome = installChrome()
    await importWorker()

    chrome.install()

    expect(chrome.badgeColor).toEqual([{ color: '#4c8dff' }])
    expect(chrome.alarms.map((alarm) => alarm.name)).toContain('tc:badge')
  })

  it('sets a repeating alarm: the recount outlives the sleep of the worker', async () => {
    const chrome = installChrome()
    await importWorker()

    chrome.install()

    // A one-shot alarm (delayInMinutes/when) would set the badge exactly once, and a setInterval
    // would fall asleep with the worker after half a minute of idling.
    const badge = chrome.alarms.find((alarm) => alarm.name === 'tc:badge')!
    const options = badge.options as { periodInMinutes?: number }
    expect(options.periodInMinutes, 'the alarm does not repeat').toBeGreaterThan(0)
    expect(options.periodInMinutes, 'the badge lags the recording by over half a minute').toBeLessThan(
      0.5,
    )
  })

  it('sets the alarm that wakes the sweeper too, and sets it repeating', async () => {
    const chrome = installChrome()
    await importWorker()

    chrome.install()

    // The keeping and the ceiling of §7.4 must not depend on whether a tab is open, and the
    // sweeper is the one context that exists when none is. Without an alarm of its own it would
    // run only when something nudged it — that is, only while somebody was recording.
    const sweeping = chrome.alarms.find((alarm) => alarm.name === SWEEP_ALARM)
    expect(sweeping, 'nothing wakes the sweeper on its own').toBeDefined()
    const options = sweeping!.options as { periodInMinutes?: number }
    expect(options.periodInMinutes, 'the sweep does not repeat').toBeGreaterThan(0)
  })

  it('checks the index against the disk when the browser starts', async () => {
    const chrome = installChrome()
    await importWorker()

    chrome.start()
    await Promise.resolve()

    // After a crash the index and the disk disagree, and everything else in the program believes
    // the index. The grace is passed at the call rather than left to the default, so that the
    // delay is readable where the repair is asked for.
    expect(asked.repairs).toEqual([ORPHAN_GRACE_MS])
  })

  it('checks it on an install and an update as well', async () => {
    const chrome = installChrome()
    await importWorker()

    chrome.install()
    await Promise.resolve()

    // An update is a start like any other: the index may name pieces of a build that wrote them
    // differently.
    expect(asked.repairs).toEqual([ORPHAN_GRACE_MS])
  })

  it('lets no failure of the repair out as an unhandled rejection', async () => {
    const chrome = installChrome()
    await importWorker()
    asked.fail = new Error('the index would not open')

    const loose = await looseRejections(() => chrome.start())

    // A service worker has nobody to hand a rejection to: an unhandled one goes into the
    // extension's error list and wakes the worker to put it there. There is nothing to be done
    // about a repair that would not run — the next start checks again.
    expect(loose, 'a rejection escaped into the browser').toEqual([])
  })
})

describe('sweeping', () => {
  it('sweeps when its alarm goes off, and counts no badge for it', async () => {
    const chrome = installChrome()
    await importWorker()

    await chrome.fire(SWEEP_ALARM)

    expect(asked.log).toEqual(['sweep'])
    // Two alarms and one listener, which must not count the badge on this one: it would ask the
    // active tab for a list every minute the sweeper woke, and put the answer on that tab. Two
    // things keep it from happening — the sweep branch returns, and the badge asks for its own
    // name — and this stays green while either of them does.
    expect(chrome.sent).toEqual([])
    expect(chrome.badgeText).toEqual([])
  })

  it('does not sweep on the alarm that counts the badge', async () => {
    const chrome = installChrome()
    await importWorker()

    await chrome.fire()

    expect(asked.log).toEqual([])
  })

  it('lets no failure of a sweep out as an unhandled rejection', async () => {
    const chrome = installChrome()
    await importWorker()
    asked.fail = new Error('the disk would not answer')

    // The alarm listener is the last place a rejection can be answered before the browser sees
    // it, and the next pass is a minute away.
    await expect(chrome.fire(SWEEP_ALARM)).resolves.toBeUndefined()
  })

  it('lowers the ceiling before sweeping when the writer says storage refused it', async () => {
    const chrome = installChrome()
    await importWorker()

    const { held } = await chrome.ask({ type: 'tc:sweep', full: true })

    // The order is the whole of it. A refusal below our own ceiling leaves `bytes - ceiling`
    // negative, so a sweep started first finds nothing to take and the writer is refused again in
    // thirty seconds — for ever, and without a word in the interface (§11).
    expect(asked.log).toEqual(['full:true', 'sweep'])
    // Nothing is answered, and the channel must not be held: a listener returning true would
    // leave the writer waiting on a reply that never comes.
    expect(held, 'the channel was held open over an answer nobody sends').toBe(false)
  })

  it('takes a nudge that claims nothing as a nudge', async () => {
    const chrome = installChrome()
    await importWorker()

    // The popup sends one after a deletion whose undo has expired. It has not been refused
    // anything, and lowering the ceiling on its word would throw away recordings nobody asked to
    // lose.
    await chrome.ask({ type: 'tc:sweep' })

    expect(asked.log).toEqual(['sweep'])
  })

  it('clears the files first and the rows after, and answers when it is done', async () => {
    const chrome = installChrome()
    await importWorker()

    const { answer, held } = await chrome.ask({ type: 'tc:clear' })

    // Rows first would leave rows promising material that is not there if the wipe stopped
    // halfway; files first leaves orphans, and the repair takes those. The refusal the index
    // remembers goes last and it has to go: "disk full" is a fact about material that is no
    // longer there, and left behind it comes back over an empty store on the next reload — the
    // page hides the banner on the spot, so nobody sees it happen until then.
    expect(asked.log).toEqual([
      'clear',
      'drop:kept',
      'drop:gone',
      'drop-snapshot:snap',
      'clear-full',
    ])
    // The button of §9.4 waits on this: without the channel held open the popup would be told
    // the port closed under it.
    expect(held).toBe(true)
    expect(answer).toEqual({ ok: true })
  })

  it('is not moved by a message that belongs to somebody else', async () => {
    const chrome = installChrome()
    await importWorker()

    // Everything every part of the extension sends arrives here: what a tab announces about
    // itself, what the popup asks a tab for, and the answers travelling back.
    for (const message of [{ type: 'tc:ping' }, { type: 'tc:list' }, { type: 'tc:recording' }]) {
      await chrome.ask(message)
    }

    expect(asked.log).toEqual([])
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

  it('says the recording is off on a host the user denied', async () => {
    const chrome = installChrome({ settings: { recording: { deny: ['site.example'] } } })
    await importWorker()

    await chrome.fire()

    // §9.1 asks for this, and it is not decoration: over a denied host an empty badge and a badge
    // over a page with no video on it look exactly the same, and the first of them is a decision
    // the user made and can unmake.
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: 'off' }])
  })

  it('says it is off with the mode set to Off, over a tab that is holding something', async () => {
    const chrome = installChrome({ settings: { recording: { mode: 'off' } } })
    await importWorker()

    await chrome.fire()

    // The frame answers six seconds — a page loaded before the switch was thrown still holds what
    // it gathered, because switching recording off is not an erasure (§7.2). What the badge says
    // is about the switch, and the popup is where the six seconds are still offered.
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: 'off' }])
  })

  it('badges the length on a host the allow list names', async () => {
    const chrome = installChrome({
      settings: { recording: { mode: 'allowlist', allow: ['site.example'] } },
    })
    await importWorker()

    await chrome.fire()

    // The address of the tab and not a constant: under `Only on these sites` these very settings
    // answer `off` for every host but this one.
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '6s' }])
  })

  it('leaves the badge empty on a tab whose address it cannot read', async () => {
    const chrome = installChrome({ url: null, reply: { sessions: [] } })
    await importWorker()

    await chrome.fire()

    // chrome://, the extension gallery, a tab older than the installation: Chrome gives no url
    // for them at all, and `siteAllows` refuses an address it cannot read. `off` here would say
    // the user had switched something off, and what is the matter is that there is nothing here
    // to switch off.
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

  it('does not fall over on a tab that closed before it could be asked about', async () => {
    const chrome = installChrome()
    chrome.breakTabLookup()
    await importWorker()

    // The first of the two things under the badge that refuse with a promise: chrome.tabs.get
    // over a tab that closed while the poll was running. Nothing is known about it afterwards —
    // not even whether the site is one the user records — and an empty badge is what nothing
    // looks like. An unhandled rejection here would go into the extension's error list and wake
    // the worker to put it there.
    await expect(chrome.fire()).resolves.toBeUndefined()

    expect(chrome.sent, 'a tab that is gone was asked for its sessions').toEqual([])
    expect(chrome.badgeText).toEqual([{ tabId: 7, text: '' }])
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
