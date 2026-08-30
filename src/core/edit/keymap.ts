import type { SessionAction } from './session'

export interface KeyPress {
  /** `KeyboardEvent.key`. */
  key: string
  shift: boolean
  ctrl: boolean
  meta: boolean
  alt: boolean
  repeat: boolean
}

/** One press of + or − multiplies the scale by this. */
export const ZOOM_KEY_STEP = 1.4

/**
 * A press turned into an action, or null when the press is none of the editor's business.
 *
 * The whole layout is one table, and it is pure: the listener that owns the DOM (state/keys.ts)
 * decides only whether the focus is in a text field, and asks this for the rest. Space belongs to
 * the player and is deliberately left unbound here — the player component takes it.
 */
export function actionFor(press: KeyPress): SessionAction | null {
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key
  const command = press.ctrl || press.meta

  if (command) {
    if (key === 'z') return press.shift ? { type: 'redo' } : { type: 'undo' }
    if (key === 'y') return { type: 'redo' }
    // Ctrl+S saves the page, Ctrl+F finds on it: taking those would break the browser.
    return null
  }

  // Alt frees a dragged handle from snapping. It never
  // starts an action of its own, so that holding it and pressing something is not a command.
  if (press.alt) return null

  if (key === 'ArrowRight') return press.shift ? { type: 'skip', seconds: 1 } : { type: 'step', frames: 1 }
  if (key === 'ArrowLeft') return press.shift ? { type: 'skip', seconds: -1 } : { type: 'step', frames: -1 }

  // Everything below is a one-shot: a held key must not write a step of history per repeat.
  if (press.repeat) return null

  switch (key) {
    case 'i':
      return { type: 'setIn' }
    case 'o':
      return { type: 'setOut' }
    case 's':
      return { type: 'splitClip' }
    case 'm':
      // The pair: M drops one where the playhead is, Shift+M takes that one away. A second M on
      // the same frame is refused rather than treated as an undrop, so removal needs a key.
      return press.shift ? { type: 'removeMarkerAt' } : { type: 'addMarker' }
    case 'n':
      return { type: 'toggleSnapping' }
    case 'z':
      return { type: 'zoomToSelection' }
    case 'f':
      return { type: 'fitAll' }
    case '=':
    case '+':
      return { type: 'zoomStep', factor: 1 / ZOOM_KEY_STEP }
    case '-':
    case '_':
      return { type: 'zoomStep', factor: ZOOM_KEY_STEP }
    case 'Delete':
    case 'Backspace':
      return { type: 'removeClip' }
    case 'Home':
      return { type: 'seek', time: 0 }
    case 'End':
      // Clamped by the reducer: the keyboard has no business knowing how long the material is.
      return { type: 'seek', time: Number.POSITIVE_INFINITY }
    default:
      return null
  }
}
