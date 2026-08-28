import type { KeyPress } from './keymap'

/**
 * J, K and L, the three keys every editing desk has had since tape.
 *
 * The state is not part of the project: it lives exactly as long as the finger between two
 * presses, it is not undone and not restored, and putting it in the document would put a speed
 * into the history of an edit. What is here is the ladder and its rules, so that they can be
 * checked as a list of presses and not as a sequence of clicks.
 */
export interface ShuttleState {
  direction: -1 | 0 | 1
  /** One of SHUTTLE_RATES while moving; zero while still. */
  rate: number
}

export const STILL: ShuttleState = { direction: 0, rate: 0 }

export const SHUTTLE_RATES: readonly number[] = [1, 2, 4, 8, 16]

export type ShuttleKey = 'j' | 'k' | 'l'

/**
 * J, K or L off a key press, or null for anything else.
 *
 * Ctrl, Meta and Alt take the letter away; **Shift does not**, and that is deliberate rather than
 * an oversight: the capital comes from Shift and from CapsLock alike, and a shuttle that dies
 * under CapsLock is a fault nobody diagnoses. The price is that Shift+J, Shift+K and Shift+L are
 * spent — they shuttle — and no later command may claim them. Shift+M (`removeMarkerAt`) is the
 * pattern this one deliberately does not follow.
 */
export function shuttleKeyOf(press: KeyPress): ShuttleKey | null {
  if (press.ctrl || press.meta || press.alt) return null
  const key = press.key.toLowerCase()
  return key === 'j' || key === 'k' || key === 'l' ? key : null
}

export function shuttled(state: ShuttleState, key: ShuttleKey): ShuttleState {
  if (key === 'k') return state.direction === 0 ? state : STILL

  const wanted = key === 'l' ? 1 : -1
  const at = SHUTTLE_RATES.indexOf(state.rate)

  if (state.direction !== wanted) {
    // The opposite key takes a notch off the speed first: from eight forward, J means four
    // forward. Only from the slowest notch does it cross over — stopping is what K is for.
    if (state.direction === 0 || at <= 0) return { direction: wanted, rate: SHUTTLE_RATES[0]! }
    return { direction: state.direction, rate: SHUTTLE_RATES[at - 1]! }
  }

  const next = SHUTTLE_RATES[Math.min(at + 1, SHUTTLE_RATES.length - 1)]!
  return next === state.rate ? state : { direction: wanted, rate: next }
}

/** Seconds of material to cross in that much wall-clock time. Negative going back. */
export function shuttleAdvance(state: ShuttleState, elapsedSeconds: number): number {
  return state.direction * state.rate * elapsedSeconds
}

/** What the readout under the player says. Empty while still: nothing to announce. */
export function shuttleLabel(state: ShuttleState): string {
  if (state.direction === 0) return ''
  return `${state.rate}×${state.direction < 0 ? ' back' : ''}`
}
