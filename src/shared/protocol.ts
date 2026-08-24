/** Path to the bridge page inside the extension package. */
export const BRIDGE_PATH = 'bridge/bridge.html'

export type PageToBridge =
  | { type: 'tc:append'; sourceId: string; bufferId: string; mime: string; bytes: ArrayBuffer }
  /** objectUrl ties a MediaSource to a particular <video> on the page */
  | { type: 'tc:source'; sourceId: string; objectUrl: string }
  /**
   * A MediaSource built inside a worker — twitch, live and VOD. It has no address at all: what
   * reaches the page is a handle, and the element playing it is named by SOURCE_EVENT instead.
   * The announcement still has to be made, or the watcher would never hear of the stream and
   * would leave it recording with no verdict ever spoken about it.
   */
  | { type: 'tc:worker'; sourceId: string }
  /**
   * How long the whole video is, in seconds, as the page itself stated it on its MediaSource.
   *
   * The third component of the merge key (§6.1). What the page states out of its manifest, and
   * never what the browser works out for itself: with the duration left unset MSE grows it to the
   * end of whatever has been buffered, and a number that climbs with every segment would move a
   * session to a new key on every poll.
   *
   * It is what tells two videos of a feed apart where the address cannot — measured on
   * tiktok.com/foryou, whose address does not change through a whole scroll.
   */
  | { type: 'tc:duration'; sourceId: string; seconds: number }

/**
 * How the main world tells the isolated one which stream an element is playing.
 *
 * Only for streams that come out of a worker: those have no address for the watcher to find them
 * by, and `video.srcObject` holds a handle rather than a blob address. The two worlds share the
 * DOM and nothing else — a property set on the element in one is invisible in the other — so the
 * word is passed as an event, with the identifier of the stream in `detail` and the element in
 * `composedPath()[0]`, which is the element itself even inside an open shadow tree.
 *
 * An empty `detail` is the other half of the message: an element is playing a stream out of a
 * worker and the hook cannot name it, which is what a worker it was not allowed to wrap looks
 * like from the outside.
 */
export const SOURCE_EVENT = 'tailcut:source'

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
 * What the bridge answers a list request with: everything the popup draws its page from.
 *
 * The sessions alone are not the whole answer, because "no sessions" has three meanings and they
 * are not the same news. Usually it means the page has nothing worth recording on it. On a page
 * whose player lives in a worker the extension was not allowed to reach, it means the recording
 * never started at all. On a page playing protected media it means the recording is refused and
 * always will be — and the popup must say which of the three it is looking at.
 */
export interface SessionList {
  sessions: SessionSummary[]
  /**
   * This page plays media that is encrypted, and nothing of it may be recorded.
   *
   * Set when protection was found in the material itself — in the boxes of a segment, or by a
   * media element firing `encrypted` over what it was being fed. Everything gathered before that
   * moment is dropped and nothing more is taken in (see SessionStore.refuseEncrypted), so this
   * never arrives beside a session; it is the reason there is none, and the popup says so in
   * words instead of showing the emptiness of a page with no video on it.
   */
  encrypted?: boolean
  /**
   * This page holds a player tailcut cannot reach.
   *
   * Set when an element is playing a MediaSourceHandle whose worker was never wrapped (see
   * src/page/worker-hook.ts): the material of such a player never passes through the extension,
   * and no later moment will change that. It says nothing about the sessions beside it — a page
   * can have both, and then the popup shows what was recorded and says what was not.
   */
  unreachable?: boolean
}

/**
 * Everything the bridge sends outwards and nothing besides. There are two channels and the union
 * describes both: the handshake goes to the window that inserted the bridge, and the answer to a
 * list request only into the MessageChannel port that came with it. A message not described here
 * is an undeclared part of the protocol: the receiver does not know of it, and the next reader of
 * the code learns of it from the bridge implementation rather than from the type.
 */
export type BridgeToPage = { type: 'tc:ready' } | SessionList

/**
 * Requests to the content script of a tab: sent by the popup and by the service worker through
 * `chrome.tabs.sendMessage`. The session registry lives in the bridge frame, which an extension
 * message does not reach on its own — the content script passes the request on and returns the
 * answer.
 */
export type ExtensionToTab = { type: 'tc:list' } | { type: 'tc:save'; key: string }

/**
 * Why a save produced no file.
 *
 * Named rather than left as a plain `false`, because the popup has to say something to the user
 * and the three are not the same news. Answered as one, the popup blamed the session for being
 * gone whatever had happened — measured on a title carrying U+200E LEFT-TO-RIGHT MARK, where
 * Chrome refused the file name and the user was told the recording had disappeared from a page
 * that was still recording it.
 *
 * - `gone` — nothing in the registry under that key: evicted by triage, or lost with the page
 *   under the open popup.
 * - `empty` — the session is there and holds nothing a file could be cut from yet: a stream that
 *   opened and loaded nothing, or a second buffer that has not brought its first fragment.
 * - `refused` — Chrome would not start the download. What it said about it is in `detail`.
 */
export type SaveFailure = 'gone' | 'empty' | 'refused'

/** What the bridge answers tc:save with. */
export interface SaveResult {
  ok: boolean
  /** Absent when the file was saved. */
  reason?: SaveFailure
  /** What Chrome answered when it refused; absent when it said nothing, and on the other two. */
  detail?: string
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
  return (
    type === 'tc:append' ||
    type === 'tc:source' ||
    type === 'tc:worker' ||
    type === 'tc:duration'
  )
}

export function isExtensionToTab(value: unknown): value is ExtensionToTab {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; key?: unknown }
  if (message.type === 'tc:list') return true
  return message.type === 'tc:save' && typeof message.key === 'string'
}
