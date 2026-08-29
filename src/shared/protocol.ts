/** Path to the bridge page inside the extension package. */
export const BRIDGE_PATH = 'bridge/bridge.html'

/** Path to the editor page inside the extension package. */
export const EDITOR_PATH = 'editor/editor.html'

/** Directory of OPFS the snapshots live in. Stage 3 adds `sessions/` beside it. */
export const SNAPSHOT_DIR = 'snapshots'

/**
 * Name of a snapshot file. Never derived from the session key: that key is
 * `url|codecs|duration` and carries '/', ':' and '|', none of which belong in a file name.
 */
export function snapshotFileName(id: string): string {
  return `${id}.tcs`
}

export function snapshotPath(id: string): string {
  return `${SNAPSHOT_DIR}/${snapshotFileName(id)}`
}

/** Address of the editor for one snapshot, relative to the root of the extension. */
export function editorUrl(id: string): string {
  return `${EDITOR_PATH}?s=${encodeURIComponent(id)}`
}

/**
 * Is this a name the extension itself minted?
 *
 * The identifier travels through the address bar of the editor tab, and from there straight into
 * a file name in OPFS. Anything but the shape of a randomUUID is refused before it gets there:
 * a name with a slash in it would address a directory of its own, and one with dots a directory
 * upwards.
 */
export function isSnapshotId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

/**
 * What the bridge answers tc:edit with. A refusal says which of the four it is, because they ask
 * four different things of the user: `gone` — the session is no longer on the page, `empty` — it
 * holds nothing to cut yet, `unread` — its material is a file on somebody's server that could not
 * be fetched, `storage` — the browser would not take the snapshot.
 *
 * `unread` belongs to the one kind of session whose material is not in the frame already. A
 * capture holds its bytes; an ordinary file is copied into the snapshot at the moment of the
 * freeze (src/bridge/write.ts), and that read can be refused by an address that has expired or a
 * host that stopped answering. Told apart from `storage` because they blame different machines,
 * and from `empty` because the recording is there and it was the fetching that failed.
 */
export interface EditResult {
  ok: boolean
  snapshotId?: string
  reason?: 'gone' | 'empty' | 'unread' | 'storage'
}

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
   * A media element of the page is playing an ordinary file: see PlainSource.
   *
   * Repeated as what the element knows changes — a length that was NaN until the metadata
   * arrived, a buffered range that grows while the file downloads — and silent while it does not.
   */
  | ({ type: 'tc:plain' } & PlainSource)
  /**
   * An `<audio>` of the page is playing a soundtrack of its own: see SoundSource.
   *
   * Said on the same terms as tc:plain — when what the element knows changes, and never while it
   * does not — and it is never a recording by itself. A soundtrack becomes anything at all only
   * beside a picture that has no sound of its own, and what comes of the pairing is settled by
   * the registry (src/bridge/session-store.ts) and described over `SoundApart`.
   */
  | ({ type: 'tc:sound' } & SoundSource)

/**
 * A media element playing an ordinary file: `currentSrc` is an http(s) address rather than a blob
 * one, and not a byte of the material passes through MediaSource.
 *
 * Eighteen of the twenty-one live pages measured where video actually arrived deliver it this way,
 * and it is the norm everywhere outside the video platforms — articles, documentation, landing
 * pages, imageboards, file hosts. Nothing of it can be captured as it plays, because there is
 * nothing to capture: the browser fetches the file itself and the extension never sees the bytes.
 * What the page can say about it is said here, and the bytes are fetched again afterwards, from
 * the extension origin (src/bridge/loader.ts).
 *
 * A plain source is filtered exactly like a stream out of MediaSource: the verdict about it
 * travels the ordinary `tc:verdict` road under the identifier below. Ten of those eighteen pages
 * held nothing but muted looping previews and three-second animations, and they must keep being
 * refused — that filter is the whole reason this carries no material of its own.
 */
export interface PlainSource {
  /**
   * Identity of the file inside the page: the address with a prefix that keeps it apart from the
   * identifiers the hook hands out for streams. It is the address and not a counter because two
   * elements playing one file are playing one file, and because an element re-created by the page
   * has to land on what was already known about what it plays.
   */
  sourceId: string
  /** The address the element resolved, absolute, exactly as it will have to be fetched. */
  url: string
  /**
   * How long the whole file is, in seconds, as the element states it; zero while it states
   * nothing — before the metadata has arrived it is NaN, and on a stream of no stated end it is
   * Infinity, and neither is a length.
   */
  durationSeconds: number
  /**
   * What the element holds right now, in seconds of media time: the pairs of `HTMLMediaElement.buffered`.
   *
   * The one thing the page knows that the file itself does not say — which stretch the user has
   * actually got. It says nothing about which bytes those are; the map from seconds to bytes is
   * read out of the container once the loader has it.
   */
  buffered: Array<[number, number]>
}

/**
 * An `<audio>` element playing a soundtrack of its own, beside a picture that has none.
 *
 * The other half of the one page shape tailcut could not deliver (§5.6): the picture in a
 * `<video src>` with no audio track in it, the sound in a separate `<audio src>` seven times as
 * long, both looping on cycles of their own. Measured on coub, one site of the seven surveyed.
 *
 * It is reported and never judged. Triage weighs an element by how wide it is on the screen and
 * how long it has been watched, and an `<audio>` has no width at all — so a soundtrack is never a
 * session, never a row in the popup and never a saved file by itself. A file of somebody's music
 * with no picture is not a clip of anything, and offering one would make tailcut a music
 * downloader, which §2 puts out of scope. What it can be is the sound of a picture beside it, and
 * that is the whole of what this message is for.
 */
export interface SoundSource {
  /** Identity of the soundtrack inside the page: its address, marked off as a sound. */
  sourceId: string
  /** The address the element resolved, absolute, exactly as it will have to be fetched. */
  url: string
  /** How long the whole track is as the element states it; zero while it states nothing. */
  durationSeconds: number
  /** What the element holds right now, in seconds: the pairs of `HTMLMediaElement.buffered`. */
  buffered: Array<[number, number]>
  /**
   * The element is playing right now.
   *
   * What makes a soundtrack a soundtrack rather than a sound effect waiting for a click. A page
   * holds `<audio>` elements that never play — a notification, a hover sound — and one of those
   * says nothing about the picture beside it. Only a track the page is actually playing is
   * offered to a picture, and only a track that is playing tells the filter that a silent looping
   * picture is not a banner (`VideoSignals.soundApart`).
   */
  playing: boolean
}

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
 * - `sound` — this page plays its sound in an element of its own beside a picture that has none
 *   (§5.6), and that soundtrack could not be used: unreadable, or two of them playing at once
 *   with nothing to say which belongs to the picture. The clip is silent, which is the one thing
 *   the popup must not leave the user to discover in a player.
 * - `soundShort` — the same page, paired: the soundtrack was taken and it runs out before the
 *   picture does, so the end of the clip is silent. Nothing is looped round to cover it — the
 *   page played what it played.
 * - `rendition` — the picture or the sound was recorded at more than one quality (§6.2), and
 *   one file carries one of them.
 * - `alternate` — the material holds more than one track of a kind, and one file carries one of
 *   each. Kept apart from `rendition` because the two are different news: a rendition is the
 *   same material over again at another quality, an alternate is other material altogether —
 *   a dub beside the original, a commentary beside the film. Measured on w3schools' mov_bbb.mp4,
 *   one picture and two soundtracks, which the popup called "recorded at more than one quality".
 * - `gap` — the material is not continuous, and a save takes the longest unbroken stretch.
 */
export type Omission = 'track' | 'sound' | 'rendition' | 'alternate' | 'gap' | 'soundShort'

/**
 * Summary of one session of the registry: this is what the bridge answers a list request with,
 * and what the popup signs a row of its list with. The key is the handle a session is asked for
 * by; it is not the address of the page.
 *
 * Every number here describes the file that "Save all" would write and not the material the
 * session holds — the two differ, and the popup is the place a difference becomes a promise.
 *
 * The address and the title are the frame's own, even when that frame is an embed inside somebody
 * else's page, and the title of the top page is not borrowed for it. Three reasons, in the order
 * they were weighed. The file is named after this title in the bridge, so a borrowed one would be
 * a name the popup promises and the file does not carry. A page with three embeds has one top
 * title and three players, and three rows reading "Some article — a blog" is a list the user
 * cannot pick out of. And the address of the frame is where the material actually came from: for
 * an embedded player it names the site the video is from, which is the thing worth recognising
 * about it. The cost is a frame that never titled itself, which the popup shows as "Untitled"
 * over the host it came from — thin, but true.
 */
export interface SessionSummary {
  key: string
  url: string
  title: string
  /**
   * When material last arrived in this session, by the clock of the page (Date.now()).
   *
   * A registry answers newest first on its own, but a tab holds a registry per frame and the
   * popup shows one list. Without a clock the frames could only be merged in the order they were
   * asked in, and the session at the top — the one the popup opens on and calls the one being
   * watched right now — would be whichever frame the page happened to declare first.
   */
  lastAt: number
  /** Length of the clip a save would write, in seconds. */
  duration: number
  /** Weight of the media data that would go into it. */
  bytes: number
  /** What the file will not hold of what was recorded; absent when it holds all of it. */
  omits?: Omission
  /**
   * The sound of this clip comes from a separate track the page was playing beside the picture.
   *
   * Not an omission — nothing is missing, and the number above already counts it — but it is not
   * silence either, and the user is owed the sentence. The file will carry a soundtrack that is
   * not the video's own sound: it is a thing playing underneath on a cycle of its own, taken from
   * its start, which is where the page itself pairs the two. See `SoundApart` for why that
   * pairing and not another.
   */
  pairedSound?: boolean
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
  /**
   * A file this page was watching could not be read.
   *
   * Set when triage promoted an ordinary file — somebody really was watching it — and the tables
   * of it could not be reached: a container with no movie box in it, an address that has expired,
   * a host that will not answer a ranged read. Told apart from the emptiness of a page with no
   * video, because here a video was watched and there is nothing to offer for it. Measured live
   * on an imageboard thread, where the material is webm.
   *
   * Like `unreachable`, it says nothing about the sessions beside it: a page can hold one file
   * that was read and another that was not.
   */
  unreadableFile?: boolean
}

/**
 * Nothing of this page will be kept, so nothing of it need be copied.
 *
 * The one word the registry sends back out to the world that does the copying. The hook in the
 * MAIN world knows nothing of sessions, verdicts or protection — that is the whole point of it,
 * and parsing on the synchronous path of a player is out of the question — so it goes on copying
 * every append and posting it here to be dropped. Measured on dash.js ClearKey: 53 messages and
 * 29.7 MB thrown away in forty seconds, and on Widevine 40 messages and 34.7 MB. The cost of
 * refusing equalled the cost of recording.
 *
 * Only one refusal may be sent this way, and it is the protected-media one (see
 * SessionStore.refuseEncrypted): it covers the whole page and it never turns. A triage rejection
 * must not travel here even though it looks alike. A rejection turns — a pause, a hidden tab, an
 * element off the screen are all rejections of §5.5 — and a hook that stopped copying mid-stream
 * would leave the reader on this side inside a segment with no way of finding its place again:
 * MSE hands a SourceBuffer a byte stream, not a list of segments, and the init that would explain
 * the next header went past in the first second of playback.
 *
 * It carries no identifier because it has nothing to address: the page is refused, all of it.
 */
export interface PageRefused {
  type: 'tc:refused'
}

/**
 * This frame has something recorded in it.
 *
 * Said by the bridge to the document that inserted it, and passed on from there to the service
 * worker (`TabToExtension` below). The badge is the whole reason it exists.
 *
 * The badge has to count what a tab holds, and a tab holds a registry per frame, so it used to
 * enumerate the frames of the active tab and ask every one of them, every ten seconds. Measured
 * on a news page carrying 154 frames: 154 script injections and 154 messages per recount, 60 to
 * 90 ms of extension work every ten seconds, on a page with no video anywhere in it. The recount
 * costs what a page has recorded and not what it has frames, so the frames that recorded
 * something say so and the badge asks those.
 *
 * Repeated rather than said once: the service worker is not a place to keep anything, and one
 * that has been restarted knows nothing of what it was told before. It carries no number — the
 * badge asks for that — and no identity: the frame it came from is the frame the sender says it
 * came from, which no page can write for itself.
 */
export interface FrameRecording {
  type: 'tc:recording'
}

/**
 * Whether the hook in the MAIN world should copy anything at all.
 *
 * The recording mode of §9.4 (`All sites` / `Allowlist` / `Off`) and the two lists beside it,
 * decided by the bridge and carried across as the one bit the hook can act on. Off, the hook
 * stops copying: that is the whole of what turning recording off buys, and it cannot be bought
 * anywhere further downstream — a registry that dropped what it was given would still be paying
 * for a copy of every append.
 *
 * One bit and not the settings. The MAIN world is the page's own realm: everything that reaches
 * it, the page can read. Which domains a user has forbidden is a list of what they watch, and it
 * has no business there.
 *
 * It travels from the bridge rather than from the content script, although the content script is
 * the one holding chrome.storage. The bridge stands on the extension origin, which a page cannot
 * imitate, and the hook already refuses everything that does not (see PageRefused). Sent from the
 * content script it would be indistinguishable from a message the page sent itself — and a site
 * could switch its own recording off with one postMessage.
 *
 * Unlike the refusal, this one turns: it is said again whenever the settings change, and again
 * to a hook that has just started. What was recorded before it was switched off stays exactly
 * where it was (§7.2); nothing is erased by a switch.
 */
export interface RecordingSwitch {
  type: 'tc:record'
  on: boolean
}

/**
 * Everything the bridge sends outwards and nothing besides. There are two channels and the union
 * describes both: the handshake, the refusal, the recording switch and the word that this frame
 * is recording go to the window that inserted the bridge, and the answer to a list request only
 * into the MessageChannel port that came with it. A message not described here is an undeclared
 * part of the protocol: the receiver does not know of it, and the next reader of the code learns
 * of it from the bridge implementation rather than from the type.
 */
export type BridgeToPage =
  | { type: 'tc:ready' }
  | PageRefused
  | FrameRecording
  | RecordingSwitch
  | SessionList

/**
 * How the main world tells a message of the bridge from a message of the page.
 *
 * The bridge stands in a frame on the extension origin and posts to `window.parent`, which is the
 * page — and both worlds of that page hear it. The MAIN world has no `chrome.runtime` to check an
 * identity with, and it has to check something: a page may post whatever it likes into its own
 * window, and a refusal it could imitate would be a switch for turning the recording off. An
 * origin is the one thing it cannot imitate — no document of a site carries this scheme.
 */
export const EXTENSION_ORIGIN_PREFIX = 'chrome-extension://'

/**
 * Requests to the content script of a tab: sent by the popup and by the service worker through
 * `chrome.tabs.sendMessage`. The session registry lives in the bridge frame, which an extension
 * message does not reach on its own — the content script passes the request on and returns the
 * answer.
 *
 * A tab holds one of each per frame, so a request is addressed to a frame. The popup asks all of
 * them; the badge asks the main one and whichever have said they hold a recording (see
 * FrameRecording). Both roads are in src/shared/frames.ts.
 */
export type ExtensionToTab =
  | { type: 'tc:list' }
  | { type: 'tc:save'; key: string }
  | { type: 'tc:edit'; key: string }

/**
 * What the content script of a tab sends the service worker of its own accord.
 *
 * The one message that travels this way, and it travels because the alternative is polling: see
 * FrameRecording. Chrome signs it with the tab and the frame it came from — `sender.tab.id` and
 * `sender.frameId` — so nothing here has to name either, and a page cannot claim to be a frame it
 * is not.
 */
export type TabToExtension = FrameRecording

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

export function isPageToBridge(value: unknown): value is PageToBridge {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return (
    type === 'tc:append' ||
    type === 'tc:source' ||
    type === 'tc:worker' ||
    type === 'tc:duration' ||
    type === 'tc:plain' ||
    type === 'tc:sound'
  )
}

export function isTabToExtension(value: unknown): value is TabToExtension {
  if (typeof value !== 'object' || value === null) return false
  return (value as { type?: unknown }).type === 'tc:recording'
}

export function isExtensionToTab(value: unknown): value is ExtensionToTab {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; key?: unknown }
  if (message.type === 'tc:list') return true
  if (typeof message.key !== 'string') return false
  return message.type === 'tc:save' || message.type === 'tc:edit'
}
