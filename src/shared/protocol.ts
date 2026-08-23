/** Path to the bridge page inside the extension package. */
export const BRIDGE_PATH = 'bridge/bridge.html'

export type PageToBridge =
  | { type: 'tc:append'; sourceId: string; bufferId: string; mime: string; bytes: ArrayBuffer }
  /** objectUrl ties a MediaSource to a particular <video> on the page */
  | { type: 'tc:source'; sourceId: string; objectUrl: string }
  | { type: 'tc:drm'; sourceId: string }

/**
 * Why a saved file will hold less than the session does.
 *
 * A session gathers everything the page played; a file is one continuous clip of one quality
 * with one stream per kind, and the difference between the two has to be said out loud. The
 * length in the summary already counts only what will be written — this says what was left
 * out of that count, so that a shorter number than the user expected has a reason beside it.
 *
 * - `track` — a stream the ingest boundary refused: its container or codec cannot be written
 *   out, nothing of it was ever collected, and the file is short of a whole kind of media.
 * - `rendition` — the picture or the sound was recorded at more than one quality (§6.2), and
 *   one file carries one of them.
 * - `gap` — the material is not continuous, and a save takes the longest unbroken stretch.
 */
export type Omission = 'track' | 'rendition' | 'gap'

/**
 * Summary of one session of the registry: this is what the bridge answers a list request with,
 * and what the popup signs a row of its list with. The key is the handle a session is asked for
 * by; it is not the address of the page.
 *
 * Every number here describes the file that "Save all" would write and not the material the
 * session holds — the two differ, and the popup is the place a difference becomes a promise.
 */
export interface SessionSummary {
  key: string
  url: string
  title: string
  /** Length of the clip a save would write, in seconds. */
  duration: number
  /** Weight of the media data that would go into it. */
  bytes: number
  /** What the file will not hold of what was recorded; absent when it holds all of it. */
  omits?: Omission
}

/**
 * Everything the bridge sends outwards and nothing besides. There are two channels and the union
 * describes both: the handshake goes to the window that inserted the bridge, and the list of
 * sessions only into the MessageChannel port that came with the request. A message not described
 * here is an undeclared part of the protocol: the receiver does not know of it, and the next
 * reader of the code learns of it from the bridge implementation rather than from the type.
 */
export type BridgeToPage = { type: 'tc:ready' } | SessionSummary[]

/**
 * Requests to the content script of a tab: sent by the popup and by the service worker through
 * `chrome.tabs.sendMessage`. The session registry lives in the bridge frame, which an extension
 * message does not reach on its own — the content script passes the request on and returns the
 * answer.
 */
export type ExtensionToTab = { type: 'tc:list' } | { type: 'tc:save'; key: string }

/** What the bridge answers tc:save with. */
export interface SaveResult {
  ok: boolean
}

/**
 * Addressee of the extension's requests — the main frame of the tab. Without it the message goes
 * to every frame at once (content scripts are declared with all_frames), each answers with its
 * own registry, and the popup gets the answer of whoever was first: on a page with advertising
 * frames that is anybody's empty list. A player embedded in a frame is invisible to the popup at
 * this stage — its sessions live in the registry of its own frame.
 */
export const TOP_FRAME = { frameId: 0 } as const

export function isPageToBridge(value: unknown): value is PageToBridge {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return type === 'tc:append' || type === 'tc:source' || type === 'tc:drm'
}

export function isExtensionToTab(value: unknown): value is ExtensionToTab {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; key?: unknown }
  if (message.type === 'tc:list') return true
  return message.type === 'tc:save' && typeof message.key === 'string'
}
