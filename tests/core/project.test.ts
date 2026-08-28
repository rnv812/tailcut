import { describe, it, expect } from 'vitest'
import { ctx, clip } from './edit-fixture'
import {
  EMPTY_DOC,
  clipBands,
  clipById,
  clipsAt,
  newProject,
  selectedClip,
  totalLength,
  withDoc,
  type Doc,
} from '../../src/core/edit/project'

const doc: Doc = {
  clips: [clip({ id: 'c1', in: 0, out: 3 }), clip({ id: 'c2', name: 'Two', in: 2, out: 4 })],
  markers: [{ id: 'm1', time: 1, label: 'M1' }],
  nextId: 3,
}

describe('project', () => {
  it('opens on the whole material', () => {
    const project = newProject(1200, ctx)

    expect(project.ui.playhead).toBe(0)
    expect(project.ui.selectedClipId).toBeNull()
    expect(project.ui.snapping).toBe(true)
    expect(project.ui.view).toEqual({ start: 0, scale: 10 / 1200, widthPx: 1200 })
    expect(project.doc).toEqual(EMPTY_DOC)
  })

  it('opens on something sane when there is no material', () => {
    const project = newProject(1200, { ...ctx, duration: 0 })

    expect(project.ui.view.scale).toBeGreaterThan(0)
  })

  it('finds a clip by id and by selection', () => {
    const project = { doc, ui: { ...newProject(1200, ctx).ui, selectedClipId: 'c2' } }

    expect(clipById(doc, 'c1')!.name).toBe('One')
    expect(clipById(doc, 'nope')).toBeUndefined()
    // Nothing selected finds nothing — and not the first clip, which is what a `?? clips[0]`
    // slipped in anywhere under `selectedClip` would hand back to a project with no selection.
    expect(clipById(doc, null)).toBeUndefined()
    expect(selectedClip(project)!.id).toBe('c2')
  })

  it('finds every clip over a time, overlapping or not', () => {
    expect(clipsAt(doc, 2.5).map((found) => found.id)).toEqual(['c1', 'c2'])
    expect(clipsAt(doc, 3.5).map((found) => found.id)).toEqual(['c2'])
    expect(clipsAt(doc, 9)).toEqual([])
  })

  it('counts a clip as covering its own edges', () => {
    // A clip is picked by pressing on it, and the pixel of its edge belongs to it: an out point
    // that answers "no clip here" is a clip that cannot be grabbed where it is easiest to aim.
    expect(clipsAt(doc, 3).map((found) => found.id)).toEqual(['c1', 'c2'])
    expect(clipsAt(doc, 0).map((found) => found.id)).toEqual(['c1'])
    expect(clipsAt(doc, 4).map((found) => found.id)).toEqual(['c2'])
  })

  it('hands the timeline bands with the selection marked', () => {
    const project = { doc, ui: { ...newProject(1200, ctx).ui, selectedClipId: 'c2' } }

    expect(clipBands(project)).toEqual([
      { id: 'c1', name: 'One', in: 0, out: 3, selected: false },
      { id: 'c2', name: 'Two', in: 2, out: 4, selected: true },
    ])
  })

  it('adds the clips up', () => {
    expect(totalLength(doc)).toBe(5)
  })

  it('drops a selection whose clip is gone and keeps one that survived', () => {
    const project = { doc, ui: { ...newProject(1200, ctx).ui, selectedClipId: 'c2' } }
    const without: Doc = { ...doc, clips: [doc.clips[0]!] }

    expect(withDoc(project, without).ui.selectedClipId).toBeNull()
    expect(withDoc(project, doc)).toBe(project)
  })

  it('leaves the whole of the ui alone when the selection survived', () => {
    // Undo puts a document back and nothing else. Handing out a fresh `ui` would move the
    // playhead and the viewport by identity alone, and every panel watching them would repaint.
    const project = { doc, ui: { ...newProject(1200, ctx).ui, selectedClipId: 'c2' } }
    const edited: Doc = { ...doc, markers: [] }

    expect(withDoc(project, edited).ui).toBe(project.ui)
  })
})
