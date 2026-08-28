import {
  isPageToBridge,
  type BridgeToPage,
  type SaveResult,
  type SessionList,
  type SessionSummary,
} from '../shared/protocol'
import { openPlainFile } from './loader'
import { SessionStore, planSave, summarize } from './session-store'
import { writeSaveFile } from './write'

/**
 * The registry of this frame, with the one thing it cannot do for itself handed to it: reading a
 * file that was never intercepted. The read has to be made from the extension origin, which is
 * what this frame is and what the page is not — 48 CORS refusals out of 57 measured from the page
 * — and the registry itself has no business knowing that.
 */
const store = new SessionStore({
  openPlain: (url) => openPlainFile(url),
  // The read of a file's tables is the one thing here that finishes after the message that asked
  // for it: the session it makes appears with nothing else arriving to carry the word out. A file
  // watched to the end and fully downloaded would otherwise be recorded and never counted on the
  // badge — see tellRecording.
  onFileRead: () => tellRecording(),
})

/**
 * How long a blob lives after a download starts. Chrome does not read it instantly, and an
 * address revoked right after the call cuts an already started download off halfway.
 */
const REVOKE_DELAY_MS = 60_000

/** Limit on the length of a file name in characters: file systems have one, page titles do not. */
const MAX_NAME_LENGTH = 100

/**
 * The same limit in bytes, which is the unit the file systems actually count in.
 *
 * The two are not the same limit and neither implies the other: a hundred characters of Japanese
 * are three hundred bytes and a hundred emoji are four hundred, both past what ext4 and NTFS take
 * for one name. Two hundred leaves room under the shortest common limit of 255 for the extension
 * and for the "(1)" Chrome appends when a name is already taken.
 */
const MAX_NAME_BYTES = 200

/** What a session with no name of its own is saved as. */
const FALLBACK_NAME = 'tailcut'

/**
 * Characters a file name may not carry, replaced by a space because their place is between words.
 *
 * `\ / : * ? " < > |` are forbidden outright by Windows, and the two slashes are path separators
 * everywhere: "AC\DC.mp4" is written not as a file but as a directory AC holding DC.mp4, and the
 * user who pressed "Save all" finds no clip. The control characters follow, both ranges of them:
 * C0 below the space, and C1 above DEL, which arrives from pages served in a legacy encoding.
 */
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]+/g

/**
 * Characters that show nothing and break everything: removed outright rather than turned into a
 * space, because they stand inside a word as readily as between two.
 *
 * The bidirectional controls — the marks, the embeddings, the overrides and the isolates — are
 * written by every page that mixes scripts, and by plenty that do not. Measured: a title carrying
 * U+200E LEFT-TO-RIGHT MARK, which is neither whitespace nor forbidden, survived every step of the
 * cleaning, Chrome refused the name, and the popup blamed the session for being gone. The
 * zero-width characters (space, non-joiner, joiner, no-break space) and the soft hyphen come from
 * the same place — a page's own typography — and are as invisible in a file manager as they are
 * in a title.
 */
const INVISIBLE =
  /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g

/** How many bytes one code point takes in UTF-8: the unit a file system counts its limit in. */
function utf8SizeOf(point: string): number {
  const code = point.codePointAt(0) ?? 0
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0x10000) return 3
  return 4
}

/**
 * The name cut down to what a file system will take — by whole characters and by bytes at once.
 *
 * By code points and not by string index: a title of emoji is a string of surrogate pairs, and a
 * cut between the halves of one leaves a lone surrogate behind. That is not valid Unicode, and
 * Chrome refuses such a name exactly as it refuses a control character.
 */
function clipToLimits(text: string): string {
  let taken = ''
  let bytes = 0
  let points = 0

  for (const point of text) {
    if (points === MAX_NAME_LENGTH) break
    const size = utf8SizeOf(point)
    if (bytes + size > MAX_NAME_BYTES) break

    taken += point
    bytes += size
    points += 1
  }

  return taken
}

interface PageContext {
  url: string
  title: string
}

/**
 * The bridge lives on the extension origin and does not know the address of the page that
 * inserted it. Until the first tc:context there is the referrer: it is not always there, but it
 * beats an empty string.
 */
let pageContext: PageContext = { url: document.referrer, title: '' }

/**
 * The page holds a player this extension could not reach; see tc:unreachable below.
 *
 * Kept in the frame and not in the registry, because it is a fact about the page rather than
 * about any material: nothing of such a player was ever collected, so there is no session for it
 * to be a property of. Once set it is never cleared — a worker that was not wrapped is not going
 * to be wrapped later on.
 */
let unreachable = false

/**
 * Whether the main world has already been told that this page is refused; see tellRefusal.
 */
let refusalTold = false

/**
 * How often this frame repeats that it has something recorded in it; see announceRecording.
 *
 * The badge is recounted every ten seconds, so a word more often than that would be a word
 * nobody acts on. Less often and a service worker that restarted would go a whole period longer
 * than it has to with a badge counted off the main frame alone.
 */
const ANNOUNCE_INTERVAL_MS = 10_000

/** When this frame last said it was recording; 0 — it never has. */
let announcedAt = 0

/**
 * Tells the document that inserted this bridge that there is a recording in here.
 *
 * The badge of the tab is counted out of the registries of its frames, and a tab has as many of
 * those as it has frames. Enumerating them all and asking every one, every ten seconds, cost 154
 * injections and 154 messages on a news page that held no video at all — so the frames that have
 * something say so, and the badge asks those and the main frame (see FrameRecording).
 */
function announceRecording(): void {
  if (!store.recording) return

  announcedAt = Date.now()

  // To the window that inserted this frame, as the handshake is, and for the same reason: the
  // bridge stands up in every frame of the page, and the content script that can carry this to
  // the service worker is the one of that very frame.
  const notice: BridgeToPage = { type: 'tc:recording' }
  window.parent.postMessage(notice, '*')
}

/**
 * The word by the clock, and not by the traffic alone.
 *
 * What the service worker holds it holds in memory: Chrome stops it after half a minute of
 * idling and the instance that comes back has been told nothing. It asks the main frame anyway —
 * that is what the main frame is asked unconditionally for — but on a page whose player sits in
 * an embed the main frame has nothing to answer, and the recording would be off the badge until
 * something arrived to prompt this frame again.
 *
 * Nothing need ever arrive. A clip buffered to its end, a paused player, a file already
 * downloaded whole: the page has said everything it is going to say, and that is precisely the
 * state a page is in while somebody decides to save from it. Said on the traffic alone, the word
 * came only while material was flowing — which is the one stretch of a page's life in which the
 * badge is in no danger of losing it.
 *
 * It costs a timer per frame and one comparison per tick on the frames that hold nothing, which
 * is 153 frames out of that news page's 154. The content script of every one of those frames
 * already polls twice a second (CONTEXT_POLL_MS); this adds one tick per ten seconds beside it.
 */
setInterval(announceRecording, ANNOUNCE_INTERVAL_MS)

/**
 * The same word on the arrival of something, at most once per period.
 *
 * The clock above would carry it within ten seconds anyway; this is for the ten seconds. A
 * recording that has just begun is the news the badge exists for, and a period of nothing over a
 * page that is recording is a period the user has no reason to open the popup in. The throttle is
 * what keeps a page appending every half-second from saying it twenty times per recount.
 *
 * Cheap on the path it stands in: the store answers whether it holds anything without walking
 * anything, and on a frame with nothing recorded in it this is one comparison per segment.
 */
function tellRecording(): void {
  if (Date.now() - announcedAt < ANNOUNCE_INTERVAL_MS) return
  announceRecording()
}

/**
 * Tells the world that does the copying that it may stop.
 *
 * The registry refuses a protected page outright and drops every byte that arrives after — but
 * the hook goes on copying each append and posting it here, because it knows nothing of any of
 * this and must not: it stands on the synchronous path of somebody's player. Measured on dash.js
 * ClearKey, 53 messages and 29.7 MB were copied and thrown away in forty seconds; on Widevine, 40
 * and 34.7 MB. The cost of refusing equalled the cost of recording.
 *
 * Sent to `window.parent` for the same reason the handshake is: the bridge stands up in every
 * frame of the page, and the document that inserted it is the one whose hook is doing the
 * copying. Sent once — a message per append of a page that is already refused would be the very
 * traffic this ends. And sent only for the one refusal that never turns: a triage rejection would
 * take the byte stream away from the reader in the middle of a segment, and there is no init
 * segment coming to help it find its place again.
 */
function tellRefusal(): void {
  if (refusalTold || !store.encrypted) return
  refusalTold = true

  const refusal: BridgeToPage = { type: 'tc:refused' }
  window.parent.postMessage(refusal, '*')
}

function summaries(): SessionSummary[] {
  return store.list().map((session) => ({
    key: session.key,
    url: session.url,
    title: session.title,
    // The moment material last arrived here. The popup merges the registries of every frame of
    // the tab into one list, and this is the only thing the sessions of two frames can be put in
    // order by: each registry sorts its own, and neither knows of the other.
    lastAt: session.lastSeenAt,
    ...summarize(session),
  }))
}

/**
 * A file name out of the page title. What file names forbid is cleaned out and the rest stays as
 * it is: a title in any language is no reason to hand the user a file made of underscores.
 *
 * The title is written by the page and travels from here straight into the file system, so every
 * step below answers something a real title was measured to do. Chrome answers a name it will not
 * take by refusing the whole download, which is the one failure the user has no way of guessing
 * at — see the `refused` reason in the save below.
 */
function fileNameFor(title: string): string {
  const cleaned = title
    // The invisible ones go first and go away: turned into spaces they would open gaps inside
    // words, and left alone they reach Chrome and the download is refused.
    .replace(INVISIBLE, '')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A name starting with a dot is a hidden file to Chrome, and ".." is a path upwards. Dots at
    // the edges are cut after whitespace is collapsed: otherwise "../../.bashrc" would keep them
    // behind the first space.
    .replace(/^[.\s]+/, '')

  // The cut comes last, so that the limits are spent on what survived the cleaning, and the tail
  // is tidied after the cut, so that a name cut on a space or a dot does not carry it into the
  // extension.
  const base = clipToLimits(cleaned).replace(/[.\s]+$/, '')

  return `${base || FALLBACK_NAME}.mp4`
}

/**
 * Assembles a session into a file and hands it to Chrome to download.
 *
 * The file is put together here and not in the popup: what a save is made of lives in this frame,
 * and pushing megabytes through extension messages would copy them twice and through JSON. What
 * kind of material it is made of this function does not ask — see writeSaveFile.
 *
 * Awaited rather than immediate, because one of the two kinds has to read its material off the
 * network first. That is also why the emptiness of a session is answered before any of it starts:
 * a save that cannot produce a file must say so at once and not after a round trip.
 */
async function save(key: string, port: MessagePort | undefined): Promise<void> {
  const session = store.get(key)

  // Triage may have evicted the session and the page may have reloaded while the popup was open:
  // the popup key then points at nothing.
  if (!session) {
    const missing: SaveResult = { ok: false, reason: 'gone' }
    port?.postMessage(missing)
    return
  }

  // A session made of init segments alone has nothing to cut, and neither has one whose second
  // buffer is yet to bring a fragment, nor a file the element has not held a whole frame of. Told
  // apart from the one above because the two are owed different words: this session is in the
  // registry and recording, and "it may be gone from the page" would send the user looking for a
  // loss that never happened.
  const plan = planSave(session)
  if (plan.bytes === 0) {
    const empty: SaveResult = { ok: false, reason: 'empty' }
    port?.postMessage(empty)
    return
  }

  // A Blob only takes a view over a plain ArrayBuffer, while Uint8Array allows shared memory by
  // type. Both writers allocate the buffer themselves and neither is shared.
  const file = (await writeSaveFile(plan.source)) as Uint8Array<ArrayBuffer> | null

  // Only the plain path reaches this: the material is on somebody's server, and the answer to a
  // read of it may be a refusal. Said in the words of a refused download rather than of an empty
  // session — the recording is there, and what failed was fetching it.
  if (!file) {
    const unread: SaveResult = { ok: false, reason: 'refused', detail: 'the file could not be read' }
    port?.postMessage(unread)
    return
  }

  const url = URL.createObjectURL(new Blob([file], { type: 'video/mp4' }))

  chrome.downloads.download(
    {
      url,
      filename: fileNameFor(session.title),
      // Said out loud rather than left to the default. Two sessions of one page share a title as
      // a matter of course — a feed leaves one behind per video — and so do two long titles that
      // differ only past the length limit; overwriting would take the first file away without a
      // word, and prompting would stop a save the user has already asked for.
      conflictAction: 'uniquify',
    },
    (downloadId) => {
      const failed = downloadId === undefined
      // Read for two reasons. Unread, Chrome writes about it to the console itself and the frame
      // fills with "Unchecked runtime.lastError" — errors of the extension by the look of them.
      // And it is the only account of what actually went wrong: no space, no permission, a name
      // the file system will not take. Answered as a plain "false", the last of those reached the
      // user as "this recording may be gone from the page" while it sat in the registry recording
      // on.
      const detail = failed ? chrome.runtime.lastError?.message : undefined

      setTimeout(() => URL.revokeObjectURL(url), failed ? 0 : REVOKE_DELAY_MS)

      const result: SaveResult = failed ? { ok: false, reason: 'refused' } : { ok: true }
      if (detail) result.detail = detail
      port?.postMessage(result)
    },
  )
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data

  if (data?.type === 'tc:context') {
    pageContext = { url: String(data.url), title: String(data.title) }
    // The sessions of this page take the title on as well. A session is signed at the moment its
    // first init segment arrives, and the page learns its own title later than that: recording
    // starts at document_start, and a single-page application loads the next video without a
    // navigation. Left to the moment of opening alone, the popup would say "Untitled" for a
    // video that has a name, and the saved file would be named after nothing.
    store.pageIsAt(pageContext.url, pageContext.title)
    return
  }

  // Requests from the popup arrive through a port: chrome.runtime.sendMessage does not reach
  // this iframe, it is addressed to the content script.
  if (data?.type === 'tc:list') {
    // Through the declared union rather than directly: postMessage accepts anything, and a reply
    // that silently drifted away from BridgeToPage would only show up at the receiver.
    const list: SessionList = { sessions: summaries() }
    // Why there is nothing here, when there is nothing here. A protected page and a page with no
    // video on it look the same in an empty list, and the two are owed different sentences.
    if (store.encrypted) list.encrypted = true
    if (unreachable) list.unreachable = true
    // A file was watched and could not be read — a webm on an imageboard, an address that had
    // expired. A fourth silence with a sentence of its own, for the same reason as the other two.
    if (store.unreadableFile) list.unreadableFile = true

    const reply: BridgeToPage = list
    event.ports[0]?.postMessage(reply)
    return
  }

  // The file is put together here and not in the popup: the bytes live in this frame, and
  // pushing megabytes through extension messages would copy them twice and through JSON.
  if (data?.type === 'tc:save') {
    void save(String(data.key), event.ports[0])
    return
  }

  // An element of the page is playing a stream out of a worker that the hook was not allowed to
  // wrap: measured on a page whose policy forbids blob workers, where the material of such a
  // player passes the extension by entirely. There is nothing to record and nothing to fix, and
  // the one thing owed to the user is to be told — a popup that shows nothing looks broken.
  if (data?.type === 'tc:unreachable') {
    unreachable = true
    return
  }

  // A media element of the page has fired `encrypted`: the material it is being fed carries
  // protection, and that is the end of this page — §5.4 refuses encrypted media outright, and the
  // refusal is acted on here rather than left to triage. A verdict speaks about an element the
  // watcher has found, and on a page whose <video> lives in a shadow root it never finds one:
  // tv.apple.com reported its DRM four times while no verdict was ever spoken, and the registry
  // went on offering the material of a protected page for saving.
  //
  // The other half of the same refusal needs no message at all — the registry reads protection out
  // of the boxes it parses anyway. This is for the material it never gets to parse: a stream in a
  // container it does not read, or a player whose bytes come by a road of their own.
  if (data?.type === 'tc:encrypted') {
    store.refuseEncrypted()
    tellRefusal()
    return
  }

  // The triage verdict is passed by the content script on signals from <video>: the hook in the
  // MAIN world always copies the bytes, and deciding what stays of them is the work of the
  // isolated world. The verdict is addressed, so a rejection acts on exactly its own source.
  if (data?.type === 'tc:verdict') {
    const sourceId = String(data.sourceId)
    if (data.verdict === 'reject') store.dropPending(sourceId)
    if (data.verdict === 'hold') store.resumePending(sourceId)
    if (data.verdict === 'promote') store.promotePending(sourceId)
    // A promotion is the moment a page that has been playing for six seconds becomes a recording,
    // and on a page that appended everything it had in the first second it is the only moment
    // there is: nothing arrives here afterwards to carry the word out.
    tellRecording()
    return
  }

  if (!isPageToBridge(data)) return

  // The page has stated how long the whole video is. It is the third component of the merge key
  // (§6.1) and the only one that tells two videos of a feed apart where the address does not
  // change from one to the next; the registry decides for itself whether it is news.
  if (data.type === 'tc:duration') {
    store.setDuration(data.sourceId, data.seconds)
    return
  }

  // A media element of the page is playing an ordinary file. Nothing of its material passes
  // through the extension — the browser fetched it and nobody intercepted a byte — so what
  // arrives is an address and an account of how much of it the element holds. The registry
  // decides what to do with that, and does nothing at all until triage has promoted the source.
  if (data.type === 'tc:plain') {
    store.plain({
      sourceId: data.sourceId,
      url: data.url,
      // The frame's own address and title, exactly as a captured session is signed: the material
      // is what the file holds, and the page is where the user saw it.
      pageUrl: pageContext.url,
      title: pageContext.title,
      durationSeconds: data.durationSeconds,
      buffered: data.buffered,
      now: Date.now(),
    })
    tellRecording()
    return
  }

  if (data.type === 'tc:append') {
    store.append({
      sourceId: data.sourceId,
      // Which SourceBuffer the bytes were appended to. Without it the registry cannot tell the
      // video stream from the audio one: both come from one MediaSource under one sourceId.
      bufferId: data.bufferId,
      // The type that SourceBuffer was opened with. A WebM picture track is described by nothing
      // else: Matroska carries no VP9 profile, and the codec string carries all of it.
      mime: data.mime,
      url: pageContext.url,
      title: pageContext.title,
      bytes: new Uint8Array(data.bytes),
      now: Date.now(),
    })

    // The registry reads protection out of the boxes it was parsing anyway, so the refusal may
    // begin here as readily as it does in tc:encrypted above — and this is the one that fires on
    // the pages that never announce themselves.
    tellRefusal()

    // After the refusal and never before it: a page that has just been refused holds no session
    // any more, and there is nothing here for the badge to count.
    tellRecording()
  }
})

// The handshake goes to the window of its own frame rather than window.top: the bridge stands up
// in every frame of the page (all_frames in the manifest), and for a player in a nested frame the
// top page is a stranger — the document that inserted the bridge is the one that must learn of it.
const handshake: BridgeToPage = { type: 'tc:ready' }
window.parent.postMessage(handshake, '*')
