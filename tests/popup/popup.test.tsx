// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Omission, SaveResult, SessionSummary } from '../../src/shared/protocol'

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
}

type Sent = { tabId: number; message: unknown }

/** The answer of the tab: a list of summaries, or silence — the tab has not answered yet. */
type Reply = {
  sessions: SessionSummary[]
  /** The tab says this page holds a player the extension could not reach. */
  unreachable?: boolean
  /** The tab says this page plays media that is encrypted. */
  encrypted?: boolean
  save?: SaveResult
} | 'silent'

/**
 * Replaces chrome for the popup: there is one tab, and it answers with what the test set. The api
 * module stays the real one — the whole road from the tab's answer to the markup is checked.
 */
function installChrome(reply: Reply) {
  const sent: Sent[] = []
  // The save answer is mutable: the same popup saves more than once, and the second attempt may
  // well go through where the first did not.
  let saveReply: unknown = (reply === 'silent' ? undefined : reply.save) ?? { ok: true }

  vi.stubGlobal('chrome', {
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: (tabId: number, message: unknown) => {
        sent.push({ tabId, message })
        if ((message as { type?: string }).type === 'tc:save') return Promise.resolve(saveReply)
        // Silence from the tab is not a refusal: the promise simply never settles, and the popup
        // waits.
        if (reply === 'silent') return new Promise(() => {})
        return Promise.resolve({
          sessions: reply.sessions,
          unreachable: reply.unreachable,
          encrypted: reply.encrypted,
        })
      },
    },
  })

  return {
    sent,
    setSaveReply: (value: unknown) => {
      saveReply = value
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the popup', () => {
  it('waits while the tab has not answered', async () => {
    await mount('silent')

    expect(bodyText()).toBe('Loading…')
  })

  it('says there was nothing to record on a page with no recording', async () => {
    await mount({ sessions: [] })

    // An empty list differs from "no answer yet": without that fork the popup reads the fields of
    // a summary that does not exist, the render throws, and it stays in "Loading…" for good.
    expect(bodyText()).toBe('Nothing recorded on this page yet.')
    expect(at('title'), 'the popup shows a summary where there are none').toBeNull()
  })

  it('says a protected page cannot be recorded, rather than showing the same emptiness', async () => {
    await mount({ sessions: [], encrypted: true })

    // The page plays encrypted media, so nothing of it was kept and nothing ever will be. Told
    // "nothing recorded yet", the user waits for a recording that is never coming and takes a
    // deliberate refusal for a defect — which is exactly what the survey found on every protected
    // page it opened.
    expect(bodyText()).toBe(
      'This page plays protected video, which tailcut does not record. Nothing of it was kept.',
    )
    expect(at('save'), 'a protected page must not be offered for saving').toBeNull()
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
    expect(bodyText()).toBe('tailcut cannot reach the player on this page, so nothing of it was recorded.')
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
    ['gap', 'Recording has gaps: the longest piece is saved.'],
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

  it('carries the notice of the session it shows, not of the one it showed', async () => {
    await mount({ sessions: [{ ...fresh, omits: 'gap' }, older] })

    await click(allAt('session')[0]!)

    expect(at('omits'), 'the notice of the previous session stayed on screen').toBeNull()
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

  it('shows the session picked out of the list in place of the current one', async () => {
    await mount({ sessions: [fresh, older] })

    await click(allAt('session')[0]!)

    expect(textAt('title')).toBe(older.title)
    expect(textAt('host')).toBe('other.example')
    expect(textAt('duration')).toBe('5:00')
    // The one that was current takes the place of the one that was picked: the list holds every
    // session but the one being shown, or a session would vanish from the popup on being chosen.
    expect(allAt('session').map((row) => row.textContent)).toEqual([
      expect.stringContaining(fresh.title),
    ])
  })

  it('saves the session picked out of the list, not the freshest one', async () => {
    const { sent } = await mount({ sessions: [fresh, older] })

    await click(allAt('session')[0]!)
    await click(saveButton())

    expect(sent.map((item) => item.message)).toEqual([
      { type: 'tc:list' },
      { type: 'tc:save', key: older.key },
    ])
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
