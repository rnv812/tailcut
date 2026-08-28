import { describe, it, expect } from 'vitest'
import { FRAME, ctx, oneQuality } from './edit-fixture'
import { reduce, undoModeOf, type Action } from '../../src/core/edit/actions'
import { newProject, selectedClip, type Project } from '../../src/core/edit/project'
import { MIN_CLIP_FRAMES } from '../../src/core/edit/clip'
import { EMPTY_CONTEXT } from '../../src/core/edit/context'
import { timeToX } from '../../src/core/timeline/view'

const fresh = (): Project => newProject(1200, ctx)

/** Runs a list of actions from a fresh project: a scenario reads as a list. */
const run = (actions: Action[], from: Project = fresh()): Project =>
  actions.reduce((project, action) => reduce(project, action, ctx), from)

const at = (time: number): Action => ({ type: 'seek', time })

describe('the playhead', () => {
  it('lands on a frame boundary', () => {
    expect(run([at(1.011)]).ui.playhead).toBeCloseTo(1, 9)
  })

  it('is clamped to the material and never lands in a gap', () => {
    expect(run([at(-5)]).ui.playhead).toBe(0)
    expect(run([at(99)]).ui.playhead).toBe(10)
    expect(run([at(5)]).ui.playhead).toBe(4)
  })

  it('is held inside the material even when there is no grid to fall on', () => {
    // A snapshot with no picture has no frame boundaries at all, and quantising cannot hold what
    // it does not know: the length of the material is what the playhead is clamped by.
    const bare = { ...ctx, frames: new Float64Array(), duration: 7 }
    const project = newProject(1200, bare)

    expect(reduce(project, at(99), bare).ui.playhead).toBe(7)
    expect(reduce(project, at(-1), bare).ui.playhead).toBe(0)
  })

  it('steps whole frames and stops at the ends', () => {
    expect(run([at(1), { type: 'step', frames: 2 }]).ui.playhead).toBeCloseTo(1 + 2 * FRAME, 9)
    expect(run([at(0), { type: 'step', frames: -5 }]).ui.playhead).toBe(0)
  })

  it('crosses a gap in one step, because there is no frame inside it', () => {
    expect(run([at(4), { type: 'step', frames: 1 }]).ui.playhead).toBe(6)
  })

  it('skips a second at a time', () => {
    expect(run([at(1), { type: 'skip', seconds: 1 }]).ui.playhead).toBeCloseTo(2, 9)
    expect(run([at(2), { type: 'skip', seconds: -1 }]).ui.playhead).toBeCloseTo(1, 9)
  })
})

describe('marking', () => {
  it('I with nothing selected starts a clip from the playhead to the end of the run', () => {
    const project = run([at(1), { type: 'setIn' }])
    const clip = selectedClip(project)!

    expect(clip).toMatchObject({ in: 1, out: 4, representation: '480p', sound: true, format: 'mp4' })
    expect(project.doc.clips).toHaveLength(1)
  })

  it('O with nothing selected starts a clip from the start of the run to the playhead', () => {
    const clip = selectedClip(run([at(8), { type: 'setOut' }]))!

    expect(clip).toMatchObject({ in: 6, out: 8, representation: '720p' })
    // Named after where it starts, which is where the run started and not where the hand was.
    expect(clip.name).toBe('A page about cats 00.06')
  })

  it('I on the last frame of a run starts nothing', () => {
    // The clip would have to grow into the gap to reach two frames, and a clip that spans a hole
    // nobody chose is worse than no clip.
    const standing = run([at(4)])

    expect(reduce(standing, { type: 'setIn' }, ctx)).toBe(standing)
  })

  it('I with a clip selected moves its in point and leaves the out alone', () => {
    const project = run([at(1), { type: 'setIn' }, at(2), { type: 'setIn' }])

    expect(project.doc.clips).toHaveLength(1)
    expect(selectedClip(project)).toMatchObject({ in: 2, out: 4 })
  })

  it('O with a clip selected moves its out point', () => {
    expect(selectedClip(run([at(1), { type: 'setIn' }, at(3), { type: 'setOut' }]))).toMatchObject({
      in: 1,
      out: 3,
    })
  })

  it('names a new clip after the page and where it starts', () => {
    expect(selectedClip(run([at(1), { type: 'setIn' }]))!.name).toBe('A page about cats 00.01')
  })

  it('gives a second clip in the same place a name of its own', () => {
    const project = run([
      at(1),
      { type: 'setIn' },
      { type: 'selectClip', id: null },
      at(1),
      { type: 'setIn' },
    ])

    expect(project.doc.clips.map((clip) => clip.name)).toEqual([
      'A page about cats 00.01',
      'A page about cats 00.01 (2)',
    ])
    expect(project.doc.clips.map((clip) => clip.id)).toEqual(['c1', 'c2'])
  })

  it('lets ranges overlap', () => {
    const project = run([
      at(0),
      { type: 'setIn' },
      { type: 'selectClip', id: null },
      at(2),
      { type: 'setIn' },
    ])

    expect(project.doc.clips.map((clip) => [clip.in, clip.out])).toEqual([
      [0, 4],
      [2, 4],
    ])
  })
})

describe('clips', () => {
  const one = run([at(1), { type: 'setIn' }, at(3), { type: 'setOut' }])

  it('trim moves the edge it names', () => {
    const trimmed = reduce(one, { type: 'trim', id: 'c1', edge: 'in', time: 2 }, ctx)

    expect(trimmed.doc.clips[0]).toMatchObject({ in: 2, out: 3 })
  })

  it('trim of a clip that is gone changes nothing at all', () => {
    expect(reduce(one, { type: 'trim', id: 'nope', edge: 'in', time: 2 }, ctx)).toBe(one)
  })

  it('trim cannot push one edge past the other', () => {
    const trimmed = reduce(one, { type: 'trim', id: 'c1', edge: 'in', time: 3.5 }, ctx)

    expect(trimmed.doc.clips[0]!.in).toBeCloseTo(3 - MIN_CLIP_FRAMES * FRAME, 9)
    expect(trimmed.doc.clips[0]!.out).toBe(3)
  })

  it('trim keeps the clip inside its quality, and asking again changes nothing', () => {
    const stopped = reduce(one, { type: 'trim', id: 'c1', edge: 'out', time: 9 }, ctx)
    expect(stopped.doc.clips[0]!.out).toBe(4)

    // §8.3: the wall stays. Nothing in this stage moves the handle past a change of quality, so
    // the same trim asked twice gives the same project back by identity.
    expect(reduce(stopped, { type: 'trim', id: 'c1', edge: 'out', time: 9 }, ctx)).toBe(stopped)
  })

  it('trim crosses a hole without being asked, because a hole is not a change of quality', () => {
    // The same clip against material recorded at one quality throughout: nothing stops it, and
    // the export collapses the hole (§8.2).
    expect(reduce(one, { type: 'trim', id: 'c1', edge: 'out', time: 9 }, oneQuality).doc.clips[0]!.out).toBe(9)
  })

  it('leaves the other clips alone while one of them is trimmed', () => {
    const two = run([{ type: 'selectClip', id: null }, at(2), { type: 'setIn' }], one)
    const trimmed = reduce(two, { type: 'trim', id: 'c1', edge: 'out', time: 2 }, ctx)

    expect(trimmed.doc.clips.map((clip) => [clip.id, clip.in, clip.out])).toEqual([
      ['c1', 1, 2],
      ['c2', 2, 4],
    ])
  })

  it('selecting a clip that is not there selects nothing', () => {
    expect(reduce(one, { type: 'selectClip', id: 'nope' }, ctx).ui.selectedClipId).toBeNull()
  })

  it('removes the selected clip when no id is given, and clears the selection', () => {
    const empty = reduce(one, { type: 'removeClip' }, ctx)

    expect(empty.doc.clips).toEqual([])
    expect(empty.ui.selectedClipId).toBeNull()
  })

  it('removes the clip that was named and leaves the selection where it is', () => {
    const two = run([{ type: 'selectClip', id: null }, at(2), { type: 'setIn' }], one)
    const left = reduce(two, { type: 'removeClip', id: 'c1' }, ctx)

    expect(left.doc.clips.map((clip) => clip.id)).toEqual(['c2'])
    expect(left.ui.selectedClipId).toBe('c2')
  })

  it('renames a clip, trimming the name and refusing an empty one', () => {
    expect(reduce(one, { type: 'renameClip', id: 'c1', name: '  Goal  ' }, ctx).doc.clips[0]!.name).toBe('Goal')
    expect(reduce(one, { type: 'renameClip', id: 'c1', name: '   ' }, ctx)).toBe(one)
  })

  it('turns the sound of one clip off and on', () => {
    const muted = reduce(one, { type: 'toggleSound', id: 'c1' }, ctx)

    expect(muted.doc.clips[0]!.sound).toBe(false)
    expect(reduce(muted, { type: 'toggleSound', id: 'c1' }, ctx).doc.clips[0]!.sound).toBe(true)
  })
})

describe('split', () => {
  const one = run([at(0), { type: 'setIn' }, at(3), { type: 'setOut' }])

  it('cuts the selected clip in two at the playhead', () => {
    const cut = run([at(1), { type: 'splitClip' }], one)

    expect(cut.doc.clips.map((clip) => [clip.in, clip.out])).toEqual([
      [0, 1],
      [1, 3],
    ])
    expect(cut.doc.clips.map((clip) => clip.id)).toEqual(['c1', 'c2'])
  })

  it('the halves add up to the whole and keep its settings', () => {
    const cut = run([at(1), { type: 'splitClip' }], reduce(one, { type: 'toggleSound', id: 'c1' }, ctx))
    const [left, right] = cut.doc.clips

    expect(left!.out).toBe(right!.in)
    expect(right!.out - right!.in + (left!.out - left!.in)).toBeCloseTo(3, 9)
    expect(right!.sound).toBe(false)
    expect(right!.representation).toBe('480p')
  })

  it('leaves the second half selected and names it after its own start', () => {
    const cut = run([at(1), { type: 'splitClip' }], one)

    expect(cut.ui.selectedClipId).toBe('c2')
    expect(selectedClip(cut)!.name).toBe('A page about cats 00.01')
  })

  it('refuses when the playhead is too close to either edge', () => {
    const near = run([at(FRAME), { type: 'splitClip' }], one)
    const nearEnd = run([at(3 - FRAME), { type: 'splitClip' }], one)

    expect(near.doc.clips).toHaveLength(1)
    expect(nearEnd.doc.clips).toHaveLength(1)
  })

  it('cuts on a frame boundary even when the playhead is between two', () => {
    // The playhead was put on the grid of the representation that was open when it was moved;
    // opening another one leaves it between two frames of this one. Both halves are checked
    // against the cut, so a cut off the grid would refuse every split instead of making one.
    const between = { ...one, ui: { ...one.ui, playhead: 1.011 } }

    expect(reduce(between, { type: 'splitClip' }, ctx).doc.clips.map((clip) => [clip.in, clip.out])).toEqual([
      [0, 1],
      [1, 3],
    ])
  })

  it('moves the counter on, so the next thing made is not the second half over again', () => {
    const cut = run([at(1), { type: 'splitClip' }, { type: 'addMarker' }], one)

    expect(cut.doc.markers.map((marker) => marker.id)).toEqual(['m3'])
  })

  it('does nothing with no clip selected', () => {
    const none = reduce(one, { type: 'selectClip', id: null }, ctx)

    expect(reduce(none, { type: 'splitClip' }, ctx)).toBe(none)
  })
})

describe('markers', () => {
  it('drops a marker on the playhead', () => {
    const marked = run([at(2), { type: 'addMarker' }])

    expect(marked.doc.markers).toEqual([{ id: 'm1', time: 2, label: 'M1' }])
  })

  it('does not drop a second marker on the same frame', () => {
    const marked = run([at(2), { type: 'addMarker' }])

    expect(reduce(marked, { type: 'addMarker' }, ctx)).toBe(marked)
  })

  it('keeps the markers in time order however they were dropped', () => {
    const marked = run([at(3), { type: 'addMarker' }, at(1), { type: 'addMarker' }])

    expect(marked.doc.markers.map((marker) => [marker.time, marker.label])).toEqual([
      [1, 'M2'],
      [3, 'M1'],
    ])
  })

  it('numbers a marker by the markers and not by the counter of ids', () => {
    // Clips and markers are numbered out of one counter, so the third thing made is m3 whatever
    // the first two were. The label the user reads counts markers.
    const marked = run([at(1), { type: 'setIn' }, at(2), { type: 'addMarker' }])

    expect(marked.doc.markers).toEqual([{ id: 'm2', time: 2, label: 'M1' }])
  })

  it('removes a marker by id and ignores one that is gone', () => {
    const marked = run([at(2), { type: 'addMarker' }, at(3), { type: 'addMarker' }])

    expect(reduce(marked, { type: 'removeMarker', id: 'm1' }, ctx).doc.markers.map((m) => m.id)).toEqual(['m2'])
    expect(reduce(marked, { type: 'removeMarker', id: 'nope' }, ctx)).toBe(marked)
  })

  it('takes away the marker the playhead is standing on', () => {
    // What the keyboard can reach: Shift+M knows where the playhead is, not what id the marker
    // was given. Without it a marker dropped by mistake would stay for good — M does not undrop
    // it, because a second M on the same frame is refused above.
    const marked = run([at(2), { type: 'addMarker' }])

    expect(reduce(marked, { type: 'removeMarkerAt' }, ctx).doc.markers).toEqual([])
    expect(reduce(run([at(3)], marked), { type: 'removeMarkerAt' }, ctx).doc.markers).toHaveLength(1)
  })

  it('takes away a marker standing a fraction of a frame from the playhead', () => {
    // A marker put down on the grid of another representation lands between two frames of this
    // one, and Shift+M is the only way back for it. "Here" is half a frame wide, on both sides
    // of the pair: the same window refuses a second marker above.
    const marked = run([at(2), { type: 'addMarker' }])
    const drifted = {
      ...marked,
      doc: { ...marked.doc, markers: [{ id: 'm1', time: 2 + FRAME / 4, label: 'M1' }] },
    }

    expect(reduce(drifted, { type: 'removeMarkerAt' }, ctx).doc.markers).toEqual([])
    expect(reduce(drifted, { type: 'addMarker' }, ctx)).toBe(drifted)
  })
})

describe('the view', () => {
  it('zooms toward a pixel and pans by pixels', () => {
    const zoomed = run([{ type: 'zoom', atPx: 600, factor: 0.5 }])

    expect(zoomed.ui.view.scale).toBeCloseTo(10 / 1200 / 2, 12)
    expect(run([{ type: 'pan', dxPx: -100 }], zoomed).ui.view.start).toBeGreaterThan(zoomed.ui.view.start)
  })

  it('frames the selected clip and fits everything back', () => {
    const one = run([at(1), { type: 'setIn' }, at(2), { type: 'setOut' }])
    const framed = reduce(one, { type: 'zoomToSelection' }, ctx)

    expect(framed.ui.view.start).toBeLessThan(1)
    expect(framed.ui.view.scale).toBeLessThan(one.ui.view.scale)
    expect(reduce(framed, { type: 'fitAll' }, ctx).ui.view).toEqual(one.ui.view)
  })

  it('zooms on the keyboard around the playhead, which stays where it was on the screen', () => {
    const before = run([at(8)])
    const zoomed = reduce(before, { type: 'zoomStep', factor: 0.5 }, ctx)

    expect(zoomed.ui.view.scale).toBeCloseTo(before.ui.view.scale / 2, 12)
    expect(timeToX(zoomed.ui.view, 8)).toBeCloseTo(timeToX(before.ui.view, 8), 6)
  })

  it('keeps the start when the window is resized', () => {
    const resized = run([{ type: 'zoom', atPx: 600, factor: 0.5 }, { type: 'resize', widthPx: 600 }])

    expect(resized.ui.view.widthPx).toBe(600)
    expect(resized.ui.view.scale).toBeCloseTo(10 / 1200 / 2, 12)
    expect(resized.ui.view.start).toBeCloseTo(2.5, 12)
  })

  it('pulls the view back inside its limits when the window grows', () => {
    // Twice the width at the same scale would show twenty seconds of a ten second recording.
    const wider = run([{ type: 'resize', widthPx: 2400 }])

    expect(wider.ui.view.scale).toBeCloseTo(10 / 2400, 12)
  })

  it('sets and toggles snapping', () => {
    expect(run([{ type: 'setSnapping', on: false }]).ui.snapping).toBe(false)
    expect(run([{ type: 'toggleSnapping' }]).ui.snapping).toBe(false)
    expect(run([{ type: 'toggleSnapping' }, { type: 'toggleSnapping' }]).ui.snapping).toBe(true)
  })
})

describe('identity', () => {
  it('an action that changes nothing gives the very same project back', () => {
    const project = run([at(1), { type: 'setIn' }])
    const idle: Action[] = [
      at(1),
      { type: 'step', frames: 0 },
      { type: 'selectClip', id: 'c1' },
      { type: 'resize', widthPx: 1200 },
      { type: 'trim', id: 'c1', edge: 'in', time: 1 },
      { type: 'setSnapping', on: true },
      { type: 'removeMarker', id: 'nope' },
    ]

    for (const action of idle) expect(reduce(project, action, ctx)).toBe(project)
  })

  it('survives an empty context without a clip in sight', () => {
    const bare = newProject(1200, EMPTY_CONTEXT)
    const anything: Action[] = [
      { type: 'setIn' },
      { type: 'splitClip' },
      { type: 'addMarker' },
      { type: 'fitAll' },
    ]

    for (const action of anything) expect(() => reduce(bare, action, EMPTY_CONTEXT)).not.toThrow()
  })
})

describe('undoModeOf', () => {
  it('does not write a step for a movement or a look', () => {
    const looks: Action[] = [
      at(1),
      { type: 'step', frames: 1 },
      { type: 'skip', seconds: 1 },
      { type: 'selectClip', id: null },
      { type: 'zoom', atPx: 0, factor: 1 },
      { type: 'zoomStep', factor: 1 },
      { type: 'zoomToSelection' },
      { type: 'fitAll' },
      { type: 'pan', dxPx: 1 },
      { type: 'resize', widthPx: 1 },
      { type: 'setSnapping', on: true },
      { type: 'toggleSnapping' },
    ]

    for (const action of looks) expect(undoModeOf(action)).toEqual({ kind: 'skip' })
  })

  it('writes a step for an edit', () => {
    const edits: Action[] = [
      { type: 'setIn' },
      { type: 'setOut' },
      { type: 'addClip' },
      { type: 'removeClip' },
      { type: 'splitClip' },
      { type: 'toggleSound', id: 'c1' },
      { type: 'addMarker' },
      { type: 'removeMarker', id: 'm1' },
      { type: 'removeMarkerAt' },
    ]

    for (const action of edits) expect(undoModeOf(action)).toEqual({ kind: 'step' })
  })

  it('merges a drag and a rename under a key of their own', () => {
    expect(undoModeOf({ type: 'trim', id: 'c1', edge: 'in', time: 0 })).toEqual({
      kind: 'merge',
      key: 'trim:c1:in',
    })
    expect(undoModeOf({ type: 'renameClip', id: 'c1', name: 'x' })).toEqual({
      kind: 'merge',
      key: 'rename:c1',
    })
  })
})
