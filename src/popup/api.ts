import {
  MAIN_FRAME,
  editInFrame,
  listTabSessions,
  saveInFrame,
  type FramedSession,
} from '../shared/frames'
import { editorUrl } from '../shared/protocol'
import type {
  EditResult,
  Omission,
  SaveFailure,
  SaveResult,
  SessionList,
  SessionSummary,
} from '../shared/protocol'

// The answer is described by the protocol and not by the popup: let the two descriptions drift
// apart and the popup would read fields the bridge does not send, showing undefined in silence.
export type { EditResult, Omission, SaveFailure, SaveResult, SessionList, SessionSummary }

/** The reasons the bridge may give; a reply naming anything else is a refusal without a reason. */
const FAILURES: SaveFailure[] = ['gone', 'empty', 'refused']

/**
 * A refusal in a shape the popup can act on, out of whatever the tab actually answered.
 *
 * The reply crosses an extension message and is not typed on arrival: a bridge of another version,
 * or a tab that answered nothing at all, has to come out as a refusal the popup can still show —
 * with no reason to it rather than with a made-up one.
 */
function refusalOf(reply: SaveResult | undefined): SaveResult {
  const reason = reply?.reason
  if (!reason || !FAILURES.includes(reason)) return { ok: false }

  const detail = reply?.detail
  return typeof detail === 'string' && detail ? { ok: false, reason, detail } : { ok: false, reason }
}

/** What a tab that cannot answer amounts to: no sessions, and nothing said about the page. */
const NOTHING: SessionList = { sessions: [] }

/**
 * The tab the popup took its list from. Remembered because the session to save has to be exactly
 * the one the popup is showing: the active tab does change under an open popup, and "Save all"
 * would go to the wrong place.
 */
let boundTabId: number | undefined

/**
 * The sessions of the last list, each with the frame it came out of.
 *
 * A session is material, and material never leaves the frame it was gathered in: the registry of
 * an embedded player is inside the embed. The popup asks every frame for its list and has to
 * remember which answered what, or "Save all" would go knocking at the top frame for a session
 * that was never there.
 */
let listed: FramedSession[] = []

async function targetTabId(): Promise<number | undefined> {
  if (boundTabId !== undefined) return boundTabId

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  boundTabId = tab?.id
  return boundTabId
}

/**
 * Asks the tab what it has gathered, and what it could not. The popup only shows the answer:
 * there is no parsing and no assembly here — it is obliged to open instantly.
 *
 * Every frame of the tab is asked, not the top one alone. A page that carries an embedded player
 * rather than one of its own — an article, a documentation page, a landing page — records into
 * the registry of the frame that holds the player, and the top frame knows nothing about it.
 */
export async function listSessions(): Promise<SessionList> {
  const tabId = await targetTabId()
  if (tabId === undefined) return NOTHING

  // A tab with no content script in any frame — chrome://, the extension store, a tab older than
  // the installation — comes back as an empty answer rather than as an error: there is nothing to
  // record there, and nothing is known about the page either.
  const answer = await listTabSessions(tabId)

  // Which frame answered what. The popup shows the sessions and addresses them by key; the save
  // has to find the registry the bytes are actually in.
  listed = answer.sessions
  return answer
}

/**
 * Asks the tab to assemble what it has gathered into a file. The building and the download happen
 * in the bridge, and its verdict comes back here.
 *
 * The answer is what the caller acts on: the bridge refuses when the session is gone — evicted by
 * triage, or lost to a reload under the open popup — when there is nothing in it to cut yet, and
 * when Chrome refuses the download. Left unread, a refusal is indistinguishable from a slow save:
 * no file appears and nothing is said. Read without its reason, it is worse than that — the popup
 * used to answer a name Chrome would not take by telling the user the recording was gone.
 */
export async function saveAll(key: string): Promise<SaveResult> {
  const tabId = await targetTabId()
  if (tabId === undefined) return { ok: false }

  // Back to the frame the session was listed from: its bytes are there and nowhere else. A key
  // the popup never listed can only be asked of the main frame, which will answer that it knows
  // of no such session — which is the truth about it.
  const frameId = listed.find((session) => session.key === key)?.frameId ?? MAIN_FRAME

  try {
    const result = await saveInFrame(tabId, frameId, key)
    // Chrome answers undefined when the channel closed with nobody answering: the tab was closed
    // or taken off the page while the file was being built. Nothing was saved.
    return result?.ok === true ? { ok: true } : refusalOf(result)
  } catch {
    // A page with no content script, or a tab that is gone: an unhandled rejection would reach no
    // further than the console of the popup.
    return { ok: false }
  }
}

/**
 * Asks the tab to freeze the session and write it out. What comes back is the name of the
 * snapshot; the editor is opened by the popup, because a tab is opened from the extension and
 * the bridge lives on the page.
 *
 * Addressed to the frame the session was listed from, exactly as a save is: the material of an
 * embedded player is inside the embed, and the freeze has to be made where the bytes are.
 */
export async function editSession(key: string): Promise<EditResult> {
  const tabId = await targetTabId()
  if (tabId === undefined) return { ok: false, reason: 'gone' }

  const frameId = listed.find((session) => session.key === key)?.frameId ?? MAIN_FRAME

  try {
    const result = await editInFrame(tabId, frameId, key)
    if (result?.ok !== true || typeof result.snapshotId !== 'string') {
      return { ok: false, reason: result?.reason ?? 'gone' }
    }
    return result
  } catch {
    // A page with no content script, or a tab that has gone away under the open popup.
    return { ok: false, reason: 'gone' }
  }
}

/** Opens the editor over one snapshot in a tab of its own. */
export async function openEditor(snapshotId: string): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL(editorUrl(snapshotId)) })
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The page address in a form fit for the line under the title; an unreadable one — empty. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
