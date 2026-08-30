import type { ExportFormat } from '../../shared/settings'
import { normalizeCrop, ratioCrop, type Crop, type CropRatio } from '../encode/crop'
import { quantize, shiftBy } from '../timeline/grid'
import {
  clampView,
  fitAll,
  fitRange,
  panBy,
  zoomAt,
  zoomToward,
} from '../timeline/view'
import { clipName, normalizeClip, type Clip, type ClipMode, type Marker } from './clip'
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
  | { type: 'trim'; id: string; edge: 'in' | 'out'; time: number; typed?: boolean }
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
  | { type: 'setCrop'; id: string; crop: Crop; dragging?: boolean }
  | { type: 'cropRatio'; id: string; ratio: CropRatio }
  | { type: 'clearCrop'; id: string }
  | { type: 'applyCropToAll' }
  | { type: 'setFormat'; id: string; format: ExportFormat }
  | { type: 'setMode'; id: string; mode: ClipMode }

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

const sameCrop = (a: Crop | null, b: Crop | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height)

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
    name: clipName({
      title: ctx.title,
      at: start,
      to: end,
      host: ctx.host,
      template: ctx.nameTemplate,
      taken: project.doc.clips.map((clip) => clip.name),
    }),
    in: start,
    out: end,
    representation: zoneAt(ctx, start)?.representation ?? '',
    sound: true,
    crop: null,
    format: ctx.newClipFormat,
    mode: 'original',
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
      name: clipName({
        title: ctx.title,
        at,
        to: clip.out,
        host: ctx.host,
        template: ctx.nameTemplate,
        taken: project.doc.clips.map((candidate) => candidate.name),
      }),
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

    case 'setCrop': {
      const clip = clipById(project.doc, action.id)
      if (!clip) return project
      const crop = normalizeCrop(action.crop, ctx.frameSize)
      // The drag sends one of these a frame; a rectangle that came back the same is not an edit,
      // and letting it through would put a history entry on every pixel the pointer did not move.
      if (sameCrop(clip.crop, crop)) return project
      return replaceClip(project, clip.id, { ...clip, crop })
    }

    case 'cropRatio': {
      const clip = clipById(project.doc, action.id)
      if (!clip) return project
      return replaceClip(project, clip.id, {
        ...clip,
        crop: ratioCrop(action.ratio, ctx.frameSize),
      })
    }

    case 'clearCrop': {
      const clip = clipById(project.doc, action.id)
      if (!clip || clip.crop === null) return project
      return replaceClip(project, clip.id, { ...clip, crop: null })
    }

    case 'applyCropToAll': {
      const from = selectedClip(project)
      if (!from) return project
      // Only the clips of the same representation. Another representation is another frame size,
      // and a 1080p rectangle put on a 480p clip would be pushed inside its edges by
      // `normalizeCrop` — becoming a different rectangle, silently, which is the one thing
      // "apply to all" must not do.
      const clips = project.doc.clips.map((clip) =>
        clip.id === from.id || clip.representation !== from.representation
          ? clip
          : { ...clip, crop: from.crop === null ? null : normalizeCrop(from.crop, ctx.frameSize) },
      )
      if (clips.every((clip, at) => clip === project.doc.clips[at])) return project
      return edited(project, { clips })
    }

    case 'setFormat': {
      const clip = clipById(project.doc, action.id)
      if (!clip || clip.format === action.format) return project
      // The rectangle is not touched by a change of format, and there is nothing to touch: it was
      // put right against the picture it is cut from, and the picture does not change when the
      // container does. An earlier draft re-rounded it here, back when evenness was a rule about
      // MP4 rather than about 4:2:0 — that was the shape of the bug, not of the fix.
      return replaceClip(project, clip.id, { ...clip, format: action.format })
    }

    case 'setMode': {
      const clip = clipById(project.doc, action.id)
      if (!clip || clip.mode === action.mode) return project
      return replaceClip(project, clip.id, { ...clip, mode: action.mode })
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

/** The two modes that carry no data, shared by the table below. */
const STEP: UndoMode = { kind: 'step' }
const SKIP: UndoMode = { kind: 'skip' }

/** A mode, or a mode computed from the action when it needs a key of its own. */
type ModeFor<T extends Action['type']> =
  | UndoMode
  | ((action: Extract<Action, { type: T }>) => UndoMode)

/**
 * What every command does to the history — one entry per member of the union, and no default.
 *
 * A `Record` and not a set of the names that count. A set answers "no step" for a name it has
 * never heard of, so a command added later would be undoable by nobody and nothing would say so:
 * it compiles, it runs, it edits the document, and Ctrl+Z does nothing. Here the compiler refuses
 * a member of `Action` that is missing from the table, and `tests/core/undo.test.ts` refuses an
 * entry whose mode disagrees with what the command actually does to the document.
 */
const MODES: { [T in Action['type']]: ModeFor<T> } = {
  // Movement and looking. The present moves, no step is written: coming back to the zoom of two
  // gestures ago is not the undoing of an edit, it is the loss of one's place.
  seek: SKIP,
  step: SKIP,
  skip: SKIP,
  selectClip: SKIP,
  zoom: SKIP,
  zoomStep: SKIP,
  zoomToSelection: SKIP,
  fitAll: SKIP,
  pan: SKIP,
  resize: SKIP,
  setSnapping: SKIP,
  toggleSnapping: SKIP,

  // Edits, one press one step.
  setIn: STEP,
  setOut: STEP,
  addClip: STEP,
  removeClip: STEP,
  splitClip: STEP,
  toggleSound: STEP,
  addMarker: STEP,
  removeMarker: STEP,
  removeMarkerAt: STEP,

  // Edits that arrive in floods and have to become one step each. The key comes out of the action
  // itself, which is what lets a drag of hundreds of events undo in one press without a timer and
  // without anybody telling the history that a gesture began or ended.
  trim: (action) =>
    action.typed ? STEP : { kind: 'merge', key: `trim:${action.id}:${action.edge}` },
  renameClip: (action) => ({ kind: 'merge', key: `rename:${action.id}` }),

  clearCrop: STEP,
  cropRatio: STEP,
  applyCropToAll: STEP,
  setFormat: STEP,
  setMode: STEP,

  // A drag of the crop handles is a flood like a trim: hundreds of events, one press of Ctrl+Z.
  // The key is the clip, not the handle — a frame moved and then resized is one act of framing.
  setCrop: (action) => (action.dragging ? { kind: 'merge', key: `crop:${action.id}` } : STEP),
}

/** Every command there is, taken off the table so that the two cannot drift apart. */
export const ACTION_TYPES = Object.keys(MODES) as ReadonlyArray<Action['type']>

export function undoModeOf(action: Action): UndoMode {
  const mode = MODES[action.type] as UndoMode | ((action: Action) => UndoMode)
  return typeof mode === 'function' ? mode(action) : mode
}
