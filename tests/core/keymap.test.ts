import { describe, it, expect } from 'vitest'
import { ZOOM_KEY_STEP, actionFor, type KeyPress } from '../../src/core/edit/keymap'

const press = (key: string, held: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shift: false,
  ctrl: false,
  meta: false,
  alt: false,
  repeat: false,
  ...held,
})

describe('keymap', () => {
  it('marks in and out on I and O', () => {
    expect(actionFor(press('i'))).toEqual({ type: 'setIn' })
    expect(actionFor(press('o'))).toEqual({ type: 'setOut' })
  })

  it('steps a frame with the arrows and a second with shift', () => {
    expect(actionFor(press('ArrowRight'))).toEqual({ type: 'step', frames: 1 })
    expect(actionFor(press('ArrowLeft'))).toEqual({ type: 'step', frames: -1 })
    expect(actionFor(press('ArrowRight', { shift: true }))).toEqual({ type: 'skip', seconds: 1 })
    expect(actionFor(press('ArrowLeft', { shift: true }))).toEqual({ type: 'skip', seconds: -1 })
  })

  it('splits on S, marks on M, unmarks on Shift+M, removes on Delete and on Backspace', () => {
    expect(actionFor(press('s'))).toEqual({ type: 'splitClip' })
    expect(actionFor(press('m'))).toEqual({ type: 'addMarker' })
    expect(actionFor(press('M', { shift: true }))).toEqual({ type: 'removeMarkerAt' })
    expect(actionFor(press('Delete'))).toEqual({ type: 'removeClip' })
    expect(actionFor(press('Backspace'))).toEqual({ type: 'removeClip' })
  })

  it('goes to the ends on Home and End', () => {
    expect(actionFor(press('Home'))).toEqual({ type: 'seek', time: 0 })
    expect(actionFor(press('End'))).toEqual({ type: 'seek', time: Number.POSITIVE_INFINITY })
  })

  it('frames the selection on Z and fits everything on F', () => {
    expect(actionFor(press('z'))).toEqual({ type: 'zoomToSelection' })
    expect(actionFor(press('f'))).toEqual({ type: 'fitAll' })
  })

  it('zooms around the playhead on plus and minus', () => {
    // How big a step it is may be tuned; which way round the pair goes may not. Every check
    // below is written against the constant, so a step below one would swap plus with minus and
    // pass all the same — the one thing about its value worth pinning is stated here.
    expect(ZOOM_KEY_STEP).toBeGreaterThan(1)
    expect(actionFor(press('='))).toEqual({ type: 'zoomStep', factor: 1 / ZOOM_KEY_STEP })
    expect(actionFor(press('+'))).toEqual({ type: 'zoomStep', factor: 1 / ZOOM_KEY_STEP })
    expect(actionFor(press('-'))).toEqual({ type: 'zoomStep', factor: ZOOM_KEY_STEP })
    // The shifted pair of each: a keyboard that sends '+' for shift+= sends '_' for shift+-.
    expect(actionFor(press('_', { shift: true }))).toEqual({ type: 'zoomStep', factor: ZOOM_KEY_STEP })
  })

  it('toggles snapping on N', () => {
    expect(actionFor(press('n'))).toEqual({ type: 'toggleSnapping' })
  })

  it('undoes and redoes, on both kinds of keyboard', () => {
    expect(actionFor(press('z', { ctrl: true }))).toEqual({ type: 'undo' })
    expect(actionFor(press('z', { meta: true }))).toEqual({ type: 'undo' })
    expect(actionFor(press('z', { ctrl: true, shift: true }))).toEqual({ type: 'redo' })
    expect(actionFor(press('y', { ctrl: true }))).toEqual({ type: 'redo' })
  })

  it('leaves the rest of the ctrl combinations to the browser', () => {
    for (const key of ['s', 'f', 'r', 'w', 't']) {
      expect(actionFor(press(key, { ctrl: true }))).toBeNull()
    }
  })

  it('repeats the arrows and nothing else', () => {
    // Holding an arrow steps; holding I would write a step of history per repeat.
    expect(actionFor(press('ArrowRight', { repeat: true }))).toEqual({ type: 'step', frames: 1 })
    expect(actionFor(press('i', { repeat: true }))).toBeNull()
    expect(actionFor(press('z', { ctrl: true, repeat: true }))).toEqual({ type: 'undo' })
  })

  it('takes a letter whatever the case', () => {
    expect(actionFor(press('I'))).toEqual({ type: 'setIn' })
    expect(actionFor(press('Z', { ctrl: true }))).toEqual({ type: 'undo' })
  })

  it('leaves alt alone: it is a mouse modifier, not a command', () => {
    expect(actionFor(press('i', { alt: true }))).toBeNull()
  })

  it('says nothing about a key nobody bound', () => {
    for (const key of [' ', 'q', 'Escape', 'ArrowUp', 'Tab', 'F5']) {
      expect(actionFor(press(key))).toBeNull()
    }
  })
})
