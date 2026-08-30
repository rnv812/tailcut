import { describe, it, expect } from 'vitest'
import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  commit,
  history,
  redo,
  undo,
  type History,
  type UndoMode,
} from '../../src/core/edit/history'

const step: UndoMode = { kind: 'step' }
const skip: UndoMode = { kind: 'skip' }
const merge = (key: string): UndoMode => ({ kind: 'merge', key })

const after = (values: string[], mode: UndoMode): History<string> =>
  values.reduce((current, value) => commit(current, value, mode), history('a'))

describe('history', () => {
  it('writes a step and takes it back', () => {
    const one = commit(history('a'), 'b', step)

    expect(one.present).toBe('b')
    expect(canUndo(one)).toBe(true)
    expect(undo(one).present).toBe('a')
    expect(canRedo(undo(one))).toBe(true)
  })

  it('puts a step back on redo, and the step is there to take back again', () => {
    const again = redo(undo(commit(history('a'), 'b', step)))

    expect(again.present).toBe('b')
    expect(undo(again).present).toBe('a')
  })

  it('has nothing to put back until something has been taken back', () => {
    // canRedo controls whether the Redo button is disabled, and a button that is never disabled is a
    // button that lies. Fresh, after an edit, and after the one redo there was has been used up.
    const one = commit(history('a'), 'b', step)

    expect(canRedo(history('a'))).toBe(false)
    expect(canRedo(one)).toBe(false)
    expect(canRedo(redo(undo(one)))).toBe(false)
  })

  it('clears the future as soon as something new is done', () => {
    const back = undo(commit(history('a'), 'b', step))

    expect(commit(back, 'c', step).future).toEqual([])
  })

  it('a skip moves the present and writes nothing', () => {
    const skipped = commit(history('a'), 'b', skip)

    expect(skipped.present).toBe('b')
    expect(skipped.past).toEqual([])
    expect(canUndo(skipped)).toBe(false)
  })

  it('collapses a hundred merges under one key into one step', () => {
    const dragged = after(
      Array.from({ length: 100 }, (_, i) => `b${i}`),
      merge('trim:c1:in'),
    )

    expect(dragged.past).toEqual(['a'])
    expect(dragged.present).toBe('b99')
    expect(undo(dragged).present).toBe('a')
  })

  it('a merge under another key is another step', () => {
    let current = commit(history('a'), 'b', merge('trim:c1:in'))
    current = commit(current, 'c', merge('trim:c1:out'))

    expect(current.past).toEqual(['a', 'b'])
  })

  it('a skip between two merges breaks the key', () => {
    // Trim, move the playhead, trim again: the hand expects two undos, and gets them.
    let current = commit(history('a'), 'b', merge('trim:c1:in'))
    current = commit(current, 'b', skip)
    current = commit(current, 'c', merge('trim:c1:in'))

    expect(current.past).toEqual(['a', 'b'])
  })

  it('a skip breaks the key even when it did move the value', () => {
    // The two halves of a skip are tested apart: the editor only ever skips with the document
    // unchanged (a seek, a zoom), and the branch that moves the present is what a caller with
    // something else to put in the history would reach. Both must let go of the key.
    let current = commit(history('a'), 'b', merge('trim:c1:in'))
    current = commit(current, 'c', skip)
    current = commit(current, 'd', merge('trim:c1:in'))

    expect(current.past).toEqual(['a', 'c'])
  })

  it('a step taken back does not let the next drag merge into it', () => {
    // Undo hands the key back too. Without that, dragging a handle after undoing a drag of the
    // same handle would merge into the step that is already on the stack and eat it.
    const back = undo(commit(history('a'), 'b', merge('trim:c1:out')))

    expect(commit(back, 'c', merge('trim:c1:out')).past).toEqual(['a'])
  })

  it('a merge leaves no redo behind, whatever route the history took to it', () => {
    // The invariant is local rather than circumstantial: nothing that moves the document leaves
    // a future standing, and a merge is the one branch that does not rebuild the record around it.
    const mid: History<string> = { past: ['a'], present: 'b', future: ['c'], key: 'trim:c1:in' }

    expect(commit(mid, 'd', merge('trim:c1:in')).future).toEqual([])
  })

  it('writes nothing at all when the value did not change', () => {
    const same = commit(history('a'), 'a', step)

    expect(same.past).toEqual([])
    expect(same.present).toBe('a')
  })

  it('a merge that moved nothing leaves the key where it was', () => {
    // The first pixel of a drag often lands on the frame the handle already sits on. If that
    // claimed the key, the next event would merge into the step before the drag and eat it.
    const before = commit(history('a'), 'b', step)
    const nudged = commit(before, 'b', merge('trim:c1:out'))

    expect(nudged).toBe(before)
    expect(commit(nudged, 'c', merge('trim:c1:out')).past).toEqual(['a', 'b'])
  })

  it('caps the depth and forgets the oldest', () => {
    const deep = after(
      Array.from({ length: HISTORY_LIMIT + 50 }, (_, i) => `b${i}`),
      step,
    )

    expect(deep.past).toHaveLength(HISTORY_LIMIT)
    expect(deep.past[0]).toBe(`b${49}`)
  })

  it('undo of nothing and redo of nothing give the same history back', () => {
    const empty = history('a')

    expect(undo(empty)).toBe(empty)
    expect(redo(empty)).toBe(empty)
  })
})
