// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { attachKeys, isTypingTarget } from '../../src/editor/state/keys'

let detach: (() => void) | null = null
afterEach(() => {
  detach?.()
  detach = null
  document.body.innerHTML = ''
})

const stand = () => {
  const dispatch = vi.fn()
  const transport = { toggle: vi.fn(), stop: vi.fn(), shuttle: vi.fn() }
  const onHelp = vi.fn()
  detach = attachKeys(window, { dispatch, transport, onHelp })
  return { dispatch, transport, onHelp }
}

/** Sends a press and answers whether the editor took it away from the browser. */
const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window): boolean => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

describe('attachKeys', () => {
  it('turns a press into the action the keymap names', () => {
    const { dispatch } = stand()

    expect(press('i')).toBe(true)
    expect(dispatch).toHaveBeenCalledWith({ type: 'setIn' })
  })

  it('gives space, J, K and L to the transport and not to the model', () => {
    const { dispatch, transport } = stand()

    expect(press(' ')).toBe(true)
    expect(transport.toggle).toHaveBeenCalledTimes(1)

    expect(press('l')).toBe(true)
    expect(press('k')).toBe(true)
    expect(transport.shuttle.mock.calls).toEqual([['l'], ['k']])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('stops playback before it steps', () => {
    // Stepping while running would have the picture and the playhead pulling in two directions.
    const { dispatch, transport } = stand()

    press('ArrowRight')
    expect(transport.stop).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({ type: 'step', frames: 1 })
  })

  it('leaves the transport alone for everything that is not a move of the playhead', () => {
    // The other side of the rule above: I, O and S are done where the playhead already stands,
    // and a transport stopped by every command could not be running while a clip was marked up.
    const { transport } = stand()

    for (const key of ['i', 'o', 'm', 'n', 'f']) press(key)

    expect(transport.stop).not.toHaveBeenCalled()
  })

  it('leaves the browser its own keys', () => {
    const { dispatch } = stand()

    // Ctrl+S saves the page and Ctrl+F finds on it; an unbound letter is nobody's business.
    expect(press('s', { ctrlKey: true })).toBe(false)
    expect(press('f', { ctrlKey: true })).toBe(false)
    expect(press('q')).toBe(false)
    expect(press('Tab')).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()

    expect(press('z', { ctrlKey: true })).toBe(true)
    expect(dispatch).toHaveBeenCalledWith({ type: 'undo' })
  })

  it('leaves the transport keys alone when a modifier is down', () => {
    // Ctrl+L is the address bar, Ctrl+Space switches the input method, and Alt is the modifier
    // that frees a handle. The transport is read before the keymap, so it is the transport that
    // has to let a held modifier past — nothing behind it will.
    const { transport } = stand()

    expect(press('l', { ctrlKey: true })).toBe(false)
    expect(press('j', { altKey: true })).toBe(false)
    expect(press(' ', { ctrlKey: true })).toBe(false)
    expect(press('k', { metaKey: true })).toBe(false)
    expect(transport.shuttle).not.toHaveBeenCalled()
    expect(transport.toggle).not.toHaveBeenCalled()
  })

  it('switches off entirely while a field has the focus', () => {
    const { dispatch, transport } = stand()
    const input = document.createElement('input')
    document.body.append(input)

    // S in a name field is a letter, not a cut; space is a space; the arrows are the caret's.
    expect(press('s', {}, input)).toBe(false)
    expect(press(' ', {}, input)).toBe(false)
    expect(press('ArrowLeft', {}, input)).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(transport.toggle).not.toHaveBeenCalled()
  })

  it('opens the list of keys on ? and closes it on Escape', () => {
    const { onHelp } = stand()

    expect(press('?')).toBe(true)
    expect(onHelp).toHaveBeenLastCalledWith(true)

    // Escape is answered but not taken: it is the browser's key too.
    expect(press('Escape')).toBe(false)
    expect(onHelp).toHaveBeenLastCalledWith(false)
  })

  it('repeats the arrows and nothing else', () => {
    const { dispatch, transport, onHelp } = stand()

    press('ArrowRight', { repeat: true })
    press(' ', { repeat: true })
    press('l', { repeat: true })
    press('i', { repeat: true })
    press('?', { repeat: true })

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(transport.toggle).not.toHaveBeenCalled()
    expect(transport.shuttle).not.toHaveBeenCalled()
    expect(onHelp).not.toHaveBeenCalled()
  })

  it('still takes the keys it answers to nothing for while they repeat', () => {
    // A held space that scrolled the page on every repeat but the first would be worse than one
    // that never worked at all: the playhead stays put and the page walks away under it.
    stand()

    expect(press(' ', { repeat: true })).toBe(true)
    expect(press('l', { repeat: true })).toBe(true)
    expect(press('?', { repeat: true })).toBe(true)
  })

  it('hands the keymap every modifier that is down', () => {
    // Shift is the difference between a frame and a second, and Ctrl+Shift+Z between undo and
    // redo. A listener that read the key and dropped the modifiers would answer both wrongly.
    const { dispatch } = stand()

    press('ArrowRight', { shiftKey: true })
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'skip', seconds: 1 })

    press('z', { ctrlKey: true, shiftKey: true })
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'redo' })
  })

  it('lets go of the window when it is detached', () => {
    const { dispatch } = stand()
    detach?.()
    detach = null

    press('i')
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('isTypingTarget', () => {
  it('knows the three boxes and anything made editable', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(editable)

    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTypingTarget(document.createElement(tag))).toBe(true)
    }
    expect(isTypingTarget(editable)).toBe(true)
    expect(isTypingTarget(document.createElement('canvas'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })

  it('answers about a target that is no element at all', () => {
    // The listener sits on the window, so `event.target` is the window for every press that
    // lands on no element — which is most of them. Asked with a selector (`matches`, `closest`)
    // this question throws there, and the throw comes out of the keydown handler: the whole
    // keyboard dies on the first press. It has to be an answer, and the answer is no.
    expect(isTypingTarget(window)).toBe(false)
    expect(isTypingTarget(document)).toBe(false)
    expect(isTypingTarget({} as EventTarget)).toBe(false)
  })
})
