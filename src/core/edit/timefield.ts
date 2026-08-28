import { formatTimecode, parseTimecode, timecodeRate } from '../timeline/timecode'

export interface FieldState {
  /** What stands in the box, letter for letter. Never rewritten behind the user's back. */
  text: string
  /** The last commit could not read it. Cleared by the next keystroke. */
  invalid: boolean
}

export interface FieldCommit {
  state: FieldState
  /** Seconds to move to, or null when nothing is to move. */
  time: number | null
}

export function fieldOf(seconds: number, fps: number): FieldState {
  return { text: formatTimecode(seconds, fps), invalid: false }
}

export function retyped(state: FieldState, text: string): FieldState {
  if (text === state.text && !state.invalid) return state
  return { text, invalid: false }
}

/**
 * One entry read, in any of the forms a hand used to an editor produces.
 *
 * Two beyond the timecodes parseTimecode already knows: a frame number, which is what somebody
 * reading a bug report types, and an offset from where the value stands, which is how a boundary
 * gets nudged by an exact amount. `from` is that standing value.
 */
export function parseEntry(text: string, fps: number, from: number): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const sign = trimmed.startsWith('+') ? 1 : trimmed.startsWith('-') ? -1 : 0
  const body = sign ? trimmed.slice(1).trim() : trimmed

  const frames = /^(\d+)\s*f$/i.exec(body)
  const value = frames ? Number(frames[1]) / timecodeRate(fps) : parseTimecode(body, fps)
  if (value === null || !Number.isFinite(value)) return null

  return sign ? from + sign * value : value
}

/** Never negative: a time before the start of the recording is a time nothing can be cut at. */
const onMaterial = (time: number): number => (time < 0 ? 0 : time)

/**
 * What pressing Enter, or leaving the box, does.
 *
 * Three outcomes and they are different on purpose. A time: the caller sends it to the model.
 * Rubbish: no time, `invalid`, and **the same text** — the whole point of the field is that a
 * mistyped digit costs a digit and not the entry. An emptied box: no time, no complaint; the
 * caller puts the model's value back, because an empty box is a box on the way somewhere, not a
 * request to go to zero.
 */
export function commitField(state: FieldState, fps: number, from: number): FieldCommit {
  if (!state.text.trim()) return { state: { text: '', invalid: false }, time: null }

  const time = parseEntry(state.text, fps, from)
  if (time === null) return { state: { text: state.text, invalid: true }, time: null }

  const landed = onMaterial(time)
  return { state: fieldOf(landed, fps), time: landed }
}

/**
 * What the arrows in the box do: move by frames, from whatever the box says.
 *
 * From the box and not from the model, so that typing a value and then nudging it works the way
 * it reads. Rubbish is refused here too rather than quietly replaced with the model's value.
 */
export function nudged(state: FieldState, frames: number, fps: number, from: number): FieldCommit {
  const standing = state.text.trim() ? parseEntry(state.text, fps, from) : from
  if (standing === null) return { state: { text: state.text, invalid: true }, time: null }

  const time = onMaterial(standing + frames / timecodeRate(fps))
  return { state: fieldOf(time, fps), time }
}
