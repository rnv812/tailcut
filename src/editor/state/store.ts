import { useLayoutEffect, useState } from 'preact/hooks'
import type { EditContext } from '../../core/edit/context'
import { step, type EditSession, type SessionAction } from '../../core/edit/session'

export interface EditorStore {
  get(): EditSession
  dispatch(action: SessionAction): void
  subscribe(listener: () => void): () => void
}

/**
 * The one changeable thing in the tab.
 *
 * Every part of the editor writes through `dispatch` and reads through a subscription: the
 * keyboard, the pointer on the canvas and the inspector all send the same actions, so a clip
 * trimmed by hand and a clip trimmed by number cannot come out different. The context is handed
 * in once and never changes for the life of the store — a new representation is a new store.
 */
export function createStore(initial: EditSession, ctx: EditContext): EditorStore {
  let session = initial
  const listeners = new Set<() => void>()

  return {
    get: () => session,

    dispatch(action: SessionAction): void {
      const next = step(session, action, ctx)
      // `step` hands the session itself back when nothing changed. A key that does nothing must
      // not repaint the timeline, and this is the single place that is decided.
      if (next === session) return

      session = next
      for (const listener of listeners) listener()
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function useSession(store: EditorStore): EditSession {
  const [session, setSession] = useState(store.get())
  // A child measures the timeline in a passive mount effect. Subscribe during layout so that
  // first measurement cannot update the store before this component starts listening.
  useLayoutEffect(() => store.subscribe(() => setSession(store.get())), [store])
  return session
}
