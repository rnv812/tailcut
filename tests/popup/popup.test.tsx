// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { Omission, SaveResult, SessionSummary } from '../../src/shared/protocol'
import { DEFAULTS, merge, type Settings } from '../../src/shared/settings'
import type { HistoryRow } from '../../src/popup/api'

/**
 * What the index of the history holds, and what the store of settings holds.
 *
 * Both are replaced outright: the real index wants IndexedDB and the real store wants
 * chrome.storage, and a runner has neither. Nothing between them and the markup is replaced —
 * the popup is checked from the row the index gave it to the line the user reads.
 */
let rows: HistoryRow[] = []

/**
 * What the index says is on disk while a test says nothing else about it: a gigabyte and a half,
 * which is 1.50 GB in the binary units this program counts in.
 */
const IN_USE = { bytes: 1_610_612_736, full: false }
let inUse = { ...IN_USE }

/** Every pin and unpin the popup asked for, and every deletion and undo, in order. */
const pinned: Array<[string, boolean]> = []
const deleted: string[] = []
const undone: string[] = []
let cleared = 0

/**
 * The deletion marks the index holds, by identifier: the moment a row was deleted, or nothing.
 *
 * Kept here and honoured by the listing below, because that is what the real index does — a
 * marked row is off every list it has (src/shared/history-db.ts). A fake that went on answering a
 * deleted row would let the popup put it back the moment the toast left, and the set would call
 * that working.
 */
const marks = new Map<string, number>()

let stored: Settings = DEFAULTS
const written: Settings[] = []

/**
 * The row as the index keeps it, out of the row the popup needs.
 *
 * The index knows a great deal more about a session than the popup shows — when it was opened,
 * when it was last cut from, which stretches of media time it covers, which tracks are in it —
 * and the popup is entitled to none of it. Padded here rather than left out, so that a popup
 * that started reading one of those fields would be reading a made-up value out of a fake
 * instead of quietly working.
 */
const asStored = (row: HistoryRow) => ({
  ...row,
  createdAt: row.lastSeenAt,
  usedAt: 0,
  deletedAt: marks.get(row.id) ?? 0,
  covered: [{ start: 0, end: row.seconds }],
  widthPx: 640,
  sound: true,
  tracks: [],
})

vi.mock('../../src/shared/history-db', () => ({
  // Sifted the way the index sifts: a row marked deleted is not in the list any more, whoever
  // asks and however soon after the mark.
  listSessions: async (limit: number) =>
    rows
      .filter((row) => !marks.get(row.id))
      .slice(0, limit)
      .map(asStored),
  readTotals: async () => ({
    id: 'totals',
    bytes: inUse.bytes,
    cappedBytes: 0,
    // How a refusal by the browser is written down: the moment it happened, and never a flag.
    fullAt: inUse.full ? 1_700_000_000_000 : 0,
  }),
  setPinned: async (id: string, on: boolean) => {
    pinned.push([id, on])
  },
  // One call for both, and the argument is what tells them apart: a deletion is a moment and an
  // undo is that moment taken back.
  setDeleted: async (id: string, at: number) => {
    marks.set(id, at)
    ;(at ? deleted : undone).push(id)
  },
}))

vi.mock('../../src/shared/settings-store', () => ({
  readSettings: async () => stored,
  // Through `merge` and in two steps with a turn between them, exactly as the real store runs:
  // it reads what is stored, applies the edit to that and stores the result. Written as one step
  // the fake would hide every race between two writes in flight at once.
  writeSettings: async (edit: (current: Settings) => Settings) => {
    const before = stored
    await Promise.resolve()
    stored = merge(edit(before))
    written.push(stored)
    return stored
  },
}))

/**
 * The freshest session of the tab: the list comes newest first, and this is the one the popup is
 * obliged to show — the one being recorded right now.
 */
const fresh: SessionSummary = {
  key: 'https://site.example/watch|avc1|inf',
  url: 'https://site.example/watch?v=abc',
  title: 'Clip — site.example',
  duration: 6,
  bytes: 1_543_210,
  lastAt: 1_700_000_000_000,
}

/**
 * A second session of the same tab. A page comes by two sessions as a matter of course: a feed
 * of short clips opens one per video, and a player that moves on to the next one leaves the
 * previous session behind with all its material.
 */
const older: SessionSummary = {
  key: 'https://other.example/watch|mp4a|inf',
  url: 'https://other.example/watch',
  title: 'Older session',
  duration: 300,
  bytes: 90_000_000,
  lastAt: 1_699_999_000_000,
}

/**
 * A recording of the history: another day, another page, and nothing at all to do with the tab
 * that is open now. The popup shows it because it is on disk, which is the whole of this stage.
 */
const row: HistoryRow = {
  id: 'h1',
  key: 'https://old.example/v|avc1|240',
  title: 'Yesterday',
  url: 'https://old.example/v',
  seconds: 240,
  bytes: 90_000_000,
  lastSeenAt: 1_699_900_000_000,
  pinned: false,
}

const OTHER_SNAPSHOT = '1f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c32'

type Sent = { tabId: number; message: unknown }

/**
 * Everything the popup sent the tab, oldest first.
 *
 * At the level of the file rather than of one mounting, because what a click sends has to be
 * read after the popup that sent it has been thrown away and stood up again.
 */
const sent: Sent[] = []

/** The answer of the tab: a list of summaries, or silence — the tab has not answered yet. */
type Reply = {
  sessions: SessionSummary[]
  /** The tab says this page holds a player the extension could not reach. */
  unreachable?: boolean
  /** The tab says a file this page was watching could not be read. */
  unreadableFile?: boolean
  /** The tab says this page plays media that is encrypted. */
  encrypted?: boolean
  /** The tab says recording in it is stopped by hand until the page is reloaded. */
  paused?: boolean
  save?: SaveResult
} | 'silent'

/**
 * Replaces chrome for the popup: there is one tab, and it answers with what the test set. The api
 * module stays the real one — the whole road from the tab's answer to the markup is checked.
 */
function installChrome(reply: Reply) {
  const created: Array<{ url: string; windowId?: number }> = []
  // The save answer is mutable: the same popup saves more than once, and the second attempt may
  // well go through where the first did not.
  let saveReply: unknown = (reply === 'silent' ? undefined : reply.save) ?? { ok: true }
  let editReply: unknown = { ok: false, reason: 'gone' }
  let holdEdit = false
  let closed = false

  // window is the global object here, so this is the window.close() the popup calls.
  vi.stubGlobal('close', () => {
    closed = true
  })

  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => `chrome-extension://tailcut/${path}`,
      sendMessage: async (message: { type?: string }) => {
        if (message.type === 'tc:clear') {
          cleared += 1
          rows = []
          inUse = { bytes: 0, full: false }
          return { ok: true }
        }
        return undefined
      },
      // Chrome may place this page wherever it chooses. Kept as a no-op so the settings test
      // detects that old path by its missing same-window tab rather than by a fake API crash.
      openOptionsPage: async () => undefined,
    },
    tabs: {
      // With the address of the page in it. The quick switch below the history is about the site
      // the tab stands on, and no answer of the tab says where that is: an embedded player
      // reports the address of the embed, which is a different site from the page around it.
      query: async () => [{ id: 7, url: fresh.url, windowId: 23 }],
      create: async (options: { url: string; windowId?: number }) => {
        created.push(options)
      },
      sendMessage: (tabId: number, message: unknown) => {
        sent.push({ tabId, message })
        const type = (message as { type?: string }).type
        if (type === 'tc:save') return Promise.resolve(saveReply)
        // A freeze that never answers: the popup has to keep its buttons closed, not spin.
        if (type === 'tc:edit') return holdEdit ? new Promise(() => {}) : Promise.resolve(editReply)
        // Silence from the tab is not a refusal: the promise simply never settles, and the popup
        // waits.
        if (reply === 'silent') return new Promise(() => {})
        return Promise.resolve({
          sessions: reply.sessions,
          unreachable: reply.unreachable,
          unreadableFile: reply.unreadableFile,
          encrypted: reply.encrypted,
          paused: reply.paused,
        })
      },
    },
  })

  return {
    sent,
    created,
    get closed() {
      return closed
    },
    setSaveReply: (value: unknown) => {
      saveReply = value
    },
    setEditReply: (value: unknown) => {
      editReply = value
    },
    holdEditReply: () => {
      holdEdit = true
    },
  }
}

/**
 * Lets the popup finish drawing. The frame is no belt and braces: preact defers effects until it,
 * and before the effect the popup has not asked the tab anything. The microtasks after it are for
 * the tab's answer and the redraw on it.
 */
const flush = async () => {
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Stands the popup up the way Chrome does: by loading the module of the page. */
async function mount(reply: Reply): Promise<ReturnType<typeof installChrome>> {
  const chrome = installChrome(reply)
  // A new page body rather than a cleared old one: the previous body still holds the preact tree
  // of the last render, and the next one would reconcile against it.
  document.documentElement.replaceChild(document.createElement('body'), document.body)
  // The module draws itself when it loads and remembers the tab between calls: every render needs
  // a fresh import.
  vi.resetModules()
  await import('../../src/popup/popup')
  await flush()
  return chrome
}

const at = (testId: string) => document.body.querySelector(`[data-testid="${testId}"]`)
const allAt = (testId: string) => [...document.body.querySelectorAll(`[data-testid="${testId}"]`)]
const textAt = (testId: string) => at(testId)?.textContent ?? null
const bodyText = () => document.body.textContent?.trim() ?? ''
const saveButton = () => document.body.querySelector<HTMLButtonElement>('[data-testid="save"]')!

/** Clicks an element and lets the popup redraw on what follows. */
async function click(element: Element): Promise<void> {
  ;(element as HTMLElement).click()
  await flush()
}

/**
 * Stands the popup up over a page that is recording, which is the ordinary state of the tab the
 * history sits under: what is on disk is shown below what the page is doing now.
 */
const draw = () => mount({ sessions: [fresh] })

/**
 * Lets the promises a click started land, and the popup redraw on what they answered.
 *
 * Microtasks and nothing else, on purpose. Preact renders on a microtask and puts its effects
 * off until the next frame, and what a click promises is the call it makes — the re-reading the
 * popup does afterwards is a second thing, and a set that waited for it would stop being able to
 * say which of the two sent what.
 */
const settle = async () => {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve()
}

beforeEach(() => {
  rows = []
  inUse = { ...IN_USE }
  pinned.length = 0
  deleted.length = 0
  undone.length = 0
  cleared = 0
  marks.clear()
  written.length = 0
  stored = DEFAULTS
  sent.length = 0
})

afterEach(async () => {
  // The timers of a test are run out before its clock is taken away. Preact defers the effects of
  // a render to a timer and schedules that flush only when its queue goes from empty to one — so a
  // fake clock thrown away with one still pending leaves a component in the queue of the whole
  // module, which no `vi.resetModules()` clears, and every popup mounted after it would sit in
  // "Loading…" for ever with nobody able to say why.
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(100)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the popup', () => {
  it('identifies itself with the packaged tailcut mark', async () => {
    await draw()
    const mark = document.querySelector<HTMLImageElement>('[data-testid="brand-mark"]')

    expect(mark?.alt).toBe('tailcut')
    expect(mark?.getAttribute('src')).toBe('../assets/tailcut/svg/mark-light.svg')
  })

  it('waits while the tab has not answered', async () => {
    await mount('silent')

    expect(bodyText()).toBe('Loading…')
  })

  it('says there was nothing to record on a page with no recording', async () => {
    await mount({ sessions: [] })

    // An empty list differs from "no answer yet": without that fork the popup reads the fields of
    // a summary that does not exist, the render throws, and it stays in "Loading…" for good.
    //
    // The sentence and not the whole of the body: below it stand the history and the switches
    // for the page, which are there whether or not this page is recording anything.
    expect(textAt('nothing')).toBe('Nothing recorded on this page yet.')
    expect(at('title'), 'the popup shows a summary where there are none').toBeNull()
    expect(at('save'), 'a page with nothing on it was offered for saving').toBeNull()
  })

  it('says a protected page cannot be recorded, rather than showing the same emptiness', async () => {
    await mount({ sessions: [], encrypted: true })

    // The page plays encrypted media, so nothing of it was kept and nothing ever will be. Told
    // "nothing recorded yet", the user waits for a recording that is never coming and takes a
    // deliberate refusal for a defect — which is exactly what the survey found on every protected
    // page it opened.
    expect(textAt('nothing')).toBe(
      'This page plays protected video, which tailcut does not record. Nothing of it was kept.',
    )
    expect(at('save'), 'a protected page must not be offered for saving').toBeNull()
    expect(at('title'), 'the popup shows a summary where there are none').toBeNull()
  })

  it('says that before it says a page is empty or out of reach', async () => {
    // A protected page can be both: a player out of reach, and nothing recorded. Protection is
    // the reason there is nothing, and the reason is what the user is owed.
    await mount({ sessions: [], encrypted: true, unreachable: true })

    expect(bodyText()).toContain('protected video')
  })

  it('calls no ordinary page protected', async () => {
    await mount({ sessions: [fresh] })

    expect(bodyText()).not.toContain('protected')
  })

  it('says a page it could not reach cannot be recorded, rather than showing nothing', async () => {
    await mount({ sessions: [], unreachable: true })

    // The page plays its video out of a worker the extension was not allowed to wrap: nothing of
    // it was recorded and nothing ever will be. "Nothing recorded yet" would promise a wait that
    // will never end.
    expect(textAt('nothing')).toBe(
      'tailcut cannot reach the player on this page, so nothing of it was recorded.',
    )
    expect(at('save'), 'a page out of reach was offered for saving').toBeNull()
  })

  it('says it beside the session it did record', async () => {
    await mount({ sessions: [fresh], unreachable: true })

    // Both at once: one player in the main world, recorded, and another out of reach. The saved
    // file is not the whole of the page, and the popup must not let that pass unsaid.
    expect(textAt('title')).toBe(fresh.title)
    expect(textAt('unreachable')).toBe(
      'Another player on this page is out of reach and was not recorded.',
    )
  })

  it('says nothing of the sort on an ordinary page', async () => {
    await mount({ sessions: [fresh] })

    expect(at('unreachable')).toBeNull()
  })

  it('says a file it could not read was not saved, rather than showing nothing', async () => {
    await mount({ sessions: [], unreadableFile: true })

    // Somebody watched a video and there is nothing to offer for it: the file is a webm, or its
    // address had expired, or its host will not answer a ranged read. Measured live on an
    // imageboard thread, where "nothing recorded on this page yet" was the whole of the answer
    // over a file that had just been watched to the end.
    expect(textAt('nothing')).toBe(
      'tailcut could not read the video file on this page, so nothing of it was saved.',
    )
    expect(at('save'), 'there is nothing to save and no button to press').toBeNull()
    expect(at('title'), 'the popup shows a summary where there are none').toBeNull()
  })

  it('says it beside the session it did read', async () => {
    await mount({ sessions: [fresh], unreadableFile: true })

    // A page holds two files and only one of them could be read — a thread with an mp4 and a webm
    // in it. What was read is offered; what was not is said out loud beside it.
    expect(textAt('title')).toBe(fresh.title)
    expect(textAt('unreadable')).toBe(
      'Another file on this page could not be read and was not saved.',
    )
  })

  it('says nothing of the sort where every file was read', async () => {
    await mount({ sessions: [fresh] })

    expect(at('unreadable')).toBeNull()
  })

  it('names the protection first of all, whatever else is true of the page', async () => {
    await mount({ sessions: [], encrypted: true, unreadableFile: true })

    expect(bodyText()).toContain('protected video')
  })

  it('shows the freshest session of the tab', async () => {
    await mount({ sessions: [fresh, older] })

    // A page has several sessions, and the order of the list means something: at the top is the
    // one being recorded now. Take another and the popup shows and saves one long abandoned.
    expect(textAt('title')).toBe(fresh.title)
    expect(textAt('host')).toBe('site.example')
    expect(textAt('duration')).toBe('0:06')
  })

  it('signs a session without a title with a word rather than with emptiness', async () => {
    // The title is taken from the page and may not have arrived yet: the content script runs at
    // document_start, and some pages have no <title> at all. Without a sign the line above the
    // address simply disappears.
    await mount({ sessions: [{ ...fresh, title: '' }] })

    expect(textAt('title')).toBe('Untitled')
  })

  it('shows how much has been recorded', async () => {
    await mount({ sessions: [fresh, older] })

    // The label beside the duration is about bytes: mix the fields up and a megabyte and a half
    // turns into "0 KB", and the user decides there is nothing to record.
    expect(textAt('bytes')).toBe('1.5 MB')
  })

  it.each<[Omission, string]>([
    ['track', 'One track is in a format tailcut cannot save.'],
    ['rendition', 'Recorded at more than one quality; one is saved.'],
    // Not the same news as a rendition, and it was told as one: over a file holding one picture
    // and two soundtracks the popup said the video had been recorded at more than one quality.
    ['alternate', 'This file has more than one picture or sound track; one of each is saved.'],
    ['gap', 'Recording gaps are joined in the saved clip.'],
    // A page that keeps its sound in an element of its own, where that element could not be used.
    // The clip really is silent, and on such a page a silent clip reads as a defect in the saving
    // rather than as a page whose sound was somewhere tailcut could not follow.
    [
      'sound',
      'This page plays its sound in a separate track that tailcut could not read; the clip is silent.',
    ],
    [
      'soundShort',
      'The separate soundtrack is shorter than the picture; the clip ends in silence.',
    ],
  ])('says what the file will be missing when part of it cannot be saved (%s)', async (
    omits,
    line,
  ) => {
    await mount({ sessions: [{ ...fresh, omits }] })

    // The length above the line is already the length of the file, so the user is not misled by
    // the number — but a clip shorter than the time they spent watching needs its reason said
    // out loud, or the extension looks like it lost the rest.
    expect(textAt('omits')).toBe(line)
  })

  it('stays quiet when the file will hold everything that was recorded', async () => {
    await mount({ sessions: [fresh] })

    // The ordinary case, and the popup is minimal by design: a line that is always there is a
    // line nobody reads on the day it matters.
    expect(at('omits')).toBeNull()
  })

  it('says nothing for a reason it has no words for', async () => {
    await mount({ sessions: [{ ...fresh, omits: 'something-new' as Omission }] })

    // The bridge and the popup ship together, but a version of one against the other must not
    // draw an empty amber box under the length.
    expect(at('omits')).toBeNull()
  })

  it('keeps the notice on the current recording when another row is clicked', async () => {
    await mount({ sessions: [{ ...fresh, omits: 'gap' }, older] })

    await click(allAt('session')[0]!)

    expect(textAt('title')).toBe(fresh.title)
    expect(textAt('omits')).toBe('Recording gaps are joined in the saved clip.')
  })

  it('says where the sound came from when it came from a track beside the picture', async () => {
    await mount({ sessions: [{ ...fresh, pairedSound: true }] })

    // Not a loss — the length above already counts it — but not the video's own sound either.
    // On such a page the picture and the track are two files of different lengths looping on
    // cycles of their own, and a split-track clip takes each track from its start.
    expect(textAt('paired-sound')).toBe(
      'Sound here is a separate looping track on this page, taken from its start.',
    )
    expect(at('omits')).toBeNull()
  })

  it('says nothing of the sort about an ordinary video with its own sound', async () => {
    await mount({ sessions: [fresh] })

    expect(at('paired-sound')).toBeNull()
  })

  it('carries that line with the session it belongs to', async () => {
    await mount({ sessions: [{ ...fresh, pairedSound: true }, older] })

    await click(allAt('session')[0]!)

    expect(textAt('title')).toBe(fresh.title)
    expect(at('paired-sound')).not.toBeNull()
  })

  it('saves the session it showed', async () => {
    const { sent } = await mount({ sessions: [fresh, older] })

    await click(saveButton())

    // The key of the session shown and the key of the session saved are one and the same: let
    // them diverge and the button would save the neighbouring track of the same page.
    expect(sent.map((item) => item.message)).toEqual([
      { type: 'tc:list' },
      { type: 'tc:save', key: fresh.key },
    ])
  })
})

describe('the popup and the other sessions of the page', () => {
  it('lists the sessions the page has besides the current one', async () => {
    await mount({ sessions: [fresh, older] })

    // Show the first session alone and every other one on the page is invisible and out of
    // reach: a feed of short clips leaves a session per video behind, and the one the user wants
    // is rarely the last.
    expect(allAt('session').map((row) => row.textContent)).toEqual([
      expect.stringContaining(older.title),
    ])
  })

  it('says nothing of other sessions when there is only one', async () => {
    await mount({ sessions: [fresh] })

    expect(allAt('session')).toEqual([])
    expect(at('recent')).toBeNull()
  })

  it('does not promote a recording when its row is clicked', async () => {
    await mount({ sessions: [fresh, older] })

    await click(allAt('session')[0]!)

    expect(textAt('title')).toBe(fresh.title)
    expect(textAt('host')).toBe('site.example')
    expect(allAt('session').map((row) => row.textContent)).toEqual([
      expect.stringContaining(older.title),
    ])
  })

  it('saves another recording from its own action without promoting it', async () => {
    const { sent } = await mount({ sessions: [fresh, older] })

    await click(allAt('session-save')[0]!)

    expect(sent.map((item) => item.message)).toEqual([
      { type: 'tc:list' },
      { type: 'tc:save', key: older.key },
    ])
    expect(textAt('title')).toBe(fresh.title)
  })

  it('opens another recording in the editor from its own action', async () => {
    const chrome = await mount({ sessions: [fresh, older] })
    chrome.setEditReply({ ok: true, snapshotId: OTHER_SNAPSHOT })

    await click(allAt('session-edit')[0]!)

    expect(chrome.created).toEqual([
      { url: `chrome-extension://tailcut/editor/editor.html?s=${OTHER_SNAPSHOT}&tab=7`, windowId: 23 },
    ])
  })

  it('leaves a session with nothing in it out of the list', async () => {
    // A session with no material to cut: a stream that opened and brought nothing, a second
    // buffer that has not delivered its first fragment. Live, one of these stood in "Recent"
    // promising 0:00.
    const empty: SessionSummary = { ...older, key: 'empty', title: 'Nothing in it', duration: 0, bytes: 0 }
    await mount({ sessions: [fresh, empty, older] })

    // A row offers direct actions, and this one can only refuse them: the bridge answers that
    // there is nothing recorded to save yet.
    expect(allAt('session').map((row) => row.textContent)).toEqual([
      expect.stringContaining(older.title),
    ])
  })

  it('still shows a session with nothing in it when it is the one being recorded', async () => {
    const empty: SessionSummary = { ...fresh, duration: 0, bytes: 0 }
    await mount({ sessions: [empty] })

    // The block at the top is not an offer, it is the state of the page: a recording that has
    // just started and has no whole fragment yet is there, and saying "Nothing recorded on this
    // page yet" over it would be the wrong sentence about a page that is recording.
    expect(textAt('title')).toBe(fresh.title)
    expect(textAt('duration')).toBe('0:00')
    expect(at('recent')).toBeNull()
  })

  it('signs a session without a title in the list too', async () => {
    await mount({ sessions: [fresh, { ...older, title: '' }] })

    expect(allAt('session')[0]!.textContent).toContain('Untitled')
  })
})

describe('the popup and a save that failed', () => {
  it('says so when the tab refused to save', async () => {
    // The bridge answers so when the session is gone — evicted by triage, or lost to a reload
    // under the open popup — and when there is nothing in it to cut yet.
    await mount({ sessions: [fresh], save: { ok: false } })

    await click(saveButton())

    // Without a word about it a refusal is indistinguishable from a slow save: no file appears
    // and the user has no way of telling which of the two happened.
    expect(at('error')).not.toBeNull()
  })

  it('stays quiet about a save that went through', async () => {
    await mount({ sessions: [fresh], save: { ok: true } })

    await click(saveButton())

    expect(at('error')).toBeNull()
  })

  it('names Chrome, and not the session, when it was Chrome that refused', async () => {
    // The one failure the user cannot guess at. Measured on a title carrying U+200E LEFT-TO-RIGHT
    // MARK: Chrome would not take the file name, the session sat in the registry recording on,
    // and the popup told the user the recording was gone from the page.
    await mount({
      sessions: [fresh],
      save: { ok: false, reason: 'refused', detail: 'Invalid filename' },
    })

    await click(saveButton())

    const said = at('error')!.textContent!
    expect(said).toContain('Invalid filename')
    expect(said, 'the popup blamed the session for a refusal by Chrome').not.toContain('gone')
  })

  it('says the recording is gone only when it is gone', async () => {
    await mount({ sessions: [fresh], save: { ok: false, reason: 'gone' } })

    await click(saveButton())

    expect(at('error')!.textContent).toContain('no longer on the page')
  })

  it('does not call an empty session a lost one', async () => {
    // The stream opened and loaded nothing, or the second buffer has yet to bring a fragment.
    // The session is right there in the list the popup is showing.
    await mount({ sessions: [fresh], save: { ok: false, reason: 'empty' } })

    await click(saveButton())

    const said = at('error')!.textContent!
    expect(said).toContain('nothing recorded')
    expect(said).not.toContain('no longer on the page')
  })

  it('says something to the point when the refusal came with no reason to it', async () => {
    await mount({ sessions: [fresh], save: { ok: false } })

    await click(saveButton())

    expect(at('error')!.textContent!.length).toBeGreaterThan(0)
  })

  it('takes the complaint back when the next save goes through', async () => {
    const { setSaveReply } = await mount({ sessions: [fresh], save: { ok: false } })

    await click(saveButton())
    expect(at('error'), 'setup: the refusal was not shown').not.toBeNull()

    setSaveReply({ ok: true })
    await click(saveButton())

    // A complaint left on screen after a file has been saved would send the user looking for a
    // failure that is over.
    expect(at('error')).toBeNull()
  })
})

describe('Edit', () => {
  const SNAPSHOT = '0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31'
  const editButton = () => document.body.querySelector<HTMLButtonElement>('[data-testid="edit"]')!

  it('freezes the session and opens the editor over its snapshot', async () => {
    const chrome = await mount({ sessions: [fresh] })
    chrome.setEditReply({ ok: true, snapshotId: SNAPSHOT })

    await click(editButton())

    expect(chrome.sent.map((one) => one.message)).toContainEqual({
      type: 'tc:edit',
      key: fresh.key,
    })
    expect(chrome.created).toEqual([
      { url: `chrome-extension://tailcut/editor/editor.html?s=${SNAPSHOT}&tab=7`, windowId: 23 },
    ])
    // The popup gets out of the way of the tab it has just sent the user to.
    expect(chrome.closed).toBe(true)
  })

  it('does not redirect the main Edit action when another row is clicked', async () => {
    const chrome = await mount({ sessions: [fresh, older] })
    chrome.setEditReply({ ok: true, snapshotId: SNAPSHOT })

    await click(allAt('session')[0]!)
    await click(editButton())

    expect(chrome.sent.at(-1)!.message).toEqual({ type: 'tc:edit', key: fresh.key })
  })

  it('explains a session that has gone instead of opening an empty tab', async () => {
    const chrome = await mount({ sessions: [fresh] })
    chrome.setEditReply({ ok: false, reason: 'gone' })

    await click(editButton())

    expect(textAt('edit-error')).toContain('gone from the page')
    expect(chrome.created, 'an editor tab opened over a refusal').toEqual([])
    expect(chrome.closed).toBe(false)
  })

  it('has words of its own for every reason a freeze can fail', async () => {
    const shown: string[] = []

    for (const [reason, said] of [
      ['gone', 'gone from the page'],
      ['empty', 'nothing to edit'],
      // The material of an ordinary file is not in the frame: the freeze fetches it, and that
      // read can be refused by a host or an address that has expired. Nothing was lost from the
      // page, so neither "gone" nor "empty" is the truth about it.
      ['unread', 'Could not read the video file'],
      ['storage', 'refused the storage'],
    ] as const) {
      const chrome = await mount({ sessions: [fresh] })
      chrome.setEditReply({ ok: false, reason })

      await click(editButton())

      const text = textAt('edit-error')
      expect(text, `the ${reason} refusal`).toContain(said)
      shown.push(text!)
    }

    // Four reasons and four sentences: they ask four different things of the user, and two of
    // them explained alike would send somebody looking for a loss that never happened.
    expect(new Set(shown).size, 'two refusals are explained in the same words').toBe(4)
  })

  it('keeps a current-recording complaint when another row is clicked', async () => {
    const chrome = await mount({ sessions: [fresh, older] })
    chrome.setEditReply({ ok: false, reason: 'gone' })

    await click(editButton())
    expect(textAt('edit-error'), 'setup: the refusal was not shown').not.toBeNull()

    await click(allAt('session')[0]!)

    expect(textAt('title')).toBe(fresh.title)
    expect(at('edit-error')).not.toBeNull()
  })

  it('closes both buttons while the snapshot is being written', async () => {
    const chrome = await mount({ sessions: [fresh] })
    chrome.holdEditReply()

    await click(editButton())

    expect(editButton().disabled).toBe(true)
    expect(saveButton().disabled).toBe(true)
  })
})

describe('history', () => {
  it('puts site recording first and presents live and stored material as one recordings list', async () => {
    rows = [row]
    await mount({ sessions: [fresh, older] })

    const siteControl = at('site-control')!
    const recordings = at('recordings')!
    expect(
      siteControl.compareDocumentPosition(recordings) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the recording switch was not before the recordings',
    ).toBeTruthy()
    expect(recordings.textContent).toContain(fresh.title)
    expect(recordings.textContent).toContain(older.title)
    expect(recordings.textContent).toContain(row.title)
    expect(bodyText()).not.toContain('Recent')
    expect(bodyText()).not.toContain('Pin')
  })

  it('shows the current tab memory separately from persistent disk storage', async () => {
    inUse = { bytes: 1_610_612_736, full: false }
    await mount({ sessions: [fresh, older] })

    expect(textAt('memory-in-use')).toContain('87.3 MB')
    expect(textAt('disk-in-use')).toContain('1.50 GB')
  })

  it('clears all stored recordings from one explicit history action', async () => {
    rows = [row]
    await draw()

    const actions = at('storage-actions')!
    expect(actions.querySelector('[data-testid="delete-all"]')).not.toBeNull()
    expect(actions.querySelector('[data-testid="open-settings"]')).not.toBeNull()

    await click(at('delete-all')!)
    await click(at('confirm-delete-all')!)

    expect(cleared).toBe(1)
    expect(allAt('history-row')).toHaveLength(0)
  })

  it('lists what is on disk under what the page is recording now', async () => {
    inUse = { bytes: 1_610_612_736, full: false }
    rows = [
      { id: 'h1', key: 'other|k', title: 'Yesterday', url: 'https://old.example/v', seconds: 240, bytes: 90_000_000, lastSeenAt: Date.now() - 86_400_000, pinned: false },
    ]
    await draw()

    expect(document.querySelector('[data-testid="history-title"]')!.textContent).toBe('Yesterday')
    expect(document.querySelector('[data-testid="history-length"]')!.textContent).toBe('4:00')
  })

  it('leaves out what the tab is already showing above', async () => {
    // One video, one merge key, two places it could be listed from. Two rows leading to two
    // different places would be the same recording pretending to be two.
    rows = [{ ...row, key: fresh.key }]
    await draw()
    expect(document.querySelectorAll('[data-testid="history-row"]')).toHaveLength(0)
  })

  it('keeps Delete all available when the stored row is also live on this page', async () => {
    rows = [{ ...row, key: fresh.key }]
    await draw()

    expect(document.querySelectorAll('[data-testid="history-row"]')).toHaveLength(0)
    expect(at('delete-all')).not.toBeNull()
  })

  it('does not expose the old pin state as a second history mode', async () => {
    rows = [row]
    await draw()
    expect(at('history-pin')).toBeNull()
    expect(pinned).toEqual([])
  })

  it('takes a row away at once and offers to put it back', async () => {
    rows = [row]
    await draw()
    await click(document.querySelector<HTMLButtonElement>('[data-testid="history-delete"]')!)

    expect(deleted).toEqual(['h1'])
    expect(document.querySelectorAll('[data-testid="history-row"]')).toHaveLength(0)

    const toast = document.querySelector('[data-testid="undo"]')!
    expect(toast.textContent).toContain('Deleted')
    toast.querySelector<HTMLButtonElement>('button')!.click()
    await settle()

    expect(undone).toEqual(['h1'])
    expect(document.querySelectorAll('[data-testid="history-row"]')).toHaveLength(1)
  })

  it('shows the volume in use out of the index', async () => {
    await draw()
    expect(document.querySelector('[data-testid="in-use"]')!.textContent).toContain('1.50 GB')
    expect(document.querySelector('[data-testid="in-use"]')!.getAttribute('data-bytes')).toBe(
      String(1.5 * 1024 ** 3),
    )
    expect(document.querySelector('[data-testid="in-use"]')!.textContent).not.toContain('full')
  })

  it('says when the disk is full, rather than a number that looks like all is well', async () => {
    inUse = { bytes: 1_610_612_736, full: true }
    await draw()
    expect(document.querySelector('[data-testid="in-use"]')!.textContent).toContain('Disk full')
  })

  it('switches recording off for this site, and says which site', async () => {
    await draw()
    const toggle = document.querySelector<HTMLInputElement>('[data-testid="site-toggle"]')!
    expect(document.querySelector('[data-testid="site-name"]')!.textContent).toBe('site.example')
    toggle.click()
    await settle()
    expect(written.at(-1)!.recording.deny).toEqual(['site.example'])
  })

  it('pauses this page without touching the settings', async () => {
    await draw()
    document.querySelector<HTMLButtonElement>('[data-testid="pause-tab"]')!.click()
    await settle()
    // A message to the tab and nothing stored: a pause is about this page until it is reloaded,
    // and a setting that outlived the tab it was meant for would be a switch nobody can find.
    expect(sent.at(-1)).toMatchObject({ message: { type: 'tc:pause', on: true } })
    expect(written).toHaveLength(0)
  })
})

describe('the history and the switches under it', () => {
  it('shows no history at all when there is nothing on disk', async () => {
    rows = []
    await draw()

    // A heading over an empty list is a promise of something that is not there. On a browser
    // that has recorded nothing the popup stays what it was: the page, and what to do with it.
    expect(at('history')).toBeNull()
  })

  it('opens a recording of the history in an editor of its own', async () => {
    rows = [row]
    const chrome = await draw()

    await click(at('history-open')!)

    // By the second door of the editor and not by the first: `?h=` is a session of the history,
    // whose material is the pieces on disk, and `?s=` is a snapshot file written for one editing.
    expect(chrome.created).toEqual([
      { url: 'chrome-extension://tailcut/editor/editor.html?h=h1', windowId: 23 },
    ])
  })

  it('opens settings in the same window as the page', async () => {
    const chrome = await draw()

    await click(at('open-settings')!)

    expect(chrome.created).toEqual([
      { url: 'chrome-extension://tailcut/options/options.html', windowId: 23 },
    ])
  })

  it('does not expose pin even for a row kept by an older version', async () => {
    rows = [{ ...row, pinned: true }]
    await draw()
    expect(at('history-pin')).toBeNull()
    expect(pinned).toEqual([['h1', false]])
  })

  it('says this page is paused because the frame said so, not because a button was pressed', async () => {
    // A popup opened a second time over a page that is already paused. The pause lives in the
    // frame and nowhere else, so the answer of the frame is the only thing that knows of it —
    // and a button offering to pause a paused page would turn the recording back on.
    await mount({ sessions: [fresh], paused: true })

    expect(textAt('pause-tab')).toBe('Resume on this page')
    document.querySelector<HTMLButtonElement>('[data-testid="pause-tab"]')!.click()
    await settle()

    expect(sent.at(-1)).toMatchObject({ message: { type: 'tc:pause', on: false } })
  })

  it('keeps the rows the user did not delete', async () => {
    const other: HistoryRow = {
      ...row,
      id: 'h2',
      key: 'https://old.example/w|avc1|60',
      title: 'The one to keep',
    }
    rows = [row, other]
    await draw()

    document.querySelectorAll<HTMLButtonElement>('[data-testid="history-delete"]')[0]!.click()
    await settle()

    // One row goes and the other stays, and the toast names the one that went: a toast reading
    // "Deleted" over a list that lost a row is no undo at all if it cannot say which row.
    expect(allAt('history-row')).toHaveLength(1)
    expect(textAt('history-title')).toBe('The one to keep')
    expect(textAt('undo')).toContain('Yesterday')
    expect(deleted).toEqual(['h1'])
  })

  it('does not bring an earlier row back when two recordings are deleted quickly', async () => {
    const other: HistoryRow = {
      ...row,
      id: 'h2',
      key: 'https://old.example/w|avc1|60',
      title: 'The second one',
    }
    rows = [row, other]
    await draw()

    await click(allAt('history-delete')[0]!)
    await click(allAt('history-delete')[0]!)

    expect(allAt('history-row')).toHaveLength(0)
    expect(deleted).toEqual(['h1', 'h2'])
  })

  it('names the recordings region for assistive navigation', async () => {
    rows = [row]
    await draw()

    const region = at('recordings')!
    expect(region.querySelector('h2')?.textContent).toBe('Recordings')
  })

  it('says when a recording was last watched, and how much of the disk it holds', async () => {
    rows = [{ ...row, lastSeenAt: Date.now() - 26 * 3_600_000 }]
    await draw()

    // Recent sessions include their recording time. Three rows all reading "4:00" are three
    // rows the user cannot tell apart, and the moment is what tells yesterday's recording from
    // last month's; the weight beside the address is the other half of the same question — what
    // is on disk, and what taking a row back would give.
    expect(textAt('history-when')).toBe('Yesterday')
    expect(textAt('history-host')).toBe('old.example · 85.8 MB')
  })

  it('takes the undo away when the time to change one’s mind is up', async () => {
    // The window in which a deletion can be called off is the toast, and it is not for ever: the
    // sweeper takes the files half a minute later, and an undo left on screen past that would be
    // a button promising back what is already gone.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    rows = [row]
    await draw()

    await click(document.querySelector<HTMLButtonElement>('[data-testid="history-delete"]')!)
    expect(at('undo'), 'setup: nothing was offered back').not.toBeNull()

    await vi.advanceTimersByTimeAsync(6_000)
    await settle()

    expect(at('undo')).toBeNull()
  })

  it('keeps a deleted row gone once the undo has left, rather than putting it back', async () => {
    // The row is hidden while the toast is up and out of the index for good the moment it was
    // deleted — those are two different mechanisms, and the toast leaving must not undo the
    // second one. The index here marks and sifts exactly as the real one does, so the row is
    // already out of what a re-reading answers.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    rows = [row]
    await draw()

    await click(document.querySelector<HTMLButtonElement>('[data-testid="history-delete"]')!)

    await vi.advanceTimersByTimeAsync(6_000)
    await settle()

    expect(allAt('history-row')).toHaveLength(0)
    expect(at('history'), 'a heading was left standing over an empty history').toBeNull()
  })

  it('offers no switch for the site while nothing is recorded anywhere', async () => {
    stored = merge({ recording: { ...DEFAULTS.recording, mode: 'off' } })
    await draw()

    // `Off` is not "this site is not recorded": neither list decides anything while it holds, so
    // a live switch here writes a host onto a list nothing reads and comes back unticked — a
    // control that answers a press by doing nothing and saying nothing about why.
    const toggle = at('site-toggle') as HTMLInputElement
    expect(toggle.disabled, 'a switch that decides nothing was offered as a live one').toBe(true)
    expect(toggle.checked).toBe(false)
    expect(textAt('site-off')).toBe('Recording is off in Settings — no site is recorded.')
  })

  it('leaves the switch live, and unexplained, wherever the settings do decide something', async () => {
    await draw()

    expect((at('site-toggle') as HTMLInputElement).disabled).toBe(false)
    expect(at('site-off'), 'a reason was given for a switch that works').toBeNull()
  })
})
