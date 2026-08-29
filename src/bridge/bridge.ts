import { sanitizeFileName } from '../core/export/naming'
import { planSnapshot, type SnapshotMeta } from '../core/snapshot/build'
import {
  isPageToBridge,
  snapshotPath,
  type BridgeToPage,
  type EditResult,
  type SaveResult,
  type SessionList,
  type SessionSummary,
} from '../shared/protocol'
import { memoryCeilingFor, siteAllows } from '../shared/settings'
import { liveSettings } from '../shared/settings-store'
import { HistoryWriter, historyWorker } from './history-writer'
import { openPlainFile, openSoundFile } from './loader'
import {
  SessionStore,
  fileSnapshotSourceOf,
  planSave,
  snapshotSourceOf,
  summarize,
  type Session,
} from './session-store'
import {
  openSession,
  recordPiece,
  recordSnapshot,
  renameSession,
} from '../shared/history-db'
import { writeSnapshot } from './snapshot-writer'
import { writeSaveFile } from './write'

const writeHistoryPiece = historyWorker()

const history = new HistoryWriter({
  write: (path, bytes) => writeHistoryPiece(path, bytes),
  // By merge key, so that a second tab playing the same video fills in the session the first one
  // opened rather than starting one of its own beside it (§6.1). A refusal — private browsing, a
  // store the browser would not open — is answered with null, and nothing is written at all.
  open: (event) =>
    openSession(event.key, event.page).catch(() => null),
  record: (id, piece, tracks, event) =>
    recordPiece(id, piece, tracks, event).catch(() => undefined),
  // The one thing about a live session the writer asks for at the moment a piece lands. Why it is
  // asked then, and why the stamp the chunks carry is kept beside the answer, is in HistoryIo.
  liveWidth: (key) => store.widthOf(key),
  rename: (id, event) =>
    renameSession(id, event.to, event.page)
      .then(() => undefined)
      .catch(() => undefined),
  sweep: () => {
    // Storage is full — full below our own ceiling, which is the browser's right (§7.4 is a
    // ceiling we keep, not a quota we are given). The service worker lowers the effective ceiling
    // to below what is occupied and sweeps; without `full` there would be nothing over the
    // ceiling to take, and this would be a nudge that frees nothing, every thirty seconds.
    void chrome.runtime.sendMessage({ type: 'tc:sweep', full: true }).catch(() => undefined)
  },
  now: () => Date.now(),
})

/**
 * The registry of this frame, with the one thing it cannot do for itself handed to it: reading a
 * file that was never intercepted. The read has to be made from the extension origin, which is
 * what this frame is and what the page is not — 48 CORS refusals out of 57 measured from the page
 * — and the registry itself has no business knowing that.
 */
const store = new SessionStore({
  openPlain: (url) => openPlainFile(url),
  // The soundtrack of a page that plays its sound apart from its picture (§5.6). Read from here
  // for the same reason the picture is — a ranged fetch of somebody's CDN is refused from the
  // page — and only as far as the picture is long, so the whole of a music file is never fetched.
  openSound: (url, seconds) => openSoundFile(url, seconds),
  // The read of a file's tables is the one thing here that finishes after the message that asked
  // for it: the session it makes appears with nothing else arriving to carry the word out. A file
  // watched to the end and fully downloaded would otherwise be recorded and never counted on the
  // badge — see tellRecording.
  onFileRead: () => tellRecording(),
  // Everything that lands on a map goes to the disk as well, in batches (§7.1). The registry says
  // it happened; what to do about it is entirely the writer's business.
  onChunk: (event) => history.take(event),
  // The key of a session changes while it is being recorded (§6.1), and what is on disk is
  // addressed by it. Without this the disk would keep the halves apart.
  onRekey: (event) => history.rekey(event),
})

/**
 * The settings, live, in the frame that records.
 *
 * Everything they change here is applied on the spot: the recording switch reaches the hook, the
 * history writer is turned on or off, and the buffer length is what the next trim will use
 * (Task 9). Nothing waits for a reload — the settings page is a tab of its own, and a user who
 * changes a setting while a video is playing is changing it about that video.
 *
 * `onChange` is called for the first read too, so the stored settings of a returning user are
 * acted on exactly like a change they make now. Until that read lands the copy answers the
 * defaults of §7.4, which is also what the writer is built with.
 */
const settings = liveSettings((next) => {
  history.setEnabled(next.history.toDisk)
  applyRecordingMode()
})

/**
 * Whether the address of the page is known at all.
 *
 * Until the first `tc:context` it is not: the bridge stands on the extension origin and sees
 * neither the address nor the title of the page it was inserted into, and `document.referrer` is
 * empty on any site with a strict referrer policy. "Not known yet" and "cannot be read" are two
 * different states and must not be confused — `siteAllows` refuses an address it cannot read, and
 * that refusal is right for `about:blank` and wrong for a page whose handshake is still in
 * flight.
 */
let contextKnown = false

/** Whether this page is recorded at all, by the mode and the two lists (§9.4). */
function recordingHere(): boolean {
  return siteAllows(settings.get(), pageContext.url)
}

/**
 * The registry stops taking material in, and the hook stops copying it.
 *
 * Silent until the address has arrived, and that is the whole of what it is guarding. Applied on
 * `settings.ready` instead — which is what a first version of this did — the frame would switch
 * itself off on every page that strips its referrer, because `siteAllows(settings, '')` is
 * `false`; then `tc:context` would arrive a moment later, switch it back on, and `pauseIntake`
 * would let the half-read stream readers go. Everything that arrived in that window would be
 * lost, and among it the init segments, which a site hands out in the first second of playback
 * and never repeats — so the session would be unreadable for good over a message ordering.
 */
function applyRecordingMode(): void {
  if (!contextKnown) return
  const on = recordingHere()
  store.pauseIntake(!on)
  tellRecordingSwitch()
}

let switchTold: boolean | undefined

/**
 * Tells the hook whether to copy. Said on every change, and again whenever the page moves: a
 * single-page application walks from an allowed address to a forbidden one without a navigation,
 * and the hook has no idea where it stands.
 */
function tellRecordingSwitch(): void {
  const on = recordingHere()
  if (switchTold === on) return
  switchTold = on

  const message: BridgeToPage = { type: 'tc:record', on }
  window.parent.postMessage(message, '*')
}

/**
 * How long a blob lives after a download starts. Chrome does not read it instantly, and an
 * address revoked right after the call cuts an already started download off halfway.
 */
const REVOKE_DELAY_MS = 60_000

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
 * How often the buffer length and the memory ceiling are enforced.
 *
 * The same two seconds as the tail of a batch, and for a related reason: this is the granularity
 * at which the frame acts on anything at all. Enforcing on every append would be arithmetic over
 * every map on a path that runs dozens of times a minute; enforcing once a minute would let a
 * shortened buffer look broken for a minute after the user shortened it.
 */
const EVICT_INTERVAL_MS = 2_000

// Both halves of §7.2 off one setting, read afresh on every tick: the buffer length each session
// is trimmed to, and the ceiling the document as a whole is held under — which is that same
// length turned into bytes plus room for the other sessions (see `memoryCeilingFor`). A ceiling
// that did not move with the setting promised a length the frame then refused to keep.
setInterval(() => {
  const bufferSeconds = settings.get().recording.bufferSeconds
  store.trimToBuffer(bufferSeconds)
  store.dropOverCeiling(memoryCeilingFor(bufferSeconds), Date.now())
}, EVICT_INTERVAL_MS)

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

  // The material is there and no file could be made of it. On the plain path it is on somebody's
  // server and the answer to a read of it may be a refusal; on the captured path it is here, and
  // the writer could make nothing of it — an init whose sample entry it does not know, segments
  // it could not read. Said in the words of a refused download rather than of an empty session:
  // the recording is there, and what failed was turning it into a file.
  if (!file) {
    const unread: SaveResult = {
      ok: false,
      reason: 'refused',
      detail:
        plan.source.kind === 'plain'
          ? 'the file could not be read'
          : 'the recorded material could not be read',
    }
    port?.postMessage(unread)
    return
  }

  const url = URL.createObjectURL(new Blob([file], { type: 'video/mp4' }))

  chrome.downloads.download(
    {
      url,
      filename: `${sanitizeFileName(session.title)}.mp4`,
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

/**
 * Freezes the session and writes it out as a snapshot.
 *
 * This is the "freeze on click" of §9.2 made into a file. Recording carries on behind it: the
 * page keeps appending, triage keeps evicting, and the editor works from the file, so the buffer
 * cannot move under the user while they are choosing.
 *
 * Both kinds of session are frozen, and the difference is where the material has to be fetched
 * from — the same difference, and the only one, that a save has (see writeSaveFile). The button
 * used to be offered on both and to work on one: an ordinary file has no tracks in the registry
 * at all, so the freeze found nothing to lay out and answered "there is nothing to edit in this
 * session yet" beside a Save all button that was saving that very file perfectly.
 */
async function freeze(key: string): Promise<EditResult> {
  const session = store.get(key)
  if (!session) return { ok: false, reason: 'gone' }

  const meta: SnapshotMeta = {
    id: crypto.randomUUID(),
    capturedAt: Date.now(),
    producer: `tailcut ${chrome.runtime.getManifest().version}`,
  }

  return session.plain ? freezeFile(session, meta) : freezeCaptured(session, meta)
}

/**
 * The freeze of material this frame is holding.
 *
 * Everything up to the first await is one turn — reading the maps, laying the parts out, copying
 * them into the buffer that goes to the worker. Split across an await, the plan would describe
 * chunks an eviction had already dropped.
 */
async function freezeCaptured(session: Session, meta: SnapshotMeta): Promise<EditResult> {
  const plan = planSnapshot(snapshotSourceOf(session), meta)

  // A session of init segments alone, or one whose buffers have not brought a fragment yet.
  // Nothing to edit, and a snapshot of it would open on an empty timeline.
  if (!plan.index.tracks.some((track) => track.chunks.length)) return { ok: false, reason: 'empty' }

  const written = await writeSnapshot(plan, snapshotPath(meta.id))
  if (!written) return { ok: false, reason: 'storage' }

  // A snapshot is a temporary of one editing and it is swept by age like everything else, so it
  // has to be in the index that the sweeper and the volume indicator read. Written after the file
  // and never before it, exactly as a piece of the history is.
  await recordSnapshot({
    id: meta.id,
    capturedAt: meta.capturedAt,
    bytes: plan.bytes,
    title: session.title,
  }).catch(() => undefined)

  return { ok: true, snapshotId: meta.id }
}

/**
 * The freeze of material that is still on somebody's server.
 *
 * There is nothing here to lay out: the extension never intercepted a byte of this file, and what
 * it holds is an index of it and a reader (§5.6). So the material is fetched — the very clip
 * "Save all" would have written, cut over the stretch the element actually held — and the
 * snapshot is that file, whole, with its movie box named inside it. The editor reads the sample
 * tables straight out of it and never goes back to the network.
 *
 * Fetching rather than remembering the address is what makes the snapshot a snapshot: the editor
 * tab outlives the page, and a signed URL does not. It costs one read of exactly what the popup
 * has already promised to save, made once, on a click — and the popup says "Freezing…" while it
 * runs, as it does for the other kind.
 *
 * There is no synchronous turn to keep here and nothing an eviction could take away underneath:
 * the file on the server does not move, and the plan is made of it before the first await.
 */
async function freezeFile(session: Session, meta: SnapshotMeta): Promise<EditResult> {
  const cut = planSave(session)

  // The element holds not one whole frame yet: no sample of the file lies inside what it has, and
  // there is nothing to cut. The same emptiness a capture of init segments alone answers with.
  if (cut.bytes === 0) return { ok: false, reason: 'empty' }

  const file = await writeSaveFile(cut.source)
  // An address that has expired, a host that stopped answering, a read that came back short. The
  // recording is not lost — it was never here — so this is neither "gone" nor "empty".
  if (!file) return { ok: false, reason: 'unread' }

  // Nothing but a defect in our own writer produces bytes with no movie box in them; answered
  // rather than written out, because a snapshot no editor can open is worse than a refusal.
  const source = fileSnapshotSourceOf(session, file, cut.duration)
  if (!source) return { ok: false, reason: 'unread' }

  const plan = planSnapshot(source, meta)
  const written = await writeSnapshot(plan, snapshotPath(meta.id))
  if (!written) return { ok: false, reason: 'storage' }

  // The same as for material this frame was holding: the file first, the row after it, and the
  // sweeper counts this one in the occupied volume like any other.
  await recordSnapshot({
    id: meta.id,
    capturedAt: meta.capturedAt,
    bytes: plan.bytes,
    title: session.title,
  }).catch(() => undefined)

  return { ok: true, snapshotId: meta.id }
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
    contextKnown = true
    // The address decides whether anything is recorded here, so the answer is worked out when the
    // address arrives and again whenever it changes — never before it, and never on a timer.
    applyRecordingMode()
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
    // A file was watched and could not be read — an address that had expired, a host that will
    // not range. A fourth silence with a sentence of its own, for the same reason as the other two.
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

  // Edit does not build a file: it writes the material out as it stands and hands back the name
  // of it. The editor is a tab of its own and reads the snapshot from storage, so it survives
  // this page being closed — which is the whole reason the snapshot exists.
  if (data?.type === 'tc:edit') {
    const port = event.ports[0]
    void freeze(String(data.key)).then((result) => port?.postMessage(result))
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

  // The size of the player a stream is being watched in, measured by the same poll of the same
  // isolated world that speaks the verdicts. A value signal of §7.3 and nothing else: no file, no
  // list and no save depends on it, which is why a forged one could do no harm beyond flattering
  // a recording of the page's own.
  //
  // Kept whatever the verdict says afterwards. A rejection is a freeze and not an erasure (§5.5),
  // and the size the player had while it was playing stays true.
  if (data?.type === 'tc:player') {
    store.sawPlayer(String(data.sourceId), Number(data.widthPx) || 0)
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

  // An <audio> of the page is playing a soundtrack of its own. It is not a recording and does not
  // become one: what it can be is the sound of a picture on this page that has none, which the
  // registry decides. Nothing of the material travels here either — the browser fetched the track
  // and the hook never saw it.
  if (data.type === 'tc:sound') {
    store.sound({
      sourceId: data.sourceId,
      url: data.url,
      durationSeconds: data.durationSeconds,
      buffered: data.buffered,
      playing: data.playing,
    })
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
