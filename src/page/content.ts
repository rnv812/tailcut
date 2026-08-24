import { BRIDGE_PATH, SOURCE_EVENT, isExtensionToTab, isPageToBridge } from '../shared/protocol'
import { bindSource, registerSource, registerWorkerSource, startWatching } from './watcher'

let bridgePromise: Promise<HTMLIFrameElement> | null = null

/**
 * How often the address and the title of the page are re-read.
 *
 * By polling and not by observation: a title change is a character-data mutation inside <head>,
 * and an address change on a single-page application is a pushState with nothing in the DOM to
 * watch at all. A MutationObserver wide enough to catch the first would fire on every text node
 * a busy page touches, which is exactly the cost this extension must not impose. Two string
 * comparisons twice a second cost nothing beside it.
 */
const CONTEXT_POLL_MS = 500

interface PageContext {
  url: string
  title: string
}

/** What the bridge has already been told; null — it has not been told anything yet. */
let toldContext: PageContext | null = null

function pageContext(): PageContext {
  return { url: location.href, title: document.title }
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
 * Keeps the bridge's idea of the page up to date.
 *
 * At document_start the page has no title yet, and on a single-page application it has no final
 * address either: YouTube fills its <title> in after the player has already started and swaps
 * both when the next video is opened without a navigation. Told once, the bridge would sign every
 * session of such a page with nothing, and the saved file would be named after nothing.
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

window.addEventListener('message', async (event: MessageEvent) => {
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
