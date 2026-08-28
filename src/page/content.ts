import {
  BRIDGE_PATH,
  SOURCE_EVENT,
  isExtensionToTab,
  isPageToBridge,
  type TabToExtension,
} from '../shared/protocol'
import { bindSource, registerSource, registerWorkerSource, startWatching } from './watcher'

let bridgePromise: Promise<HTMLIFrameElement> | null = null

/**
 * The origin the bridge of this frame speaks from.
 *
 * A page may post whatever it likes into its own window, and what arrives from the bridge is
 * acted on — so the sender has to be established, and an origin is the one thing a page cannot
 * imitate: no document of a site is served from the extension scheme. The exact origin and not
 * the scheme alone, because the isolated world has chrome.runtime to ask and nothing is gained by
 * accepting another extension's frames as this one's bridge.
 *
 * Spelled out of the address rather than taken from `new URL(...).origin`: `chrome-extension` is
 * a scheme the URL parser of a browser knows and the one in a test runner does not, and outside
 * Chrome that call answers "null" for every extension there has ever been.
 */
const BRIDGE_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '')

/**
 * How often the address and the title of the page are re-read when nothing else has asked.
 *
 * A backstop and not the mechanism. What signs a session is read at the moment the material
 * arrives (see the forwarding below), so the poll no longer decides anything about the address of
 * a recording; what is left for it is the page that changes its <title> with no media traffic to
 * ride along with — a single-page application fills that in after the player has already started,
 * and the popup would go on showing the name of nothing.
 *
 * By polling and not by observation: a title change is a character-data mutation inside <head>,
 * and a MutationObserver wide enough to catch it would fire on every text node a busy page
 * touches, which is exactly the cost this extension must not impose. Two string comparisons twice
 * a second cost nothing beside it.
 */
const CONTEXT_POLL_MS = 500

interface PageContext {
  url: string
  title: string
}

/** What the bridge has already been told; null — it has not been told anything yet. */
let toldContext: PageContext | null = null

/**
 * Extensions of a media file: cut off a name taken out of an address.
 *
 * What is being named is the recording, and the container it will be saved in is the save's own
 * business — every save writes an mp4. Left on, a clip of `cat.webm` would be handed over as
 * `cat.webm.mp4`.
 */
const MEDIA_EXTENSION = /\.(?:mp4|m4v|m4a|mov|webm|mkv|ogv|ogg|ogm|avi|ts|m2ts|mpg|mpeg|3gp|flv|wmv|mp3|aac|opus|flac|wav)$/i

/**
 * The name of a file out of the address it stands at; empty when the address names none.
 *
 * The last part of the path and nothing else: the query carries a token or a signature, the
 * fragment carries a start time, and neither is part of what the material is called. What the
 * address spells in percent signs is a name in somebody's language and is read back as one — a
 * malformed escape is left as it stands rather than thrown over.
 */
function fileNameIn(href: string): string {
  let path: string
  try {
    path = new URL(href).pathname
  } catch {
    return ''
  }

  const last = path.slice(path.lastIndexOf('/') + 1)
  if (!last) return ''

  let name = last
  try {
    name = decodeURIComponent(last)
  } catch {
    // A stray percent sign: the address is somebody else's and not ours to correct.
  }

  return name.replace(MEDIA_EXTENSION, '')
}

/**
 * Where the page stands and what it is called.
 *
 * A link straight to a file makes Chrome build a document around it — one `<video>` and nothing
 * else — and content scripts do run in that document, which is how a plain file gets watched
 * without a page around it. Such a document has no `<title>` at all: the name on the tab is the
 * browser's own doing and appears nowhere in the DOM, measured as the empty string on
 * https://www.w3schools.com/html/mov_bbb.mp4. So the address is asked instead, because on that
 * one kind of page the address is the name of the material itself.
 *
 * Only on that kind of page. On an ordinary one the last part of the path is a slug, a number or
 * the word "watch", and a page that has not filled its title in yet is a page whose title is
 * coming — the poll above exists for exactly that.
 */
function pageContext(): PageContext {
  const url = location.href
  const title = document.title
  if (title) return { url, title }

  const type = document.contentType ?? ''
  const isMediaDocument = type.startsWith('video/') || type.startsWith('audio/')

  return { url, title: isMediaDocument ? fileNameIn(url) : '' }
}

/**
 * Tells the bridge where it stands, unless it knows already.
 *
 * The bridge lives on the extension origin and sees neither the address nor the title of the page
 * for itself, and its document.referrer runs dry under the referrer policy of the site.
 */
function tellContext(iframe: HTMLIFrameElement): void {
  const context = pageContext()
  if (toldContext?.url === context.url && toldContext.title === context.title) return

  toldContext = context
  iframe.contentWindow?.postMessage({ type: 'tc:context', ...context }, '*')
}

/** Inserts an invisible iframe on the extension origin and gives it back once it has loaded. */
export function ensureBridge(): Promise<HTMLIFrameElement> {
  if (bridgePromise) return bridgePromise

  bridgePromise = new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    // The address goes in before the insertion: a frame inserted without one loads about:blank
    // first, and the listener below would hand out the promise on that load — a frame with no
    // bridge in it yet.
    iframe.src = chrome.runtime.getURL(BRIDGE_PATH)
    iframe.dataset.tailcut = 'bridge'
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText =
      'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none;left:-9999px'

    iframe.addEventListener(
      'load',
      () => {
        // The context goes out before the resolve: otherwise the first segments would land in a
        // session with no address to it.
        tellContext(iframe)
        resolve(iframe)
      },
      { once: true },
    )

    // The script runs at document_start: <html> is parsed, <head> and <body> are not yet, so the
    // bridge goes in as a direct child of documentElement straight away. Waiting for
    // DOMContentLoaded is out — the player opens its MediaSource and gathers segments earlier.
    document.documentElement.appendChild(iframe)
  })

  return bridgePromise
}

/**
 * Keeps the bridge's idea of the page up to date between one piece of material and the next.
 *
 * At document_start the page has no title yet: YouTube fills its <title> in after the player has
 * already started. A page that plays nothing more after that would otherwise keep the name it had
 * at the moment its session opened, which is no name at all.
 */
function watchContext(): void {
  setInterval(() => {
    const context = pageContext()
    if (toldContext?.url === context.url && toldContext.title === context.title) return
    void ensureBridge().then(tellContext)
  }, CONTEXT_POLL_MS)
}

ensureBridge()
watchContext()

/**
 * Passes the bridge's word that this frame is recording on to the service worker.
 *
 * The badge is counted out of the registries of the frames of a tab, and a tab holds one per
 * frame. Asked of every frame every ten seconds it cost 154 injections and 154 messages on a news
 * page with no video in it; the frames that have something say so instead, and the badge asks
 * those (see FrameRecording). Chrome signs the message with the tab and the frame it came from,
 * so nothing of either has to be carried in it.
 *
 * Sent and forgotten: there is no answer to wait for, and the one thing that can come back is a
 * worker that was asleep or an extension that was reloaded under the page. Neither is news, and
 * neither may be left as an unhandled rejection in somebody's page.
 */
function tellWorkerRecording(): void {
  const notice: TabToExtension = { type: 'tc:recording' }
  try {
    void chrome.runtime.sendMessage(notice).catch(() => undefined)
  } catch {
    // The extension was reloaded and this content script outlived it: chrome.runtime is there and
    // its context is not. Nothing of this page reaches the new instance until it is loaded again.
  }
}

window.addEventListener('message', async (event: MessageEvent) => {
  // The bridge of this frame speaking. It is answered before the check below, and not after it:
  // the bridge posts from its own frame, so `event.source` is that frame's window and never this
  // one. Nothing else of what it sends is for this world — the handshake and the refusal are
  // addressed to the hook in the MAIN world, which reads the same origin off the same message.
  if (event.origin === BRIDGE_ORIGIN) {
    if ((event.data as { type?: unknown } | null)?.type === 'tc:recording') tellWorkerRecording()
    return
  }

  if (event.source !== window) return
  if (!isPageToBridge(event.data)) return

  const message = event.data

  // To the watcher first, before the wait for the bridge: it needs the address from
  // createObjectURL at its very next poll, and the bridge may still be loading by then.
  if (message.type === 'tc:source') registerSource(message.sourceId, message.objectUrl)
  // A MediaSource built inside a worker: it has no address, so the watcher is told of it by name
  // alone and learns which element plays it from SOURCE_EVENT below.
  if (message.type === 'tc:worker') registerWorkerSource(message.sourceId)

  const iframe = await ensureBridge()

  // The page is read here, in front of whatever it is that arrived, and not left to the poll.
  //
  // A single-page application changes what it is playing without a navigation, and the two moments
  // that matter — a new MediaSource, and the first bytes through it — are exactly the moments this
  // line stands in front of. Measured on youtube.com/shorts: the address of a short was already in
  // location.href when its SourceBuffers were created, and the poll was still half a second away,
  // so all four sessions of the run were signed with the previous video (address, title and merge
  // key alike) and the user saved a file named after a stranger.
  //
  // It costs two string comparisons per message: tellContext sends nothing when the page has not
  // moved, which on an ordinary page is every time after the first.
  tellContext(iframe)

  if (message.type === 'tc:append') {
    iframe.contentWindow?.postMessage(message, '*', [message.bytes])
  } else {
    iframe.contentWindow?.postMessage(message, '*')
  }
})

// The popup and the service worker address the content script: an extension message does not
// reach the bridge frame on its own, and the session registry lives exactly there. The bridge
// answers into a MessageChannel port — the same channel it answers tc:list to the page with.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExtensionToTab(message)) return false

  ensureBridge().then((iframe) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = (event: MessageEvent) => sendResponse(event.data)
    iframe.contentWindow?.postMessage(message, '*', [channel.port2])
  })

  // true holds the reply channel open: the bridge does not answer at once, and a channel that
  // closed would hand the asker undefined before the bridge had even seen the request.
  return true
})

// The hook in the MAIN world always copies the bytes: it knows nothing of the DOM and must not,
// and parsing on the synchronous path of the player is out of the question. Whether a stream is
// kept is decided by the isolated world — here, on the signals of the element — and the verdict
// goes to the bridge addressed, with the identifier of the stream. A rejection of one <video>
// then leaves its neighbour on the same page alone.
startWatching(
  async (sourceId, verdict) => {
    const iframe = await ensureBridge()
    iframe.contentWindow?.postMessage({ type: 'tc:verdict', sourceId, verdict }, '*')
  },
  // The page holds a player this extension cannot reach: its MediaSource lives in a worker that
  // the hook was not allowed to wrap, so not a byte of it was ever copied and none ever will be.
  // The popup is told, because a popup that shows nothing looks broken rather than honest.
  async () => {
    const iframe = await ensureBridge()
    iframe.contentWindow?.postMessage({ type: 'tc:unreachable' }, '*')
  },
  // A media element of the page says the material it is being fed is encrypted. That is the
  // stream speaking for itself and the one thing a page cannot feign: asking the browser about
  // key systems fires nothing here, and a page that asks and then plays in the clear is recorded
  // like any other. The registry reads the same protection out of the boxes it parses; this is
  // for the material that never reaches the parser.
  async () => {
    const iframe = await ensureBridge()
    iframe.contentWindow?.postMessage({ type: 'tc:encrypted' }, '*')
  },
  // A media element of this page is playing an ordinary file (§5.6). There is no material to
  // carry — the browser fetched the file itself and the hook in the MAIN world never saw it — so
  // what goes across is the address, the length and the stretch the element holds. The frame it
  // goes to is the one that can act on it: the bridge stands on the extension origin, which is
  // the only place a ranged fetch of somebody else's CDN is not refused.
  async (source) => {
    const iframe = await ensureBridge()
    iframe.contentWindow?.postMessage({ type: 'tc:plain', ...source }, '*')
  },
  // An <audio> of this page is playing a soundtrack of its own (§5.6). It is not a recording and
  // never becomes one: what it can be is the sound of a picture on the same page that has none,
  // and the registry decides that. Like a plain source it carries no material — the browser
  // fetched the track itself — so what crosses is the address and what the element knows of it.
  async (source) => {
    const iframe = await ensureBridge()
    iframe.contentWindow?.postMessage({ type: 'tc:sound', ...source }, '*')
  },
)

// Which stream an element is playing, when the stream comes out of a worker and has no address to
// be found by. The hook says it as an event on the element, because the two worlds share the DOM
// and nothing else; `composedPath()[0]` is the element itself even inside an open shadow tree,
// where `target` would have been retargeted to the host of it.
document.addEventListener(
  SOURCE_EVENT,
  (event: Event) => {
    const element = event.composedPath()[0]
    if (element) bindSource(element, String((event as CustomEvent).detail ?? ''))
  },
  true,
)
