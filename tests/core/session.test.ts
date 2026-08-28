import { describe, it, expect } from 'vitest'
import { ctx } from './edit-fixture'
import { newProject } from '../../src/core/edit/project'
import { newSession, step, type EditSession, type SessionAction } from '../../src/core/edit/session'

const start = (): EditSession => newSession(newProject(1200, ctx))

const play = (actions: SessionAction[], from: EditSession = start()): EditSession =>
  actions.reduce((session, action) => step(session, action, ctx), from)

/** One clip from 1 s to 3 s, made the way a user makes it. */
const marked = (): EditSession =>
  play([{ type: 'seek', time: 1 }, { type: 'setIn' }, { type: 'seek', time: 3 }, { type: 'setOut' }])

describe('session', () => {
  it('moves the project and writes the step', () => {
    const session = marked()

    expect(session.project.doc.clips).toHaveLength(1)
    expect(session.history.past).toHaveLength(2)
  })

  it('undoes a hundred events of one drag in one', () => {
    const dragged = play(
      Array.from({ length: 100 }, (_, i) => ({
        type: 'trim' as const,
        id: 'c1',
        edge: 'out' as const,
        time: 3 - i / 100,
      })),
      marked(),
    )

    expect(dragged.project.doc.clips[0]!.out).toBeLessThan(3)
    expect(play([{ type: 'undo' }], dragged).project.doc.clips[0]!.out).toBe(3)
  })

  it('undoes a drag, a seek and a drag in two', () => {
    const twice = play(
      [
        { type: 'trim', id: 'c1', edge: 'out', time: 2.8 },
        { type: 'seek', time: 2 },
        { type: 'trim', id: 'c1', edge: 'out', time: 2.6 },
      ],
      marked(),
    )

    expect(play([{ type: 'undo' }], twice).project.doc.clips[0]!.out).toBeCloseTo(2.8, 9)
    expect(play([{ type: 'undo' }, { type: 'undo' }], twice).project.doc.clips[0]!.out).toBe(3)
  })

  it('breaks the merge even when the seek that broke it moved nothing', () => {
    // The playhead was already there, so the reducer answers with the very same project — and the
    // history still has to let go of the key, or the drag after the seek merges into the one
    // before it and the two become one undo.
    const twice = play(
      [
        { type: 'trim', id: 'c1', edge: 'out', time: 2.8 },
        { type: 'seek', time: 3 },
        { type: 'trim', id: 'c1', edge: 'out', time: 2.6 },
      ],
      marked(),
    )

    expect(play([{ type: 'undo' }], twice).project.doc.clips[0]!.out).toBeCloseTo(2.8, 9)
  })

  it('starts its history where the project it was handed already stands', () => {
    // A session is not always born empty. Undoing the first edit made on an opened project has
    // to give that project back, so the history begins on the document it was handed.
    const opened = newSession(marked().project)
    const edited = play([{ type: 'addMarker' }], opened)
    const back = play([{ type: 'undo' }], edited)

    expect(back.project.doc.clips).toHaveLength(1)
    expect(back.project.doc.markers).toEqual([])
  })

  it('takes back the document and leaves the playhead and the zoom alone', () => {
    const zoomed = play([{ type: 'zoom', atPx: 600, factor: 0.5 }, { type: 'seek', time: 2 }], marked())
    const back = play([{ type: 'undo' }], zoomed)

    expect(back.project.doc.clips[0]!.out).toBeCloseTo(4, 9)
    expect(back.project.ui.playhead).toBe(zoomed.project.ui.playhead)
    expect(back.project.ui.view).toBe(zoomed.project.ui.view)
  })

  it('lets go of a selection whose clip the undo took away', () => {
    const back = play([{ type: 'undo' }, { type: 'undo' }], marked())

    expect(back.project.doc.clips).toEqual([])
    expect(back.project.ui.selectedClipId).toBeNull()
  })

  it('gives the session itself back when nothing happened', () => {
    const session = marked()

    expect(step(session, { type: 'redo' }, ctx)).toBe(session)
    expect(step(session, { type: 'seek', time: 3 }, ctx)).toBe(session)
  })

  it('cuts three overlapping clips, splits one, drops one, and takes it all back', () => {
    const built = play([
      { type: 'seek', time: 0 },
      { type: 'setIn' },
      { type: 'selectClip', id: null },
      { type: 'seek', time: 1 },
      { type: 'setIn' },
      { type: 'selectClip', id: null },
      { type: 'seek', time: 2 },
      { type: 'setIn' },
      { type: 'seek', time: 3 },
      { type: 'splitClip' },
      { type: 'removeClip', id: 'c1' },
    ])

    expect(built.project.doc.clips.map((clip) => clip.id)).toEqual(['c2', 'c3', 'c4'])

    const undone = play(Array.from({ length: 6 }, () => ({ type: 'undo' as const })), built)
    expect(undone.project.doc.clips).toEqual([])

    const redone = play(Array.from({ length: 6 }, () => ({ type: 'redo' as const })), undone)
    expect(redone.project.doc.clips).toEqual(built.project.doc.clips)
  })
})
