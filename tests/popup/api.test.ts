import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SessionSummary } from '../../src/shared/protocol'

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
    tabs?: Array<{ id?: number }>
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
  let tabs = options.tabs ?? [{ id: 7 }]
  let frames: Record<number, unknown> =
    options.frames ??
    ({ [TOP]: 'listReply' in options ? options.listReply : { sessions: [summary] } })
  const silent = new Set(options.silent ?? [])
  let saveReply: unknown = 'saveReply' in options ? options.saveReply : { ok: true }
  let editReply: unknown =
    'editReply' in options ? options.editReply : { ok: true, snapshotId: SNAPSHOT }
  let failure: Error | null = null

  vi.stubGlobal('chrome', {
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
    [3661, '61:01'],
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
    [1_073_741_824, '1024.0 MB'],
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
