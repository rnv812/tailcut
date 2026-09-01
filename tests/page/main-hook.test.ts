import { describe, it, expect, afterEach, vi } from 'vitest'

/** Bridge origin: extension pages use it, while a site document never can. */
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

const MIME = 'video/mp4; codecs="avc1.4d401e"'
/** Audio track: every DASH/HLS stream gives it a separate SourceBuffer on the same MediaSource. */
const AUDIO_MIME = 'audio/mp4; codecs="mp4a.40.2"'

/** 32-bit FNV-1a: compare contents, not length, so another memory region of equal size fails. */
function digest(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return `${bytes.byteLength}:${hash}`
}

/** A recognizable pattern in place of a real segment, since nothing here parses it. */
function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index++) bytes[index] = (index * 31 + 7) & 0xff
  return bytes
}

function segment(length: number): ArrayBuffer {
  const buffer = new ArrayBuffer(length)
  new Uint8Array(buffer).set(pattern(length))
  return buffer
}

/** Snapshot data at call time because it cannot be read after the buffer is detached. */
function snapshot(data: BufferSource): { byteLength: number; digest: string } {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
    : new Uint8Array(data).slice()
  return { byteLength: bytes.byteLength, digest: digest(bytes) }
}

type Posted = {
  /** Message exactly as the recipient would receive it. */
  message: Record<string, unknown>
  /** Number of objects sent in the transfer list. */
  transferred: number
  /** Whether the segment buffer itself was transferred; otherwise every segment is copied. */
  transfersBytes: boolean
}

/** State to restore after a test in addition to stubbed globals. */
const cleanups: Array<() => void> = []

/**
 * Fake page realm: window, URL, MediaSource, SourceBuffer, and navigator. The hook patches
 * prototypes at module top level, so every installation creates new classes. Otherwise the next
 * import would wrap an already wrapped prototype.
 *
 * `eme: false` represents a page without EME: Chrome does not expose
 * navigator.requestMediaKeySystemAccess on HTTP.
 */
function installPage(options: { eme?: boolean } = {}) {
  const posted: Posted[] = []
  const emeCalls: Array<{ keySystem: string; configs: unknown; thisArg: unknown }> = []

  class FakeSourceBuffer {
    readonly appended: Array<{ byteLength: number; digest: string }> = []
    timestampOffset = 0
    mode: AppendMode = 'segments'
    sequenceOffsetAfterAppend = 0
    private readonly listeners: Array<{
      listener: EventListenerOrEventListenerObject
      once: boolean
    }> = []
    /**
     * What the browser throws instead of appending. appendBuffer exceptions are normal MSE
     * behavior: QuotaExceededError for a full buffer and InvalidStateError when appending during
     * an update. The real appendBuffer throws before accepting anything.
     */
    failWith: unknown = null
    constructor(readonly mime: string) {}
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ): void {
      if (type !== 'updateend') return
      this.listeners.push({
        listener,
        once: typeof options === 'object' && options.once === true,
      })
    }
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type !== 'updateend') return
      const at = this.listeners.findIndex((entry) => entry.listener === listener)
      if (at >= 0) this.listeners.splice(at, 1)
    }
    appendBuffer(data: BufferSource): void {
      if (this.failWith !== null) throw this.failWith
      this.appended.push(snapshot(data))
      if (this.mode === 'sequence') this.timestampOffset = this.sequenceOffsetAfterAppend
      for (const entry of [...this.listeners]) {
        if (typeof entry.listener === 'function') entry.listener(new Event('updateend'))
        else entry.listener.handleEvent(new Event('updateend'))
        if (entry.once) this.removeEventListener('updateend', entry.listener)
      }
    }
  }

  class FakeMediaSource {
    readonly buffers: FakeSourceBuffer[] = []
    /**
     * Duration as stored by the browser: a prototype accessor that is NaN before assignment. The
     * player sets it after reading the manifest, and MSE then exposes it to the element.
     */
    stored = NaN
    /**
     * What the browser throws instead of assigning. The real setter throws InvalidStateError for
     * an unopened source or while a buffer is updating, before changing anything.
     */
    failDurationWith: unknown = null
    get duration(): number {
      return this.stored
    }
    set duration(value: number) {
      if (this.failDurationWith !== null) throw this.failDurationWith
      this.stored = Number(value)
    }
    addSourceBuffer(mime: string): FakeSourceBuffer {
      const sourceBuffer = new FakeSourceBuffer(mime)
      this.buffers.push(sourceBuffer)
      return sourceBuffer
    }
  }

  let urlCounter = 0

  /** Window listeners through which bridge messages reach the hook. */
  const listeners: Array<(event: MessageEvent) => void> = []

  vi.stubGlobal('window', {
    addEventListener(type: string, listener: (event: MessageEvent) => void): void {
      if (type === 'message') listeners.push(listener)
    },
    postMessage(message: unknown, _targetOrigin: string, transfer: Transferable[] = []): void {
      const bytes = (message as { bytes?: unknown }).bytes
      posted.push({
        transferred: transfer.length,
        transfersBytes: transfer.length === 1 && transfer[0] === bytes,
        // Real transfer semantics detach the listed buffers from the sender.
        message: structuredClone(message, { transfer }) as Record<string, unknown>,
      })
    },
  })

  // URL cannot be replaced wholesale because the environment needs it as a constructor. Replace
  // only createObjectURL, which the hook wraps, and restore its original descriptor afterward.
  const pristine = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (): string => `blob:https://site.example/${++urlCounter}`,
  })
  cleanups.push(() => {
    if (pristine) Object.defineProperty(URL, 'createObjectURL', pristine)
    else delete (URL as { createObjectURL?: unknown }).createObjectURL
  })

  vi.stubGlobal('MediaSource', FakeMediaSource)
  vi.stubGlobal('SourceBuffer', FakeSourceBuffer)

  const navigatorStub: Record<string, unknown> = { userAgent: 'test' }
  if (options.eme !== false) {
    navigatorStub.requestMediaKeySystemAccess = function (
      this: unknown,
      keySystem: string,
      configs: unknown,
    ) {
      emeCalls.push({ keySystem, configs, thisArg: this })
      return Promise.resolve({ keySystem })
    }
  }
  vi.stubGlobal('navigator', navigatorStub)

  return {
    posted,
    emeCalls,
    MediaSource: FakeMediaSource,
    SourceBuffer: FakeSourceBuffer,
    /** Messages of one type in send order. */
    of: (type: string): Posted[] => posted.filter((item) => item.message.type === type),
    /**
     * Deliver a message to the page window. The origin is explicit because the hook listens only
     * to its extension and must ignore the same message from the page origin.
     */
    deliver(data: unknown, origin = EXTENSION_ORIGIN): void {
      for (const listener of listeners) {
        listener({ data, origin } as unknown as MessageEvent)
      }
    },
  }
}

/** Importing installs the wrappers because the module contains only top-level code. */
async function importHook(): Promise<void> {
  vi.resetModules()
  await import('../../src/page/main-hook')
}

/** The hook sends from a microtask, so let the queue drain. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Catch errors the wrapper throws from a microtask. The caller cannot observe them, and without
 * the trap this failure would look like an ordinary error in the page console.
 */
async function trapAsyncErrors(body: () => Promise<void>): Promise<unknown[]> {
  const errors: unknown[] = []
  const trap = (error: unknown): void => {
    errors.push(error)
  }
  process.on('uncaughtException', trap)
  try {
    await body()
  } finally {
    process.off('uncaughtException', trap)
  }
  return errors
}

/** Open a source like a player: assign the createObjectURL result to video.src. */
function openSource(page: ReturnType<typeof installPage>) {
  const mediaSource = new page.MediaSource()
  const objectUrl = URL.createObjectURL(mediaSource as unknown as MediaSource)
  return { mediaSource, objectUrl, sourceBuffer: mediaSource.addSourceBuffer(MIME) }
}

/** Outbound message identifiers used by the bridge to distinguish streams and tracks. */
const labelsOf = (item: Posted) => ({
  sourceId: String(item.message.sourceId),
  bufferId: String(item.message.bufferId),
  mime: String(item.message.mime),
})

afterEach(() => {
  vi.unstubAllGlobals()
  while (cleanups.length) cleanups.pop()!()
})

describe('segment copy', () => {
  it('reports the SourceBuffer timestamp offset used for an append', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    sourceBuffer.timestampOffset = 12.5
    sourceBuffer.appendBuffer(segment(64))
    await flush()

    expect(page.of('tc:append')[0]!.message).toMatchObject({ timestampOffset: 12.5 })
  })

  it('reports the offset sequence mode derives while processing the append', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    sourceBuffer.mode = 'sequence'
    sourceBuffer.sequenceOffsetAfterAppend = 7.5
    sourceBuffer.appendBuffer(segment(64))
    await flush()

    expect(page.of('tc:append')[0]!.message).toMatchObject({ timestampOffset: 7.5 })
  })

  it('does not detach the page buffer so a bare ArrayBuffer can be appended again', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    // Players append a bare ArrayBuffer from `(await fetch(url)).arrayBuffer()`, then reuse the same
    // buffer when the segment cache appends it after a seek. If the wrapper sent the page's buffer,
    // transferring it to the bridge would detach it. A second appendBuffer would fire updateend
    // without appending anything, silently stalling the player.
    const buffer = segment(829)
    const expected = digest(new Uint8Array(buffer))

    sourceBuffer.appendBuffer(buffer)
    await flush()

    expect(buffer.byteLength, 'sending to the bridge detached the page buffer').toBe(829)

    sourceBuffer.appendBuffer(buffer)
    await flush()

    // Both times the player receives all its bytes and the bridge receives a copy.
    expect(sourceBuffer.appended).toEqual([
      { byteLength: 829, digest: expected },
      { byteLength: 829, digest: expected },
    ])
    expect(
      page.of('tc:append').map((item) => digest(new Uint8Array(item.message.bytes as ArrayBuffer))),
    ).toEqual([expected, expected])
  })

  it('copies the view window rather than its entire backing buffer', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    const padded = new Uint8Array(64 + 11)
    padded.set(pattern(64), 7)
    const view = new Uint8Array(padded.buffer, 7, 64)
    const expected = digest(pattern(64))

    sourceBuffer.appendBuffer(view)
    // MSE copies data synchronously, so the player may immediately reuse its buffer. If the wrapper
    // delayed copying until a microtask, the bridge would receive garbage.
    padded.fill(0xff)
    await flush()

    expect(
      page.of('tc:append').map((item) => digest(new Uint8Array(item.message.bytes as ArrayBuffer))),
    ).toEqual([expected])
    expect(padded.byteLength, 'sending to the bridge detached the backing buffer').toBe(75)
  })

  it('copies from DataView because appendBuffer accepts any ArrayBufferView', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    // appendBuffer accepts BufferSource, meaning any ArrayBufferView, not just Uint8Array. DataView
    // is the riskiest because it has no length property, so `.set(data)` would copy zero bytes. The
    // bridge would silently receive a correctly sized all-zero buffer and box parsing would see
    // nothing.
    const padded = new Uint8Array(64 + 11)
    padded.set(pattern(64), 7)
    const view = new DataView(padded.buffer, 7, 64)
    const expected = digest(pattern(64))

    sourceBuffer.appendBuffer(view)
    await flush()

    expect(
      page.of('tc:append').map((item) => digest(new Uint8Array(item.message.bytes as ArrayBuffer))),
    ).toEqual([expected])
  })

  it('copies a typed array wider than one byte as bytes rather than elements', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    // Int16Array is also a valid BufferSource. Here an incorrect `.set(data)` corrupts rather than
    // silently dropping data: Uint8Array.set copies source elements, truncating 16-bit values to a
    // byte and filling only half the copy. The segment must be copied byte for byte as stored in
    // memory, regardless of the caller's view type.
    const bytes = pattern(64)
    const holder = new Uint8Array(8 + 64)
    holder.set(bytes, 8)
    // The offset is aligned to the element size or the Int16Array constructor throws RangeError.
    const view = new Int16Array(holder.buffer, 8, 32)
    const expected = digest(bytes)

    sourceBuffer.appendBuffer(view)
    await flush()

    expect(view.byteLength, 'setup: the view must cover all 64 bytes').toBe(64)
    expect(
      page.of('tc:append').map((item) => digest(new Uint8Array(item.message.bytes as ArrayBuffer))),
    ).toEqual([expected])
  })

  it('sends to the bridge with a transfer list rather than another copy', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    sourceBuffer.appendBuffer(segment(128))
    await flush()

    // Copying here would add another pass over every segment.
    const append = page.of('tc:append')
    expect(append).toHaveLength(1)
    expect({
      transferred: append[0]!.transferred,
      transfersBytes: append[0]!.transfersBytes,
    }).toEqual({ transferred: 1, transfersBytes: true })
  })
})

describe('foreign SourceBuffer', () => {
  it('passes through without breaking the wrapper', async () => {
    const page = installPage()
    await importHook()

    // This resembles a call from another realm: the object exists, but this realm has no record of
    // it, as with a SourceBuffer from an about:blank frame the hook did not reach.
    const foreign = new page.SourceBuffer(MIME)
    const buffer = segment(32)

    const errors = await trapAsyncErrors(async () => {
      foreign.appendBuffer(buffer)
      await flush()
    })

    expect(errors, 'the wrapper threw for an unregistered SourceBuffer').toEqual([])
    expect(page.posted, 'a foreign buffer has no source or track to report').toEqual([])
    expect(foreign.appended).toEqual([snapshot(buffer)])
  })
})

describe('EME', () => {
  const config = { initDataTypes: ['keyids'], videoCapabilities: [{ contentType: MIME }] }

  it('does not touch the key-system request', async () => {
    const page = installPage()
    const original = navigator.requestMediaKeySystemAccess
    await importHook()

    const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [
      config as MediaKeySystemConfiguration,
    ])

    // The hook used to wrap this method, so every call, including a rejected capability probe,
    // disabled recording for the entire page. One edition.cnn.com article made 16 probes in 1.5
    // seconds while the stream contained no encryption boxes, causing a genuine 367x648 video
    // watched for 40 seconds to be lost entirely.
    //
    // Calling EME expresses intent, not protected media. The extension detects protection in the
    // bytes themselves (src/core/container.ts) and through the element's `encrypted` event; the
    // page may query the browser as often as it wants.
    expect(
      navigator.requestMediaKeySystemAccess,
      'the hook still replaces the page method',
    ).toBe(original)
    expect(page.posted, 'a key-system request provides nothing to report').toEqual([])
    expect(page.emeCalls).toEqual([
      { keySystem: 'org.w3.clearkey', configs: [config], thisArg: navigator },
    ])
    expect(access.keySystem).toBe('org.w3.clearkey')
  })

  it('does not add a method the browser lacks on a page without EME', async () => {
    const page = installPage({ eme: false })
    await importHook()

    // The extension runs on <all_urls>, but Chrome does not expose this method on an HTTP page.
    // Players such as shaka, dash.js, and hls.js check for it before calling it. Adding a wrapper
    // would invent a browser capability and make the eventual call fail inside the wrapper.
    expect(
      typeof navigator.requestMediaKeySystemAccess,
      'the hook exposed EME where the browser does not',
    ).toBe('undefined')
    expect(page.posted).toEqual([])
  })
})

describe('identifiers', () => {
  it('distinguishes video and audio from one MediaSource by bufferId', async () => {
    const page = installPage()
    await importHook()

    // This is what every DASH/HLS player does: one MediaSource with two SourceBuffers, one for video
    // and one for audio. bufferId lets the bridge distinguish them. If shared, both tracks reach
    // the bridge as one and are interleaved into unusable data.
    const { mediaSource, sourceBuffer: video } = openSource(page)
    const audio = mediaSource.addSourceBuffer(AUDIO_MIME)

    video.appendBuffer(segment(64))
    audio.appendBuffer(segment(48))
    video.appendBuffer(segment(96))
    await flush()

    const seen = page.of('tc:append').map(labelsOf)
    expect(seen.map((item) => item.mime)).toEqual([MIME, AUDIO_MIME, MIME])
    expect(
      new Set(seen.map((item) => item.sourceId)).size,
      'tracks from one MediaSource must share one source',
    ).toBe(1)
    expect(seen[2]!.bufferId, 'segments from one track received different bufferIds').toBe(
      seen[0]!.bufferId,
    )
    expect(
      seen[1]!.bufferId,
      'audio and video received the same bufferId, so the bridge cannot distinguish tracks',
    ).not.toBe(seen[0]!.bufferId)
  })

  it('distinguishes two page MediaSources by sourceId', async () => {
    const page = installPage()
    await importHook()

    // A second MediaSource is normal. A player recreates one when changing quality or restarting,
    // and a page may also contain two video elements.
    const first = openSource(page)
    const second = openSource(page)

    first.sourceBuffer.appendBuffer(segment(64))
    second.sourceBuffer.appendBuffer(segment(48))
    await flush()

    const sources = page.of('tc:source').map((item) => ({
      sourceId: String(item.message.sourceId),
      objectUrl: String(item.message.objectUrl),
    }))
    expect(
      sources.map((item) => item.objectUrl),
      'setup: sources must have different URLs',
    ).toEqual([first.objectUrl, second.objectUrl])
    expect(
      sources[1]!.sourceId,
      'two independent streams received one sourceId, so the bridge will merge them',
    ).not.toBe(sources[0]!.sourceId)

    const seen = page.of('tc:append').map(labelsOf)
    expect(seen.map((item) => item.sourceId)).toEqual([
      sources[0]!.sourceId,
      sources[1]!.sourceId,
    ])
    expect(seen[1]!.bufferId, 'tracks from different sources received one bufferId').not.toBe(
      seen[0]!.bufferId,
    )
  })
})

describe('appendBuffer transparency', () => {
  it('passes a browser exception to the player instead of swallowing it', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    // QuotaExceededError is normal MSE behavior. It tells the player to clear buffered ranges and
    // append the segment again. If the wrapper swallows it, the player receives no signal, does not
    // evict, and silently stalls.
    const quota = new DOMException('buffer full', 'QuotaExceededError')
    sourceBuffer.failWith = quota

    let thrown: unknown = '(the wrapper threw nothing)'
    try {
      sourceBuffer.appendBuffer(segment(64))
    } catch (error) {
      thrown = error
    }
    await flush()

    expect(thrown, 'the wrapper swallowed the appendBuffer exception').toBe(quota)
  })
})

describe('player synchronous path', () => {
  it('sends in a microtask rather than inside appendBuffer', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    sourceBuffer.appendBuffer(segment(256))

    // Structured cloning and buffer detachment do not belong on the synchronous path. Calling send
    // here would add both to the player's call for every segment.
    expect(page.of('tc:append'), 'the wrapper sent during the player call').toEqual([])
    expect(sourceBuffer.appended, 'setup: the player receives its bytes immediately').toHaveLength(1)

    // Use a microtask rather than a timer so the queue drains before returning to the event loop and
    // the bridge receives the segment in the same tick.
    await Promise.resolve()
    await Promise.resolve()

    expect(page.of('tc:append'), 'sending was delayed beyond a microtask').toHaveLength(1)
  })
})

/**
 * Duration declared by the page on MediaSource, the third component of the merge key.
 *
 * Use the page's declaration rather than the browser's inferred value. If the player leaves the
 * duration unset, MSE extends it to the end of buffered data. That number grows with every segment
 * and would move the session to a new key on every poll.
 */
describe('declared duration', () => {
  it('sends the stream identifier to the bridge', async () => {
    const page = installPage()
    await importHook()
    const { mediaSource } = openSource(page)

    mediaSource.duration = 23.581

    expect(page.of('tc:duration').map((item) => item.message)).toEqual([
      { type: 'tc:duration', sourceId: 's1', seconds: 23.581 },
    ])
  })

  it('lets the page set it so the value reaches the browser', async () => {
    const page = installPage()
    await importHook()
    const { mediaSource } = openSource(page)

    mediaSource.duration = 42

    // The wrapper intercepts the assignment a player uses to declare the video length to the
    // element. Swallowing it would prevent seeking beyond buffered data.
    expect(mediaSource.duration).toBe(42)
    expect(mediaSource.stored).toBe(42)
  })

  it('stays silent for live streams and durations reset by the player', async () => {
    const page = installPage()
    await importHook()
    const { mediaSource } = openSource(page)

    mediaSource.duration = Infinity
    mediaSource.duration = NaN
    mediaSource.duration = 0

    // None describes a video. A live stream, a reset, and a zero-length video tell the registry the
    // same thing as silence.
    expect(page.of('tc:duration')).toEqual([])
  })

  it('passes a browser exception outward without reporting it', async () => {
    const page = installPage()
    await importHook()
    const { mediaSource } = openSource(page)

    const invalid = new Error('InvalidStateError')
    mediaSource.failDurationWith = invalid

    // The real setter throws for an unopened source and while a buffer is updating. The page must
    // observe exactly the same behavior as it would without the extension.
    expect(() => {
      mediaSource.duration = 12
    }).toThrow(invalid)
    expect(page.of('tc:duration'), 'the bridge received a duration the page did not set').toEqual([])
  })

  it('reports every refinement and leaves comparison to the registry', async () => {
    const page = installPage()
    await importHook()
    const { mediaSource } = openSource(page)

    // dash.js redeclares duration on every manifest update. Comparison precision belongs in the
    // key at whole seconds; duplicating it here would create two sources of truth.
    mediaSource.duration = 600
    mediaSource.duration = 600.4

    expect(page.of('tc:duration').map((item) => item.message.seconds)).toEqual([600, 600.4])
  })

  it('distinguishes two MediaSources on one page', async () => {
    const page = installPage()
    await importHook()
    const first = openSource(page)
    const second = openSource(page)

    first.mediaSource.duration = 10
    second.mediaSource.duration = 20

    // A short-video feed opens a MediaSource for each video. Duration belongs to the stream it was
    // declared for; mixing them up would give both sessions one key.
    expect(page.of('tc:duration').map((item) => [item.message.sourceId, item.message.seconds])).toEqual([
      ['s1', 10],
      ['s3', 20],
    ])
  })

  it('sends without a transfer list', async () => {
    const page = installPage()
    await importHook()
    const { mediaSource } = openSource(page)

    mediaSource.duration = 7

    expect(page.of('tc:duration').map((item) => item.transferred)).toEqual([0])
  })
})

describe('page refusal', () => {
  /**
   * The storage side permanently refuses an entire page when it detects protected media. The hook
   * used to keep copying anyway: dash.js ClearKey sent and discarded 53 postMessage calls totaling
   * 29.7 MB, while Widevine sent 40 totaling 34.7 MB in 40 seconds. Refusal cost as much as
   * recording.
   */
  const REFUSED = { type: 'tc:refused' }

  it('stops copying segments when the bridge declares the page refused', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    sourceBuffer.appendBuffer(segment(512))
    await flush()
    expect(page.of('tc:append'), 'setup: segments reach the bridge before refusal').toHaveLength(1)

    page.deliver(REFUSED)

    sourceBuffer.appendBuffer(segment(512))
    sourceBuffer.appendBuffer(segment(512))
    await flush()

    expect(page.of('tc:append'), 'the hook still copies and sends after refusal').toHaveLength(1)
  })

  it('does not interfere with the player so the page keeps appending its bytes', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    page.deliver(REFUSED)

    const buffer = segment(300)
    const expected = digest(new Uint8Array(buffer))
    sourceBuffer.appendBuffer(buffer)
    await flush()

    // Refusal applies to recording, not playback. The browser must receive the same bytes and the
    // page must retain its buffer.
    expect(sourceBuffer.appended).toEqual([{ byteLength: 300, digest: expected }])
    expect(buffer.byteLength, 'the page buffer was detached after refusal').toBe(300)
  })

  it('also stays silent about sources, buffers, and durations the bridge no longer expects', async () => {
    const page = installPage()
    await importHook()

    page.deliver(REFUSED)

    const { mediaSource } = openSource(page)
    mediaSource.duration = 42

    expect(page.posted, 'the bridge received another message after refusal').toEqual([])
  })

  it('listens only to its extension so the same page message changes nothing', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    // A page may post anything to its own window. Treating it as the bridge would give the site a
    // recording switch. A site document cannot carry the extension origin.
    page.deliver(REFUSED, 'https://site.example')

    sourceBuffer.appendBuffer(segment(512))
    await flush()

    expect(page.of('tc:append')).toHaveLength(1)
  })

  it('does not confuse unrelated messages in the same window', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    // Many senders post to the page window, including the hook itself. None of these messages is a
    // refusal.
    page.deliver({ type: 'tc:ready' })
    page.deliver(null)
    page.deliver('tc:refused')

    sourceBuffer.appendBuffer(segment(512))
    await flush()

    expect(page.of('tc:append')).toHaveLength(1)
  })
})

describe('the recording switch', () => {
  /**
   * The hook receives one recording setting: copy or do not copy. It comes from the bridge over
   * the same channel and through the same origin check as a refusal. Unlike a refusal, it can
   * change because a user may change their preference for a site without reloading it.
   */
  const OFF = { type: 'tc:record', on: false }
  const ON = { type: 'tc:record', on: true }

  it('stops copying while recording is switched off', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    sourceBuffer.appendBuffer(segment(512))
    await flush()
    expect(page.of('tc:append'), 'setup: the hook copies before the switch is touched').toHaveLength(1)

    page.deliver(OFF)

    sourceBuffer.appendBuffer(segment(512))
    sourceBuffer.appendBuffer(segment(512))
    await flush()

    // The whole of what turning recording off buys is bought here. Anywhere further downstream
    // the copy of every append has already been made and paid for.
    expect(page.of('tc:append'), 'the hook went on copying with recording off').toHaveLength(1)
  })

  it('copies again when the switch turns back on', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    page.deliver(OFF)
    sourceBuffer.appendBuffer(segment(512))
    await flush()
    expect(page.of('tc:append'), 'setup: nothing travels while the switch is off').toHaveLength(0)

    // This is what the refusal never does. What comes back is the middle of somebody's byte
    // stream, and finding a place in it again is the registry's business (pauseIntake), not the
    // hook's: a hook that tried to resume at a boundary would have to parse.
    page.deliver(ON)
    sourceBuffer.appendBuffer(segment(512))
    await flush()

    expect(page.of('tc:append'), 'the switch turned on and the hook stayed silent').toHaveLength(1)
  })

  it('holds everything else back too while it stands', async () => {
    const page = installPage()
    await importHook()

    page.deliver(OFF)

    const { mediaSource } = openSource(page)
    mediaSource.duration = 42

    // Not only the segments: an announcement of a source nothing will ever be copied from is
    // traffic bought for nothing, and the bridge has no use for it.
    expect(page.posted, 'the hook kept talking with recording off').toEqual([])
  })

  it('is the extension’s to work and not the page’s', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    // A page may post whatever it likes into its own window. Taken as the bridge speaking, this
    // would hand every site a switch for its own recording — and the far worse one: a site that
    // could say `on` would turn a switch the user had turned off.
    page.deliver(OFF, 'https://site.example')

    sourceBuffer.appendBuffer(segment(512))
    await flush()

    expect(page.of('tc:append')).toHaveLength(1)
  })

  it('does not lift a refusal: protected media stays refused whatever the settings say', async () => {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)

    page.deliver({ type: 'tc:refused' })
    page.deliver(ON)

    sourceBuffer.appendBuffer(segment(512))
    await flush()

    // The two messages govern different things: refusal permanently blocks this page's protected
    // media, while recording mode is the user's site preference. The less restrictive setting
    // must not override refusal, or changing the setting would record a page playing DRM.
    expect(page.of('tc:append'), 'a switch turned on undid the refusal of a protected page').toHaveLength(
      0,
    )
  })
})

/**
 * A buffer that says who read it: the page's own view, with a count of the times its bytes were
 * reached for. The browser reaches for them once, to append them; the hook reaches for them a
 * second time, to make the copy it sends to the bridge.
 *
 * It is a real ArrayBufferView — ArrayBuffer.isView says so — so both the wrapper and the fake
 * SourceBuffer treat it exactly as they treat what a player appends.
 */
class CountedView extends Uint8Array {
  reads = 0
  override get buffer(): ArrayBuffer {
    this.reads++
    return super.buffer as ArrayBuffer
  }
}

describe('what a switched-off recording costs the page', () => {
  /** How many times the page's own bytes were reached for over one appendBuffer. */
  async function readsOverOneAppend(deliver?: unknown): Promise<number> {
    const page = installPage()
    await importHook()
    const { sourceBuffer } = openSource(page)
    if (deliver) page.deliver(deliver)

    const view = new CountedView(pattern(512))
    sourceBuffer.appendBuffer(view)
    await flush()
    return view.reads
  }

  it('costs the page no copy of the segment at all', async () => {
    // The measured cost of copying and throwing away: 29.7 MB on dash.js ClearKey in forty
    // seconds, 34.7 MB on Widevine. A switch that only dropped the copy at the far end would
    // leave every byte of that on the page's bill, and there would be nothing to switch off.
    //
    // Silence downstream is not the same fact and is checked next door: this is about the
    // synchronous path of somebody's player, where the copy is made.
    const recording = await readsOverOneAppend()
    const off = await readsOverOneAppend({ type: 'tc:record', on: false })

    expect(recording, 'setup: the hook is meant to copy what it is given').toBeGreaterThan(1)
    // Once, by the browser appending it, and by nobody else.
    expect(off, 'the hook copied the segment of a page it was told not to record').toBe(1)
  })

  it('costs it none on a refused page either', async () => {
    // The same guard, for the refusal that stands beside the switch. Both stop before the copy
    // and for the same reason; a change that moved one and not the other would be found here.
    expect(await readsOverOneAppend({ type: 'tc:refused' })).toBe(1)
  })
})
