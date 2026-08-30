import {
  MAIN_FRAME,
  editInFrame,
  listTabSessions,
  pauseInFrame,
  saveInFrame,
  type FramedSession,
} from '../shared/frames'
import { hostOf } from '../shared/format'
import { editorUrl, historyUrl } from '../shared/protocol'
import type {
  EditResult,
  Omission,
  SaveFailure,
  SaveResult,
  SessionList,
  SessionSummary,
} from '../shared/protocol'
// The index of what is on disk, read here and nowhere else in the popup: the markup is handed
// rows, and what a row is made of is this file's business.
import { listSessions as listHistory, readTotals, setDeleted, setPinned } from '../shared/history-db'
import { siteAllows } from '../shared/settings'
import { readSettings, writeSettings } from '../shared/settings-store'

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

/**
 * Where that tab stands; empty until it has been asked, and on a tab that answered no address.
 *
 * Read off the same answer as the identifier and not asked for separately: the popup is bound to
 * one tab for as long as it is open, and a second query could come back about another.
 */
let boundUrl = ''

async function targetTabId(): Promise<number | undefined> {
  if (boundTabId !== undefined) return boundTabId

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  boundTabId = tab?.id
  boundUrl = tab?.url ?? ''
  return boundTabId
}

/**
 * The address of the page the popup was opened over.
 *
 * The page's own and not a session's. A session carries the address of the frame it was gathered
 * in, which for an embedded player is the site the video comes from rather than the site the user
 * is on — and the switch below the history is about the site the user is on. Empty where Chrome
 * says nothing: a tab of another extension, a page opened before the installation.
 */
export async function pageUrl(): Promise<string> {
  await targetTabId()
  return boundUrl
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

/** One recording of the history, as a row of the popup needs it. */
export interface HistoryRow {
  id: string
  key: string
  title: string
  url: string
  seconds: number
  bytes: number
  lastSeenAt: number
  pinned: boolean
}

/**
 * What is on disk, newest first.
 *
 * Straight out of the index, from the popup itself: the popup is a document of the extension
 * origin and the index is one IndexedDB read away. Nothing is computed and nothing is walked;
 * that keeps the popup opening instantly now that there is a disk to be tempted by.
 */
export async function historyRows(limit = 20): Promise<HistoryRow[]> {
  try {
    const sessions = await listHistory(limit)
    return sessions.map((session) => ({
      id: session.id,
      key: session.key,
      title: session.title,
      url: session.url,
      seconds: session.seconds,
      bytes: session.bytes,
      lastSeenAt: session.lastSeenAt,
      pinned: session.pinned,
    }))
  } catch {
    // No index yet, or a store the browser would not open. An empty history is what nothing
    // looks like, and it is not worth a message beside the recording of this page.
    return []
  }
}

export const pinHistory = (id: string, pinned: boolean) => setPinned(id, pinned)

/**
 * Marks a session deleted. The files go with the sweeper, half a minute later.
 *
 * Marked rather than removed because deletion offers undo in a toast instead of
 * a confirmation dialogue: the row has to be out of every list at once and recoverable for as
 * long as the toast can be on screen. Closing the popup settles it — the user deleted it — and
 * the sweeper does the rest.
 */
export const deleteHistory = (id: string) => setDeleted(id, Date.now())
export const undoDelete = (id: string) => setDeleted(id, 0)

/**
 * Occupied volume, as the index has it. Never navigator.storage.estimate(): the index tracks the
 * extension's own files while the browser estimate covers unrelated origin data.
 *
 * `full` distinguishes a browser refusal from reaching the configured limit: the browser may
 * refuse a write below our own ceiling, and when it has, the popup says so instead of showing a
 * number that looks like everything is fine while the writer retries every thirty seconds.
 */
export async function storageInUse(): Promise<{ bytes: number; full: boolean }> {
  try {
    const totals = await readTotals()
    return { bytes: totals.bytes, full: totals.fullAt > 0 }
  } catch {
    return { bytes: 0, full: false }
  }
}

/** Opens the editor over a recording of the history, in a tab of its own. */
export async function openHistoryEditor(id: string): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL(historyUrl(id)) })
}

/** What the switch under the history stands at, and whether it decides anything at all. */
export interface SiteSwitch {
  /** Is this site recorded, by the settings as they stand? */
  recorded: boolean
  /**
   * Do the settings record nothing anywhere?
   *
   * `Off` is not "this site is not recorded", and unticked the two look the same: neither list
   * decides anything while it holds, so the switch is shown shut with the reason beside it rather
   * than as a live control that writes a list nothing reads.
   */
  off: boolean
}

/**
 * The state of the switch under the history, out of one read of the settings.
 *
 * One read and not two, because it is one answer: a second read could come back from between two
 * writes and describe a switch half in one mode and half in another.
 */
export async function siteSwitch(url: string): Promise<SiteSwitch> {
  const settings = await readSettings()
  return { recorded: siteAllows(settings, url), off: settings.recording.mode === 'off' }
}

/**
 * Switches recording on or off for the site of this address.
 *
 * Writes the deny list in `All sites` mode and the allow list in `Allowlist` mode, which is the
 * only reading of "record here" that means the same thing in both. In `Off` mode there is nothing
 * to switch — the popup shows the switch shut and says why, and this is the same refusal one
 * layer down: a host put on a list nothing reads is a setting the user never made, and the
 * settings page shows it to them afterwards.
 */
export async function setSiteRecorded(url: string, on: boolean): Promise<void> {
  const host = hostOf(url)
  if (!host) return
  if ((await readSettings()).recording.mode === 'off') return

  await writeSettings((current) => {
    const recording = { ...current.recording }
    if (recording.mode === 'allowlist') {
      recording.allow = on
        ? [...recording.allow.filter((one) => one !== host), host]
        : recording.allow.filter((one) => one !== host)
    } else {
      recording.deny = on
        ? recording.deny.filter((one) => one !== host)
        : [...recording.deny.filter((one) => one !== host), host]
    }
    return { ...current, recording }
  })
}

/**
 * Stops the recording in this tab until the page is reloaded.
 *
 * Nothing is stored: it is about this page and this visit, and a setting that outlived the tab it
 * was meant for would be a switch the user could not find again. The bridge of every frame is
 * told, because the player may be in an embed.
 */
export async function pauseThisTab(on: boolean): Promise<void> {
  const tabId = await targetTabId()
  if (tabId === undefined) return
  await pauseInFrame(tabId, on).catch(() => undefined)
}

// One place for the numbers people read: the popup and the settings page show the same ones, and
// two copies of "how big is a megabyte" is how they come to disagree. `hostOf` is there for the
// same reason and came back here as a re-export, because the popup has always asked api for it.
export { formatBytes, formatDuration, formatWhen, hostOf } from '../shared/format'
