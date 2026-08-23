import {
  isPageToBridge,
  type BridgeToPage,
  type SaveResult,
  type SessionSummary,
} from '../shared/protocol'
import { muxFragmentedMp4 } from '../core/mux'
import { SessionStore, selectMaterial, summarize } from './session-store'

const store = new SessionStore()

/**
 * How long a blob lives after a download starts. Chrome does not read it instantly, and an
 * address revoked right after the call cuts an already started download off halfway.
 */
const REVOKE_DELAY_MS = 60_000

/** Limit on the length of a file name: file systems have one, and page titles are longer. */
const MAX_NAME_LENGTH = 100

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

function summaries(): SessionSummary[] {
  return store.list().map((session) => ({
    key: session.key,
    url: session.url,
    title: session.title,
    ...summarize(session),
  }))
}

/**
 * A file name out of the page title. What file names forbid is cleaned out and the rest stays as
 * it is: a title in any language is no reason to hand the user a file made of underscores.
 */
function fileNameFor(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A name starting with a dot is a hidden file to Chrome, and ".." is a path upwards. Dots at
    // the edges are cut after whitespace is collapsed: otherwise "../../.bashrc" would keep them
    // behind the first space.
    .replace(/^[.\s]+/, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[.\s]+$/, '')

  return `${base || 'tailcut'}.mp4`
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
    store.retitle(pageContext.url, pageContext.title)
    return
  }

  // Requests from the popup arrive through a port: chrome.runtime.sendMessage does not reach
  // this iframe, it is addressed to the content script.
  if (data?.type === 'tc:list') {
    // Through the declared union rather than directly: postMessage accepts anything, and a reply
    // that silently drifted away from BridgeToPage would only show up at the receiver.
    const reply: BridgeToPage = summaries()
    event.ports[0]?.postMessage(reply)
    return
  }

  // The file is put together here and not in the popup: the bytes live in this frame, and
  // pushing megabytes through extension messages would copy them twice and through JSON.
  if (data?.type === 'tc:save') {
    const port = event.ports[0]
    const session = store.get(String(data.key))
    // Every track of the session over the stretch where all of them are there at once: a session
    // holds a track per SourceBuffer, and a real player gives the picture and the sound apart.
    const material = session ? selectMaterial(session) : []

    // Triage may have evicted the session and the page may have reloaded while the popup was
    // open: the popup key then points at nothing. A session made of init segments alone has
    // nothing to cut either, and neither has one whose second buffer is yet to bring a fragment.
    if (!session || !material.length) {
      const empty: SaveResult = { ok: false }
      port?.postMessage(empty)
      return
    }

    // A Blob only takes a view over a plain ArrayBuffer, while Uint8Array allows shared memory
    // by type. The muxer allocates the buffer itself and it is never shared.
    const file = muxFragmentedMp4(material) as Uint8Array<ArrayBuffer>
    const url = URL.createObjectURL(new Blob([file], { type: 'video/mp4' }))

    chrome.downloads.download({ url, filename: fileNameFor(session.title) }, (downloadId) => {
      const failed = downloadId === undefined
      // The failure has to be read, otherwise Chrome writes about it to the console itself.
      if (failed) void chrome.runtime.lastError

      setTimeout(() => URL.revokeObjectURL(url), failed ? 0 : REVOKE_DELAY_MS)

      const result: SaveResult = { ok: !failed }
      port?.postMessage(result)
    })
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
    return
  }

  if (!isPageToBridge(data)) return

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
  }
})

// The handshake goes to the window of its own frame rather than window.top: the bridge stands up
// in every frame of the page (all_frames in the manifest), and for a player in a nested frame the
// top page is a stranger — the document that inserted the bridge is the one that must learn of it.
const handshake: BridgeToPage = { type: 'tc:ready' }
window.parent.postMessage(handshake, '*')
