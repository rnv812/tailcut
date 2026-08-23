import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SessionSummary } from '../../src/shared/protocol'

const PAGE_URL = 'https://site.example/watch?v=abc'

const summary: SessionSummary = {
  key: 'https://site.example/watch|avc1|inf',
  url: PAGE_URL,
  title: 'Clip — site.example',
  duration: 6,
  bytes: 1_543_210,
}

/** What the popup sent the tab: the message and its addressee inside it. */
type Sent = { tabId: number; message: unknown; options: unknown }

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

/**
 * Replaces chrome for the popup. The tabs are given as a list: these are the active tabs of the
 * current window, and the first of them is what chrome.tabs.query gives back. Beside them live a
 * neighbouring window and a background tab — the query has to sift those out itself. The answers
 * of the tab are set separately, one per request type: a tab may not answer at all (no content
 * script), and then sendMessage rejects.
 */
function installChrome(
  options: { tabs?: Array<{ id?: number }>; listReply?: unknown; saveReply?: unknown } = {},
) {
  const sent: Sent[] = []
  let tabs = options.tabs ?? [{ id: 7 }]
  let listReply: unknown = 'listReply' in options ? options.listReply : [summary]
  let saveReply: unknown = 'saveReply' in options ? options.saveReply : { ok: true }
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
        return (message as { type?: string }).type === 'tc:save' ? saveReply : listReply
      },
    },
  })

  return {
    sent,
    /** The user switched tabs while the popup was open. */
    switchTo: (id: number | undefined) => {
      tabs = [{ id }]
    },
    /** A page with no content script: sendMessage rejects with "receiving end does not exist". */
    breakTab: () => {
      failure = new Error('Could not establish connection. Receiving end does not exist.')
    },
    setListReply: (value: unknown) => {
      listReply = value
    },
    setSaveReply: (value: unknown) => {
      saveReply = value
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
})

describe('listSessions', () => {
  it('gives back the summaries the tab sent', async () => {
    installChrome()
    const { listSessions } = await importApi()

    expect(await listSessions()).toEqual([summary])
  })

  it('asks the active tab and only its top frame', async () => {
    const chrome = installChrome()
    const { listSessions } = await importApi()

    await listSessions()

    // Without frameId Chrome sends the request round every frame of the page, and whoever is
    // first answers: on a page with advertising frames that is a stranger's empty list.
    expect(chrome.sent).toEqual([{ tabId: 7, message: { type: 'tc:list' }, options: { frameId: 0 } }])
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

  it('gives back an empty list on a tab with no content script', async () => {
    const chrome = installChrome()
    chrome.breakTab()
    const { listSessions } = await importApi()

    // chrome://, the extension store, a tab older than the installation. An uncaught rejection
    // would leave the popup in "Loading…" for good.
    expect(await listSessions()).toEqual([])
  })

  it('gives back an empty list when the tab answers nothing', async () => {
    const chrome = installChrome()
    chrome.setListReply(undefined)
    const { listSessions } = await importApi()

    // That is how Chrome answers when there is no listener at all and the channel closed unanswered.
    expect(await listSessions()).toEqual([])
  })

  it('troubles nobody when there is no active tab', async () => {
    const chrome = installChrome({ tabs: [] })
    const { listSessions } = await importApi()

    expect(await listSessions()).toEqual([])
    expect(chrome.sent).toEqual([])
  })

  it('counts a tab without an identifier as absent', async () => {
    // A devtools tab and a prerendered page may have no id at all.
    const chrome = installChrome({ tabs: [{}] })
    const { listSessions } = await importApi()

    expect(await listSessions()).toEqual([])
    expect(chrome.sent).toEqual([])
  })
})

describe('saveAll', () => {
  it('asks the tab to save the session by its key', async () => {
    const chrome = installChrome()
    const { saveAll } = await importApi()

    await saveAll(summary.key)

    expect(chrome.sent).toEqual([
      { tabId: 7, message: { type: 'tc:save', key: summary.key }, options: { frameId: 0 } },
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
