import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { SessionSummary } from '../../src/shared/protocol'
import { DEFAULTS, merge, type Settings } from '../../src/shared/settings'

/**
 * The index of what is on disk and the store of settings, replaced outright: the first wants
 * IndexedDB and the second chrome.storage, and a runner has neither. Everything between them and
 * the answer this file checks is the real thing.
 */
let indexed: Array<Record<string, unknown>> = []
/** The limits the api asked the index for, in order: the popup shows a page and not a database. */
const asked: number[] = []
let totals = { id: 'totals', bytes: 0, cappedBytes: 0, fullAt: 0 }
/** An index the browser will not open at all: private browsing, a store it refused. */
let indexRefuses = false
const pinned: Array<[string, boolean]> = []
const stamped: Array<[string, number]> = []

let stored: Settings = DEFAULTS
const written: Settings[] = []

vi.mock('../../src/shared/history-db', () => ({
  listSessions: async (limit: number) => {
    asked.push(limit)
    if (indexRefuses) throw new Error('the store would not open')
    return indexed
  },
  readTotals: async () => {
    if (indexRefuses) throw new Error('the store would not open')
    return totals
  },
  setPinned: async (id: string, on: boolean) => {
    pinned.push([id, on])
  },
  setDeleted: async (id: string, at: number) => {
    stamped.push([id, at])
  },
}))

vi.mock('../../src/shared/settings-store', () => ({
  readSettings: async () => stored,
  writeSettings: async (edit: (current: Settings) => Settings) => {
    const before = stored
    await Promise.resolve()
    stored = merge(edit(before))
    written.push(stored)
    return stored
  },
}))

const PAGE_URL = 'https://site.example/watch?v=abc'

const summary: SessionSummary = {
  key: 'https://site.example/watch|avc1|inf',
  url: PAGE_URL,
  title: 'Clip — site.example',
  duration: 6,
  bytes: 1_543_210,
  lastAt: 1_700_000_000_000,
}

/**
 * The material of an embedded player: a session of the frame the embed stands in, not of the page
 * around it. Its address is the frame's own — the site the video is really coming from — and the
 * title of the page that embedded it is nowhere in it.
 */
const embedded: SessionSummary = {
  key: 'https://player.example/embed/xyz|vp09|inf',
  url: 'https://player.example/embed/xyz',
  title: 'A clip inside an article',
  duration: 27,
  bytes: 4_014_954,
  lastAt: 1_700_000_060_000,
}

/** The main frame of a tab. Chrome numbers it zero and numbers no other frame that. */
const TOP = 0

/** A frame holding an embedded player. Chrome hands out the numbers; nothing predicts them. */
const EMBED = 4

/** The summary as the popup keeps it: with the frame whose registry it came out of. */
const inFrame = (session: SessionSummary, frameId: number) => ({ ...session, frameId })

/** What the popup sent the tab: the message and its addressee inside it. */
type Sent = { tabId: number; message: unknown; options: unknown }

/** The save requests among everything the popup sent the tab, the list requests sifted out. */
const savesIn = (sent: Sent[]): Sent[] =>
  sent.filter((item) => (item.message as { type?: string }).type === 'tc:save')

/** The same sieve for the other request that has to find a particular frame: the freeze. */
const editsIn = (sent: Sent[]): Sent[] =>
  sent.filter((item) => (item.message as { type?: string }).type === 'tc:edit')

/** A snapshot name in the shape the bridge mints them: a randomUUID and nothing else. */
const SNAPSHOT = '0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31'

/**
 * The active tab of a neighbouring window. A user has several windows open, and Chrome lists
 * tabs by window: answering a query without `currentWindow`, the neighbouring window comes
 * before the current one, and its tab ends up first in the list.
 */
const OTHER_WINDOW_TAB = { id: 42 }

/**
 * A background tab of the current window. Answering a query without `active` it comes before the
 * active one: the tabs of one window are listed left to right.
 */
const BACKGROUND_TAB = { id: 5 }

/** What the tab query is narrowed by: exactly the fields the extension uses. */
type QueryInfo = { active?: boolean; currentWindow?: boolean }

/** What the popup asked chrome.scripting for: the tab to enumerate, and on what terms. */
type Injected = { tabId?: number; allFrames?: boolean }

/**
 * Replaces chrome for the popup. The tabs are given as a list: these are the active tabs of the
 * current window, and the first of them is what chrome.tabs.query gives back. Beside them live a
 * neighbouring window and a background tab — the query has to sift those out itself.
 *
 * A tab is not one addressee but one per frame: both content scripts are declared with
 * all_frames, every frame keeps a registry of its own, and the answers are given here per frame.
 * A frame may also be unreachable (no content script in it — about:blank, a sandboxed frame) or
 * silent (it hears the request and never answers), and the two are not the same thing.
 */
function installChrome(
  options: {
    tabs?: Array<{ id?: number; url?: string }>
    /** What each frame of the tab answers a list request with, by frame number. */
    frames?: Record<number, unknown>
    /** Frames that hear the request and never answer it. */
    silent?: number[]
    /** Shorthand for a tab of one frame: what the main frame answers. */
    listReply?: unknown
    saveReply?: unknown
    editReply?: unknown
    /** The frames of a tab that cannot be enumerated at all: chrome.scripting refuses. */
    blindToFrames?: boolean
  } = {},
) {
  const sent: Sent[] = []
  const injected: Injected[] = []
  let tabs: Array<{ id?: number; url?: string }> = options.tabs ?? [{ id: 7, url: PAGE_URL }]
  let frames: Record<number, unknown> =
    options.frames ??
    ({ [TOP]: 'listReply' in options ? options.listReply : { sessions: [summary] } })
  const silent = new Set(options.silent ?? [])
  let saveReply: unknown = 'saveReply' in options ? options.saveReply : { ok: true }
  let editReply: unknown =
    'editReply' in options ? options.editReply : { ok: true, snapshotId: SNAPSHOT }
  let failure: Error | null = null

  /** Tabs the popup opened: the editor over a snapshot, and the editor over the history. */
  const created: Array<{ url: string }> = []

  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://tailcut/${path}` },
    scripting: {
      executeScript: async (details: { target?: { tabId?: number; allFrames?: boolean } }) => {
        injected.push({ tabId: details.target?.tabId, allFrames: details.target?.allFrames })
        if (options.blindToFrames) throw new Error('Cannot access contents of the page.')
        // Backwards, because Chrome answers in the order the injections happened to finish and
        // the popup may not inherit that order: a list that came out differently on two openings
        // would move the session under the user's finger.
        return Object.keys(frames)
          .map((id) => ({ frameId: Number(id), result: true }))
          .sort((a, b) => b.frameId - a.frameId)
      },
    },
    tabs: {
      query: async (info: QueryInfo = {}) => [
        ...(info.currentWindow ? [] : [OTHER_WINDOW_TAB]),
        ...(info.active ? [] : [BACKGROUND_TAB]),
        ...tabs,
      ],
      create: async (options: { url: string }) => {
        created.push(options)
      },
      sendMessage: async (tabId: number, message: unknown, opts: { frameId?: number } = {}) => {
        sent.push({ tabId, message, options: opts })
        if (failure) throw failure
        if (silent.has(opts.frameId ?? TOP)) return new Promise(() => {})
        if ((message as { type?: string }).type === 'tc:save') return saveReply
        if ((message as { type?: string }).type === 'tc:edit') return editReply
        const reply = frames[opts.frameId ?? TOP]
        // A frame with no content script in it: Chrome finds nobody to deliver to and rejects.
        if (reply === undefined) throw new Error('Could not establish connection.')
        return reply
      },
    },
  })

  return {
    sent,
    injected,
    created,
    /** The user switched tabs while the popup was open. */
    switchTo: (id: number | undefined) => {
      tabs = [{ id }]
    },
    /** A page with no content script: sendMessage rejects with "receiving end does not exist". */
    breakTab: () => {
      failure = new Error('Could not establish connection. Receiving end does not exist.')
    },
    setListReply: (value: unknown) => {
      frames = { [TOP]: value }
    },
    setSaveReply: (value: unknown) => {
      saveReply = value
    },
    setEditReply: (value: unknown) => {
      editReply = value
    },
  }
}

/** The module remembers the tab between calls, so every test needs a fresh import. */
async function importApi() {
  vi.resetModules()
  return import('../../src/popup/api')
}

beforeEach(() => {
  indexed = []
  asked.length = 0
  totals = { id: 'totals', bytes: 0, cappedBytes: 0, fullAt: 0 }
  indexRefuses = false
  pinned.length = 0
  stamped.length = 0
  stored = DEFAULTS
  written.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('listSessions', () => {
  it('gives back the answer the tab sent', async () => {
    installChrome()
    const { listSessions } = await importApi()

    // With the frame it came out of beside it: the material of a session never leaves the frame
    // that gathered it, and a save has to find its way back to that same registry.
    expect(await listSessions()).toEqual({ sessions: [inFrame(summary, TOP)] })
  })

  it('carries back what the tab said about a page it cannot reach', async () => {
    const chrome = installChrome()
    chrome.setListReply({ sessions: [], unreachable: true })
    const { listSessions } = await importApi()

    // Not the same as an empty list: the popup shows one as "nothing to record here" and the
    // other as "this page cannot be recorded at all", and only the tab knows which it is.
    expect(await listSessions()).toEqual({ sessions: [], unreachable: true })
  })

  it('asks every frame of the active tab, each addressed', async () => {
    const chrome = installChrome({
      frames: { [TOP]: { sessions: [] }, 9: { sessions: [] }, [EMBED]: { sessions: [embedded] } },
    })
    const { listSessions } = await importApi()

    await listSessions()

    // Addressed, one frame at a time. A request with no frame in it goes round every frame at
    // once and Chrome hands back whichever answer arrived first: on a page carrying advertising
    // frames that is a stranger's empty list — which is why the top frame used to be asked alone,
    // and why a player inside an embed was invisible to the popup.
    expect(chrome.sent).toEqual([
      { tabId: 7, message: { type: 'tc:list' }, options: { frameId: TOP } },
      { tabId: 7, message: { type: 'tc:list' }, options: { frameId: EMBED } },
      { tabId: 7, message: { type: 'tc:list' }, options: { frameId: 9 } },
    ])
    // And the frames are enumerated by injecting into all of them: chrome.scripting is a
    // permission the extension already holds, where chrome.webNavigation would add a second
    // consent screen at installation for nothing but a list of numbers.
    expect(chrome.injected).toEqual([{ tabId: 7, allFrames: true }])
  })

  it('lists the recording of a player the page only embeds', async () => {
    // The whole class of ordinary pages: an article, a documentation page, a landing page that
    // carries somebody else's player rather than one of its own. The capture works there and
    // always did — the registry it fills is the one inside the embed — and the popup, asking the
    // top frame alone, answered "Nothing recorded on this page yet".
    installChrome({ frames: { [TOP]: { sessions: [] }, [EMBED]: { sessions: [embedded] } } })
    const { listSessions } = await importApi()

    expect(await listSessions()).toEqual({ sessions: [inFrame(embedded, EMBED)] })
  })

  it('puts the sessions of every frame in one list, freshest first', async () => {
    const older = { ...summary, lastAt: embedded.lastAt - 60_000 }
    const chrome = installChrome({
      frames: { [TOP]: { sessions: [older] }, [EMBED]: { sessions: [embedded] } },
    })
    const { listSessions } = await importApi()

    // Each registry sorts its own and knows of no other, so the merge is the popup's to make. By
    // frame it would be by nothing at all: the popup opens on the head of the list and calls it
    // the recording being watched right now, and the top frame's session here is a minute stale.
    expect((await listSessions()).sessions).toEqual([
      inFrame(embedded, EMBED),
      inFrame(older, TOP),
    ])
    expect(chrome.sent).toHaveLength(2)
  })

  it('draws the list a frame with no content script in it cannot answer', async () => {
    // about:blank, a sandboxed frame, a data: document. Measured on a page of 52 frames: three
    // such, each refusing in 6 ms. One refusal may not take the tab's whole list down with it.
    const chrome = installChrome({
      frames: { [TOP]: undefined, [EMBED]: { sessions: [embedded] } },
    })
    const { listSessions } = await importApi()

    expect(await listSessions()).toEqual({ sessions: [inFrame(embedded, EMBED)] })
    expect(chrome.sent).toHaveLength(2)
  })

  it('says what one frame said about a page that may not be recorded', async () => {
    installChrome({
      frames: { [TOP]: { sessions: [] }, [EMBED]: { sessions: [], encrypted: true } },
    })
    const { listSessions } = await importApi()

    // A protected player inside an embed refuses exactly as one on the top page does, and the
    // popup owes the user the reason there is nothing to show. Merged away, the refusal would
    // reach the user as the silence of a page with no video on it.
    expect(await listSessions()).toEqual({ sessions: [], encrypted: true })
  })

  it('shows one row when two frames answer under the same key', async () => {
    const twice = { ...embedded, lastAt: embedded.lastAt + 1_000, duration: 30 }
    installChrome({
      frames: { [TOP]: { sessions: [embedded] }, [EMBED]: { sessions: [twice] } },
    })
    const { listSessions } = await importApi()

    // The same clip embedded twice on one page. A key addresses one session and the popup has
    // nothing else to address one by: two rows the user cannot tell apart, of which "Save all"
    // would reach whichever came first, are worse than one — and the freshest is kept.
    expect((await listSessions()).sessions).toEqual([inFrame(twice, EMBED)])
  })

  it('does not wait on a frame that never answers', async () => {
    vi.useFakeTimers()
    installChrome({
      frames: { [TOP]: { sessions: [] }, 9: { sessions: [] }, [EMBED]: { sessions: [embedded] } },
      silent: [9],
    })
    const { listSessions } = await importApi()

    const pending = listSessions()
    await vi.runAllTimersAsync()

    // The content script answers through its bridge, and a frame whose bridge never loads leaves
    // the reply channel open with nobody on it. One such frame used to hold the popup on
    // "Loading…" for good; a tab has as many chances at that as it has frames.
    expect(await pending).toEqual({ sessions: [inFrame(embedded, EMBED)] })
  })

  it('asks the main frame when the frames of the tab cannot be enumerated', async () => {
    const chrome = installChrome({ blindToFrames: true })
    const { listSessions } = await importApi()

    // A tab no extension may touch, or one that closed under the popup. There is still one frame
    // that is certainly there, and asking it is no worse than what came before.
    expect(await listSessions()).toEqual({ sessions: [inFrame(summary, TOP)] })
    expect(chrome.sent).toEqual([
      { tabId: 7, message: { type: 'tc:list' }, options: { frameId: TOP } },
    ])
  })

  it('takes the active tab of the current window, not of a neighbouring one', async () => {
    const chrome = installChrome()
    const { listSessions } = await importApi()

    await listSessions()

    // Two windows are open, and a query without currentWindow returns the active tab of each —
    // a foreign one first. The popup would then show the summary of a tab in another window and
    // save its session on "Save all" instead of the one the user is looking at.
    expect(chrome.sent.map((item) => item.tabId)).toEqual([7])
  })

  it('gives back an empty answer on a tab with no content script', async () => {
    const chrome = installChrome()
    chrome.breakTab()
    const { listSessions } = await importApi()

    // chrome://, the extension store, a tab older than the installation. An uncaught rejection
    // would leave the popup in "Loading…" for good.
    expect(await listSessions()).toEqual({ sessions: [] })
  })

  it('gives back an empty answer when the tab answers nothing', async () => {
    const chrome = installChrome()
    chrome.setListReply(undefined)
    const { listSessions } = await importApi()

    // That is how Chrome answers when there is no listener at all and the channel closed unanswered.
    expect(await listSessions()).toEqual({ sessions: [] })
  })

  it('troubles nobody when there is no active tab', async () => {
    const chrome = installChrome({ tabs: [] })
    const { listSessions } = await importApi()

    expect(await listSessions()).toEqual({ sessions: [] })
    expect(chrome.sent).toEqual([])
  })

  it('counts a tab without an identifier as absent', async () => {
    // A devtools tab and a prerendered page may have no id at all.
    const chrome = installChrome({ tabs: [{}] })
    const { listSessions } = await importApi()

    expect(await listSessions()).toEqual({ sessions: [] })
    expect(chrome.sent).toEqual([])
  })
})

describe('saveAll', () => {
  it('asks the tab to save the session by its key', async () => {
    const chrome = installChrome()
    const { saveAll } = await importApi()

    await saveAll(summary.key)

    // A key the popup never listed can only be asked of the main frame: it is the one frame
    // certainly there, and it will answer that it knows of no such session — which is the truth.
    expect(chrome.sent).toEqual([
      { tabId: 7, message: { type: 'tc:save', key: summary.key }, options: { frameId: TOP } },
    ])
  })

  it('sends the save to the frame the session was listed from', async () => {
    const chrome = installChrome({
      frames: { [TOP]: { sessions: [summary] }, [EMBED]: { sessions: [embedded] } },
    })
    const { listSessions, saveAll } = await importApi()

    await listSessions()
    expect(await saveAll(embedded.key)).toEqual({ ok: true })

    // The bytes are in the registry of the embed and nowhere else. Sent to the top frame, this
    // save would come back "gone" — the session is no more lost than the popup showing it is,
    // it is simply somewhere else.
    expect(savesIn(chrome.sent)).toEqual([
      { tabId: 7, message: { type: 'tc:save', key: embedded.key }, options: { frameId: EMBED } },
    ])
  })

  it('sends each save to its own frame when two embeds are recording', async () => {
    const second = {
      ...embedded,
      key: 'https://player.example/embed/two|vp09|inf',
      lastAt: embedded.lastAt - 1,
    }
    const chrome = installChrome({
      frames: {
        [TOP]: { sessions: [] },
        [EMBED]: { sessions: [embedded] },
        9: { sessions: [second] },
      },
    })
    const { listSessions, saveAll } = await importApi()

    await listSessions()
    await saveAll(second.key)
    await saveAll(embedded.key)

    expect(savesIn(chrome.sent).map((item) => item.options)).toEqual([
      { frameId: 9 },
      { frameId: EMBED },
    ])
  })

  it('goes to the tab the popup took the list from', async () => {
    const chrome = installChrome()
    const { listSessions, saveAll } = await importApi()

    await listSessions()
    // The active tab does change under an open popup. Ask for it again and "Save all" would save
    // a foreign session, or none at all.
    chrome.switchTo(9)
    await saveAll(summary.key)

    expect(chrome.sent.map((item) => item.tabId)).toEqual([7, 7])
  })

  it('reports the success the bridge answered with', async () => {
    installChrome()
    const { saveAll } = await importApi()

    expect(await saveAll(summary.key)).toEqual({ ok: true })
  })

  it('reports the refusal of the bridge instead of swallowing it', async () => {
    const chrome = installChrome()
    // The bridge answers so when the session is gone — triage evicted it, or the page reloaded
    // under the open popup — and when there is nothing in it to cut yet.
    chrome.setSaveReply({ ok: false })
    const { saveAll } = await importApi()

    // Read nothing of the answer and the popup cannot tell a refusal from a slow save: no file
    // appears and not a word is said.
    expect(await saveAll(summary.key)).toEqual({ ok: false })
  })

  it('carries the reason of the refusal, and what Chrome said about it', async () => {
    const chrome = installChrome()
    // The popup shows the reason to the user. Dropped here, a name Chrome would not take reaches
    // the user as "this recording may be gone from the page" while it is being recorded on.
    chrome.setSaveReply({ ok: false, reason: 'refused', detail: 'Invalid filename' })
    const { saveAll } = await importApi()

    expect(await saveAll(summary.key)).toEqual({
      ok: false,
      reason: 'refused',
      detail: 'Invalid filename',
    })
  })

  it('carries a reason that came without a detail as it is', async () => {
    const chrome = installChrome()
    chrome.setSaveReply({ ok: false, reason: 'gone' })
    const { saveAll } = await importApi()

    expect(await saveAll(summary.key)).toEqual({ ok: false, reason: 'gone' })
  })

  it('invents no reason out of an answer that names one nobody declared', async () => {
    const chrome = installChrome()
    // The answer crosses an extension message untyped, and a bridge of another version is a
    // thing that happens. A word the popup has no sentence for would draw an empty complaint.
    chrome.setSaveReply({ ok: false, reason: 'whatever', detail: 'x' })
    const { saveAll } = await importApi()

    expect(await saveAll(summary.key)).toEqual({ ok: false })
  })

  it('keeps nothing of the answer to a save that went through', async () => {
    const chrome = installChrome()
    chrome.setSaveReply({ ok: true, reason: 'gone' })
    const { saveAll } = await importApi()

    // A success carrying the leftovers of a refusal would light the complaint under a saved file.
    expect(await saveAll(summary.key)).toEqual({ ok: true })
  })

  it('counts an answer of nothing as a failure', async () => {
    const chrome = installChrome()
    // Chrome answers undefined when the channel closed with nobody answering.
    chrome.setSaveReply(undefined)
    const { saveAll } = await importApi()

    expect(await saveAll(summary.key)).toEqual({ ok: false })
  })

  it('does not throw on a tab with no content script and calls it a failure', async () => {
    const chrome = installChrome()
    chrome.breakTab()
    const { saveAll } = await importApi()

    // The tab was closed or taken off the page: an uncaught rejection would reach no further
    // than the console of the popup, and the user would be left waiting for a file.
    await expect(saveAll(summary.key)).resolves.toEqual({ ok: false })
  })

  it('troubles nobody when there is no active tab, and says the save failed', async () => {
    const chrome = installChrome({ tabs: [] })
    const { saveAll } = await importApi()

    expect(await saveAll(summary.key)).toEqual({ ok: false })
    expect(chrome.sent).toEqual([])
  })
})

/**
 * The freeze travels the same road as the save and has to be addressed the same way.
 *
 * It is a road with a fork in it: the material of a session never leaves the frame it was
 * gathered in, so the frame the session was listed from is the only registry that holds it. The
 * save has been held to that since embedded players were first recorded; the freeze was written
 * beside it and never checked, and swapping its addressee for the main frame left the whole set
 * green — a player inside an embed could not be frozen at all, and the popup blamed the session
 * for being gone.
 */
describe('editSession', () => {
  it('asks the tab to freeze the session by its key', async () => {
    const chrome = installChrome()
    const { editSession } = await importApi()

    expect(await editSession(summary.key)).toEqual({ ok: true, snapshotId: SNAPSHOT })

    // A key the popup never listed can only be asked of the main frame: the one frame certainly
    // there, and the one that will answer that it knows of no such session.
    expect(chrome.sent).toEqual([
      { tabId: 7, message: { type: 'tc:edit', key: summary.key }, options: { frameId: TOP } },
    ])
  })

  it('sends the freeze to the frame the session was listed from', async () => {
    const chrome = installChrome({
      frames: { [TOP]: { sessions: [summary] }, [EMBED]: { sessions: [embedded] } },
    })
    const { listSessions, editSession } = await importApi()

    await listSessions()
    expect(await editSession(embedded.key)).toEqual({ ok: true, snapshotId: SNAPSHOT })

    // The bytes are in the registry of the embed and nowhere else. Sent to the top frame, this
    // freeze comes back "gone" about a session that is recording on, and no editor ever opens
    // over a player inside an embed.
    expect(editsIn(chrome.sent)).toEqual([
      { tabId: 7, message: { type: 'tc:edit', key: embedded.key }, options: { frameId: EMBED } },
    ])
  })

  it('sends each freeze to its own frame when two embeds are recording', async () => {
    const second = {
      ...embedded,
      key: 'https://player.example/embed/two|vp09|inf',
      lastAt: embedded.lastAt - 1,
    }
    const chrome = installChrome({
      frames: {
        [TOP]: { sessions: [] },
        [EMBED]: { sessions: [embedded] },
        9: { sessions: [second] },
      },
    })
    const { listSessions, editSession } = await importApi()

    await listSessions()
    await editSession(second.key)
    await editSession(embedded.key)

    expect(editsIn(chrome.sent).map((item) => item.options)).toEqual([
      { frameId: 9 },
      { frameId: EMBED },
    ])
  })

  it('goes to the tab the popup took the list from', async () => {
    const chrome = installChrome()
    const { listSessions, editSession } = await importApi()

    await listSessions()
    // The active tab does change under an open popup, and a freeze asked of whatever is in front
    // now would snapshot a session the popup is not showing.
    chrome.switchTo(9)
    await editSession(summary.key)

    expect(chrome.sent.map((item) => item.tabId)).toEqual([7, 7])
  })

  it('carries the reason of a refusal instead of inventing one', async () => {
    const chrome = installChrome()
    chrome.setEditReply({ ok: false, reason: 'empty' })
    const { editSession } = await importApi()

    expect(await editSession(summary.key)).toEqual({ ok: false, reason: 'empty' })
  })

  it('counts an answer with no snapshot in it as a refusal', async () => {
    const chrome = installChrome()
    // A bridge of another version, or a tab that closed with the channel open: an "ok" with
    // nothing to open would send the user to an editor tab addressed to nothing.
    chrome.setEditReply({ ok: true })
    const { editSession } = await importApi()

    expect(await editSession(summary.key)).toEqual({ ok: false, reason: 'gone' })
  })

  it('does not throw on a tab with no content script and calls the session gone', async () => {
    const chrome = installChrome()
    chrome.breakTab()
    const { editSession } = await importApi()

    await expect(editSession(summary.key)).resolves.toEqual({ ok: false, reason: 'gone' })
  })

  it('troubles nobody when there is no active tab', async () => {
    const chrome = installChrome({ tabs: [] })
    const { editSession } = await importApi()

    expect(await editSession(summary.key)).toEqual({ ok: false, reason: 'gone' })
    expect(chrome.sent).toEqual([])
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [6, '0:06'],
    [6.4, '0:06'],
    // Minutes are the whole part of the division and not a rounding: 45 seconds is "0:45" and
    // never "1:45". A remainder over half a minute turns up on the very first recording.
    [45, '0:45'],
    [59.6, '1:00'],
    [65, '1:05'],
    [100, '1:40'],
    [150, '2:30'],
    [600, '10:00'],
    // Past an hour the clock grows a field rather than counting on in minutes; the whole table
    // of lengths lives in tests/shared/format.test.ts, this is the road through the re-export.
    [3661, '1:01:01'],
  ])('%s seconds → %s', async (seconds, expected) => {
    installChrome()
    const { formatDuration } = await importApi()

    expect(formatDuration(seconds)).toBe(expected)
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 KB'],
    [1024, '1 KB'],
    // A kilobyte is rounded, not rounded up: one byte over a kilobyte is still "1 KB".
    [1025, '1 KB'],
    [500, '0 KB'],
    [700_000, '684 KB'],
    // The border between kilobytes and megabytes is binary, like the count itself: up to 1024 KB
    // the label stays kilobytes, though a million bytes is already behind.
    [1_020_000, '996 KB'],
    [1_048_576, '1.0 MB'],
    [1_543_210, '1.5 MB'],
    [1_073_741_824, '1.00 GB'],
  ])('%s bytes → %s', async (bytes, expected) => {
    installChrome()
    const { formatBytes } = await importApi()

    expect(formatBytes(bytes)).toBe(expected)
  })
})

describe('hostOf', () => {
  it.each([
    ['https://site.example/watch?v=abc', 'site.example'],
    ['https://site.example:8443/watch', 'site.example:8443'],
    // The bridge lives on the extension origin and knows only the referrer until the first
    // tc:context, and there may be none at all: the session then has a title but no address.
    ['', ''],
    ['not an address', ''],
  ])('%s → %s', async (url, expected) => {
    installChrome()
    const { hostOf } = await importApi()

    expect(hostOf(url)).toBe(expected)
  })
})

/** A row of the index, as the index keeps one: the popup reads eight of these fields and no more. */
const indexRow = (over: Record<string, unknown> = {}) => ({
  id: 'h1',
  key: 'https://old.example/v|avc1|240',
  url: 'https://old.example/v',
  title: 'Yesterday',
  createdAt: 1_699_800_000_000,
  lastSeenAt: 1_699_900_000_000,
  pinned: false,
  usedAt: 0,
  deletedAt: 0,
  bytes: 90_000_000,
  covered: [{ start: 0, end: 240 }],
  seconds: 240,
  widthPx: 640,
  sound: true,
  tracks: [],
  ...over,
})

describe('the history the popup shows', () => {
  it('takes its rows out of the index and asks for a page of them', async () => {
    indexed = [indexRow(), indexRow({ id: 'h2', key: 'k2', title: 'The day before' })]
    installChrome()
    const { historyRows } = await importApi()

    // Straight out of the index and in the order it answers — newest first, which is the order
    // the popup lists them in. Nothing is computed here and nothing walks the disk: the UI expects
    // a popup that opens instantly, and a browser can hold a thousand of these rows.
    expect(await historyRows()).toEqual([
      {
        id: 'h1',
        key: 'https://old.example/v|avc1|240',
        title: 'Yesterday',
        url: 'https://old.example/v',
        seconds: 240,
        bytes: 90_000_000,
        lastSeenAt: 1_699_900_000_000,
        pinned: false,
      },
      expect.objectContaining({ id: 'h2', title: 'The day before' }),
    ])
    // A page of them and not everything there is: the popup is 340 pixels wide.
    expect(asked).toEqual([20])
  })

  it('shows an empty history where the index would not open, rather than nothing at all', async () => {
    indexRefuses = true
    installChrome()
    const { historyRows, storageInUse } = await importApi()

    // Private browsing, a store the browser refused, a profile with nothing written yet. An empty
    // history is what nothing looks like, and it is not worth a message beside the recording of
    // the page — but a rejection here would take the whole popup down with it.
    expect(await historyRows()).toEqual([])
    expect(await storageInUse()).toEqual({ bytes: 0, full: false })
  })

  it('counts the volume out of the index and says when the browser has refused a write', async () => {
    totals = { id: 'totals', bytes: 1_610_612_736, cappedBytes: 1_449_551_462, fullAt: 1_700_000_000_000 }
    installChrome()
    const { storageInUse } = await importApi()

    // Never navigator.storage.estimate(): with a real ceiling of 200 MB forced on it, that call
    // went on reporting 10 GiB while the write failed at 128 MB. The sum in the index is
    // the only number that is true.
    expect(await storageInUse()).toEqual({ bytes: 1_610_612_736, full: true })
  })

  it('marks a recording deleted at a moment, and takes that moment back on an undo', async () => {
    installChrome()
    const { deleteHistory, undoDelete, pinHistory } = await importApi()

    await deleteHistory('h1')
    await undoDelete('h1')
    await pinHistory('h1', true)

    // Marked and not removed because deletion offers undo in a toast rather than
    // confirmation, so the row has to be out of every list at once and recoverable while the
    // toast is up. The files are the sweeper's business, half a minute later.
    const [deleted, undone] = stamped
    expect(deleted![0]).toBe('h1')
    expect(deleted![1], 'a deletion was written down as a flag rather than as a moment')
      .toBeGreaterThan(1_700_000_000_000)
    expect(undone).toEqual(['h1', 0])
    expect(pinned).toEqual([['h1', true]])
  })

  it('opens a recording of the history by the second door of the editor', async () => {
    const chrome = installChrome()
    const { openHistoryEditor } = await importApi()

    await openHistoryEditor('h1')

    // `?h=` and not `?s=`: a snapshot is a file written for one editing, a history session is the
    // pieces on disk and the rows over them, and nothing is copied to open it.
    expect(chrome.created).toEqual([
      { url: 'chrome-extension://tailcut/editor/editor.html?h=h1' },
    ])
  })
})

describe('the switches under the history', () => {
  it('reads whether this site is recorded out of the settings as they stand', async () => {
    installChrome()
    const { siteSwitch } = await importApi()

    expect(await siteSwitch(PAGE_URL)).toEqual({ recorded: true, off: false })

    stored = merge({ recording: { ...DEFAULTS.recording, deny: ['site.example'] } })
    expect(await siteSwitch(PAGE_URL)).toEqual({ recorded: false, off: false })
  })

  it('says the switch decides nothing where the settings record nothing anywhere', async () => {
    stored = merge({ recording: { ...DEFAULTS.recording, mode: 'off' } })
    installChrome()
    const { siteSwitch } = await importApi()

    // `Off` is not "this site is not recorded": it is every site, and neither list decides
    // anything while it holds. Unticked, the two read the same in the popup — so the answer
    // carries the mode as well, out of the one read that answered the other half.
    expect(await siteSwitch(PAGE_URL)).toEqual({ recorded: false, off: true })
  })

  it('writes nothing at all while recording is off altogether', async () => {
    stored = merge({ recording: { ...DEFAULTS.recording, mode: 'off' } })
    installChrome()
    const { setSiteRecorded } = await importApi()

    await setSiteRecorded(PAGE_URL, true)
    await setSiteRecorded(PAGE_URL, false)

    // A host put on a list nothing reads is a setting the user never made, and the settings page
    // shows it to them afterwards. The popup keeps the switch shut in this mode; this is the same
    // refusal one layer down, where it holds whoever asks.
    expect(written).toEqual([])
  })

  it('forbids the site in the deny list while every site is recorded', async () => {
    installChrome()
    const { setSiteRecorded } = await importApi()

    await setSiteRecorded(PAGE_URL, false)

    expect(written.at(-1)!.recording.deny).toEqual(['site.example'])
    expect(written.at(-1)!.recording.allow, 'the allow list is not what "all sites" reads').toEqual([])
  })

  it('allows the site in the allow list while only listed sites are recorded', async () => {
    stored = merge({ recording: { ...DEFAULTS.recording, mode: 'allowlist' } })
    installChrome()
    const { setSiteRecorded } = await importApi()

    await setSiteRecorded(PAGE_URL, true)

    // The only reading of "record here" that means the same thing in both modes: in `All sites`
    // it is the deny list that decides, in `Allowlist` the allow list, and writing the wrong one
    // would be a switch that moves and changes nothing.
    expect(written.at(-1)!.recording.allow).toEqual(['site.example'])
    expect(written.at(-1)!.recording.deny).toEqual([])
  })

  it('takes the site off the list it was on rather than putting it on twice', async () => {
    stored = merge({ recording: { ...DEFAULTS.recording, deny: ['site.example', 'other.example'] } })
    installChrome()
    const { setSiteRecorded } = await importApi()

    await setSiteRecorded(PAGE_URL, true)

    expect(written.at(-1)!.recording.deny).toEqual(['other.example'])
  })

  it('writes nothing at all for an address that names no site', async () => {
    installChrome()
    const { setSiteRecorded } = await importApi()

    // about:blank, a chrome:// page, a tab Chrome tells the extension nothing about. There is no
    // host to put on a list, and a settings write that stored the empty string would be an entry
    // the settings page shows and nobody can match.
    await setSiteRecorded('', false)
    await setSiteRecorded('about:blank', false)

    expect(written).toEqual([])
  })

  it('pauses every frame of the tab, each addressed, and stores nothing', async () => {
    const chrome = installChrome({
      frames: { [TOP]: { sessions: [] }, [EMBED]: { sessions: [embedded] } },
    })
    const { pauseThisTab } = await importApi()

    await pauseThisTab(true)

    // Every frame, because the player may be in an embed: a pause that missed it would be a
    // button that does nothing on exactly the pages where the recording is not obvious.
    expect(chrome.sent).toEqual([
      { tabId: 7, message: { type: 'tc:pause', on: true }, options: { frameId: TOP } },
      { tabId: 7, message: { type: 'tc:pause', on: true }, options: { frameId: EMBED } },
    ])
    // And nothing is stored: the pause is about this page until it is reloaded, and a setting
    // that outlived the tab it was meant for would be a switch the user cannot find again.
    expect(written).toEqual([])
  })

  it('lets a frame that cannot be reached refuse without taking the pause down', async () => {
    const chrome = installChrome({ frames: { [TOP]: undefined, [EMBED]: { sessions: [embedded] } } })
    const { pauseThisTab } = await importApi()

    // about:blank, a sandboxed frame, a data: document: there is nothing in it to pause, and the
    // frame that holds the player is still owed the message.
    await expect(pauseThisTab(true)).resolves.toBeUndefined()
    expect(chrome.sent).toHaveLength(2)
  })

  it('says where the tab stands, out of the same answer that named it', async () => {
    const chrome = installChrome()
    const { pageUrl, listSessions } = await importApi()

    await listSessions()
    expect(await pageUrl()).toBe(PAGE_URL)

    // Asked once and remembered, like the identifier beside it: the active tab does change under
    // an open popup, and a switch thrown at the site of another tab is a setting nobody meant.
    chrome.switchTo(9)
    expect(await pageUrl()).toBe(PAGE_URL)
  })
})
