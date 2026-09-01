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

  it('skips a second of material, so a gap costs it nothing', () => {
    // The second is counted in frames, and the grid holds what exists: from 3.6 a second forward
    // is the 0.4 left of the first run and the rest taken out of the second one. A skip that
    // added the seconds to the playhead would land in the hole and be dragged back to its near
    // edge — 4 — where it would sit however many times it was pressed again.
    expect(run([at(3.6), { type: 'skip', seconds: 1 }]).ui.playhead).toBeCloseTo(6.56, 9)
    expect(run([at(6.56), { type: 'skip', seconds: -1 }]).ui.playhead).toBeCloseTo(3.6, 9)
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

  it('does not start a clip while the composite monitor is over another representation', () => {
    const selectedOnly = {
      ...ctx,
      zones: ctx.zones.filter((zone) => zone.representation === '480p'),
    }
    const standing = reduce(newProject(1200, selectedOnly), at(7), selectedOnly)

    expect(reduce(standing, { type: 'setIn' }, selectedOnly)).toBe(standing)
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

describe('the name a clip is born with', () => {
  /** The settings of a user who files as they cut: the site, the page, and both edges. */
  const templated = { ...ctx, nameTemplate: '{host} {title} {in}-{out}', host: 'site.example' }
  const named = (project: Project): string => project.doc.clips.at(-1)!.name

  it('follows the template the settings gave', () => {
    const project = reduce(newProject(1200, templated), { type: 'setIn' }, templated)

    // In at nought, out at the end of the run it was begun in: the template sees both edges.
    expect(named(project)).toBe('site.example A page about cats 00.00-00.04')
  })

  it('uses the default name when there is no template', () => {
    // The default is a template too ('{title} {in}'), so this is the tab that was opened before
    // the settings came back — not a user who cleared the field.
    expect(named(reduce(newProject(1200, ctx), { type: 'setIn' }, ctx))).toBe(
      'A page about cats 00.00',
    )
  })

  it('follows it for the half a split makes as well', () => {
    // The other place a clip is born. A template honoured in one and not the other would name
    // two halves of one clip by two different rules.
    const one = reduce(
      reduce(newProject(1200, templated), { type: 'setIn' }, templated),
      { type: 'seek', time: 2 },
      templated,
    )
    const cut = reduce(one, { type: 'splitClip' }, templated)

    expect(cut.doc.clips).toHaveLength(2)
    expect(named(cut)).toBe('site.example A page about cats 00.02-00.04')
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

    // A quality boundary remains a hard wall. Nothing moves the handle past it, so
    // the same trim asked twice gives the same project back by identity.
    expect(reduce(stopped, { type: 'trim', id: 'c1', edge: 'out', time: 9 }, ctx)).toBe(stopped)
  })

  it('trim crosses a hole without being asked, because a hole is not a change of quality', () => {
    // The same clip against material recorded at one quality throughout: nothing stops it, and
    // export collapses the hole in the output timeline.
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

  it('moves both clip boundaries by whole frames without changing its length', () => {
    const moved = reduce(one, { type: 'moveClip', id: 'c1', time: 1.51 }, ctx)

    expect(moved.doc.clips[0]).toMatchObject({ in: 1.52, out: 3.52 })
    expect(moved.doc.clips[0]!.out - moved.doc.clips[0]!.in).toBeCloseTo(2, 9)
  })

  it('keeps a moved clip inside the quality zone while preserving its length', () => {
    const againstEnd = reduce(one, { type: 'moveClip', id: 'c1', time: 9 }, ctx)
    const againstStart = reduce(one, { type: 'moveClip', id: 'c1', time: -9 }, ctx)

    expect(againstEnd.doc.clips[0]).toMatchObject({ in: 2, out: 4, representation: '480p' })
    expect(againstStart.doc.clips[0]).toMatchObject({ in: 0, out: 2, representation: '480p' })
  })

  it('move of a clip that is gone changes nothing at all', () => {
    expect(reduce(one, { type: 'moveClip', id: 'nope', time: 2 }, ctx)).toBe(one)
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
    expect(cut.doc.clips[0]!.name).toBe(one.doc.clips[0]!.name)
  })

  it('leaves clips on either side of the split in their document order', () => {
    const two = run([
      { type: 'selectClip', id: null },
      at(6),
      { type: 'setIn' },
      { type: 'selectClip', id: 'c1' },
      at(1),
    ], one)
    const cut = reduce(two, { type: 'splitClip' }, ctx)

    expect(cut.doc.clips.map((clip) => clip.id)).toEqual(['c1', 'c3', 'c2'])
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
    // The playhead is moved into the middle of the clip, where a cut would go through, so that
    // the selection is the only thing left in the way — which is what this asks about. On the
    // out point, where the clip was made, the minimum length above refuses the cut whatever the
    // selection says, and a split that had stopped reading the selection would pass here too.
    const none = run([at(1), { type: 'selectClip', id: null }], one)

    expect(reduce(none, { type: 'splitClip' }, ctx)).toBe(none)
  })
})

describe('markers', () => {
  it('drops a marker on the playhead', () => {
    const marked = run([at(2), { type: 'addMarker' }])

    expect(marked.doc.markers).toEqual([{ id: 'm1', time: 2, label: 'M1' }])
  })

  it('drops the marker on a frame boundary even when the playhead is between two', () => {
    // The playhead can hold a time this grid does not have — it was put there on the grid of
    // another representation (see the split above). A marker between two frames is a marker no
    // cut and no handle can ever meet.
    const project = fresh()
    const between = { ...project, ui: { ...project.ui, playhead: 1.011 } }

    expect(reduce(between, { type: 'addMarker' }, ctx).doc.markers[0]!.time).toBeCloseTo(1, 9)
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

  it('leaves alone a marker standing further away than half a frame', () => {
    // The other side of the same window, and the reason it is half a frame and not two: the
    // marker on the next frame along is somewhere else. Shift+M leaves it where it is, and M is
    // free to put one down under the playhead. A wider window would take the neighbour away and
    // refuse the marker that was actually asked for.
    const marked = run([at(2), { type: 'addMarker' }])
    const beside = (drift: number): Project => ({
      ...marked,
      doc: { ...marked.doc, markers: [{ id: 'm1', time: 2 + drift, label: 'M1' }] },
    })

    for (const drift of [FRAME * 0.6, FRAME, -FRAME]) {
      const project = beside(drift)

      expect(reduce(project, { type: 'removeMarkerAt' }, ctx)).toBe(project)
      expect(reduce(project, { type: 'addMarker' }, ctx).doc.markers).toHaveLength(2)
    }
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
      { type: 'moveClip', id: 'c1', time: 1 },
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
      { type: 'setCrop', id: 'c1', crop: { x: 0, y: 0, width: 64, height: 64 } },
      { type: 'cropRatio', id: 'c1', ratio: '16:9' },
      { type: 'clearCrop', id: 'c1' },
      { type: 'applyCropToAll' },
      { type: 'setFormat', id: 'c1', format: 'webp' },
      { type: 'setMode', id: 'c1', mode: 'optimize' },
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
    expect(undoModeOf({ type: 'moveClip', id: 'c1', time: 2 })).toEqual({
      kind: 'merge',
      key: 'move:c1',
    })
  })

  it('merges a crop being dragged, under a key that is the clip and not the handle', () => {
    // A drag sends one of these a frame, and Ctrl+Z takes back the framing rather than the last
    // pixel of it. A rectangle moved and then resized is one act of framing; a key per handle
    // would make it two presses. The rectangle let go of is a step of its own.
    const crop = { x: 0, y: 0, width: 64, height: 64 }

    expect(undoModeOf({ type: 'setCrop', id: 'c1', crop, dragging: true })).toEqual({
      kind: 'merge',
      key: 'crop:c1',
    })
    expect(undoModeOf({ type: 'setCrop', id: 'c2', crop, dragging: true })).toEqual({
      kind: 'merge',
      key: 'crop:c2',
    })
    expect(undoModeOf({ type: 'setCrop', id: 'c1', crop })).toEqual({ kind: 'step' })
  })

  it('keeps a typed trim out of the drag it would otherwise join', () => {
    // A drag of one handle is hundreds of trims and one step of history, and that is right. A
    // value typed into the inspector is one deliberate act: joined to the drag before it, Ctrl+Z
    // would take back both and land on a value the user never saw.
    expect(undoModeOf({ type: 'trim', id: 'c1', edge: 'in', time: 1 })).toEqual({
      kind: 'merge',
      key: 'trim:c1:in',
    })
    expect(undoModeOf({ type: 'trim', id: 'c1', edge: 'in', time: 1, typed: true })).toEqual({
      kind: 'step',
    })
  })
})

/**
 * The framing of a clip: crop rectangle, output container, and export mode.
 *
 * The rectangle is put right against `ctx.frameSize` — the size of the picture the player is
 * playing — and not against the clip's own idea of anything: a crop is a rectangle of the open
 * representation, and the fixture's is 854×480.
 */
describe('the framing of a clip', () => {
  /** A fresh document with one clip, `c1`, running from 1 to 4 in the 480p zone. */
  const oneClip = (): Project => run([at(1), { type: 'setIn' }])

  const cropOf = (project: Project, id = 'c1') =>
    project.doc.clips.find((clip) => clip.id === id)!.crop

  it('puts an odd rectangle on the chroma grid before it reaches the clip', () => {
    // All four numbers, offsets included: what is cut from is a 4:2:0 frame, and an odd `x` does
    // not skew the picture, it refuses to give one — `new VideoFrame(frame, { visibleRect: { x:
    // 7, … } })` answers "x is not sample-aligned in plane 1". Correcting it here means the
    // reducer is the last place a rectangle can be odd.
    const put = run([{ type: 'setCrop', id: 'c1', crop: { x: 101, y: 7, width: 333, height: 187 } }], oneClip())

    expect(cropOf(put)).toEqual({ x: 100, y: 6, width: 332, height: 186 })
  })

  it('returns the very same project when the rectangle came back the same', () => {
    // A drag sends one of these a frame. Two pointer positions inside one pixel — or inside one
    // *pair* of pixels, after the rounding above — are the same rectangle, and an edit written
    // for each of them would put a step of history on every pixel the pointer did not move.
    const framed = run(
      [{ type: 'setCrop', id: 'c1', crop: { x: 100, y: 6, width: 332, height: 186 } }],
      oneClip(),
    )

    // The same numbers, and then the odd numbers that round to them: neither is an edit.
    expect(reduce(framed, { type: 'setCrop', id: 'c1', crop: { x: 100, y: 6, width: 332, height: 186 } }, ctx)).toBe(framed)
    expect(reduce(framed, { type: 'setCrop', id: 'c1', crop: { x: 101, y: 7, width: 333, height: 187 } }, ctx)).toBe(framed)

    // And a rectangle that moved in its size alone *is* an edit: dragging the bottom-right
    // handle leaves the corner where it was, and a comparison that only looked at the corner
    // would freeze the rectangle at whatever size the drag began from.
    const grown = reduce(framed, { type: 'setCrop', id: 'c1', crop: { x: 100, y: 6, width: 400, height: 186 } }, ctx)
    expect(grown).not.toBe(framed)
    expect(cropOf(grown)).toEqual({ x: 100, y: 6, width: 400, height: 186 })

    // And so is a rectangle that only moved: dragging the whole frame keeps its size, and a
    // comparison of the sides alone would pin it wherever the drag picked it up.
    const moved = reduce(framed, { type: 'setCrop', id: 'c1', crop: { x: 200, y: 40, width: 332, height: 186 } }, ctx)
    expect(moved).not.toBe(framed)
    expect(cropOf(moved)).toEqual({ x: 200, y: 40, width: 332, height: 186 })
  })

  it('puts a preset rectangle in the middle of the picture', () => {
    // 854×480 holds a square 480 on a side, and 187 pixels of margin round to 186.
    const square = run([{ type: 'cropRatio', id: 'c1', ratio: '1:1' }], oneClip())

    expect(cropOf(square)).toEqual({ x: 186, y: 0, width: 480, height: 480 })
  })

  it('takes the rectangle off again', () => {
    const framed = run(
      [{ type: 'setCrop', id: 'c1', crop: { x: 10, y: 10, width: 200, height: 100 } }],
      oneClip(),
    )

    expect(cropOf(reduce(framed, { type: 'clearCrop', id: 'c1' }, ctx))).toBeNull()
  })

  it('returns the very same project when there was no rectangle to take off', () => {
    const project = oneClip()

    expect(reduce(project, { type: 'clearCrop', id: 'c1' }, ctx)).toBe(project)
  })

  /** Three clips: two in the 480p zone, one in the 720p zone, the first of them selected. */
  const threeClips = (): Project =>
    run([
      at(1),
      { type: 'setIn' },
      { type: 'selectClip', id: null },
      at(2),
      { type: 'setIn' },
      { type: 'selectClip', id: null },
      at(7),
      { type: 'setIn' },
      { type: 'selectClip', id: 'c1' },
      { type: 'setCrop', id: 'c1', crop: { x: 10, y: 10, width: 200, height: 100 } },
    ])

  it('gives the selected rectangle to the other clips of the same representation', () => {
    const spread = reduce(threeClips(), { type: 'applyCropToAll' }, ctx)

    expect(cropOf(spread, 'c2')).toEqual({ x: 10, y: 10, width: 200, height: 100 })
  })

  it('leaves the clips of another representation alone', () => {
    // Another representation is another frame size. A 480p rectangle put on a 720p clip would be
    // pushed inside its edges by `normalizeCrop` and become a different rectangle without a word
    // — which is the one thing "apply to all" must not do.
    const spread = reduce(threeClips(), { type: 'applyCropToAll' }, ctx)

    expect(spread.doc.clips.find((clip) => clip.id === 'c3')!.representation).toBe('720p')
    expect(cropOf(spread, 'c3')).toBeNull()
  })

  it('does not move the rectangle when the container changes', () => {
    // Checked by identity, not by value. Evenness is a property of the 4:2:0 frame the picture is
    // cut from, and that frame is the same whether the clip is written into an MP4 or an
    // animation; an earlier draft re-rounded the rectangle here, which was the bug, not the fix.
    const framed = run(
      [{ type: 'setCrop', id: 'c1', crop: { x: 101, y: 7, width: 333, height: 187 } }],
      oneClip(),
    )
    const before = cropOf(framed)
    // Said first, and said by value: `toBe` between two nothings passes, so a clip that never
    // got the rectangle at all would satisfy both identities below without ever holding one.
    // Checked by breaking it — with the `setCrop` above taken away, the two lines that follow
    // went on passing.
    expect(before, 'there is no rectangle here to keep still').toEqual({
      x: 100,
      y: 6,
      width: 332,
      height: 186,
    })

    const webp = reduce(framed, { type: 'setFormat', id: 'c1', format: 'webp' }, ctx)
    expect(cropOf(webp)).toBe(before)

    const back = reduce(webp, { type: 'setFormat', id: 'c1', format: 'mp4' }, ctx)
    expect(cropOf(back)).toBe(before)
  })

  it('switches the mode, and says nothing happened when it is already that mode', () => {
    const optimized = reduce(oneClip(), { type: 'setMode', id: 'c1', mode: 'optimize' }, ctx)

    expect(optimized.doc.clips[0]!.mode).toBe('optimize')
    expect(reduce(optimized, { type: 'setMode', id: 'c1', mode: 'optimize' }, ctx)).toBe(optimized)
  })
})
