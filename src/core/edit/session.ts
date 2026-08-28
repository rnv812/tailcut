import { reduce, undoModeOf, type Action } from './actions'
import type { EditContext } from './context'
import { commit, history, redo, undo, type History } from './history'
import { withDoc, type Doc, type Project } from './project'

/** The project and its history, the pair a store holds and nothing else. */
export interface EditSession {
  project: Project
  history: History<Doc>
}

export type SessionAction = Action | { type: 'undo' } | { type: 'redo' }

export function newSession(project: Project): EditSession {
  return { project, history: history(project.doc) }
}

/**
 * One turn of the editor: reduce, decide what it did to the history, write it down.
 *
 * Undo and redo live here rather than in `reduce` because they are about the history and not
 * about the project — and because the document they restore has to be put back through `withDoc`,
 * which is the only place that can repair a selection pointing at a clip that no longer exists.
 */
export function step(session: EditSession, action: SessionAction, ctx: EditContext): EditSession {
  if (action.type === 'undo' || action.type === 'redo') {
    const next = action.type === 'undo' ? undo(session.history) : redo(session.history)
    if (next === session.history) return session
    return { project: withDoc(session.project, next.present), history: next }
  }

  const project = reduce(session.project, action, ctx)
  const nextHistory = commit(session.history, project.doc, undoModeOf(action))
  if (project === session.project && nextHistory === session.history) return session
  return { project, history: nextHistory }
}
