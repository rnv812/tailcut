import { describe, it, expect } from 'vitest'
import { workerShimSource, type ShimConfig } from '../../src/page/worker-hook'

/**
 * The half of the hook that runs inside a page's worker.
 *
 * It ships as text and runs in a realm the page owns, so it is run here as text too: the source
 * is built exactly as the hook builds it and evaluated against a global of this set's making.
 * What is checked is the discipline the synchronous path of a player depends on — a copy taken
 * before appendBuffer returns, the sending put off to a microtask — and the promise that the
 * page's own worker is left as it was.
 */

const MIME = 'video/mp4; codecs="avc1.4d401e"'

const CONFIG: ShimConfig = {
  handshake: '__tailcut_worker__',
  original: 'https://site.example/js/player-worker.js',
  prefix: 'w1',
  module: false,
  compensate: true,
}

type Sent = { message: Record<string, unknown>; transfer: unknown[] }

/** A message the page's own worker handler was given: the handshake must never be among them. */
type Delivered = { data: unknown; stopped: boolean }

/**
 * A worker realm: everything the shim touches and nothing besides. The classes are built anew for
 * every realm — the shim rewrites their prototypes, and a shared class would come out wrapped
 * twice.
 */
function workerRealm() {
  const listeners: Array<(event: MessageEvent) => void> = []
  const imported: string[] = []
  const fetched: unknown[] = []
  const opened: unknown[] = []
  /** What the page's own handler saw, and whether the shim had stopped the event before it. */
  const delivered: Delivered[] = []

  class FakeSourceBuffer {
    readonly appended: Array<{ digest: string; byteLength: number }> = []
    constructor(readonly mime: string) {}
    appendBuffer(data: BufferSource): void {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data)
      this.appended.push({ digest: digest(bytes), byteLength: bytes.byteLength })
    }
  }

  class FakeHandle {}

  class FakeMediaSource {
    readonly buffers: FakeSourceBuffer[] = []
    /** Built once and given out on every read, as the browser's own handle is. */
    readonly ownHandle = new FakeHandle()
    /** How many times the page asked for the handle: the shim must not multiply the reads. */
    handleReads = 0

    get handle(): FakeHandle {
      this.handleReads++
      return this.ownHandle
    }

    addSourceBuffer(mime: string): FakeSourceBuffer {
      const buffer = new FakeSourceBuffer(mime)
      this.buffers.push(buffer)
      return buffer
    }
  }

  class FakeXhr {
    open(...args: unknown[]): void {
      opened.push(args)
    }
  }

  const scope: Record<string, unknown> = {
    location: { href: 'blob:https://site.example/6b1f' },
    MediaSource: FakeMediaSource,
    SourceBuffer: FakeSourceBuffer,
    XMLHttpRequest: FakeXhr,
    Request: class FakeRequest {
      constructor(readonly url: unknown) {}
    },
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === 'message') listeners.push(listener)
    },
    postMessage() {},
    /** The global is an EventTarget of its own, and the shim dispatches back into it. */
    dispatchEvent(event: MessageEvent) {
      let stopped = false
      const forwarded = new Proxy(event, {
        get: (target, key) =>
          key === 'stopImmediatePropagation'
            ? () => {
                stopped = true
              }
            : Reflect.get(target, key),
      })
      for (const listener of listeners) {
        if (stopped) break
        listener(forwarded)
      }
      return true
    },
    importScripts(...urls: string[]) {
      imported.push(...urls)
    },
    fetch(input: unknown) {
      fetched.push(input)
      return Promise.resolve(null)
    },
  }

  return {
    scope,
    imported,
    fetched,
    opened,
    delivered,
    MediaSource: FakeMediaSource,
    /**
     * Delivers a message to the worker global. The page's own handler is added after the shim's,
     * exactly as it would be — the page's script is loaded by the shim itself — so it sees the
     * message only if the shim let it through.
     */
    deliver(data: unknown, ports: MessagePort[] = []): Delivered {
      let stopped = false
      const record: Delivered = { data, stopped: false }
      const event = {
        data,
        ports,
        stopImmediatePropagation: () => {
          stopped = true
        },
      } as unknown as MessageEvent

      for (const listener of listeners) {
        if (stopped) break
        listener(event)
      }
      record.stopped = stopped
      delivered.push(record)
      return record
    },
    /** The page's worker script: a handler of its own, added the way a real one would be. */
    addPageHandler(): unknown[] {
      const seen: unknown[] = []
      listeners.push((event: MessageEvent) => seen.push(event.data))
      return seen
    },
  }
}

/** FNV-1a, 32 bits: the content is compared and not the length. */
function digest(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return `${bytes.byteLength}:${hash}`
}

/**
 * Runs the shim in the realm, as its first script.
 *
 * The source is the one the hook builds, with one allowance: this set is transformed by vitest
 * before the function is turned into text, and the transform rewrites `import()` into a helper of
 * its own. The build ships the call as written (esbuild, see build.mjs) and tests/e2e/worker.spec
 * runs that; here the helper is supplied, and it refuses — the module of a page cannot be fetched
 * in this realm, and what these tests are about is what the shim does around the loading rather
 * than the loading itself.
 */
function run(realm: ReturnType<typeof workerRealm>, config: Partial<ShimConfig> = {}): void {
  const source = workerShimSource({ ...CONFIG, ...config })
  const load = (url: string) => Promise.reject(new Error(`no module loading here: ${url}`))
  new Function('self', '__vite_ssr_dynamic_import__', source)(realm.scope, load)
}

/** The channel the main world hands the shim, and everything that came down it. */
function channel(): { port: MessagePort; sent: Sent[] } {
  const sent: Sent[] = []
  const port = {
    postMessage(message: unknown, transfer: unknown[] = []) {
      sent.push({ message: message as Record<string, unknown>, transfer })
    },
  } as unknown as MessagePort

  return { port, sent }
}

/** Everything above, in the order a wrapped worker does it. */
function connected(config: Partial<ShimConfig> = {}) {
  const realm = workerRealm()
  run(realm, config)
  const pageSaw = realm.addPageHandler()
  const link = channel()
  const handshake = realm.deliver({ [CONFIG.handshake]: CONFIG.prefix }, [link.port])
  return { realm, pageSaw, sent: link.sent, handshake }
}

describe('the shim inside the page worker', () => {
  it('loads the address the page asked for, last of all', async () => {
    const { realm } = connected()

    // Everything of ours is in place before the page's own script runs: a MediaSource built by
    // the first line of that script is already a MediaSource the hook sees.
    expect(realm.imported).toEqual([CONFIG.original])
  })

  it('takes the handshake off the page: its own handler never sees it', async () => {
    const { pageSaw, handshake } = connected()

    expect(handshake.stopped, 'the handshake was left to travel on to the page').toBe(true)
    expect(pageSaw).toEqual([])
  })

  it('lets every other message through untouched', async () => {
    const { realm, pageSaw } = connected()

    const message = { type: 'play', segments: [] }
    const delivered = realm.deliver(message)

    expect(delivered.stopped).toBe(false)
    expect(pageSaw).toEqual([message])
  })

  it('announces the stream when the page takes the handle of its MediaSource', async () => {
    const { realm, sent } = connected()

    const source = new realm.MediaSource()
    const handle = source.handle

    // The handle is what ties a MediaSource in a worker to an element of the page: the main
    // world pairs the two, and without the announcement there is nothing to pair.
    expect(handle).toBe(source.ownHandle)
    expect(source.handleReads, 'the wrapper read the handle more than the page did').toBe(1)
    expect(sent.map((item) => item.message)).toEqual([
      { type: 'tc:worker-ready' },
      { type: 'tc:worker', sourceId: 'w1s1' },
      { type: 'tc:handle', sourceId: 'w1s1' },
    ])
  })

  it('announces a stream that never gives out a handle, at its first buffer', async () => {
    const { realm, sent } = connected()

    const source = new realm.MediaSource()
    source.addSourceBuffer(MIME)

    // Announced all the same: a stream the watcher has not heard of is a stream no verdict is
    // ever spoken about, and material of that kind stays in the registry unjudged.
    expect(sent.map((item) => item.message)).toContainEqual({ type: 'tc:worker', sourceId: 'w1s1' })
  })

  it('gives the picture and the sound of one MediaSource their own identifiers', async () => {
    const { realm, sent } = connected()

    const source = new realm.MediaSource()
    const video = source.addSourceBuffer(MIME)
    const audio = source.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"')
    video.appendBuffer(new Uint8Array([1, 2, 3]))
    audio.appendBuffer(new Uint8Array([4, 5, 6]))
    await Promise.resolve()

    const appends = sent
      .map((item) => item.message)
      .filter((message) => message.type === 'tc:append')
    expect(appends.map((message) => [message.sourceId, message.bufferId, message.mime])).toEqual([
      ['w1s1', 'w1b2', MIME],
      ['w1s1', 'w1b3', 'audio/mp4; codecs="mp4a.40.2"'],
    ])
  })

  it('copies the segment before appendBuffer returns, and sends it in a microtask', async () => {
    const { realm, sent } = connected()

    const source = new realm.MediaSource()
    const buffer = source.addSourceBuffer(MIME)

    // A player is free to write into its own buffer the moment appendBuffer returns: MSE reads it
    // synchronously. Put the copy off and what reaches the bridge is the next segment's bytes, or
    // rubbish.
    const scratch = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const expected = digest(scratch.slice())
    buffer.appendBuffer(scratch)

    expect(
      sent.some((item) => item.message.type === 'tc:append'),
      'the sending was done inside appendBuffer, on the synchronous path of the player',
    ).toBe(false)

    scratch.fill(0)
    await Promise.resolve()

    const append = sent.find((item) => item.message.type === 'tc:append')!
    expect(digest(new Uint8Array(append.message.bytes as ArrayBuffer))).toBe(expected)
    // The copy is ours, and it travels by transfer: another copy on every segment would be paid
    // for by the page.
    expect(append.transfer).toEqual([append.message.bytes])
    // And the page's own buffer went to the browser untouched.
    expect(buffer.appended).toEqual([{ digest: expected, byteLength: 8 }])
  })

  it('copies the window of a view and not the whole buffer under it', async () => {
    const { realm, sent } = connected()

    const source = new realm.MediaSource()
    const buffer = source.addSourceBuffer(MIME)

    const under = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9])
    buffer.appendBuffer(new Uint8Array(under.buffer, 2, 4))
    await Promise.resolve()

    const append = sent.find((item) => item.message.type === 'tc:append')!
    expect(digest(new Uint8Array(append.message.bytes as ArrayBuffer))).toBe(
      digest(new Uint8Array([1, 2, 3, 4])),
    )
  })

  it('holds what it has to say until the channel arrives', async () => {
    const realm = workerRealm()
    run(realm)

    // The channel comes as a message and messages are delivered on a task: a MediaSource built
    // before that must not go unannounced.
    const source = new realm.MediaSource()
    source.addSourceBuffer(MIME).appendBuffer(new Uint8Array([1, 2, 3]))
    await Promise.resolve()

    const link = channel()
    realm.deliver({ [CONFIG.handshake]: CONFIG.prefix }, [link.port])

    expect(link.sent.map((item) => item.message.type)).toEqual([
      'tc:worker-ready',
      'tc:worker',
      'tc:append',
    ])
  })

  it('does not take a handshake meant for another worker', async () => {
    const realm = workerRealm()
    run(realm)
    const pageSaw = realm.addPageHandler()

    const link = channel()
    const delivered = realm.deliver({ [CONFIG.handshake]: 'w7' }, [link.port])

    expect(delivered.stopped).toBe(false)
    expect(link.sent, 'the shim answered down a channel that is not its own').toEqual([])
    expect(pageSaw).toHaveLength(1)
  })
})

describe('a module worker', () => {
  it('is not sent what the page posted before its module had run', async () => {
    const realm = workerRealm()
    // A module is loaded asynchronously — here it fails to load at all, which ends the wait the
    // same way. The browser holds the messages of a module worker until its module has been
    // evaluated; wrapped, the worker looks ready at once, and a message let through now would be
    // delivered to a worker with no listener on it and lost without a word.
    run(realm, { module: true })
    const pageSaw = realm.addPageHandler()
    realm.deliver({ [CONFIG.handshake]: CONFIG.prefix }, [channel().port])

    realm.deliver({ type: 'play', segments: [] })
    expect(pageSaw, 'a message was delivered while the module was still loading').toEqual([])

    // The import settles, one way or the other, and what was held goes in.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pageSaw).toEqual([{ type: 'play', segments: [] }])
  })

  it('takes messages as they come once its module has run', async () => {
    const realm = workerRealm()
    run(realm, { module: true })
    const pageSaw = realm.addPageHandler()
    realm.deliver({ [CONFIG.handshake]: CONFIG.prefix }, [channel().port])
    await new Promise((resolve) => setTimeout(resolve, 0))

    realm.deliver({ type: 'play', segments: [] })

    // Once and not twice: the holding is over, and a message that went straight to the page's
    // handler must not be dispatched again on top of it.
    expect(pageSaw).toEqual([{ type: 'play', segments: [] }])
  })
})

describe('the base address of a wrapped worker', () => {
  it('is the address the page asked for, not the blob the shim was loaded from', async () => {
    const { realm } = connected()

    const location = (realm.scope as { location: { href: string } }).location
    expect(location.href).toBe(CONFIG.original)
    expect(String(location)).toBe(CONFIG.original)
  })

  it('is what relative addresses resolve against', async () => {
    const { realm } = connected()
    const scope = realm.scope as {
      importScripts: (url: string) => void
      fetch: (input: unknown) => void
      XMLHttpRequest: new () => { open: (...args: unknown[]) => void }
      Request: new (url: unknown) => { url: unknown }
    }

    scope.importScripts('./transmuxer.js')
    scope.fetch('segment-1.m4s')
    new scope.XMLHttpRequest().open('GET', '../manifest.mpd')
    const request = new scope.Request('probe')

    // Measured against the same worker run without the extension: a blob has no base to resolve
    // against at all, and every one of these would have thrown where before it worked.
    expect(realm.imported).toEqual([
      CONFIG.original,
      'https://site.example/js/transmuxer.js',
    ])
    expect(realm.fetched).toEqual(['https://site.example/js/segment-1.m4s'])
    expect(realm.opened).toEqual([['GET', 'https://site.example/manifest.mpd']])
    expect(request.url).toBe('https://site.example/js/probe')
  })

  it('leaves an address that is already absolute exactly as it is', async () => {
    const { realm } = connected()
    const scope = realm.scope as { fetch: (input: unknown) => void }

    scope.fetch('https://cdn.example/seg.m4s?a=1&b=')
    scope.fetch({ url: 'a Request object, which resolves nothing here' })

    expect(realm.fetched).toEqual([
      'https://cdn.example/seg.m4s?a=1&b=',
      { url: 'a Request object, which resolves nothing here' },
    ])
  })

  it('is left alone for a worker the page itself started from a blob', async () => {
    // Twitch's own shape: the page makes its worker out of a blob, so a blob is the ground it
    // already stood on and there is nothing to put back. Touching it would be a change, not a
    // repair.
    const realm = workerRealm()
    run(realm, { original: 'blob:https://site.example/6b1f', compensate: false })
    const before = (realm.scope as { location: { href: string } }).location.href

    expect(before).toBe('blob:https://site.example/6b1f')
    ;(realm.scope as { fetch: (input: unknown) => void }).fetch('segment-1.m4s')
    expect(realm.fetched).toEqual(['segment-1.m4s'])
  })
})
