import {
  TOP_FRAME,
  type ExtensionToTab,
  type Omission,
  type SaveResult,
  type SessionList,
  type SessionSummary,
} from '../shared/protocol'

// The answer is described by the protocol and not by the popup: let the two descriptions drift
// apart and the popup would read fields the bridge does not send, showing undefined in silence.
export type { Omission, SaveResult, SessionList, SessionSummary }

/** What a tab that cannot answer amounts to: no sessions, and nothing said about the page. */
const NOTHING: SessionList = { sessions: [] }

/**
 * The tab the popup took its list from. Remembered because the session to save has to be exactly
 * the one the popup is showing: the active tab does change under an open popup, and "Save all"
 * would go to the wrong place.
 */
let boundTabId: number | undefined

async function targetTabId(): Promise<number | undefined> {
  if (boundTabId !== undefined) return boundTabId

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  boundTabId = tab?.id
  return boundTabId
}

/**
 * Asks the tab what it has gathered, and what it could not. The popup only shows the answer:
 * there is no parsing and no assembly here — it is obliged to open instantly.
 */
export async function listSessions(): Promise<SessionList> {
  const tabId = await targetTabId()
  if (tabId === undefined) return NOTHING

  const request: ExtensionToTab = { type: 'tc:list' }
  try {
    const reply: SessionList | undefined = await chrome.tabs.sendMessage(tabId, request, TOP_FRAME)
    return reply ?? NOTHING
  } catch {
    // A page with no content script: chrome://, the extension store, a tab older than the
    // installation. An empty answer is honester here than an error — there is nothing to record,
    // and nothing is known about the page either.
    return NOTHING
  }
}

/**
 * Asks the tab to assemble what it has gathered into a file. The building and the download happen
 * in the bridge, and its verdict comes back here.
 *
 * The answer is what the caller acts on: the bridge refuses when the session is gone — evicted by
 * triage, or lost to a reload under the open popup — and when Chrome refuses the download. Left
 * unread, a refusal is indistinguishable from a slow save: no file appears and nothing is said.
 */
export async function saveAll(key: string): Promise<SaveResult> {
  const tabId = await targetTabId()
  if (tabId === undefined) return { ok: false }

  const request: ExtensionToTab = { type: 'tc:save', key }
  try {
    const result: SaveResult | undefined = await chrome.tabs.sendMessage(tabId, request, TOP_FRAME)
    // Chrome answers undefined when the channel closed with nobody answering: the tab was closed
    // or taken off the page while the file was being built. Nothing was saved.
    return { ok: result?.ok === true }
  } catch {
    // A page with no content script, or a tab that is gone: an unhandled rejection would reach no
    // further than the console of the popup.
    return { ok: false }
  }
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
