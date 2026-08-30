import { useEffect, useState } from 'preact/hooks'
import { commitField, fieldOf, nudged, retyped, type FieldState } from '../../core/edit/timefield'

export interface TimecodeFieldProps {
  /** Shown beside the box. */
  label: string
  /** The value the box stands for, in seconds of media time. */
  seconds: number
  fps: number
  /** The time typed. What happens to it is the model's business, not the field's. */
  onCommit: (time: number) => void
  /** `data-testid` of the input, and the name it is addressed by. */
  id: string
  disabled?: boolean
}

const FORMATS = '00:01:23:12 · 1:23 · 83 · 83.5s · 250f · +10 · -2:00'

/**
 * A timecode, typed.
 *
 * Everything it knows about reading and rejecting lives in core/edit/timefield.ts; what is left
 * here is a box, a focus and four keys. The value goes out through the same action the timeline
 * sends when a handle is dragged, so a clip trimmed by hand and a clip trimmed by number cannot
 * come out different.
 */
export function TimecodeField({ label, seconds, fps, onCommit, id, disabled }: TimecodeFieldProps) {
  const [state, setState] = useState<FieldState>(() => fieldOf(seconds, fps))

  // The box follows the model whenever the model moves — a handle dragged on the timeline, a
  // value the model clamped. Typing does not move the model, so an entry in progress survives.
  useEffect(() => setState(fieldOf(seconds, fps)), [seconds, fps])

  const commit = (): void => {
    const result = commitField(state, fps, seconds)
    // No time and no complaint means the box was emptied: the model's value goes back in.
    setState(result.time === null && !result.state.invalid ? fieldOf(seconds, fps) : result.state)
    if (result.time !== null) onCommit(result.time)
  }

  const nudge = (frames: number): void => {
    const result = nudged(state, frames, fps, seconds)
    setState(result.state)
    if (result.time !== null) onCommit(result.time)
  }

  return (
    <label class="tc-field">
      <span class="tc-field-label">{label}</span>
      <input
        data-testid={id}
        class={state.invalid ? 'tc-field-input invalid' : 'tc-field-input'}
        value={state.text}
        disabled={disabled}
        aria-invalid={state.invalid}
        spellcheck={false}
        title={FORMATS}
        onInput={(event) => setState(retyped(state, (event.target as HTMLInputElement).value))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
            // The entry is over, so the box gives the focus back: the editor turns its whole
            // keyboard off while a field is focused (state/keys.ts), and a hand that
            // types a timecode and then presses I means the command, not the letter. The blur
            // that follows commits once more, and harmlessly: it runs in this same handler, before
            // Preact has rendered anything, so it sees the same `state.text` and the same
            // `seconds` and works out the same number — which the reducer answers by identity and
            // the history ignores.
            ;(event.target as HTMLInputElement).blur()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setState(fieldOf(seconds, fps))
            ;(event.target as HTMLInputElement).blur()
            return
          }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            // The arrows belong to the box while it has the focus; the editor's own layout is off
            // wherever a text field is focused (state/keys.ts), so nothing else is listening.
            event.preventDefault()
            const size = event.shiftKey ? Math.max(1, Math.round(fps)) : 1
            nudge(event.key === 'ArrowUp' ? size : -size)
          }
        }}
      />
    </label>
  )
}
