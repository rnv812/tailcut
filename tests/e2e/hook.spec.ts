import { test, expect, type BrowserContext, type Frame, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchWithExtension, serveLocal } from './helpers'

const PAGE_URL = 'https://tailcut.test/player'
/** A page without a strict policy, used to prove that wrapping APIs does not break callers. */
const PLAIN_URL = 'https://tailcut.test/plain'
/** Plain HTTP: the extension covers <all_urls>, but this context is not secure. */
const INSECURE_URL = 'http://insecure.test/plain'

/** Segments in the order appended by tests/e2e/page/player.html. */
const APPENDED = [
  'h264/init-stream0.m4s',
  'h264/chunk-stream0-00001.m4s',
  'h264/chunk-stream0-00002.m4s',
  'h264/chunk-stream0-00003.m4s',
]

const MIME = 'video/mp4; codecs="avc1.4d401e"'
/** The same stream's audio track: tests/fixtures/h264/*-stream1.m4s is mp4a/soun. */
const AUDIO_MIME = 'audio/mp4; codecs="mp4a.40.2"'

/** A two-track stream uses one MediaSource and one SourceBuffer per track. */
const TRACKS = {
  video: { mime: MIME, files: ['h264/init-stream0.m4s', 'h264/chunk-stream0-00001.m4s'] },
  audio: { mime: AUDIO_MIME, files: ['h264/init-stream1.m4s', 'h264/chunk-stream1-00001.m4s'] },
}

/**
 * FNV-1a, 32-bit. The browser computes the same digest so this compares content, not lengths.
 * Otherwise a wrapper returning an adjacent memory region of the same length would pass.
 */
function digest(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return `${bytes.byteLength}:${hash}`
}

async function fixtureDigests(list: string[] = APPENDED): Promise<string[]> {
  const files = await Promise.all(
    list.map((rel) => fs.readFile(path.resolve('tests/fixtures', rel))),
  )
  return files.map((file) => digest(new Uint8Array(file)))
}

type SeenAppend = { sourceId: string; bufferId: string; mime: string; digest: string }
type SeenSource = { sourceId: string; objectUrl: string }

/** What the listener installed by the test in every page document collected. */
type Probe = {
  tcAppend: SeenAppend[]
  tcSource: SeenSource[]
  /** Every message the hook posted into the window, by type: the whole of what it says. */
  tcTypes: string[]
  tcDigest: (bytes: ArrayBuffer) => string
}

type PlayerState = { appended: number; allAppended?: boolean }

/**
 * Opens a page with the extension and installs the hook-message listener before any page script.
 * Otherwise the first messages would be missed and the test could report a false negative.
 * The listener runs in every document, including the bridge frame, exposing the full path.
 */
async function open(url: string, html?: string) {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  const consoleLog: string[] = []
  page.on('console', (msg) => consoleLog.push(`${msg.type()}: ${msg.text()}`))
  page.on('pageerror', (err) => consoleLog.push(`pageerror: ${err.message}`))

  await page.addInitScript(() => {
    const target = window as unknown as Probe
    target.tcAppend = []
    target.tcSource = []
    target.tcTypes = []
    target.tcDigest = (buffer: ArrayBuffer) => {
      const bytes = new Uint8Array(buffer)
      let hash = 0x811c9dc5
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
      return `${bytes.byteLength}:${hash}`
    }

    const record = (value: unknown) => {
      const data = value as Record<string, unknown> | null
      if (!data || typeof data !== 'object') return

      if (typeof data.type === 'string' && data.type.startsWith('tc:')) {
        target.tcTypes.push(data.type)
      }

      if (data.type === 'tc:append') {
        target.tcAppend.push({
          sourceId: String(data.sourceId),
          bufferId: String(data.bufferId),
          mime: String(data.mime),
          digest: target.tcDigest(data.bytes as ArrayBuffer),
        })
      } else if (data.type === 'tc:source') {
        target.tcSource.push({
          sourceId: String(data.sourceId),
          objectUrl: String(data.objectUrl),
        })
      }
    }

    // In the extension frame this sees only messages delivered by the authenticated port. The
    // page and the isolated content world have separate MessagePort prototypes.
    const onMessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')
    if (location.protocol === 'chrome-extension:' && onMessage?.get && onMessage.set) {
      Object.defineProperty(MessagePort.prototype, 'onmessage', {
        ...onMessage,
        set(handler) {
          onMessage.set!.call(
            this,
            handler === null
              ? null
              : function (this: MessagePort, event: MessageEvent) {
                  record(event.data)
                  return handler.call(this, event)
                },
          )
        },
      })
    }

    window.addEventListener('message', (event: MessageEvent) => {
      record(event.data)
    })
  })

  if (html !== undefined) {
    await page.route(url, (route) => route.fulfill({ body: html, contentType: 'text/html' }))
    await page.goto(url)
  } else {
    await serveLocal(page, 'player.html', url)
  }

  return {
    context,
    page,
    extensionId,
    log: () => consoleLog.join(' | ') || '(empty)',
  }
}

const openPlayer = () => open(PAGE_URL)

/** Waits until the player has appended all its segments. */
const playerDone = (page: Page) =>
  page.waitForFunction(() => (window as unknown as PlayerState).allAppended === true, undefined, {
    timeout: 15_000,
  })

/** Returns the bridge document so the test can install the same listener used in the page. */
async function bridgeFrame(page: Page, extensionId: string, log: () => string): Promise<Frame> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const frame = page.frames().find((candidate) => candidate.url().includes(extensionId))
    if (frame) return frame
    expect(Date.now(), `the bridge frame did not appear; page console: ${log()}`).toBeLessThan(
      deadline,
    )
    await page.waitForTimeout(50)
  }
}

const close = (context: BrowserContext) => context.close()

test('the hook sees every appendBuffer call without disrupting the player', async () => {
  const { context, page, log } = await openPlayer()
  await playerDone(page)

  const seen = await page.evaluate(() => (window as unknown as Probe).tcAppend)
  const appended = await page.evaluate(() => (window as unknown as PlayerState).appended)

  expect(seen.length, `the hook missed appendBuffer calls; page console: ${log()}`).toBe(
    appended,
  )
  // Check content, not only message count: each copy must carry the same bytes in the same order.
  expect(seen.map((item) => item.digest)).toEqual(await fixtureDigests())

  // One MediaSource and one SourceBuffer: without shared IDs the bridge cannot assemble the track.
  expect(new Set(seen.map((item) => item.sourceId)).size).toBe(1)
  expect(new Set(seen.map((item) => item.bufferId)).size).toBe(1)
  expect(new Set(seen.map((item) => item.mime))).toEqual(new Set([MIME]))

  const error = await page.evaluate(() => {
    const video = document.querySelector('video')!
    return video.error ? video.error.code : null
  })
  expect(error, 'the wrappers must not make the player fail').toBeNull()

  await close(context)
})

test('the source is associated with the URL assigned to video.src', async () => {
  const { context, page, log } = await openPlayer()
  await playerDone(page)

  const observed = await page.evaluate(() => {
    const seen = window as unknown as Probe
    return {
      sources: seen.tcSource,
      appendSourceId: seen.tcAppend[0]?.sourceId ?? '',
      videoSrc: document.querySelector('video')!.src,
    }
  })

  // There is exactly one source with the URL assigned by the player. The isolated-world watcher
  // uses that URL to identify which <video> owns the stream.
  expect(observed.sources, `page console: ${log()}`).toEqual([
    { sourceId: observed.appendSourceId, objectUrl: observed.videoSrc },
  ])
  expect(observed.videoSrc.startsWith('blob:')).toBe(true)

  await close(context)
})

test('the hook copies synchronously before appendBuffer returns', async () => {
  const { context, page, log } = await openPlayer()
  await playerDone(page)

  // This MediaSource appends a view at a non-zero offset, then overwrites the source buffer as soon
  // as appendBuffer returns. Players may do that because MSE copies synchronously. If the wrapper
  // delays its copy until a microtask, the bridge receives overwritten bytes.
  const scribbled = await page.evaluate(async (mime) => {
    const seen = window as unknown as Probe
    const before = seen.tcAppend.length
    const source = new MediaSource()
    const video = document.createElement('video')
    video.src = URL.createObjectURL(source)
    document.body.appendChild(video)

    await new Promise((resolve) => source.addEventListener('sourceopen', resolve, { once: true }))
    const sourceBuffer = source.addSourceBuffer(mime)

    const segment = new Uint8Array(
      await (await fetch('/fixtures/h264/init-stream0.m4s')).arrayBuffer(),
    )
    // The prefix and suffix prove that the wrapper copies the view's exact buffer window.
    const padded = new Uint8Array(segment.byteLength + 11)
    padded.set(segment, 7)
    const view = new Uint8Array(padded.buffer, 7, segment.byteLength)

    const expected = seen.tcDigest(segment.slice().buffer)

    await new Promise((resolve) => {
      sourceBuffer.addEventListener('updateend', resolve, { once: true })
      sourceBuffer.appendBuffer(view)
      padded.fill(0xff)
    })

    const deadline = Date.now() + 3_000
    while (seen.tcAppend.length === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    return { expected, captured: seen.tcAppend.slice(before).map((item) => item.digest) }
  }, MIME)

  expect(scribbled.captured, `page console: ${log()}`).toEqual([scribbled.expected])

  await close(context)
})

test('sending preserves the page buffer so the same ArrayBuffer can be appended again', async () => {
  const { context, page, log } = await openPlayer()
  await playerDone(page)

  // Players append a bare ArrayBuffer returned by fetch, then reuse it when a segment cache fills
  // the buffer after a seek. If the wrapper transferred the page's own buffer, postMessage would
  // detach it. This is worse than an exception: appending the detached buffer completes updateend
  // without adding data, so the player silently stalls.
  const replay = await page.evaluate(async (mime) => {
    const seen = window as unknown as Probe
    const before = seen.tcAppend.length
    const source = new MediaSource()
    const video = document.createElement('video')
    video.src = URL.createObjectURL(source)
    document.body.appendChild(video)

    await new Promise((resolve) => source.addEventListener('sourceopen', resolve, { once: true }))
    const sourceBuffer = source.addSourceBuffer(mime)

    const update = (act: () => void): Promise<unknown> =>
      new Promise((resolve) => {
        sourceBuffer.addEventListener('updateend', resolve, { once: true })
        act()
      })
    const fetchBuffer = async (path: string): Promise<ArrayBuffer> =>
      (await fetch(path)).arrayBuffer()
    const bufferedEnd = (): number =>
      sourceBuffer.buffered.length ? sourceBuffer.buffered.end(0) : 0
    const settle = async (count: number): Promise<void> => {
      const deadline = Date.now() + 3_000
      while (seen.tcAppend.length < before + count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    const init = await fetchBuffer('/fixtures/h264/init-stream0.m4s')
    const chunk = await fetchBuffer('/fixtures/h264/chunk-stream0-00001.m4s')
    const size = chunk.byteLength
    const expected = seen.tcDigest(chunk.slice(0))

    await update(() => sourceBuffer.appendBuffer(init))
    await update(() => sourceBuffer.appendBuffer(chunk))
    const firstPass = bufferedEnd()

    // Detachment would happen during delivery, so wait until the hook has sent both segments.
    await settle(2)
    const sizeAfterSend = chunk.byteLength

    // Simulate a seek: discard buffered data and append the same cached segment again.
    await update(() => sourceBuffer.remove(0, Infinity))
    const cleared = sourceBuffer.buffered.length
    await update(() => sourceBuffer.appendBuffer(chunk))
    const secondPass = bufferedEnd()
    await settle(3)

    return {
      size,
      sizeAfterSend,
      firstPass,
      cleared,
      secondPass,
      expected,
      digests: seen.tcAppend.slice(before + 1).map((item) => item.digest),
      error: video.error ? video.error.code : null,
    }
  }, MIME)

  expect(replay.sizeAfterSend, `sending to the bridge detached the page buffer; console: ${log()}`).toBe(
    replay.size,
  )
  expect(replay.cleared, 'setup: the buffer must be empty before the replay').toBe(0)
  expect(replay.firstPass, 'setup: the first pass buffered no data').toBeGreaterThan(0)
  expect(replay.secondPass, 'the repeated appendBuffer added nothing, so the player stalled').toBe(
    replay.firstPass,
  )
  expect(replay.digests, 'the bridge received the wrong bytes').toEqual([
    replay.expected,
    replay.expected,
  ])
  expect(replay.error, 'the wrappers must not make the player fail').toBeNull()

  await close(context)
})

test('segments reach the bridge frame', async () => {
  const { context, page, extensionId, log } = await openPlayer()
  await playerDone(page)

  const bridge = await bridgeFrame(page, extensionId, log)
  await bridge
    .waitForFunction((count) => (window as unknown as Probe).tcAppend.length >= count, APPENDED.length, {
      timeout: 5_000,
    })
    .catch(() => undefined)

  const delivered = await bridge.evaluate(() =>
    (window as unknown as Probe).tcAppend.map((item) => item.digest),
  )
  expect(delivered, `the bridge did not receive the segments; page console: ${log()}`).toEqual(
    await fixtureDigests(),
  )

  await close(context)
})

test('createObjectURL keeps working for ordinary Blobs', async () => {
  const { context, page, log } = await open(
    PLAIN_URL,
    '<!doctype html><meta charset="utf-8"><title>plain</title>',
  )

  const result = await page.evaluate(async () => {
    const url = URL.createObjectURL(new Blob(['tailcut'], { type: 'text/plain' }))
    const text = await (await fetch(url)).text()
    URL.revokeObjectURL(url)
    return { url, text, sources: (window as unknown as Probe).tcSource.length }
  })

  expect(result.text, `the blob URL became unreadable; page console: ${log()}`).toBe('tailcut')
  expect(result.url.startsWith('blob:')).toBe(true)
  // A Blob is not a MediaSource, so it must not create a session.
  expect(result.sources).toBe(0)

  await close(context)
})

test('the hook leaves DRM access untouched', async () => {
  const { context, page, log } = await openPlayer()

  const original = await page.evaluate(
    () => navigator.requestMediaKeySystemAccess.toString().includes('[native code]'),
  )

  const access = await page.evaluate(async (mime) => {
    try {
      const result = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [
        { initDataTypes: ['keyids'], videoCapabilities: [{ contentType: mime }] },
      ])
      return { keySystem: result.keySystem, failed: '' }
    } catch (error) {
      return { keySystem: '', failed: String(error) }
    }
  }, MIME)

  // Let all deferred hook messages arrive because segments are sent in a microtask.
  await page.waitForTimeout(300)

  // The page method remains native. An earlier wrapper treated every call, including a rejected
  // capability probe, as DRM for the entire page. On edition.cnn.com, sixteen probes discarded an
  // unencrypted video that contained no encryption boxes.
  expect(original, `the hook still wraps requestMediaKeySystemAccess; ${log()}`).toBe(true)
  expect(
    await page.evaluate(() => (window as unknown as Probe).tcTypes),
    'the hook must emit nothing about a key-system request',
  ).not.toContain('tc:drm')
  expect(access, 'the extension must not interfere with key-system access').toEqual({
    keySystem: 'org.w3.clearkey',
    failed: '',
  })

  await close(context)
})

test('the hook does not invent EME on an HTTP page', async () => {
  const { context, page, log } = await open(
    INSECURE_URL,
    '<!doctype html><meta charset="utf-8"><title>insecure</title>',
  )

  const observed = await page.evaluate(async () => {
    const seen = window as unknown as Probe
    // First prove that the hook is installed here. Otherwise the check below would also pass on a
    // page without the extension and would prove nothing.
    URL.createObjectURL(new MediaSource())
    await new Promise((resolve) => setTimeout(resolve, 100))

    return {
      hooked: seen.tcSource.length,
      // This is the sequence used by shaka, dash.js, and hls.js: test for the method, then call it.
      eme: typeof navigator.requestMediaKeySystemAccess,
      secure: window.isSecureContext,
    }
  })

  expect(observed.hooked, `the hook was not installed on the HTTP page; page console: ${log()}`).toBe(1)
  expect(observed.secure, 'setup: the page must be an insecure context').toBe(false)
  // Outside a secure context Chrome omits requestMediaKeySystemAccess. Wrapping a missing method
  // would invent a capability the browser does not provide: the presence check would pass and the
  // call would fail only inside the wrapper.
  expect(observed.eme, 'the hook exposed EME where the browser does not').toBe('undefined')

  await close(context)
})

test('tracks in one MediaSource have distinct bufferIds', async () => {
  const { context, page, log } = await openPlayer()
  await playerDone(page)

  // DASH and HLS players use one MediaSource with separate video and audio SourceBuffers.
  // bufferId exists so the bridge can tell those tracks apart.
  const observed = await page.evaluate(async (tracks) => {
    const seen = window as unknown as Probe
    const before = seen.tcAppend.length
    const source = new MediaSource()
    const element = document.createElement('video')
    element.src = URL.createObjectURL(source)
    document.body.appendChild(element)

    await new Promise((resolve) => source.addEventListener('sourceopen', resolve, { once: true }))

    const load = async (rel: string): Promise<ArrayBuffer> =>
      (await fetch(`/fixtures/${rel}`)).arrayBuffer()
    const append = (buffer: SourceBuffer, bytes: ArrayBuffer): Promise<unknown> =>
      new Promise((resolve) => {
        buffer.addEventListener('updateend', resolve, { once: true })
        buffer.appendBuffer(bytes)
      })

    const video = source.addSourceBuffer(tracks.video.mime)
    const audio = source.addSourceBuffer(tracks.audio.mime)

    for (const rel of tracks.video.files) await append(video, await load(rel))
    for (const rel of tracks.audio.files) await append(audio, await load(rel))

    const wanted = tracks.video.files.length + tracks.audio.files.length
    const deadline = Date.now() + 3_000
    while (seen.tcAppend.length < before + wanted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    return {
      captured: seen.tcAppend.slice(before),
      error: element.error ? element.error.code : null,
    }
  }, TRACKS)

  const video = observed.captured.filter((item) => item.mime === MIME)
  const audio = observed.captured.filter((item) => item.mime === AUDIO_MIME)

  expect(
    video.map((item) => item.digest),
    `audio or video did not arrive; page console: ${log()}`,
  ).toEqual(await fixtureDigests(TRACKS.video.files))
  expect(audio.map((item) => item.digest)).toEqual(await fixtureDigests(TRACKS.audio.files))

  // The tracks share one source but must remain distinct.
  expect(new Set(observed.captured.map((item) => item.sourceId)).size).toBe(1)
  expect(
    new Set(video.map((item) => item.bufferId)).size,
    'segments from one track were split across bufferIds',
  ).toBe(1)
  expect(new Set(audio.map((item) => item.bufferId)).size).toBe(1)
  expect(
    audio[0]!.bufferId,
    'audio and video used the same bufferId, so the bridge cannot distinguish the tracks',
  ).not.toBe(video[0]!.bufferId)
  expect(observed.error, 'the wrappers must not make the player fail').toBeNull()

  await close(context)
})

test('two MediaSources on one page remain separate sources', async () => {
  const { context, page, log } = await openPlayer()
  await playerDone(page)

  // Players routinely create a second MediaSource after a quality change or restart, and a page
  // may contain two <video> elements. A shared sourceId would merge independent streams.
  const observed = await page.evaluate(async (mime) => {
    const seen = window as unknown as Probe
    const beforeAppend = seen.tcAppend.length
    const beforeSource = seen.tcSource.length

    const load = async (rel: string): Promise<ArrayBuffer> =>
      (await fetch(`/fixtures/${rel}`)).arrayBuffer()

    const openStream = async (chunk: string): Promise<string> => {
      const source = new MediaSource()
      const element = document.createElement('video')
      element.src = URL.createObjectURL(source)
      document.body.appendChild(element)
      await new Promise((resolve) => source.addEventListener('sourceopen', resolve, { once: true }))

      const buffer = source.addSourceBuffer(mime)
      const append = (bytes: ArrayBuffer): Promise<unknown> =>
        new Promise((resolve) => {
          buffer.addEventListener('updateend', resolve, { once: true })
          buffer.appendBuffer(bytes)
        })

      await append(await load('h264/init-stream0.m4s'))
      await append(await load(chunk))
      return element.src
    }

    const first = await openStream('h264/chunk-stream0-00001.m4s')
    const second = await openStream('h264/chunk-stream0-00002.m4s')

    const deadline = Date.now() + 3_000
    while (seen.tcAppend.length < beforeAppend + 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    return {
      urls: [first, second],
      sources: seen.tcSource.slice(beforeSource),
      captured: seen.tcAppend.slice(beforeAppend),
    }
  }, MIME)

  expect(
    observed.sources.map((item) => item.objectUrl),
    `setup: two sources must have their own URLs; page console: ${log()}`,
  ).toEqual(observed.urls)

  const [first, second] = observed.sources
  expect(
    second!.sourceId,
    'two independent streams used one sourceId, so the bridge would merge them',
  ).not.toBe(first!.sourceId)

  // Segments are grouped by their own sources instead of being pooled together.
  const digestsOf = (sourceId: string): string[] =>
    observed.captured.filter((item) => item.sourceId === sourceId).map((item) => item.digest)
  expect(digestsOf(first!.sourceId)).toEqual(
    await fixtureDigests(['h264/init-stream0.m4s', 'h264/chunk-stream0-00001.m4s']),
  )
  expect(digestsOf(second!.sourceId)).toEqual(
    await fixtureDigests(['h264/init-stream0.m4s', 'h264/chunk-stream0-00002.m4s']),
  )
  // Different sources also have distinct tracks, preventing cross-stream segment mixing.
  expect(new Set(observed.captured.map((item) => item.bufferId)).size).toBe(2)

  await close(context)
})

test('appendBuffer exceptions reach the player', async () => {
  const { context, page, log } = await openPlayer()
  await playerDone(page)

  // appendBuffer exceptions are part of the browser API: InvalidStateError reports an append
  // during an update, while QuotaExceededError reports a full buffer. Players use those signals
  // to evict ranges and retry. If the wrapper swallows one, the player silently stalls.
  const observed = await page.evaluate(async (mime) => {
    const source = new MediaSource()
    const element = document.createElement('video')
    element.src = URL.createObjectURL(source)
    document.body.appendChild(element)
    await new Promise((resolve) => source.addEventListener('sourceopen', resolve, { once: true }))

    const buffer = source.addSourceBuffer(mime)
    const load = async (rel: string): Promise<ArrayBuffer> =>
      (await fetch(`/fixtures/${rel}`)).arrayBuffer()
    const settled = (): Promise<unknown> =>
      new Promise((resolve) => buffer.addEventListener('updateend', resolve, { once: true }))

    const init = await load('h264/init-stream0.m4s')
    const chunk = await load('h264/chunk-stream0-00001.m4s')

    const first = settled()
    buffer.appendBuffer(init)

    let thrown = '(the wrapper threw nothing)'
    try {
      // Appending before the previous update finishes produces InvalidStateError.
      buffer.appendBuffer(chunk)
    } catch (error) {
      thrown = (error as DOMException).name
    }
    await first

    // Match player recovery: retry the append after the buffer becomes available.
    const retried = settled()
    buffer.appendBuffer(chunk)
    await retried

    return {
      thrown,
      buffered: buffer.buffered.length ? buffer.buffered.end(0) : 0,
      error: element.error ? element.error.code : null,
    }
  }, MIME)

  expect(observed.thrown, `the wrapper swallowed the appendBuffer exception; console: ${log()}`).toBe(
    'InvalidStateError',
  )
  expect(observed.buffered, 'the retry after failure buffered no data').toBeGreaterThan(0)
  expect(observed.error, 'the wrappers must not make the player fail').toBeNull()

  await close(context)
})
