import { actionFor, type KeyPress } from '../../core/edit/keymap'
import type { SessionAction } from '../../core/edit/session'
import { shuttleKeyOf, type ShuttleKey } from '../../core/edit/shuttle'

export interface Transport {
  /** Space: run if stopped, stop if running. */
  toggle(): void
  /** Anything that moves the playhead by hand stops the picture first. */
  stop(): void
  shuttle(key: ShuttleKey): void
}

export interface KeyboardInput {
  dispatch(action: SessionAction): void
  transport: Transport
  onHelp(open: boolean): void
}

/** A box with a caret in it owns every key while it has the focus. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.tagName !== 'string') return false
  if (element.isContentEditable) return true
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)
}

const pressOf = (event: KeyboardEvent): KeyPress => ({
  key: event.key,
  shift: event.shiftKey,
  ctrl: event.ctrlKey,
  meta: event.metaKey,
  alt: event.altKey,
  repeat: event.repeat,
})

/**
 * The whole keyboard of the editor, in one listener.
 *
 * Two rules keep it out of the browser's way, and both are visible in the code rather than in a
 * list of exceptions. A press is taken away from the page only after it has done something —
 * so F5 reloads, Ctrl+F finds and Tab walks the focus, because the keymap answers null to all of
 * them. And a focused text box switches the layout off outright, so that typing a name is typing
 * a name and not a series of commands.
 */
export function attachKeys(on: Window, input: KeyboardInput): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return

    const press = pressOf(event)

    if (!press.ctrl && !press.meta && !press.alt) {
      if (press.key === '?') {
        if (!press.repeat) input.onHelp(true)
        event.preventDefault()
        return
      }

      if (press.key === 'Escape') {
        // Answered, not taken: Escape leaves full screen and closes the browser's own things.
        input.onHelp(false)
        return
      }

      if (press.key === ' ') {
        if (!press.repeat) input.transport.toggle()
        // Space scrolls a page by default, and the editor is a page.
        event.preventDefault()
        return
      }

      const shuttle = shuttleKeyOf(press)
      if (shuttle) {
        if (!press.repeat) input.transport.shuttle(shuttle)
        event.preventDefault()
        return
      }
    }

    const action = actionFor(press)
    if (!action) return

    event.preventDefault()
    if (action.type === 'step' || action.type === 'skip') input.transport.stop()
    input.dispatch(action)
  }

  on.addEventListener('keydown', onKey)
  return () => on.removeEventListener('keydown', onKey)
}
