import { describe, it, expect, afterEach, vi } from 'vitest'
import { BRIDGE_PATH } from '../../src/shared/protocol'

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const BRIDGE_URL = `${EXTENSION_ORIGIN}/${BRIDGE_PATH}`

/** Where the browser takes an inserted frame whose address is not set yet. */
const BLANK = 'about:blank'

/** The page the content script stands on: its address and title go to the bridge. */
const PAGE_URL = 'https://site.example/watch?v=abc'
const PAGE_TITLE = 'Clip — site.example'
const CONTEXT = { type: 'tc:context', url: PAGE_URL, title: PAGE_TITLE }

/**
 * A minimal element: the content script touches only these properties. The frame meanwhile moves
 * between addresses the way a browser does — while it is out of the document, assigning src loads
 * nothing; the insertion starts loading the current address, and for a frame without one that is
 * about:blank; assigning src to a frame already inserted starts one more load. Each ends with a
 * load event of its own.
 */
function fakeElement(tagName: string) {
  const listeners: Record<string, Array<() => void>> = {}
  const attributes: Record<string, string> = {}
  /** Navigations started and not yet answered with a load, in the order they began. */
  const pending: string[] = []
  /** What the content script has sent into the document of the frame. */
  const posted: Array<{ message: unknown; transfer: unknown }> = []
  let attached = false
  let src = ''

  return {
    tagName,
    posted,
    contentWindow: {
      postMessage: (message: unknown, _targetOrigin: string, transfer?: unknown) => {
        posted.push({ message, transfer })
      },
    },
    dataset: {} as Record<string, string>,
    style: { cssText: '' },
    attributes,
    pending,
    /** The address whose load the frame has already answered; empty until the first load. */
    loaded: '',
    get src(): string {
      return src
    },
    set src(value: string) {
      src = value
      if (attached) pending.push(value)
    },
    /** Insertion into the document: from now on the frame loads whatever stands in its src. */
    attach: () => {
      attached = true
      pending.push(src || BLANK)
    },
    setAttribute: (name: string, value: string) => {
      attributes[name] = value
    },
    addEventListener: (type: string, listener: () => void) => {
      ;(listeners[type] ??= []).push(listener)
    },
    fire: (type: string) => {
      for (const listener of listeners[type] ?? []) listener()
    },
  }
}

type FakeElement = ReturnType<typeof fakeElement>

/**
 * A minimal <video>: the watcher reads only what is listed here. The default is a banner — a
 * muted looping preview with no controls, the kind that is due a rejection.
 */
function fakeVideo(overrides: Record<string, unknown> = {}) {
  const rect = { width: 160, height: 90, top: 0, left: 0, bottom: 90, right: 160 }
  return {
    src: 'blob:banner',
    currentSrc: 'blob:banner',
    muted: true,
    volume: 1,
    loop: true,
    controls: false,
    paused: false,
    ended: false,
    readyState: 4,
    isConnected: true,
    mediaKeys: null,
    getBoundingClientRect: () => rect,
    ...overrides,
  }
}

function installDom(options: { title?: string } = {}) {
  const created: FakeElement[] = []
  const appended: FakeElement[] = []
  const messageListeners: Array<(event: MessageEvent) => void> = []
  /** The <video> elements of the page: the watcher finds them via document.querySelectorAll. */
  const videos: ReturnType<typeof fakeVideo>[] = []
  /** The clock of the watcher: time is moved by tick(), not by the timer queue. */
  let now = 0

  // Only setTimeout stays real: the waits for microtasks below rest on it. The watcher polls on
  // setInterval, and the test has to decide for itself when that fires.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe(): void {}
    },
  )

  // The window of the page: the content script listens for the hook's messages on it, and by it
  // it tells its own window from a stranger's.
  const pageWindow = {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') messageListeners.push(listener)
    },
  }
  vi.stubGlobal('window', pageWindow)

  // The address and the title are mutable: a single-page application changes both without a
  // navigation, and that is what the page context has to survive.
  const location = { href: PAGE_URL }
  vi.stubGlobal('location', location)

  const document = {
    title: options.title ?? PAGE_TITLE,
    visibilityState: 'visible',
    querySelectorAll: () => videos,
    createElement: (tagName: string) => {
      const element = fakeElement(tagName)
      created.push(element)
      return element
    },
    documentElement: {
      appendChild: (element: FakeElement) => {
        appended.push(element)
        element.attach()
        return element
      },
    },
  }
  vi.stubGlobal('document', document)
  /** Listeners of chrome.runtime.onMessage: the popup and the service worker call them. */
  const tabRequestListeners: Array<
    (message: unknown, sender: unknown, sendResponse: (reply: unknown) => void) => boolean
  > = []

  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`,
      onMessage: {
        addListener: (listener: (typeof tabRequestListeners)[number]) =>
          tabRequestListeners.push(listener),
      },
    },
  })

  return {
    created,
    appended,
    pageWindow,
    videos,
    /** The page fills its <title> in — at document_start there was none. */
    setTitle: (title: string): void => {
      document.title = title
    },
    /** The page moves on to another video without a navigation, the way an SPA does. */
    goTo: (href: string, title: string): void => {
      location.href = href
      document.title = title
    },
    /** Runs one poll of the watcher and lets the microtask queue drain. */
    tick: async (): Promise<void> => {
      now += 500
      vi.advanceTimersByTime(500)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    /**
     * Delivers a message to the listener of the content script. The handler is asynchronous — it
     * waits for the bridge — so the microtask queue has to be drained after the delivery.
     */
    deliverMessage: async (data: unknown, source: unknown = pageWindow): Promise<void> => {
      for (const listener of messageListeners) listener({ data, source } as MessageEvent)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    /**
     * What went into the document of the bridge apart from the page context: the bridge gets that
     * on load, separately from the forwarding, and in the forwarding checks it is only in the
     * way. That it goes out at all is checked by the "page context" describe.
     */
    forwarded: (): Array<{ message: unknown; transfer: unknown }> =>
      created.flatMap((element) =>
        element.posted.filter(
          (post) => (post.message as { type?: unknown } | null)?.type !== 'tc:context',
        ),
      ),
    /** Every page context the content script has sent to the bridge, in order. */
    contexts: (): unknown[] =>
      created.flatMap((element) =>
        element.posted
          .map((post) => post.message)
          .filter((message) => (message as { type?: unknown } | null)?.type === 'tc:context'),
      ),
    /**
     * Delivers an extension request — the way the popup and the service worker send it. Gives
     * back what the listener answered synchronously (true holds the reply channel open) and the
     * replies that went into sendResponse.
     */
    askTab: (message: unknown) => {
      const answers: unknown[] = []
      const kept = tabRequestListeners.map((listener) =>
        listener(message, { id: EXTENSION_ORIGIN }, (reply) => answers.push(reply)),
      )
      return { answers, kept }
    },
    /** The ports the content script handed the bridge along with the extension requests. */
    portsToBridge: (): MessagePort[] =>
      created
        .flatMap((element) => element.posted)
        .flatMap((post) => (Array.isArray(post.transfer) ? post.transfer : []))
        .filter((item): item is MessagePort => item instanceof MessagePort),
    /** Addresses the frames have started loading and not yet answered. */
    pendingLoads: (): string[] => created.flatMap((element) => element.pending),
    /** Answers the nearest navigation: the browser sends a load for each, about:blank included. */
    deliverLoad: (): string => {
      const element = created.find((candidate) => candidate.pending.length > 0)
      if (!element) throw new Error('no frame has started loading')
      element.loaded = element.pending.shift()!
      element.fire('load')
      return element.loaded
    },
  }
}

/** The import inserts the bridge itself: the module calls ensureBridge() at the top level. */
async function importContent() {
  vi.resetModules()
  return import('../../src/page/content')
}

/** Takes cssText apart into declarations, so as not to depend on the order of the properties. */
function declarations(cssText: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of cssText.split(';')) {
    if (!part.trim()) continue
    const colon = part.indexOf(':')
    out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim()
  }
  return out
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ensureBridge', () => {
  it('inserts a frame with the bridge page when the module loads', async () => {
    const dom = installDom()
    await importContent()

    expect(dom.created).toHaveLength(1)
    const iframe = dom.created[0]!
    expect(iframe.tagName).toBe('iframe')
    // The address is built from the same constant as in the code: what is checked here is the
    // path to it — chrome.runtime.getURL of BRIDGE_PATH. That the constant itself points at a
    // file that exists and is declared in the manifest is checked by tests/build/dist.test.ts.
    expect(iframe.src).toBe(BRIDGE_URL)
    expect(iframe.dataset.tailcut).toBe('bridge')
    expect(iframe.attributes['aria-hidden']).toBe('true')
    expect(dom.appended).toEqual([iframe])
  })

  it('gives back the same promise on repeated calls and breeds no frames', async () => {
    const dom = installDom()
    const { ensureBridge } = await importContent()

    const first = ensureBridge()
    const second = ensureBridge()

    expect(second).toBe(first)
    expect(dom.created).toHaveLength(1)
    expect(dom.appended).toHaveLength(1)
  })

  it('declares the frame invisible and of no size', async () => {
    const dom = installDom()
    await importContent()

    expect(declarations(dom.created[0]!.style.cssText)).toMatchObject({
      position: 'fixed',
      width: '0',
      height: '0',
      border: '0',
      visibility: 'hidden',
      'pointer-events': 'none',
    })
  })

  it('resolves with the frame only once it has loaded', async () => {
    const dom = installDom()
    const { ensureBridge } = await importContent()

    let settled: unknown = null
    const pending = ensureBridge().then((iframe) => {
      settled = iframe
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBeNull()

    dom.deliverLoad()
    await pending
    expect(settled).toBe(dom.created[0])
  })

  it('gives back the frame that loaded the bridge page, not the blank page before it', async () => {
    const dom = installDom()
    const { ensureBridge } = await importContent()

    let loadedAtResolve: unknown = null
    const pending = ensureBridge().then((iframe) => {
      loadedAtResolve = (iframe as unknown as FakeElement).loaded
    })

    // A frame inserted before its src is assigned gets as far as about:blank, and a listener with
    // { once: true } fires on that. The consumer of the promise would get a frame with no bridge
    // in it: a postMessage into such a contentWindow vanishes silently, with no error and no
    // receiver.
    dom.deliverLoad()
    await pending

    expect(loadedAtResolve, 'the promise gave back the frame before the bridge had loaded').toBe(
      BRIDGE_URL,
    )
    expect(dom.pendingLoads(), 'the frame went somewhere other than the bridge page').toEqual([])
  })
})

describe('forwarding the hook messages into the bridge', () => {
  const bytes = () => new ArrayBuffer(8)
  const append = (buffer: ArrayBuffer) => ({
    type: 'tc:append',
    sourceId: 's1',
    bufferId: 'b1',
    mime: 'video/mp4',
    bytes: buffer,
  })

  /** Stands the content script up with the bridge already loaded and gives back its world. */
  async function withBridge() {
    const dom = installDom()
    await importContent()
    dom.deliverLoad()
    return dom
  }

  it('hands a segment to the bridge by transfer, not by copy', async () => {
    const dom = await withBridge()
    const buffer = bytes()

    await dom.deliverMessage(append(buffer))

    // A copy on this stretch would cost one more pass over every segment.
    expect(dom.forwarded()).toEqual([{ message: append(buffer), transfer: [buffer] }])
  })

  it('sends the housekeeping messages with no transfer list', async () => {
    const dom = await withBridge()
    const message = { type: 'tc:source', sourceId: 's1', objectUrl: 'blob:https://site.example/x' }

    await dom.deliverMessage(message)

    expect(dom.forwarded()).toEqual([{ message, transfer: undefined }])
  })

  it('does not let foreign messages into the bridge', async () => {
    const dom = await withBridge()

    // On live pages the window is showered with messages from bundlers, analytics and ads.
    await dom.deliverMessage({ type: 'webpackHotUpdate' })
    await dom.deliverMessage(null)
    await dom.deliverMessage('tc:append')

    expect(dom.forwarded()).toEqual([])
  })

  it('ignores a message that did not come from the window of the page', async () => {
    const dom = await withBridge()

    // The source is not our window: that is what a message from a nested frame or from the bridge
    // itself looks like. Taking it in, the content script would drive foreign bytes in circles.
    await dom.deliverMessage(append(bytes()), { name: 'another window' })

    expect(dom.forwarded()).toEqual([])
  })
})

describe('the page context for the bridge', () => {
  it('goes to the bridge right after it has loaded', async () => {
    const dom = installDom()
    await importContent()

    // Before load the bridge has not run its script: a message sent earlier would vanish
    // silently — no listener and no error.
    expect(dom.created[0]!.posted, 'the context went into the bridge before it loaded').toEqual([])

    dom.deliverLoad()

    // The title and the address of the page: on the extension origin the bridge knows neither.
    expect(dom.created[0]!.posted).toEqual([{ message: CONTEXT, transfer: undefined }])
  })

  it('goes out before the first forwarded segment', async () => {
    const dom = installDom()
    await importContent()
    dom.deliverLoad()

    await dom.deliverMessage({
      type: 'tc:append',
      sourceId: 's1',
      bufferId: 'b1',
      mime: 'video/mp4',
      bytes: new ArrayBuffer(8),
    })

    // The order is the whole point: a session is opened by the first init segment, and the
    // address and the title have to be with the bridge by then, or the session is born nameless.
    expect(
      dom.created[0]!.posted.map((post) => (post.message as { type: string }).type),
      'the segment outran the page context',
    ).toEqual(['tc:context', 'tc:append'])
  })

  it('tells the bridge the title the page filled in later', async () => {
    // The content script runs at document_start, where <head> is not parsed yet: at the moment
    // the bridge loads there is often no <title> at all, and a single-page application sets it
    // later still. Told once, the bridge signs every session of such a page with nothing.
    const dom = installDom({ title: '' })
    await importContent()
    dom.deliverLoad()
    expect(dom.contexts()).toEqual([{ type: 'tc:context', url: PAGE_URL, title: '' }])

    dom.setTitle(PAGE_TITLE)
    await dom.tick()

    expect(dom.contexts()).toEqual([
      { type: 'tc:context', url: PAGE_URL, title: '' },
      CONTEXT,
    ])
  })

  it('tells the bridge the next video of a page that navigates without a navigation', async () => {
    const dom = installDom()
    await importContent()
    dom.deliverLoad()

    // A feed of short clips and the "next video" of YouTube change the address through the
    // history API: no load fires, and there is nothing to hang a fresh context on but a poll.
    dom.goTo('https://site.example/watch?v=next', 'Next clip')
    await dom.tick()

    expect(dom.contexts().at(-1)).toEqual({
      type: 'tc:context',
      url: 'https://site.example/watch?v=next',
      title: 'Next clip',
    })
  })

  it('does not repeat a context that has not changed', async () => {
    const dom = installDom()
    await importContent()
    dom.deliverLoad()

    await dom.tick()
    await dom.tick()

    // The poll runs for as long as the page is open. Sending the same pair every half second
    // would be work for nobody: the bridge would rewrite the same title over and over.
    expect(dom.contexts()).toEqual([CONTEXT])
  })
})

describe('the triage verdict', () => {
  /** Stands the content script up with the bridge already loaded and gives back its world. */
  async function withBridge() {
    const dom = installDom()
    await importContent()
    dom.deliverLoad()
    return dom
  }

  it('goes to the bridge with the identifier of the stream whose element got it', async () => {
    const dom = await withBridge()
    dom.videos.push(fakeVideo())

    // The isolated world learns which stream an address belongs to from the hook's message — the
    // very one it forwards to the bridge.
    await dom.deliverMessage({ type: 'tc:source', sourceId: 's1', objectUrl: 'blob:banner' })
    await dom.tick()

    expect(dom.forwarded()).toEqual([
      {
        message: { type: 'tc:source', sourceId: 's1', objectUrl: 'blob:banner' },
        transfer: undefined,
      },
      { message: { type: 'tc:verdict', sourceId: 's1', verdict: 'reject' }, transfer: undefined },
    ])
  })

  it('remembers the stream-to-address binding without waiting for the bridge', async () => {
    const dom = installDom()
    await importContent()
    dom.videos.push(fakeVideo())

    // The hook hands over the address from createObjectURL at document_start — the bridge is
    // still loading then, and the first poll of the watcher may well pass before it is done.
    // Should the isolated world put the binding off until the bridge is ready, the verdict of
    // that poll would be left with no receiver and lost altogether.
    await dom.deliverMessage({ type: 'tc:source', sourceId: 's1', objectUrl: 'blob:banner' })
    await dom.tick()

    dom.deliverLoad()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dom.forwarded().map((post) => post.message)).toContainEqual({
      type: 'tc:verdict',
      sourceId: 's1',
      verdict: 'reject',
    })
  })

  it('refuses a stream that no element of the page is playing', async () => {
    const dom = await withBridge()
    // A real player, and it is playing something else. The stream of s1 is played by something
    // out of reach — an element inside a closed shadow root, or one not attached yet.
    dom.videos.push(
      fakeVideo({
        src: 'blob:someone-else',
        currentSrc: 'blob:someone-else',
        muted: false,
        loop: false,
        controls: true,
        getBoundingClientRect: () => ({
          width: 640,
          height: 360,
          top: 0,
          left: 0,
          bottom: 360,
          right: 640,
        }),
      }),
    )

    await dom.deliverMessage({ type: 'tc:source', sourceId: 's1', objectUrl: 'blob:banner' })
    for (let poll = 0; poll < 13; poll++) await dom.tick()

    // The stream is refused and the verdict of the neighbour is not lent to it: the bridge keeps
    // whatever it is not told to drop, so silence would record a stream nobody ever judged, while
    // the neighbour's promotion would confirm the wrong one. Thirteen polls is past the probation
    // of the player, which is what makes the two outcomes tell each other apart.
    expect(dom.forwarded()).toEqual([
      {
        message: { type: 'tc:source', sourceId: 's1', objectUrl: 'blob:banner' },
        transfer: undefined,
      },
      { message: { type: 'tc:verdict', sourceId: 's1', verdict: 'reject' }, transfer: undefined },
    ])
  })

  it('cancels the recording of a real player too when keys are requested', async () => {
    const dom = await withBridge()
    const player = fakeVideo({
      src: 'blob:player',
      currentSrc: 'blob:player',
      muted: false,
      loop: false,
      controls: true,
      getBoundingClientRect: () => ({
        width: 640,
        height: 360,
        top: 0,
        left: 0,
        bottom: 360,
        right: 640,
      }),
    })
    dom.videos.push(player)

    await dom.deliverMessage({ type: 'tc:source', sourceId: 's1', objectUrl: 'blob:player' })
    await dom.tick()
    expect(
      dom.forwarded().map((post) => (post.message as { type: string }).type),
      'setup: before the keys are requested there is nothing to refuse the player for',
    ).toEqual(['tc:source'])

    await dom.deliverMessage({ type: 'tc:drm', sourceId: 'page' })
    await dom.tick()

    expect(dom.forwarded().at(-1)).toEqual({
      message: { type: 'tc:verdict', sourceId: 's1', verdict: 'reject' },
      transfer: undefined,
    })
  })
})

describe('requests from the popup and the service worker', () => {
  /** Stands the content script up with the bridge already loaded and gives back its world. */
  async function withBridge() {
    const dom = installDom()
    await importContent()
    dom.deliverLoad()
    return dom
  }

  /** Answers for the bridge into the port the content script handed it. */
  async function replyFromBridge(dom: ReturnType<typeof installDom>, reply: unknown) {
    const [port] = dom.portsToBridge()
    expect(port, 'the content script handed the bridge no channel to answer on').toBeDefined()
    port!.postMessage(reply)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const summary = {
    key: 'https://site.example/watch|avc1|inf',
    url: PAGE_URL,
    title: PAGE_TITLE,
    duration: 6,
    bytes: 1543,
    runs: 1,
  }

  it('sends the list request to the bridge together with a channel to answer on', async () => {
    const dom = await withBridge()

    const { kept } = dom.askTab({ type: 'tc:list' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dom.forwarded().map((post) => post.message)).toEqual([{ type: 'tc:list' }])
    expect(dom.portsToBridge(), 'the bridge has nothing to answer with').toHaveLength(1)
    // Chrome closes the reply channel as soon as the listener returns anything but true — the
    // popup would get undefined before the bridge had even seen the request.
    expect(kept, 'the listener did not hold the reply channel').toEqual([true])
  })

  it('carries the answer of the bridge back to the asker', async () => {
    const dom = await withBridge()

    const { answers } = dom.askTab({ type: 'tc:list' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await replyFromBridge(dom, [summary])

    expect(answers).toEqual([[summary]])
  })

  it('sends the save request to the bridge by the same road', async () => {
    const dom = await withBridge()

    const { answers, kept } = dom.askTab({ type: 'tc:save', key: summary.key })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await replyFromBridge(dom, { ok: true })

    expect(dom.forwarded().map((post) => post.message)).toEqual([
      { type: 'tc:save', key: summary.key },
    ])
    expect(kept).toEqual([true])
    expect(answers).toEqual([{ ok: true }])
  })

  it('delivers a request that arrived before the bridge had loaded once it has', async () => {
    const dom = installDom()
    await importContent()

    // The popup is opened whenever, including on a page where the bridge is still loading.
    const { kept } = dom.askTab({ type: 'tc:list' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dom.forwarded(), 'the request went into a frame that had not loaded').toEqual([])
    expect(kept).toEqual([true])

    dom.deliverLoad()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dom.forwarded().map((post) => post.message)).toEqual([{ type: 'tc:list' }])
  })

  it('neither forwards a foreign extension message nor holds the channel for it', async () => {
    const dom = await withBridge()

    // chrome.runtime.onMessage has several listeners across the extension: hold the channel of
    // someone else's request here, and the answer of its real addressee goes nowhere.
    const { kept } = dom.askTab({ type: 'tc:ping' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(kept).toEqual([false])
    expect(dom.forwarded()).toEqual([])
  })
})
