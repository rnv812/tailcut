// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from 'preact'
import {
  DEFAULTS,
  LEGAL_VERSION,
  LIMITS,
  REFERENCE_BITS_PER_SECOND,
  memoryCeilingFor,
  merge,
  termsAccepted,
  type Settings,
} from '../../src/shared/settings'
import { Options, bitsPerSecondOf, held, memoryFor } from '../../src/options/options'

/**
 * The settings page against fakes of the two things it reads: the store of settings and the
 * index of what is on disk. Both are replaced outright — the real store wants chrome.storage and
 * the real index wants IndexedDB, and a runner has neither — but nothing between them and the
 * markup is: the page is checked from the value it was given to the control that shows it.
 */

let stored: Settings = DEFAULTS
const written: Settings[] = []
/** Whoever the page subscribed with. In the browser it is chrome.storage.onChanged; here, a test. */
let listeners: Array<(next: Settings, previous: Settings) => void> = []
/** A read of the settings that never comes back: the page has to have something to show until it does. */
let holdRead = false
let refuseWrite = false
let totalsReads = 0
let sessionReads = 0

interface LegalState {
  acceptedVersion: number
  acceptedAt: number
}

type SettingsWithLegal = Settings & { legal: LegalState }

const withLegal = (legal: LegalState, over: Partial<Settings> = {}): Settings =>
  ({ ...DEFAULTS, ...over, legal }) as SettingsWithLegal

const accepted = (acceptedAt = 1_756_022_100_000, over: Partial<Settings> = {}): Settings =>
  withLegal({ acceptedVersion: LEGAL_VERSION, acceptedAt }, over)

vi.mock('../../src/shared/settings-store', () => ({
  readSettings: () =>
    holdRead ? new Promise<Settings>(() => {}) : Promise.resolve(stored),
  // Through `merge`, exactly as the real store writes: what is stored is what merge made of the
  // edit, and the page is entitled to no other answer about what it has just saved. And in two
  // steps with a turn between them, exactly as the real one runs: it reads storage, applies the
  // edit to what came back and stores that. Written as one step, the fake would hide every race
  // between two writes in flight at once — the real store has no such kindness.
  writeSettings: async (edit: (current: Settings) => Settings) => {
    const before = stored
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (refuseWrite) throw new Error('storage refused')
    stored = merge(edit(before))
    written.push(stored)
    return stored
  },
  watchSettings: (onChange: (next: Settings, previous: Settings) => void) => {
    listeners.push(onChange)
    return () => {
      listeners = listeners.filter((one) => one !== onChange)
    }
  },
}))

/** What the index says is on disk. `cappedBytes`/`fullAt` are how a refusal by the browser shows. */
let totals = { id: 'totals', bytes: 2 * 1024 ** 3, cappedBytes: 0, fullAt: 0 }

/**
 * What has been recorded, as the rate meter sees it: 450 MB of material covering five minutes,
 * which is 12 Mbit/s — twice the 1080p the page falls back to, so the two never read alike.
 */
let sessions: Array<{ bytes: number; seconds: number }> = [{ bytes: 450_000_000, seconds: 300 }]

vi.mock('../../src/shared/history-db', () => ({
  readTotals: async () => {
    totalsReads += 1
    return totals
  },
  listSessions: async () => {
    sessionReads += 1
    return sessions
  },
}))

/**
 * Lets the page finish drawing. The frame is no belt and braces: preact defers effects until it,
 * and before the effect the page has asked neither the store nor the index anything. The turns
 * after it are for the two answers, which arrive independently, and for the redraw on each.
 */
const flush = async () => {
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const draw = async () => {
  render(<Options />, document.body)
  await flush()
}

/** Long enough for a settled write to have gone through; SETTLE_MS is 300. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 400))

const at = (testId: string) => document.body.querySelector(`[data-testid="${testId}"]`)
const field = (testId: string) => document.body.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!
const textAt = (testId: string) => at(testId)?.textContent ?? null

/** Types into a control the way a person does: the value, then the event the page listens for. */
const type = (testId: string, value: string) => {
  const input = field(testId)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const check = (testId: string, on: boolean) => {
  const input = field(testId)
  input.checked = on
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Selects an option and sends the event the page listens for. */
const select = (testId: string, value: string) => {
  const input = field(testId)
  input.value = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

const click = async (testId: string) => {
  document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click()
  await flush()
}

/** Opens one advanced group through the same disclosure control a person uses. */
const openAdvanced = async (label: string) => {
  const summary = document.body.querySelector<HTMLElement>(
    `[data-testid="advanced-toggle"][aria-label="${label}"]`,
  )!
  const details = summary.closest<HTMLDetailsElement>('details')!
  if (!details.open) summary.click()
  await flush()
  expect(details.open).toBe(true)
}

beforeEach(() => {
  stored = accepted()
  totals = { id: 'totals', bytes: 2 * 1024 ** 3, cappedBytes: 0, fullAt: 0 }
  sessions = [{ bytes: 450_000_000, seconds: 300 }]
  holdRead = false
  refuseWrite = false
  totalsReads = 0
  sessionReads = 0
  written.length = 0
  listeners = []
  // A new body rather than a cleared one: the module draws itself when it loads, exactly as the
  // popup does, and the old body still holds the preact tree of the last render — cleared with
  // innerHTML it would be reconciled against nodes that are no longer in the document.
  document.documentElement.replaceChild(document.createElement('body'), document.body)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the settings page', () => {
  it('shows mandatory legal consent instead of settings until the current terms are accepted', async () => {
    stored = withLegal({ acceptedVersion: 0, acceptedAt: 0 })
    await draw()

    expect(at('legal-consent')).not.toBeNull()
    expect(document.querySelectorAll('[data-testid="group-title"]')).toHaveLength(0)
    expect(at('reset')).toBeNull()
    expect(totalsReads).toBe(0)
    expect(sessionReads).toBe(0)
  })

  it('accepts the current terms only after confirmation and records when they were accepted', async () => {
    const now = 1_756_022_399_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    stored = withLegal({ acceptedVersion: 0, acceptedAt: 0 })
    await draw()

    expect(field('legal-continue').disabled).toBe(true)
    check('legal-agree', true)
    await flush()
    expect(field('legal-continue').disabled).toBe(false)
    await click('legal-continue')

    expect((written.at(-1) as SettingsWithLegal).legal).toEqual({
      acceptedVersion: LEGAL_VERSION,
      acceptedAt: now,
    })
    expect(termsAccepted(written.at(-1)!)).toBe(true)
  })

  it('keeps consent locked and explains when the agreement could not be stored', async () => {
    stored = withLegal({ acceptedVersion: 0, acceptedAt: 0 })
    refuseWrite = true
    await draw()

    check('legal-agree', true)
    await flush()
    await click('legal-continue')
    await flush()

    expect(written).toHaveLength(0)
    expect(at('legal-consent')).not.toBeNull()
    expect(at('group-title')).toBeNull()
    expect(at('legal-error')?.getAttribute('role')).toBe('alert')
    expect(at('legal-error')?.textContent).toContain('Could not save your agreement')
    expect(field('legal-continue').disabled).toBe(false)
  })

  it('resets preferences without revoking accepted terms', async () => {
    const legal = { acceptedVersion: LEGAL_VERSION, acceptedAt: 1_756_022_100_000 }
    stored = withLegal(legal, {
      history: { ...DEFAULTS.history, keepDays: 30 },
    })
    await draw()
    await click('reset')

    expect((written.at(-1) as SettingsWithLegal).legal).toEqual(legal)
    expect(written.at(-1)!.history).toEqual(DEFAULTS.history)
  })

  it('keeps the legal links and donation link in a quiet footer after acceptance', async () => {
    stored = accepted()
    await draw()

    const footer = document.querySelector<HTMLElement>('[data-testid="legal-footer"]')!
    expect(footer).not.toBeNull()
    expect(footer.textContent).toContain('Privacy')
    expect(footer.textContent).toContain('Terms')

    const support = footer.querySelector<HTMLAnchorElement>('[data-testid="support-link"]')!
    expect(support.textContent).toBe('Donate')
    expect(support.href).toBe('https://donatty.com/rnv812')
    expect(support.target).toBe('_blank')
    expect(support.rel.split(/\s+/)).toContain('noreferrer')
    expect(support.classList.contains('legal-donate')).toBe(true)
    expect(support.getAttribute('aria-describedby')).toBe('donation-note')
    expect(support.title).toContain('voluntary')
    expect(support.title).toContain('no features or benefits')
    expect(document.querySelector('#donation-note')?.textContent).toContain(
      'Donations are voluntary and unlock no features or benefits.',
    )
  })

  it('shows the four settings groups in recording order', async () => {
    await draw()
    const titles = [...document.querySelectorAll('[data-testid="group-title"]')].map(
      (node) => node.textContent,
    )
    expect(titles).toEqual(['Recording', 'Video detection', 'History', 'Export'])
  })

  it('identifies the settings page with the packaged tailcut mark', async () => {
    await draw()
    const mark = document.querySelector<HTMLImageElement>('[data-testid="brand-mark"]')

    expect(mark?.alt).toBe('tailcut')
    expect(mark?.getAttribute('src')).toBe('../assets/tailcut/svg/mark-light.svg')
  })

  it('has something to show while the settings are still being read', async () => {
    // The read is one turn of storage, and the page is opened by a click: with nothing here the
    // tab is blank for that turn, which reads as a page that failed to open.
    holdRead = true
    await draw()

    expect(document.body.textContent).toBe('Loading…')
  })

  it('styles the native disclosure for fine tuning and keeps it folded away', async () => {
    await draw()
    const folded = [...document.querySelectorAll<HTMLDetailsElement>('details.advanced')]
    const toggles = [...document.querySelectorAll<HTMLElement>('[data-testid="advanced-toggle"]')]

    expect(folded).toHaveLength(2)
    expect(toggles.length).toBeGreaterThan(0)
    expect(folded.every((details) => !details.open)).toBe(true)
    expect(toggles.map((toggle) => toggle.textContent)).toEqual(['Advanced', 'Advanced'])
    expect(toggles.map((toggle) => toggle.getAttribute('aria-label'))).toEqual([
      'Advanced video detection settings',
      'Advanced export settings',
    ])

    toggles[0]!.click()
    await flush()

    expect(folded[0]!.open).toBe(true)
    expect(folded[1]!.open).toBe(false)
  })

  it('says what a buffer of this length will cost in memory, at the rate this user records', async () => {
    await draw()
    // 300 seconds of recorded material weighed 450 MB — 12 Mbit/s — so the three minutes of the
    // default buffer are 270 million bytes, which is 257.5 MB in the displayed binary units.
    expect(textAt('buffer-cost')).toContain('257.5 MB')
  })

  it('falls back to 1080p while there is nothing recorded to measure', async () => {
    // Nothing on disk yet, which is every user on their first day. 6 Mbit/s over three minutes
    // is 135 million bytes — 128.7 MB.
    sessions = []
    await draw()

    expect(textAt('buffer-cost')).toContain('128.7 MB')
  })

  it('writes the buffer length as a number of seconds', async () => {
    await draw()
    type('buffer', '60')
    await settled()

    expect(written.at(-1)!.recording.bufferSeconds).toBe(60)
  })

  it('leaves one write behind a slider dragged across its range, not forty', async () => {
    // Not about a quota — `local` has no write rate worth naming — but about the history of
    // changes: forty writes make the next person reading storage for a bug report read a film
    // strip. The page shows every step of the drag; storage sees where it stopped.
    await draw()
    for (const value of ['30', '45', '60', '75', '90']) type('buffer', value)

    expect(written, 'a slider still being dragged has been written').toEqual([])
    await flush()
    expect(textAt('buffer-value'), 'the page waits for storage to show the value').toBe('2 min')

    await settled()
    expect(written).toHaveLength(1)
    expect(written[0]!.recording.bufferSeconds).toBe(90)
  })

  it('writes when the drag stops, not while it is still going on', async () => {
    // A drag lasts longer than the wait does. Timed from the first move rather than from the
    // last, the write lands in the middle of it and every move after that is a write of its own
    // — which is the film strip the wait exists to prevent.
    await draw()
    for (const value of ['30', '45', '60']) {
      type('buffer', value)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    await settled()

    expect(written).toHaveLength(1)
    expect(written[0]!.recording.bufferSeconds).toBe(60)
  })

  it('lets one write finish before the next one starts', async () => {
    // `writeSettings` reads storage, applies the edit to what came back and stores that. Two of
    // them in flight at once both read the old value, and the later one puts back what the
    // earlier had just changed — a setting the user watched themselves change and found
    // unchanged a moment later.
    await draw()
    await openAdvanced('Advanced video detection settings')
    check('to-disk', false)
    check('record-muted', false)
    await flush()
    await flush()

    expect(stored.history.toDisk).toBe(false)
    expect(stored.detection.recordMuted).toBe(false)
  })

  it('does not lose a settling value to a switch thrown straight after it', async () => {
    // A field is left settling and something else is clicked a moment later. A single pending
    // write, cancelled by whatever came next, would drop the number the user had just set — and
    // drop it because of a click they cannot possibly connect it to.
    await draw()
    type('keep-days', '30')
    check('to-disk', false)
    await flush()

    // One write and not two: what was waiting and what was just clicked are one change of the
    // settings as far as anyone reading the history of them is concerned.
    expect(written).toHaveLength(1)
    expect(written.at(-1)!.history.keepDays).toBe(30)
    expect(written.at(-1)!.history.toDisk).toBe(false)
  })

  it('keeps both of two controls moved in one breath, in storage and on screen', async () => {
    await draw()
    type('keep-days', '30')
    type('ceiling', String(8 * 1024 ** 3))
    await settled()

    expect(written, 'the two moves were stored as two writes').toHaveLength(1)
    expect(written[0]!.history.keepDays).toBe(30)
    expect(written[0]!.history.ceilingBytes).toBe(8 * 1024 ** 3)

    // And on screen: an edit built on the render it was made in would show the second move over
    // a copy of the settings taken before the first, putting the first one back.
    expect(field('keep-days').value).toBe('30')
    expect(textAt('ceiling-value')).toBe('8.00 GB')
  })

  it('writes a switch the moment it is thrown', async () => {
    // A checkbox is not a drag: waiting a third of a second to store one click is a page that
    // loses the change to a tab closed straight after it.
    await draw()
    check('to-disk', false)
    await flush()

    expect(written.at(-1)!.history.toDisk).toBe(false)
  })

  it('marks a host as allowed or denied in one list', async () => {
    stored = accepted(1_756_022_100_000, {
      recording: { ...DEFAULTS.recording, deny: ['ads.example'] },
    })
    await draw()

    const row = at('host-row')!
    expect(row.textContent).toContain('ads.example')
    row.querySelector<HTMLButtonElement>('[data-testid="host-toggle"]')!.click()
    await flush()

    expect(written.at(-1)!.recording.allow).toEqual(['ads.example'])
    expect(written.at(-1)!.recording.deny).toEqual([])
  })

  it('keeps the two lists in one order, whichever list a host is in', async () => {
    // One list and not two, because a user thinks about a site once: this one, yes or no. Sorted
    // by host and not by verdict, or a site changed from denied to allowed jumps somewhere else
    // in the list and the user has to find it again to change it back.
    stored = accepted(1_756_022_100_000, {
      recording: { ...DEFAULTS.recording, allow: ['b.example'], deny: ['c.example', 'a.example'] },
    })
    await draw()

    const rows = [...document.querySelectorAll('[data-testid="host-row"]')].map((row) =>
      row.querySelector('.host-name')!.textContent,
    )
    expect(rows).toEqual(['a.example', 'b.example', 'c.example'])
  })

  it('drops a host the user is done with', async () => {
    stored = accepted(1_756_022_100_000, {
      recording: { ...DEFAULTS.recording, deny: ['ads.example'] },
    })
    await draw()

    at('host-row')!.querySelector<HTMLButtonElement>('[data-testid="host-remove"]')!.click()
    await flush()

    expect(written.at(-1)!.recording.deny).toEqual([])
    expect(at('host-row'), 'the row is still on screen after being removed').toBeNull()
  })

  it('adds nothing when the field it adds from is empty', async () => {
    // The button is there whether anything was typed or not, and an empty entry would go the
    // whole way to storage to be dropped by `merge` — a write of nothing, in the record of
    // changes, every time the button is brushed.
    await draw()
    await click('host-add')

    expect(written).toEqual([])
  })

  it('takes an address where a host is expected', async () => {
    await draw()
    type('host-input', 'https://site.example/watch?v=1')
    await flush()
    await click('host-add')

    expect(written.at(-1)!.recording.deny).toEqual(['site.example'])
    expect(at('host-row')!.textContent).toContain('site.example')
  })

  it('refuses what is neither a host nor an address, on screen as well as in storage', async () => {
    // `merge` is what settles a host out of what was typed, and the page shows what merge made
    // of it rather than what was typed. Otherwise the list on screen holds a row that storage
    // never took, and it holds it until the page is next opened.
    await draw()
    type('host-input', 'not a host at all')
    await flush()
    await click('host-add')

    expect(written.at(-1)!.recording.deny).toEqual([])
    expect(at('host-row')).toBeNull()
  })

  it('picks a preset by name and shows Custom once a value is moved', async () => {
    await draw()
    await click('preset-strict')
    expect(written.at(-1)!.detection.minWidthPx).toBe(480)

    await openAdvanced('Advanced video detection settings')
    type('min-width', '400')
    await settled()

    expect(textAt('preset-name')).toBe('Custom')
    expect(written.at(-1)!.detection.minWidthPx).toBe(400)
  })

  it('holds a number to the limits of the setting, and says that it did', async () => {
    // `min` and `max` on a number field are advice the browser gives, not a rule it enforces:
    // typed or pasted, 9999 arrives in the input event exactly as 90 does. A value quietly
    // corrected on the next reload is a page that lies for as long as it stays open.
    await draw()
    type('keep-days', '9999')
    await settled()

    // The advice is on the control as well, so that a browser which does enforce it — a spinner
    // clicked rather than a number typed — never gets the value here in the first place.
    expect(field('keep-days').min).toBe(String(LIMITS.keepDays.min))
    expect(field('keep-days').max).toBe(String(LIMITS.keepDays.max))
    expect(field('keep-days').value).toBe(String(LIMITS.keepDays.max))
    expect(written.at(-1)!.history.keepDays).toBe(LIMITS.keepDays.max)
    expect(textAt('limit-note')).toContain(`${LIMITS.keepDays.min} to ${LIMITS.keepDays.max} days`)
  })

  it('writes the disk limit in bytes and shows it in gigabytes', async () => {
    await draw()
    type('ceiling', String(8 * 1024 ** 3))
    await settled()

    expect(written.at(-1)!.history.ceilingBytes).toBe(8 * 1024 ** 3)
    expect(textAt('ceiling-value')).toBe('8.00 GB')
  })

  it('writes the probation in seconds', async () => {
    await draw()
    await openAdvanced('Advanced video detection settings')
    type('probation', '12')
    await settled()

    expect(written.at(-1)!.detection.gracePeriodSeconds).toBe(12)
  })

  it('says nothing about limits while the value is within them', async () => {
    await draw()
    type('keep-days', '30')
    await settled()

    expect(written.at(-1)!.history.keepDays).toBe(30)
    expect(at('limit-note'), 'a value inside its limits was called out').toBeNull()
  })

  it('shows the occupied volume out of the index and not out of the browser', async () => {
    // navigator.storage.estimate() showed 10 GiB with a real ceiling of 200 MB, and a walk of
    // Reading every OPFS file is expensive. The index already knows the total in one row.
    await draw()

    expect(textAt('volume')).toContain('2.00 GB')
    expect(at('disk-full')).toBeNull()
  })

  it('says when the browser refused, instead of leaving the ceiling looking kept', async () => {
    // The disk said no below the ceiling this page is showing. Without a word here, the writer
    // retries every thirty seconds for ever and the page goes on showing a limit of four
    // gigabytes as though failed writes were still retained.
    totals = { ...totals, cappedBytes: 1_800_000_000, fullAt: Date.now() }
    await draw()

    expect(textAt('disk-full')).toContain('Disk full')
  })

  it('asks the service worker to clear, and shows nothing occupied afterwards', async () => {
    const sent: unknown[] = []
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: async (message: unknown) => (sent.push(message), { ok: true }) },
    })
    totals = { ...totals, cappedBytes: 1_800_000_000, fullAt: Date.now() }
    await draw()

    await click('clear')

    // Deletion has one owner and it is the service worker: the page asks and shows the answer it
    // already knows — nothing occupied, and no refusal outstanding.
    expect(sent).toEqual([{ type: 'tc:clear' }])
    expect(textAt('volume')).toBe('0 KB')
    expect(at('disk-full')).toBeNull()
    expect(at('clear-refused')).toBeNull()
  })

  it('says so when the wipe was refused, instead of drawing a zero over it', async () => {
    // The worker answers `ok: false` when the wipe stopped halfway — a file another handle holds
    // open, an index that would not open. Drawn as a success, the page reports a deletion the
    // disk knows nothing about, and the volume comes back at the next reload with no explanation.
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: async () => ({ ok: false }) },
    })
    totals = { ...totals, cappedBytes: 1_800_000_000, fullAt: Date.now() }
    await draw()

    await click('clear')

    expect(textAt('clear-refused')).toContain('Nothing was cleared')
    // And what is shown is what the index says now, read back rather than guessed at.
    expect(textAt('volume')).toContain('2.00 GB')
    expect(textAt('disk-full')).toContain('Disk full')
  })

  it('says the same when there is no worker to hear it at all', async () => {
    // The extension was reloaded under this page: sendMessage refuses with a promise. Nothing was
    // cleared then either, and the answer on screen has to be the same one.
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: async () => {
          throw new Error('Could not establish connection.')
        },
      },
    })
    await draw()

    await click('clear')

    expect(textAt('clear-refused')).toContain('Nothing was cleared')
    expect(textAt('volume')).toContain('2.00 GB')
  })

  it('says how much of a long buffer a tab will actually keep', async () => {
    // 450 MB over five minutes is 12 Mbit/s, twice the rate the ceiling is sized at, and half an
    // hour of it is more than one document holds. Silent, the slider promised half an hour and
    // the frame kept a third of it — and used to lose the recording altogether every few minutes
    // getting there.
    stored = merge(
      accepted(1_756_022_100_000, {
        recording: { ...DEFAULTS.recording, bufferSeconds: 1_800 },
      }),
    )
    await draw()

    const ceiling = memoryCeilingFor(1_800)
    const kept = (ceiling * 8) / ((450_000_000 * 8) / 300)
    expect(textAt('buffer-cost')).toContain('2.51 GB')
    expect(textAt('buffer-cost')).toContain(`${Math.round(kept / 60)} min`)
  })

  it('says nothing of the sort while the whole of the buffer fits', async () => {
    // The ordinary case, and it has to stay quiet: three minutes at that same 12 Mbit/s is 270 MB
    // against a ceiling of half a gigabyte, so the length on the slider is the length that will
    // be there. A warning under every buffer is a warning nobody reads.
    await draw()

    expect(textAt('buffer-cost')).toContain('257.5 MB')
    expect(textAt('buffer-cost'), 'a buffer that fits was called short').not.toContain('will be kept')
  })

  it('offers only the output format and keeps encoder internals out of settings', async () => {
    await draw()

    expect(field('format').disabled).toBe(false)
    expect(document.querySelector('[data-testid="codec"]')).toBeNull()
    expect(document.querySelector('[data-testid="quality"]')).toBeNull()
    expect(document.querySelector('[data-testid="rewrite-head"]')).toBeNull()
    expect(document.querySelector('[data-testid="export-note"]')).toBeNull()
  })

  it('offers exactly MP4 and Animated WebP', async () => {
    await draw()

    expect(field('format').value).toBe(DEFAULTS.export.format)
    expect([...field('format').querySelectorAll('option')].map((option) => option.value)).toEqual([
      'mp4',
      'webp',
    ])
  })

  it('stores a changed export format', async () => {
    await draw()
    select('format', 'webp')
    await flush()

    expect(field('format').value).toBe('webp')
    expect(written.at(-1)!.export.format).toBe('webp')
  })

  it('lets through the two export settings this stage can keep', async () => {
    // The name of a file and where it is put need no encoder, so they are live while the rest of
    // the group waits. A name is typed a letter at a time, so it settles like a slider: one write
    // for the name, not one per keystroke.
    await draw()
    await openAdvanced('Advanced export settings')
    type('name-template', '{host}')
    type('name-template', '{host} {date}')
    await settled()
    expect(written).toHaveLength(1)

    check('ask-where', true)
    await flush()

    expect(written.at(-2)!.export.nameTemplate).toBe('{host} {date}')
    expect(written.at(-1)!.export.askWhere).toBe(true)
  })

  it('keeps silent video out when the user says so', async () => {
    await draw()
    await openAdvanced('Advanced video detection settings')
    check('record-muted', false)
    await flush()

    expect(written.at(-1)!.detection.recordMuted).toBe(false)
  })

  it('records nothing anywhere once the mode is Off', async () => {
    await draw()
    await click('mode-off')

    expect(written.at(-1)!.recording.mode).toBe('off')
  })

  it('restores every documented default on screen and in storage', async () => {
    stored = accepted(1_756_022_100_000, {
      history: { ...DEFAULTS.history, keepDays: 30 },
    })
    await draw()
    expect(field('keep-days').value).toBe('30')

    await click('reset')

    expect(written.at(-1)).toEqual(accepted())
    expect(field('keep-days').value).toBe(String(DEFAULTS.history.keepDays))
  })

  it('follows a change made somewhere else without being told twice', async () => {
    // The popup has quick switches of its own and they write the same key. A page showing
    // the old value would be a page that undoes the change the moment anything else is touched.
    await draw()
    expect(field('to-disk').checked).toBe(true)

    const changed = accepted(1_756_022_100_000, {
      history: { ...DEFAULTS.history, toDisk: false },
    })
    expect(listeners, 'the page subscribed to nothing').not.toEqual([])
    for (const listener of listeners) listener(changed, DEFAULTS)
    await flush()

    expect(field('to-disk').checked).toBe(false)
  })
})

describe('the expected cost of a buffer', () => {
  it('is measured over everything recorded, not over one session', () => {
    // Bytes over seconds for the lot, and not the mean of the rates: a ten-second session at a
    // huge rate would otherwise weigh as much as an hour at an ordinary one.
    expect(
      bitsPerSecondOf([
        { bytes: 100_000_000, seconds: 100 },
        { bytes: 500_000_000, seconds: 400 },
      ]),
    ).toBe((600_000_000 * 8) / 500)
  })

  it('is 1080p while nothing has been recorded', () => {
    expect(bitsPerSecondOf([])).toBe(REFERENCE_BITS_PER_SECOND)
    // And a session that covers no time at all is nothing recorded too: the first batch of a
    // session lands with its seconds still at zero, and bytes over zero is not a rate.
    expect(bitsPerSecondOf([{ bytes: 8_000_000, seconds: 0 }])).toBe(REFERENCE_BITS_PER_SECOND)
  })

  it('turns a length and a rate into bytes', () => {
    expect(memoryFor(180, 6_000_000)).toBe(135_000_000)
  })
})

describe('held', () => {
  it.each([
    ['30', { value: 30, refused: false }],
    ['1', { value: 1, refused: false }],
    ['90', { value: 90, refused: false }],
    ['9999', { value: 90, refused: true }],
    ['0', { value: 1, refused: true }],
    ['-5', { value: 1, refused: true }],
    // An emptied field: the browser hands over an empty string, and Number('') is 0, which is
    // not what the user meant by clearing it either.
    ['', { value: 1, refused: true }],
    ['x', { value: 1, refused: true }],
  ])('%s → %o', (raw, expected) => {
    expect(held(raw, LIMITS.keepDays)).toEqual(expected)
  })

  it('calls an emptied field a refusal even where zero is allowed', () => {
    // Probation starts at zero, and Number('') is zero: without a word for "nothing was typed",
    // clearing the field means "no probation at all" and the page never says so.
    expect(held('', LIMITS.gracePeriodSeconds)).toEqual({ value: 0, refused: true })
  })
})
