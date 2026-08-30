// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render } from 'preact'
import { TimecodeField } from '../../src/editor/inspector/timecode-field'

const host = document.createElement('div')
document.body.append(host)
afterEach(() => render(null, host))

const field = (): HTMLInputElement => host.querySelector<HTMLInputElement>('[data-testid="at"]')!

/**
 * The turn on which preact has re-rendered and run the effects of that render.
 *
 * `setState` queues a render, it does not perform one, and the handler a node carries is the one
 * the last render gave it. Two keystrokes dispatched in a single turn would therefore both be
 * answered against the state the box held before either of them — a pair of events no keyboard
 * can produce, and one that would let a field which never reads its own text pass. `useEffect`
 * waits for the frame after the render on top of that (see hover.test.tsx), so both waits are here.
 */
const settled = async (): Promise<void> => {
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const type = async (text: string): Promise<void> => {
  const input = field()
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settled()
}

const press = async (key: string, held: { shift?: boolean } = {}): Promise<void> => {
  field().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: held.shift ?? false, bubbles: true }))
  await settled()
}

const show = async (seconds: number, onCommit = vi.fn()) => {
  render(<TimecodeField id="at" label="In" seconds={seconds} fps={25} onCommit={onCommit} />, host)
  await settled()
  return onCommit
}

describe('TimecodeField', () => {
  it('shows the value it stands for', async () => {
    await show(83.48)
    expect(field().value).toBe('00:01:23:12')
  })

  it('commits what was typed on Enter', async () => {
    const onCommit = await show(0)
    await type('1:23')
    await press('Enter')

    expect(onCommit).toHaveBeenCalledWith(83)
    expect(field().value).toBe('00:01:23:00')
  })

  it('commits on leaving the box, because that is what a hand expects', async () => {
    const onCommit = await show(0)
    await type('250f')
    field().dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    await settled()

    expect(onCommit).toHaveBeenCalledWith(10)
  })

  it('reads an offset against the value it stands for', async () => {
    // `+10` means ten seconds on from here, and «here» is the prop. A field that offset from zero
    // would answer every relative entry with the entry itself and look right on the first one.
    const onCommit = await show(30)
    await type('+10')
    await press('Enter')

    expect(onCommit).toHaveBeenCalledWith(40)
  })

  it('keeps rubbish in the box, marks it, and moves nothing', async () => {
    const onCommit = await show(30)
    await type('1:2x')
    await press('Enter')

    expect(onCommit).not.toHaveBeenCalled()
    expect(field().value).toBe('1:2x')
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(field().className).toContain('invalid')
  })

  it('forgets the complaint at the next keystroke', async () => {
    await show(30)
    await type('1:2x')
    await press('Enter')
    await type('1:23')

    expect(field().getAttribute('aria-invalid')).toBe('false')
  })

  it('gives the focus back on Enter, because the next key belongs to the editor', async () => {
    // The editor's layout is off while a field is focused. A box that kept the focus after Enter
    // would swallow the I that comes next as text instead of an editor command.
    await show(0)
    field().focus()
    await type('1:23')
    await press('Enter')

    expect(document.activeElement).not.toBe(field())
  })

  it('does not move the value twice when the blur follows the Enter', async () => {
    // Enter commits and then drops the focus, and the blur that follows commits a second time.
    // That is harmless for one reason only: both calls run in the same handler, before preact has
    // rendered, so both see the same text and the same prop. A second call reading the canonical
    // text the first one produced would offset `+10` from the answer and land on 50.
    const onCommit = await show(30)
    field().focus()
    await type('+10')
    await press('Enter')

    // Both calls, in order, and not the set of the numbers they carried: a set of one is what
    // three calls of 40 make too, and the sentence being made here is about how many.
    expect(onCommit.mock.calls).toEqual([[40], [40]])
  })

  it('puts the value back on Escape', async () => {
    // What is typed has to be readable, and that is the whole of the second line below. Escape
    // means «forget what I was typing», and a box that committed on it instead would be caught
    // only by an entry it could commit: with rubbish in it the commit answers null and calls
    // nobody, and «onCommit was not called» is then true of every implementation there is.
    const onCommit = await show(30)
    await type('1:23')
    await press('Escape')

    expect(field().value).toBe('00:00:30:00')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('nudges by a frame with the arrows and by a second with Shift', async () => {
    const onCommit = await show(10)
    await press('ArrowUp')
    expect(onCommit).toHaveBeenLastCalledWith(10.04)

    await press('ArrowDown', { shift: true })
    // From what the box now says — 10.04 — a second back.
    expect(onCommit).toHaveBeenLastCalledWith(9.04)
  })

  it('nudges from the model when the box has been emptied', async () => {
    // Nothing in the box to move from, so the arrow moves the value the box stands for. Moving
    // from zero instead would send the playhead to the first frame of the recording.
    const onCommit = await show(10)
    await type('')
    await press('ArrowUp')

    expect(onCommit).toHaveBeenLastCalledWith(10.04)
  })

  it('follows the model when the model moves', async () => {
    const onCommit = vi.fn()
    await show(10, onCommit)
    // The same field, a new value: a handle dragged on the timeline has to show up here.
    render(<TimecodeField id="at" label="In" seconds={12} fps={25} onCommit={onCommit} />, host)
    await settled()

    expect(field().value).toBe('00:00:12:00')
  })

  it('leaves an entry in progress alone while the model stands still', async () => {
    // The box follows the model, and a box that followed it on every render would wipe out the
    // half-typed timecode of anyone whose editor repaints — which it does on every frame played.
    const onCommit = await show(10)
    await type('1:2')
    render(<TimecodeField id="at" label="In" seconds={10} fps={25} onCommit={onCommit} />, host)
    await settled()

    expect(field().value).toBe('1:2')
  })

  it('goes back to what the model says when the box is emptied', async () => {
    const onCommit = await show(10)
    await type('')
    await press('Enter')

    expect(onCommit).not.toHaveBeenCalled()
    expect(field().value).toBe('00:00:10:00')
  })
})
