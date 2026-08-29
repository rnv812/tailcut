// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from 'preact'
import { DEFAULTS, LIMITS, merge, type Settings } from '../../src/shared/settings'
import {
  DEFAULT_BITS_PER_SECOND,
  Options,
  bitsPerSecondOf,
  held,
  memoryFor,
} from '../../src/options/options'

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
  readTotals: async () => totals,
  listSessions: async () => sessions,
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

const click = async (testId: string) => {
  document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click()
  await flush()
}

beforeEach(() => {
  stored = DEFAULTS
  totals = { id: 'totals', bytes: 2 * 1024 ** 3, cappedBytes: 0, fullAt: 0 }
  sessions = [{ bytes: 450_000_000, seconds: 300 }]
  holdRead = false
  written.length = 0
  listeners = []
  // A new body rather than a cleared one: the module draws itself when it loads, exactly as the
  // popup does, and the old body still holds the preact tree of the last render — cleared with
  // innerHTML it would be reconciled against nodes that are no longer in the document.
  document.documentElement.replaceChild(document.createElement('body'), document.body)
})

describe('the settings page', () => {
  it('shows the four groups of §9.4 in the order of a recording', async () => {
    await draw()
    const titles = [...document.querySelectorAll('[data-testid="group-title"]')].map(
      (node) => node.textContent,
    )
    expect(titles).toEqual(['Recording', 'Video detection', 'History', 'Export'])
  })

  it('has something to show while the settings are still being read', async () => {
    // The read is one turn of storage, and the page is opened by a click: with nothing here the
    // tab is blank for that turn, which reads as a page that failed to open.
    holdRead = true
    await draw()

    expect(document.body.textContent).toBe('Loading…')
  })

  it('keeps the fine tuning folded away', async () => {
    await draw()
    const folded = [...document.querySelectorAll('details')]

    expect(folded.length).toBeGreaterThan(0)
    for (const details of folded) {
      expect(details.open).toBe(false)
      expect(details.querySelector('summary')!.textContent).toBe('Advanced')
    }
  })

  it('says what a buffer of this length will cost in memory, at the rate this user records', async () => {
    await draw()
    // 300 seconds of recorded material weighed 450 MB — 12 Mbit/s — so the three minutes of the
    // default buffer are 270 million bytes, which is 257.5 MB in the binary units of §7.4.
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
    stored = { ...DEFAULTS, recording: { ...DEFAULTS.recording, deny: ['ads.example'] } }
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
    stored = {
      ...DEFAULTS,
      recording: { ...DEFAULTS.recording, allow: ['b.example'], deny: ['c.example', 'a.example'] },
    }
    await draw()

    const rows = [...document.querySelectorAll('[data-testid="host-row"]')].map((row) =>
      row.querySelector('.host-name')!.textContent,
    )
    expect(rows).toEqual(['a.example', 'b.example', 'c.example'])
  })

  it('drops a host the user is done with', async () => {
    stored = { ...DEFAULTS, recording: { ...DEFAULTS.recording, deny: ['ads.example'] } }
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
    // OPFS costs a second (§7.4). The index knows, in one row.
    await draw()

    expect(textAt('volume')).toContain('2.00 GB')
    expect(at('disk-full')).toBeNull()
  })

  it('says when the browser refused, instead of leaving the ceiling looking kept', async () => {
    // The disk said no below the ceiling this page is showing. Without a word here, the writer
    // retries every thirty seconds for ever and the page goes on showing a limit of four
    // gigabytes as though it were being kept (§11).
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
    vi.unstubAllGlobals()
  })

  it('shows what waits for the re-encoding path as disabled, with the reason beside it', async () => {
    await draw()
    // The format goes with them: everything this stage can put in a file is what was recorded,
    // so MP4 is not a default among three but the only answer there is (Global Constraints).
    for (const id of ['format', 'codec', 'quality', 'rewrite-head']) {
      expect(field(id).disabled, `${id} is offered though nothing can act on it`).toBe(true)
    }
    expect(textAt('export-note')).toContain('re-encoding')
  })

  it('lets through the two export settings this stage can keep', async () => {
    // The name of a file and where it is put need no encoder, so they are live while the rest of
    // the group waits. A name is typed a letter at a time, so it settles like a slider: one write
    // for the name, not one per keystroke.
    await draw()
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
    check('record-muted', false)
    await flush()

    expect(written.at(-1)!.detection.recordMuted).toBe(false)
  })

  it('records nothing anywhere once the mode is Off', async () => {
    await draw()
    await click('mode-off')

    expect(written.at(-1)!.recording.mode).toBe('off')
  })

  it('puts everything back to §7.4, on screen as well as in storage', async () => {
    stored = { ...DEFAULTS, history: { ...DEFAULTS.history, keepDays: 30 } }
    await draw()
    expect(field('keep-days').value).toBe('30')

    await click('reset')

    expect(written.at(-1)).toEqual(DEFAULTS)
    expect(field('keep-days').value).toBe(String(DEFAULTS.history.keepDays))
  })

  it('follows a change made somewhere else without being told twice', async () => {
    // The popup has quick switches of its own (§9.2) and they write the same key. A page showing
    // the old value would be a page that undoes the change the moment anything else is touched.
    await draw()
    expect(field('to-disk').checked).toBe(true)

    const changed = { ...DEFAULTS, history: { ...DEFAULTS.history, toDisk: false } }
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
    expect(bitsPerSecondOf([])).toBe(DEFAULT_BITS_PER_SECOND)
    // And a session that covers no time at all is nothing recorded too: the first batch of a
    // session lands with its seconds still at zero, and bytes over zero is not a rate.
    expect(bitsPerSecondOf([{ bytes: 8_000_000, seconds: 0 }])).toBe(DEFAULT_BITS_PER_SECOND)
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
