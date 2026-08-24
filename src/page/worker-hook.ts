import { SOURCE_EVENT, type PageToBridge } from '../shared/protocol'

/**
 * Recording a player whose MediaSource lives in a worker.
 *
 * Measured on twitch, live and VOD alike: `video.srcObject = MediaSourceHandle`, the MediaSource
 * and every SourceBuffer built inside a DedicatedWorker, `URL.createObjectURL(MediaSource)` never
 * called in the main world. A content script does not run in a worker, so the hook in the page
 * sees nothing at all while 39–56 MB go by in ninety seconds.
 *
 * The only way into a worker is the script it starts from, so the Worker constructor is wrapped:
 * the page's address is loaded from inside a blob whose first lines are ours. What that costs and
 * what it must not cost is written out at each step below; the short of it is that a page whose
 * worker cannot be wrapped safely gets its worker exactly as it asked for it.
 */

/** Marks the one message that hands a wrapped worker its private channel. */
const HANDSHAKE = '__tailcut_worker__'

/** Script of the probe worker: it only has to prove that it started. */
const PROBE_SCRIPT = 'self.postMessage(0)'

/** What a wrapped worker says over its private channel. */
type FromWorker =
  | { type: 'tc:worker-ready' }
  | { type: 'tc:worker'; sourceId: string }
  | { type: 'tc:handle'; sourceId: string }
  | { type: 'tc:worker-failed'; text: string }
  | { type: 'tc:append'; sourceId: string; bufferId: string; mime: string; bytes: ArrayBuffer }

export interface ShimConfig {
  handshake: string
  /** Address of the script the page asked for, absolute. */
  original: string
  /** Keeps the identifiers of this worker apart from the page's and from other workers'. */
  prefix: string
  module: boolean
  /**
   * Whether the base address has to be put back by hand; see the compensation in the shim. False
   * for a worker the page itself started from a blob, where there is nothing to put back.
   */
  compensate: boolean
}

/** The part of a worker's global this shim touches. Its realm is not the page's. */
interface WorkerScope {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  dispatchEvent(event: Event): boolean
  postMessage(message: unknown, transfer?: Transferable[]): void
  importScripts?: (...urls: string[]) => void
  location: { href: string }
  MediaSource?: typeof MediaSource
  SourceBuffer?: typeof SourceBuffer
  XMLHttpRequest?: typeof XMLHttpRequest
  Request?: typeof Request
  fetch?: typeof fetch
}

/**
 * What runs inside the worker, ahead of the page's own script.
 *
 * Written as a function so that it is typed and read like the rest of the program, and shipped by
 * `toString()`: it has to cross into another realm as text. Nothing outside its argument may be
 * named here — a closure does not survive the crossing.
 */
function workerShim(config: ShimConfig): void {
  const scope = self as unknown as WorkerScope

  let port: MessagePort | null = null
  const waiting: Array<[unknown, Transferable[]]> = []
  let counter = 0

  const id = (kind: string): string => `${config.prefix}${kind}${++counter}`

  // Taken before anything below can wrap it: the page's own script is loaded with this at the
  // end, and it must be the browser's importScripts and not the one the compensation installs.
  const loadScript = scope.importScripts

  const send = (message: FromWorker, transfer: Transferable[] = []): void => {
    if (port) port.postMessage(message, transfer)
    else waiting.push([message, transfer])
  }

  // The channel arrives as a message, and the page's own handler must never see it: a worker is
  // free to refuse a message it did not expect. This listener is the first on the global — the
  // page's script has not run yet — so stopping the event here stops it for every listener the
  // page adds afterwards, `onmessage` included.
  scope.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null
    if (!data || data[config.handshake] !== config.prefix) return

    event.stopImmediatePropagation()
    port = event.ports[0] ?? null
    if (!port) return
    for (const [message, transfer] of waiting) port.postMessage(message, transfer)
    waiting.length = 0
  })

  // The base address. A worker started from a blob resolves its relative addresses against that
  // blob — which is to say it cannot resolve them at all — and the page's own worker, if it was
  // started from an address, resolved them against that address. Wrapping must not move that
  // ground: `location`, importScripts, fetch, Request and XMLHttpRequest are put back onto the
  // address the page asked for. Measured against the same page run without the extension: all
  // five answer identically, and a worker the page itself started from a blob is left alone,
  // because for it the blob is the ground it already stood on.
  if (config.compensate) {
    const base = config.original
    const resolve = (input: unknown): unknown => {
      if (typeof input !== 'string') return input
      try {
        new URL(input)
        return input
      } catch {
        // Not absolute; that is the whole of what the failure means here.
      }
      try {
        return new URL(input, base).href
      } catch {
        return input
      }
    }

    try {
      const address = new URL(base)
      const location = {
        href: address.href,
        origin: address.origin,
        protocol: address.protocol,
        host: address.host,
        hostname: address.hostname,
        port: address.port,
        pathname: address.pathname,
        search: address.search,
        hash: address.hash,
        toString: () => address.href,
      }
      Object.defineProperty(scope, 'location', { configurable: true, get: () => location })
    } catch {
      // A base that will not parse leaves the worker with the blob address it was given.
    }

    if (loadScript) {
      scope.importScripts = function (...urls: string[]): void {
        return loadScript.apply(scope, urls.map(resolve) as string[])
      }
    }

    const fetching = scope.fetch
    if (fetching) {
      scope.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        return fetching.call(scope, resolve(input) as RequestInfo, init)
      }
    }

    const RealRequest = scope.Request
    if (RealRequest) {
      scope.Request = new Proxy(RealRequest, {
        construct: (target, args: unknown[], newTarget) =>
          Reflect.construct(target, [resolve(args[0]), args[1]], newTarget),
      })
    }

    const RealXhr = scope.XMLHttpRequest
    if (RealXhr) {
      const open = RealXhr.prototype.open
      RealXhr.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
        args[1] = resolve(args[1])
        return (open as (...rest: unknown[]) => void).apply(this, args)
      }
    }
  }

  const Source = scope.MediaSource
  const Buffer = scope.SourceBuffer
  if (Source && Buffer) {
    const sources = new WeakMap<MediaSource, string>()
    const buffers = new WeakMap<
      SourceBuffer,
      { sourceId: string; bufferId: string; mime: string }
    >()

    const announce = (source: MediaSource): string => {
      const known = sources.get(source)
      if (known) return known

      const sourceId = id('s')
      sources.set(source, sourceId)
      // The isolated world learns of the stream from here and from nowhere else: a MediaSource in
      // a worker has no address, so the watcher cannot find it by one. Announced, it is judged;
      // unannounced, it would be recorded without a verdict ever being spoken about it.
      send({ type: 'tc:worker', sourceId })
      return sourceId
    }

    // The handle is the one thing that ties this MediaSource to an element of the page: it is
    // taken here and assigned to srcObject there, and the two ends are put together in the main
    // world (see the pairing in installWorkerHook).
    const handle = Object.getOwnPropertyDescriptor(Source.prototype, 'handle')
    if (handle?.get) {
      const take = handle.get
      Object.defineProperty(Source.prototype, 'handle', {
        configurable: true,
        enumerable: handle.enumerable,
        get(this: MediaSource): MediaSourceHandle {
          const taken = take.call(this) as MediaSourceHandle
          send({ type: 'tc:handle', sourceId: announce(this) })
          return taken
        },
      })
    }

    const addSourceBuffer = Source.prototype.addSourceBuffer
    Source.prototype.addSourceBuffer = function (this: MediaSource, mime: string): SourceBuffer {
      const buffer = addSourceBuffer.call(this, mime)
      buffers.set(buffer, { sourceId: announce(this), bufferId: id('b'), mime })
      return buffer
    }

    const appendBuffer = Buffer.prototype.appendBuffer
    Buffer.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource): void {
      const tracked = buffers.get(this)

      // The same discipline as in the main world: a copy taken synchronously, because MSE reads
      // the caller's buffer synchronously and a player may write into it the moment appendBuffer
      // returns; and the sending itself put off to a microtask, so that the synchronous path of
      // the player stays empty.
      if (tracked) {
        let bytes: ArrayBuffer
        if (data instanceof ArrayBuffer) {
          bytes = data.slice(0)
        } else {
          const view = data as ArrayBufferView
          bytes = new ArrayBuffer(view.byteLength)
          new Uint8Array(bytes).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
        }
        queueMicrotask(() => {
          send(
            {
              type: 'tc:append',
              sourceId: tracked.sourceId,
              bufferId: tracked.bufferId,
              mime: tracked.mime,
              bytes,
            },
            [bytes],
          )
        })
      }

      return appendBuffer.call(this, data)
    }
  }

  send({ type: 'tc:worker-ready' })

  // Last of all, the script the page asked for. A module keeps its own address for its own
  // imports and for import.meta.url, so nothing has to be put back for it beyond `location`.
  if (config.module) {
    // A module is loaded asynchronously, and that is a difference the page must not feel. The
    // browser holds the messages sent to a module worker until its module has been evaluated;
    // wrapped, the worker looks evaluated the moment this line is reached, and everything the
    // page posts in the meantime would be delivered to a worker that has not registered a
    // listener yet — thrown away in silence. So the gap is held here: what arrives during the
    // load is kept back and dispatched again once the page's own module is in place.
    let loading = true
    const missed: MessageEvent[] = []

    scope.addEventListener('message', (event: MessageEvent) => {
      if (!loading) return
      missed.push(event)
      event.stopImmediatePropagation()
    })

    const opened = (): void => {
      loading = false
      for (const event of missed) {
        scope.dispatchEvent(
          new MessageEvent('message', {
            data: event.data,
            origin: event.origin,
            lastEventId: event.lastEventId,
            ports: [...event.ports],
          }),
        )
      }
      missed.length = 0
    }

    import(/* @vite-ignore */ config.original).then(opened, (error: unknown) => {
      send({ type: 'tc:worker-failed', text: String(error) })
      // Let the messages through even so: the page's worker is broken either way, and holding
      // them back would add a second failure of our own making on top of the first.
      opened()
    })
  } else if (loadScript) {
    try {
      loadScript.call(scope, config.original)
    } catch (error) {
      send({ type: 'tc:worker-failed', text: String(error) })
      throw error
    }
  }
}

/**
 * The shim as text: the whole of a wrapped worker's first script, with the page's own address
 * loaded at the end of it. A function crosses realms only as source, and this is where it is
 * turned into some — which is also where a test can take it and run it in a realm of its own.
 */
export function workerShimSource(config: ShimConfig): string {
  return `(${workerShim.toString()})(${JSON.stringify(config)})`
}

type Send = (message: PageToBridge, transfer?: Transferable[]) => void

/**
 * Wraps the Worker constructor so that a MediaSource built inside a worker is seen, and tells the
 * isolated world which element each of them ended up playing on.
 */
export function installWorkerHook(send: Send): void {
  // `window` and not `self`: this half runs in a document, and the shim above is the half that
  // runs in a worker. A realm without Worker in it has nothing here to wrap.
  const RealWorker = window.Worker
  if (!RealWorker) return

  /**
   * May a blob worker be started on this page? null while the answer is not in.
   *
   * It has to be asked, and it cannot be asked synchronously. A Content-Security-Policy that
   * refuses blob workers does not throw from the constructor: the worker is handed back as if it
   * were alive and fails on the next task, and a page whose worker was wrapped at that moment has
   * lost its worker for good. So a probe worker of two words is started at document_start, and
   * until it answers no worker of the page is touched. Measured: a refusal is in before the first
   * task 40 times out of 40, with the main thread busy or idle, while the earliest worker a page
   * can build arrives several tasks later — twitch builds its own at 1024 ms.
   */
  let blobWorkersAllowed: boolean | null = null

  const askAboutBlobWorkers = (): void => {
    let probeUrl = ''
    let probe: Worker | null = null

    /** Nothing more to learn: the probe is taken down and the page is left as it was. */
    const done = (): void => {
      document.removeEventListener('securitypolicyviolation', onViolation, true)
      probe?.terminate()
      probe = null
      if (probeUrl) URL.revokeObjectURL(probeUrl)
      probeUrl = ''
    }

    /**
     * A refusal, and it counts whenever it comes. The measurement says it always comes inside the
     * first task, but "always" was measured and not promised: a refusal arriving after the
     * verdict has been given still takes the mechanism away from every worker after it.
     */
    const refuse = (): void => {
      blobWorkersAllowed = false
      done()
    }

    const onViolation = (event: SecurityPolicyViolationEvent): void => {
      if (event.blockedURI !== 'blob') return
      // Ours, with all but certainty: the listener stands for one task at document_start and is
      // taken down the moment the answer is in. A refusal the page earned itself is its own
      // business, but it cannot be told from this one — blockedURI is the word "blob" and nothing
      // more — and a report of a violation the page did not commit is worse than a missing one.
      event.stopImmediatePropagation()
      refuse()
    }

    try {
      document.addEventListener('securitypolicyviolation', onViolation, true)
      probeUrl = URL.createObjectURL(new Blob([PROBE_SCRIPT], { type: 'text/javascript' }))
      probe = new RealWorker(probeUrl)
      probe.onerror = refuse
      // It started, so there was never anything to refuse: the probe has done its work and goes.
      probe.onmessage = done

      // One task later there has been no refusal, and that is the answer. Waiting for the probe
      // to boot instead would cost ten milliseconds and more of a page's start-up, which is
      // exactly where the workers of a player are built.
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        if (blobWorkersAllowed === null) blobWorkersAllowed = true
        document.removeEventListener('securitypolicyviolation', onViolation, true)
      }
      channel.port2.postMessage(0)
    } catch {
      // The probe was refused before it began. A page that requires trusted script addresses
      // ends here: measured on one with require-trusted-types-for 'script', where its own
      // worker — built from a TrustedScriptURL — runs, and the plain string of this probe is
      // refused. Nothing of such a page is wrapped, which is the whole of what it costs.
      refuse()
    }
  }

  /** Streams whose handle has been taken but which no element has been seen to play yet. */
  const unpairedSources: string[] = []
  /** Elements playing a handle that has not been named yet. */
  const unpairedElements: HTMLMediaElement[] = []

  /**
   * Names to the isolated world the stream an element is playing. An empty name says the opposite
   * — that a handle is playing here and the hook cannot say whose — and that is what a page whose
   * worker could not be wrapped looks like from the outside.
   *
   * An event and not a property: the two worlds share the DOM and nothing else, so a mark set on
   * the element in this world would be invisible in that one. It carries `composed` because the
   * element may live in a shadow tree, where the listener of the isolated world reads it out of
   * `composedPath()`.
   */
  const name = (element: HTMLMediaElement, sourceId: string): void => {
    try {
      element.dispatchEvent(
        new CustomEvent(SOURCE_EVENT, { detail: sourceId, bubbles: true, composed: true }),
      )
    } catch {
      // A page that broke dispatchEvent is not a reason to break the assignment it is in.
    }
  }

  const pair = (): void => {
    while (unpairedSources.length > 0 && unpairedElements.length > 0) {
      const sourceId = unpairedSources.shift()!
      name(unpairedElements.shift()!, sourceId)
    }
  }

  const receive = (message: FromWorker, revoke: () => void): void => {
    if (message.type === 'tc:worker-ready') return revoke()
    if (message.type === 'tc:worker-failed') {
      // The wrapper could not load the page's own script. Nothing here can undo that for the
      // worker it happened to, but every worker after it is left alone.
      blobWorkersAllowed = false
      return
    }
    if (message.type === 'tc:worker') return send({ type: 'tc:worker', sourceId: message.sourceId })
    if (message.type === 'tc:handle') {
      unpairedSources.push(message.sourceId)
      return pair()
    }

    send(
      {
        type: 'tc:append',
        sourceId: message.sourceId,
        bufferId: message.bufferId,
        mime: message.mime,
        bytes: message.bytes,
      },
      [message.bytes],
    )
  }

  let workers = 0

  /**
   * The wrapped worker, or null when this one is to be built exactly as the page asked.
   *
   * Everything that could make the page's worker behave differently ends here rather than in a
   * guess: an address of another origin is refused by the constructor itself and must go on being
   * refused, a policy that forbids blob workers takes the whole mechanism away, and anything that
   * throws on the way leaves the page with its own arguments untouched.
   */
  const wrap = (target: typeof Worker, args: unknown[], newTarget: Function): Worker | null => {
    if (blobWorkersAllowed !== true) return null
    // `new Worker()` with nothing in it is a TypeError from the browser, and it has to stay one:
    // a wrapper that made an address out of nothing would answer with a worker instead.
    if (args.length === 0) return null

    const prefix = `w${++workers}`

    let config: ShimConfig
    try {
      const original = new URL(String(args[0]), location.href)
      // Same origin or the page's own blob. A dedicated worker of another origin is a
      // SecurityError, and importScripts inside a blob is not: wrapping would quietly grant the
      // page something the browser had refused it.
      if (original.origin !== location.origin) return null

      const options = args[1] as WorkerOptions | undefined
      config = {
        handshake: HANDSHAKE,
        original: original.href,
        prefix,
        module: options?.type === 'module',
        compensate: original.protocol !== 'blob:' && original.protocol !== 'data:',
      }
    } catch {
      // An address this call cannot make sense of, and nothing more than that: the page gets its
      // own arguments and the next worker is judged on its own.
      return null
    }

    let blobUrl = ''
    let worker: Worker
    try {
      blobUrl = URL.createObjectURL(
        new Blob([workerShimSource(config)], { type: 'text/javascript' }),
      )
      worker = Reflect.construct(target, [blobUrl, args[1]], newTarget) as Worker
    } catch {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      // The page will not take what we handed it, for a reason the probe did not turn up. The
      // page gets the worker it asked for, and one refusal is the whole answer for the page:
      // nothing after this is wrapped, so it is not made to refuse the same thing again.
      blobWorkersAllowed = false
      return null
    }

    const revoke = (): void => URL.revokeObjectURL(blobUrl)
    const channel = new MessageChannel()
    channel.port1.onmessage = (event: MessageEvent) => receive(event.data as FromWorker, revoke)
    // Before anything the page will send: a message queued first is delivered first, so the
    // worker has its channel by the time the page's own first message arrives.
    worker.postMessage({ [HANDSHAKE]: prefix }, [channel.port2])

    return worker
  }

  window.Worker = new Proxy(RealWorker, {
    construct(target, args: unknown[], newTarget) {
      return wrap(target, args, newTarget) ?? Reflect.construct(target, args, newTarget)
    },
  })

  // Which element a worker's MediaSource ended up on. There is no address to go by — with a
  // handle, `video.currentSrc` stays empty — so the assignment itself is the only place the two
  // can be tied together, and the watcher needs them tied to have anything to judge.
  const srcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject')
  if (srcObject?.set) {
    const assign = srcObject.set
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      enumerable: srcObject.enumerable,
      get: srcObject.get,
      set(this: HTMLMediaElement, value: unknown) {
        assign.call(this, value)

        const Handle = (window as { MediaSourceHandle?: Function }).MediaSourceHandle
        if (!Handle || !(value instanceof Handle)) return

        // Said at once and without a name: from this moment the element is playing a stream out
        // of a worker, and whether the hook can name it is the difference between recording the
        // page and telling the user plainly that it cannot be recorded.
        name(this, '')
        unpairedElements.push(this)
        pair()
      },
    })
  }

  askAboutBlobWorkers()
}
