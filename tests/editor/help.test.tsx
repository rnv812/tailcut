// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render } from 'preact'
import { actionFor, type KeyPress } from '../../src/core/edit/keymap'
import { shuttleKeyOf } from '../../src/core/edit/shuttle'
import { HelpSheet, KEY_HELP, type KeyRow } from '../../src/editor/help'

const host = document.createElement('div')
document.body.append(host)
afterEach(() => render(null, host))

const press = (key: string, held: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shift: false,
  ctrl: false,
  meta: false,
  alt: false,
  repeat: false,
  ...held,
})

/** Every key the editor answers to, and the words it is written by in the sheet. */
const BOUND: Array<{ press: KeyPress; label: string }> = [
  { press: press(' '), label: 'Space' },
  { press: press('j'), label: 'J' },
  { press: press('k'), label: 'K' },
  { press: press('l'), label: 'L' },
  { press: press('ArrowRight'), label: '→' },
  { press: press('ArrowLeft'), label: '←' },
  { press: press('Home'), label: 'Home' },
  { press: press('End'), label: 'End' },
  { press: press('i'), label: 'I' },
  { press: press('o'), label: 'O' },
  { press: press('s'), label: 'S' },
  { press: press('m'), label: 'M' },
  { press: press('m', { shift: true }), label: 'Shift M' },
  { press: press('n'), label: 'N' },
  { press: press('z'), label: 'Z' },
  { press: press('f'), label: 'F' },
  { press: press('='), label: '+' },
  { press: press('-'), label: '−' },
  { press: press('Delete'), label: 'Delete' },
  { press: press('z', { ctrl: true }), label: 'Ctrl Z' },
]

/** How a key is written in the sheet against what `KeyboardEvent.key` calls it. */
const KEY_NAMES: Record<string, string> = {
  Space: ' ',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '+': '=',
  '−': '-',
}

/**
 * The presses a row of the sheet promises, read back out of the words it is written in.
 *
 * Reading them back is the point. A list of presses written out beside the sheet by hand says
 * only that two lists agree with each other; a name in the sheet nobody can press would be in
 * neither of them. Parsed from the row, an invented key parses into a press nothing answers.
 */
const pressesFor = (row: KeyRow): KeyPress[] =>
  row.keys.split(' · ').map((written) => {
    const parts = written.split(' ')
    const name = parts[parts.length - 1]!
    const held = parts.slice(0, -1)
    return press(KEY_NAMES[name] ?? (name.length === 1 ? name.toLowerCase() : name), {
      ctrl: held.includes('Ctrl'),
      shift: held.includes('Shift'),
      alt: held.includes('Alt'),
    })
  })

/** Space and ? are the two the model knows nothing about: they belong to the tab (state/keys.ts). */
const answers = (probe: KeyPress): boolean =>
  Boolean(actionFor(probe)) || Boolean(shuttleKeyOf(probe)) || probe.key === ' ' || probe.key === '?'

describe('KEY_HELP', () => {
  it('lists every key the editor answers to', () => {
    const written = KEY_HELP.map((row) => row.keys).join(' · ')

    for (const { label } of BOUND) {
      expect(written, `${label} does something and is not in the sheet`).toContain(label)
    }
  })

  it('promises nothing the editor does not do', () => {
    // The other direction, walked over the sheet itself: a row is worth having only if every
    // press written in it is answered by something.
    for (const row of KEY_HELP) {
      for (const probe of pressesFor(row)) {
        expect(answers(probe), `the sheet promises ${row.keys} and nothing answers ${probe.key}`)
          .toBe(true)
      }
    }
  })

  it('is read back by a parser that can tell a real key from an invented one', () => {
    // The check above is only worth what this one says: an invented key has to come out
    // unanswered, or the loop over the sheet would pass whatever was written in it.
    expect(pressesFor({ keys: 'Ctrl Shift Z', does: '' })[0]).toMatchObject({
      key: 'z',
      ctrl: true,
      shift: true,
    })
    expect(answers(press('q'))).toBe(false)
    expect(pressesFor({ keys: 'Q', does: '' }).every(answers)).toBe(false)
  })

  it('says what each of them does, and says it once', () => {
    // A row with no words beside it is a row that teaches nothing, and the same words twice mean
    // two keys were written down as one thing by mistake.
    for (const row of KEY_HELP) {
      expect(row.does.length, `${row.keys} is listed with nothing beside it`).toBeGreaterThan(3)
    }
    expect(new Set(KEY_HELP.map((row) => row.keys)).size).toBe(KEY_HELP.length)
  })
})

describe('HelpSheet', () => {
  it('stays out of the way until it is asked for', () => {
    render(<HelpSheet open={false} onClose={() => {}} />, host)
    expect(host.querySelector('[data-testid="help"]')).toBeNull()
  })

  it('shows the table and closes on the button', () => {
    const onClose = vi.fn()
    render(<HelpSheet open onClose={onClose} />, host)

    expect(host.querySelectorAll('[data-testid="help-row"]')).toHaveLength(KEY_HELP.length)
    host.querySelector<HTMLButtonElement>('[data-testid="help-close"]')!.click()
    expect(onClose).toHaveBeenCalled()
  })

  it('writes out every row it holds, keys and words together', () => {
    render(<HelpSheet open onClose={() => {}} />, host)
    const written = host.querySelector('[data-testid="help"]')!.textContent ?? ''

    for (const row of KEY_HELP) {
      expect(written, `${row.keys} is in the table and not on the screen`).toContain(row.keys)
      expect(written).toContain(row.does)
    }
  })
})
