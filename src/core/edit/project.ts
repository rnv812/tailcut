import type { ClipBand } from '../timeline/layout'
import type { Viewport } from '../timeline/view'
import type { Clip, Marker } from './clip'
import type { EditContext } from './context'

/** What the user has made. This, and only this, is what undo takes back. */
export interface Doc {
  clips: Clip[]
  markers: Marker[]
  /** Counter behind `c1`, `m2`, … — part of the document so that undo does not reuse an id. */
  nextId: number
}

/** Where the user is looking. Not part of the history: a zoom is not an edit. */
export interface Ui {
  /** Media time, always on a frame boundary. */
  playhead: number
  selectedClipId: string | null
  view: Viewport
  /** Handles stick to targets unless this is off; Alt inverts it for one movement. */
  snapping: boolean
}

export interface Project {
  doc: Doc
  ui: Ui
}

export const EMPTY_DOC: Doc = { clips: [], markers: [], nextId: 1 }

export function newProject(widthPx: number, ctx: EditContext): Project {
  return {
    doc: EMPTY_DOC,
    ui: {
      playhead: 0,
      selectedClipId: null,
      // Everything at once is the only opening view that says what was recorded.
      view: { start: 0, scale: ctx.duration > 0 ? ctx.duration / widthPx : 1, widthPx },
      snapping: true,
    },
  }
}

export function clipById(doc: Doc, id: string | null): Clip | undefined {
  return id === null ? undefined : doc.clips.find((clip) => clip.id === id)
}

export function selectedClip(project: Project): Clip | undefined {
  return clipById(project.doc, project.ui.selectedClipId)
}

/** Every clip covering a time. Ranges are allowed to overlap, so there can be several. */
export function clipsAt(doc: Doc, time: number): Clip[] {
  return doc.clips.filter((clip) => time >= clip.in && time <= clip.out)
}

/** The document as the timeline wants it. `Marker` is already a `MarkerPin` and needs no mapping. */
export function clipBands(project: Project): ClipBand[] {
  return project.doc.clips.map((clip) => ({
    id: clip.id,
    name: clip.name,
    in: clip.in,
    out: clip.out,
    selected: clip.id === project.ui.selectedClipId,
  }))
}

export function totalLength(doc: Doc): number {
  return doc.clips.reduce((total, clip) => total + (clip.out - clip.in), 0)
}

/**
 * A document put in place of the one in the project — this is what undo and redo do.
 *
 * The selection is the one part of `ui` that a change of document can invalidate: undoing the
 * clip that is selected must not leave the inspector pointing at nothing.
 */
export function withDoc(project: Project, doc: Doc): Project {
  if (doc === project.doc) return project
  const selectedClipId = clipById(doc, project.ui.selectedClipId) ? project.ui.selectedClipId : null
  return { doc, ui: selectedClipId === project.ui.selectedClipId ? project.ui : { ...project.ui, selectedClipId } }
}
