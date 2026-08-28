/** Undo as three lists and a key. `T` is the document; nothing else is ever put in here. */
export interface History<T> {
  past: T[]
  present: T
  future: T[]
  /** The key the last step was written under, for merging what belongs to one gesture. */
  key: string | null
}

/**
 * What an action does to the history.
 *
 * - `skip` — the present moves, no step is written (a seek, a zoom, a selection).
 * - `step` — a new step.
 * - `merge` — a step that replaces the previous one when the key is the same: a drag of a handle
 *   sends hundreds of these and has to undo in one.
 */
export type UndoMode = { kind: 'skip' } | { kind: 'step' } | { kind: 'merge'; key: string }

/** Steps kept. The document is clips and markers — tens of objects — so whole copies are cheaper
 *  to keep and far cheaper to reason about than deltas. */
export const HISTORY_LIMIT = 100

export function history<T>(present: T): History<T> {
  return { past: [], present, future: [], key: null }
}

export function commit<T>(h: History<T>, next: T, mode: UndoMode, limit = HISTORY_LIMIT): History<T> {
  // Nothing changed. A merge leaves everything as it stands — the first pixel of a drag often
  // moves nothing, and claiming the key here would let the first real change merge into the
  // previous step and swallow it. Anything else clears the key, which is how a seek between two
  // drags of the same handle keeps them two steps and not one.
  if (next === h.present) {
    if (mode.kind === 'merge') return h
    return h.key === null ? h : { ...h, key: null }
  }

  if (mode.kind === 'skip') return { ...h, present: next, key: null }
  if (mode.kind === 'merge' && h.key === mode.key) return { ...h, present: next, future: [] }

  return {
    past: [...h.past, h.present].slice(-limit),
    present: next,
    future: [],
    key: mode.kind === 'merge' ? mode.key : null,
  }
}

export function undo<T>(h: History<T>): History<T> {
  const previous = h.past[h.past.length - 1]
  if (previous === undefined) return h
  return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future], key: null }
}

export function redo<T>(h: History<T>): History<T> {
  const next = h.future[0]
  if (next === undefined) return h
  return { past: [...h.past, h.present], present: next, future: h.future.slice(1), key: null }
}

export function canUndo(h: History<unknown>): boolean {
  return h.past.length > 0
}

export function canRedo(h: History<unknown>): boolean {
  return h.future.length > 0
}
