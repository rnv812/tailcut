import { quantize, shiftBy } from '../timeline/grid'
import {
  clampView,
  fitAll,
  fitRange,
  panBy,
  zoomAt,
  zoomToward,
} from '../timeline/view'
import { clipName, normalizeClip, type Clip, type Marker } from './clip'
import { runAt, viewBounds, zoneAt, type EditContext } from './context'
import type { UndoMode } from './history'
import { clipById, selectedClip, type Doc, type Project, type Ui } from './project'

/**
 * Everything that can happen to the project.
 *
 * One union for the keyboard, the mouse and the inspector: a clip trimmed by dragging and a clip
 * trimmed by typing a timecode are the same action, so they cannot disagree. The first five
 * members are the shapes `TimelineGesture` produces (Task 8, Task 9), field for field.
 */
export type Action =
  | { type: 'seek'; time: number }
  | { type: 'zoom'; atPx: number; factor: number }
  | { type: 'pan'; dxPx: number }
  | { type: 'trim'; id: string; edge: 'in' | 'out'; time: number }
  | { type: 'selectClip'; id: string | null }
  | { type: 'step'; frames: number }
  | { type: 'skip'; seconds: number }
  | { type: 'setIn' }
  | { type: 'setOut' }
  | { type: 'addClip' }
  | { type: 'removeClip'; id?: string }
  | { type: 'splitClip' }
  | { type: 'renameClip'; id: string; name: string }
  | { type: 'toggleSound'; id: string }
  | { type: 'addMarker' }
  | { type: 'removeMarker'; id: string }
  | { type: 'removeMarkerAt' }
  | { type: 'zoomStep'; factor: number }
  | { type: 'zoomToSelection' }
  | { type: 'fitAll' }
  | { type: 'resize'; widthPx: number }
  | { type: 'setSnapping'; on: boolean }
  | { type: 'toggleSnapping' }

/** Returns the project itself when every field is what it already was. */
function withUi(project: Project, ui: Partial<Ui>): Project {
  const next: Ui = { ...project.ui, ...ui }
  for (const key of Object.keys(next) as (keyof Ui)[]) {
    if (next[key] !== project.ui[key]) return { doc: project.doc, ui: next }
  }
  return project
}

function edited(project: Project, doc: Partial<Doc>, ui?: Partial<Ui>): Project {
  return { doc: { ...project.doc, ...doc }, ui: ui ? { ...project.ui, ...ui } : project.ui }
}

function replaceClip(project: Project, id: string, clip: Clip): Project {
  return edited(project, {
    clips: project.doc.clips.map((candidate) => (candidate.id === id ? clip : candidate)),
  })
}

function trimTo(project: Project, clip: Clip, edge: 'in' | 'out', time: number, ctx: EditContext): Project {
  const moved = edge === 'in' ? { ...clip, in: time } : { ...clip, out: time }
  const next = normalizeClip(moved, ctx, edge)
  if (next.in === clip.in && next.out === clip.out) return project
  return replaceClip(project, clip.id, next)
}

/**
 * A clip begun from the playhead: I runs it to the end of the current run, O back to the start of
 * it. The run and not the material, because a clip born across a gap nobody chose is a clip whose
 * length lies. Reaching across a gap on purpose is a trim away, and §8.2 collapses it then.
 */
function startClip(project: Project, edge: 'in' | 'out', ctx: EditContext): Project {
  const at = project.ui.playhead
  const run = runAt(ctx, at) ?? { start: 0, end: ctx.duration }
  const start = edge === 'in' ? at : run.start
  const end = edge === 'in' ? run.end : at

  const draft: Clip = {
    id: `c${project.doc.nextId}`,
    name: clipName({ title: ctx.title, at: start, taken: project.doc.clips.map((clip) => clip.name) }),
    in: start,
    out: end,
    representation: zoneAt(ctx, start)?.representation ?? '',
    sound: true,
    crop: null,
    format: 'mp4',
  }

  // The edge the user did not choose is the one that gives way; if there is no room for it to
  // give way into, no clip is made at all.
  const clip = normalizeClip(draft, ctx, edge === 'in' ? 'out' : 'in')
  if (clip.out <= clip.in) return project

  return edited(
    project,
    { clips: [...project.doc.clips, clip], nextId: project.doc.nextId + 1 },
    { selectedClipId: clip.id },
  )
}

function splitClip(project: Project, ctx: EditContext): Project {
  const clip = selectedClip(project)
  if (!clip) return project

  const at = quantize(ctx.frames, project.ui.playhead)
  const left = normalizeClip({ ...clip, out: at }, ctx, 'out')
  const right = normalizeClip(
    {
      ...clip,
      id: `c${project.doc.nextId}`,
      name: clipName({ title: ctx.title, at, taken: project.doc.clips.map((candidate) => candidate.name) }),
      in: at,
    },
    ctx,
    'in',
  )

  // Either half having been pushed back means the playhead was inside the minimum of a half:
  // moving the cut to make it fit would be answering a question the user did not ask.
  if (left.out !== at || right.in !== at) return project

  return edited(
    project,
    {
      clips: project.doc.clips.flatMap((candidate) => (candidate.id === clip.id ? [left, right] : [candidate])),
      nextId: project.doc.nextId + 1,
    },
    { selectedClipId: right.id },
  )
}

function addMarker(project: Project, ctx: EditContext): Project {
  const time = quantize(ctx.frames, project.ui.playhead)
  const half = ctx.fps > 0 ? 1 / ctx.fps / 2 : 1e-6
  if (project.doc.markers.some((marker) => Math.abs(marker.time - time) < half)) return project

  const marker: Marker = {
    id: `m${project.doc.nextId}`,
    time,
    label: `M${project.doc.markers.length + 1}`,
  }

  return edited(project, {
    markers: [...project.doc.markers, marker].sort((a, b) => a.time - b.time),
    nextId: project.doc.nextId + 1,
  })
}

const clampTime = (time: number, ctx: EditContext): number =>
  time < 0 ? 0 : time > ctx.duration ? ctx.duration : time

/** The only place a `Project` changes. Pure and total: every action, every state. */
export function reduce(project: Project, action: Action, ctx: EditContext): Project {
  switch (action.type) {
    case 'seek':
      return withUi(project, { playhead: quantize(ctx.frames, clampTime(action.time, ctx)) })

    case 'step':
      return withUi(project, { playhead: shiftBy(ctx.frames, project.ui.playhead, action.frames) })

    case 'skip': {
      // Counted in frames, so a second of skipping is a second of material and a gap costs
      // nothing: the grid holds what exists, and nothing else.
      const frames = Math.round(action.seconds * (ctx.fps > 0 ? ctx.fps : 25))
      return withUi(project, { playhead: shiftBy(ctx.frames, project.ui.playhead, frames) })
    }

    case 'selectClip': {
      const id = clipById(project.doc, action.id) ? action.id : null
      return withUi(project, { selectedClipId: id })
    }

    case 'setIn':
    case 'setOut': {
      const edge = action.type === 'setIn' ? 'in' : 'out'
      const clip = selectedClip(project)
      return clip
        ? trimTo(project, clip, edge, project.ui.playhead, ctx)
        : startClip(project, edge, ctx)
    }

    case 'addClip':
      return startClip(project, 'in', ctx)

    case 'trim': {
      const clip = clipById(project.doc, action.id)
      return clip ? trimTo(project, clip, action.edge, action.time, ctx) : project
    }

    case 'splitClip':
      return splitClip(project, ctx)

    case 'removeClip': {
      const id = action.id ?? project.ui.selectedClipId
      if (!clipById(project.doc, id)) return project
      return edited(
        project,
        { clips: project.doc.clips.filter((clip) => clip.id !== id) },
        project.ui.selectedClipId === id ? { selectedClipId: null } : undefined,
      )
    }

    case 'renameClip': {
      const clip = clipById(project.doc, action.id)
      const name = action.name.trim()
      if (!clip || !name || name === clip.name) return project
      return replaceClip(project, clip.id, { ...clip, name })
    }

    case 'toggleSound': {
      const clip = clipById(project.doc, action.id)
      if (!clip) return project
      return replaceClip(project, clip.id, { ...clip, sound: !clip.sound })
    }

    case 'addMarker':
      return addMarker(project, ctx)

    case 'removeMarker': {
      if (!project.doc.markers.some((marker) => marker.id === action.id)) return project
      return edited(project, {
        markers: project.doc.markers.filter((marker) => marker.id !== action.id),
      })
    }

    case 'removeMarkerAt': {
      // The keyboard's half of the pair: it has a playhead, not an id. Same half-frame window
      // `addMarker` refuses a duplicate inside, so M and Shift+M agree on what "here" means.
      const time = quantize(ctx.frames, project.ui.playhead)
      const half = ctx.fps > 0 ? 1 / ctx.fps / 2 : 1e-6
      const markers = project.doc.markers.filter((marker) => Math.abs(marker.time - time) >= half)
      if (markers.length === project.doc.markers.length) return project
      return edited(project, { markers })
    }

    case 'zoom':
      return withUi(project, { view: zoomAt(project.ui.view, action.atPx, action.factor, viewBounds(ctx)) })

    case 'zoomStep':
      // The keyboard has no pointer, so the playhead is the anchor (Task 8).
      return withUi(project, {
        view: zoomToward(project.ui.view, project.ui.playhead, action.factor, viewBounds(ctx)),
      })

    case 'zoomToSelection': {
      const clip = selectedClip(project)
      const range = clip ? { start: clip.in, end: clip.out } : { start: 0, end: ctx.duration }
      return withUi(project, { view: fitRange(project.ui.view, range, viewBounds(ctx)) })
    }

    case 'fitAll':
      return withUi(project, { view: fitAll(project.ui.view, viewBounds(ctx)) })

    case 'pan':
      return withUi(project, { view: panBy(project.ui.view, action.dxPx, viewBounds(ctx)) })

    case 'resize': {
      if (action.widthPx === project.ui.view.widthPx) return project
      return withUi(project, {
        view: clampView({ ...project.ui.view, widthPx: action.widthPx }, viewBounds(ctx)),
      })
    }

    case 'setSnapping':
      return withUi(project, { snapping: action.on })

    case 'toggleSnapping':
      return withUi(project, { snapping: !project.ui.snapping })
  }
}

/** Actions that make a step of history. Everything not named here is a movement or a look. */
const STEPS: ReadonlySet<Action['type']> = new Set([
  'setIn',
  'setOut',
  'addClip',
  'removeClip',
  'splitClip',
  'toggleSound',
  'addMarker',
  'removeMarker',
  'removeMarkerAt',
])

/**
 * What an action does to the history — computed from the action alone.
 *
 * This is what lets a drag of hundreds of events undo in one press without a timer and without
 * anybody telling the history that a gesture began or ended: the key comes out of the action.
 */
export function undoModeOf(action: Action): UndoMode {
  if (action.type === 'trim') return { kind: 'merge', key: `trim:${action.id}:${action.edge}` }
  if (action.type === 'renameClip') return { kind: 'merge', key: `rename:${action.id}` }
  return STEPS.has(action.type) ? { kind: 'step' } : { kind: 'skip' }
}
