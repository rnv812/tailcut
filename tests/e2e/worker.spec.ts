import { test, expect, type BrowserContext, type Frame, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  clickEdit,
  exportClipWith,
  launchWithExtension,
  openPopupOn,
  probeFile,
  routeLocal,
} from './helpers'

/** A page whose player builds its MediaSource inside a dedicated worker — the shape of twitch. */
const PAGE_URL = 'https://tailcut.test/worker-player'
/** The same player with its worker started from an address rather than from a blob. */
const URL_PAGE = 'https://tailcut.test/url-worker'
/** The same page again, served with a policy that forbids blob workers. */
const CSP_PAGE = 'https://tailcut.test/csp-worker'
/** A page that builds its worker in the first burst of parsing, before any task has run. */
const EARLY_PAGE = 'https://tailcut.test/worker-early'
const OFFSET_PAGE = 'https://tailcut.test/worker-offset'
const SEQUENCE_PAGE = 'https://tailcut.test/worker-sequence'
/** A worker address of another origin: the browser refuses it, and so must the hook. */
const FOREIGN_WORKER = 'https://elsewhere.example/js/url-worker.js'

/**
 * How long the watcher gives an element to have its stream named before it says the page cannot
 * be recorded: two polls of half a second, and a little over for the poll itself.
 */
const UNNAMED_MS = 1_500

/** The policy of a site that allows workers of its own origin and nothing else. */
const STRICT_CSP = "default-src 'self' 'unsafe-inline' blob: data:; worker-src 'self'"

/** A page that will not take a plain string where a script address belongs. */
const TRUSTED_PAGE = 'https://tailcut.test/trusted-worker'
const TRUSTED_CSP = "require-trusted-types-for 'script'; trusted-types player"

/** Segments in the order tests/e2e/page/worker-player.html appends them. */
const APPENDED = [
  'h264/init-stream0.m4s',
  'h264/chunk-stream0-00001.m4s',
  'h264/chunk-stream0-00002.m4s',
  'h264/chunk-stream0-00003.m4s',
]

const MIME = 'video/mp4; codecs="avc1.4d401e"'

/** FNV-1a, 32 bits — the same digest the page computes, so bytes are compared and not lengths. */
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

/** What the listener the test puts into every document of the page gathered. */
type Probe = {
  tcAppend: SeenAppend[]
  tcSource: Array<{ sourceId: string; objectUrl: string }>
  tcWorker: string[]
}

type PlayerState = {
  appended: number
  allAppended?: boolean
  workerError?: string | null
  workerSaw?: string[]
  workerLocation?: string
  pageMessages: string[]
  /** What a worker started from an address made of its own address and its relative ones. */
  probes?: Record<string, string> | null
}

/**
 * Opens a page with the extension and a listener for the hook's messages, set before any script
 * of the page: the material of a worker arrives on the same window channel as the material of the
 * main world, and a listener installed later would miss the first of it.
 */
async function open(
  url: string,
  htmlFile: string,
  options: { csp?: string; hash?: string } = {},
) {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  const consoleLog: string[] = []
  page.on('console', (msg) => consoleLog.push(`${msg.type()}: ${msg.text()}`))
  page.on('pageerror', (err) => consoleLog.push(`pageerror: ${err.message}`))

  // Laid out on the context and not on the page: a worker fetches for itself, and its requests
  // are the ones this set is about — the script of the worker, the script beside it that the
  // worker imports by a relative address, and a relative fetch it makes once it is running.
  await context.route('**/js/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()
    if (name === 'url-worker.js') {
      return route.fulfill({
        body: await fs.readFile(path.resolve('tests/e2e/page/url-worker.js'), 'utf8'),
        contentType: 'text/javascript',
      })
    }
    if (name === 'module-worker.mjs') {
      return route.fulfill({
        body: await fs.readFile(path.resolve('tests/e2e/page/module-worker.mjs'), 'utf8'),
        contentType: 'text/javascript',
      })
    }
    if (name === 'sibling.js' || name === 'sibling.mjs') {
      return route.fulfill({ body: "self.__sibling = 'ok'", contentType: 'text/javascript' })
    }
    return route.fulfill({ body: 'ok', contentType: 'text/plain' })
  })

  await page.addInitScript(() => {
    const target = window as unknown as Probe
    target.tcAppend = []
    target.tcSource = []
    target.tcWorker = []

    const digestOf = (buffer: ArrayBuffer) => {
      const bytes = new Uint8Array(buffer)
      let hash = 0x811c9dc5
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
      return `${bytes.byteLength}:${hash}`
    }

    const record = (value: unknown) => {
      const data = value as Record<string, unknown> | null
      if (!data || typeof data !== 'object') return

      if (data.type === 'tc:append') {
        target.tcAppend.push({
          sourceId: String(data.sourceId),
          bufferId: String(data.bufferId),
          mime: String(data.mime),
          digest: digestOf(data.bytes as ArrayBuffer),
        })
      } else if (data.type === 'tc:source') {
        target.tcSource.push({
          sourceId: String(data.sourceId),
          objectUrl: String(data.objectUrl),
        })
      } else if (data.type === 'tc:worker') {
        target.tcWorker.push(String(data.sourceId))
      }
    }

    // In the bridge frame this wraps the receiver of the authenticated content-script port. Page
    // and isolated-world ports have prototypes in their own realms and do not reach this probe.
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

  // The address is routed without the fragment and opened with it: a fragment is never sent to
  // the network, so a route that carries one matches nothing.
  const opened = url + (options.hash ?? '')

  if (options.csp === undefined) {
    await routeLocal(page, htmlFile, url)
    await page.goto(opened)
  } else {
    // The policy comes as a header and not as a meta tag on purpose: a header is what a real site
    // sends, and it is the form nothing in the page can read for itself.
    await page.route('**/fixtures/**', async (route) => {
      const rel = new URL(route.request().url()).pathname.replace('/fixtures/', '')
      await route.fulfill({
        body: await fs.readFile(path.resolve('tests/fixtures', rel)),
        contentType: 'video/mp4',
      })
    })
    await page.route(url, async (route) => {
      await route.fulfill({
        body: await fs.readFile(path.resolve('tests/e2e/page', htmlFile), 'utf8'),
        contentType: 'text/html',
        headers: { 'content-security-policy': options.csp! },
      })
    })
    await page.goto(opened)
  }

  return { context, page, extensionId, log: () => consoleLog.join(' | ') || '(empty)' }
}

const openWorkerPlayer = () => open(PAGE_URL, 'worker-player.html')

/** Waits until the page's worker has appended everything it has. */
const playerDone = (page: Page) =>
  page.waitForFunction(
    () => {
      const state = window as unknown as PlayerState
      return state.allAppended === true || state.workerError !== undefined
    },
    undefined,
    { timeout: 15_000 },
  )

/** The bridge document; the test puts the same listener into it. */
async function bridgeFrame(page: Page, extensionId: string, log: () => string): Promise<Frame> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const frame = page.frames().find((candidate) => candidate.url().includes(extensionId))
    if (frame) return frame
    expect(Date.now(), `the bridge frame never appeared; page console: ${log()}`).toBeLessThan(
      deadline,
    )
    await page.waitForTimeout(50)
  }
}

const close = (context: BrowserContext) => context.close()

test('the hook sees every appendBuffer a worker makes', async () => {
  const { context, page, log } = await openWorkerPlayer()
  await playerDone(page)

  const state = await page.evaluate(() => {
    const player = window as unknown as PlayerState
    return { appended: player.appended, workerError: player.workerError ?? null }
  })
  expect(state.workerError, `the page's worker failed; console: ${log()}`).toBeNull()
  expect(state.appended, 'setup: the worker appended nothing').toBe(APPENDED.length)

  const seen = await page.evaluate(() => (window as unknown as Probe).tcAppend)

  expect(seen.length, `the hook missed appends made in the worker; console: ${log()}`).toBe(
    state.appended,
  )
  // The content, not the count: a copy has to carry the same bytes in the same order.
  expect(seen.map((item) => item.digest)).toEqual(await fixtureDigests())

  // One MediaSource and one SourceBuffer, both inside the worker: without one identifier per
  // stream the registry cannot tell one track from another.
  const sourceId = seen[0]!.sourceId
  expect(new Set(seen.map((item) => item.sourceId))).toEqual(new Set([sourceId]))
  expect(new Set(seen.map((item) => item.bufferId)).size).toBe(1)
  expect(new Set(seen.map((item) => item.mime))).toEqual(new Set([MIME]))

  const named = await page.evaluate(() => {
    const probe = window as unknown as Probe
    return { worker: probe.tcWorker, main: probe.tcSource }
  })
  // The stream is announced by name, once, and the watcher has nothing else to go on: this is
  // the whole difference from a MediaSource in the page, which is announced with an address.
  expect(named.worker).toEqual([sourceId])
  expect(named.main, 'the main world of such a page holds no MediaSource at all').toEqual([])

  await close(context)
})

test('the material of a worker reaches the bridge frame', async () => {
  const { context, page, extensionId, log } = await openWorkerPlayer()
  await playerDone(page)

  const bridge = await bridgeFrame(page, extensionId, log)
  await bridge
    .waitForFunction(
      (count) => (window as unknown as Probe).tcAppend.length >= count,
      APPENDED.length,
      { timeout: 5_000 },
    )
    .catch(() => undefined)

  const delivered = await bridge.evaluate(() =>
    (window as unknown as Probe).tcAppend.map((item) => item.digest),
  )
  expect(delivered, `the bridge got no segments; page console: ${log()}`).toEqual(
    await fixtureDigests(),
  )

  await close(context)
})

test('the page and its worker go on exactly as they did', async () => {
  const { context, page, log } = await openWorkerPlayer()
  await playerDone(page)

  const state = await page.evaluate(() => {
    const player = window as unknown as PlayerState
    const video = document.querySelector('video')!
    const buffered: Array<[number, number]> = []
    for (let index = 0; index < video.buffered.length; index++) {
      buffered.push([video.buffered.start(index), video.buffered.end(index)])
    }
    return {
      workerError: player.workerError ?? null,
      workerSaw: player.workerSaw ?? [],
      pageMessages: player.pageMessages,
      buffered,
      videoError: video.error ? video.error.code : null,
      srcObject: Object.prototype.toString.call(video.srcObject),
    }
  })

  expect(state.workerError, `the worker of the page failed; console: ${log()}`).toBeNull()
  expect(state.videoError, 'the element must not be given an error by the hook').toBeNull()
  expect(state.srcObject, 'the page plays a handle, as it did before').toBe(
    '[object MediaSourceHandle]',
  )
  expect(state.buffered.length, 'the element buffered nothing — playback is broken').toBe(1)

  // The handshake that hands the worker its channel must not reach the page's own handler, in
  // either direction: a message a page did not send itself is a message it may well refuse.
  expect(state.workerSaw, 'the extension handshake showed up in the worker of the page').toEqual([
    'type,segments',
  ])
  expect(state.pageMessages, 'the page was given a message it did not expect').toEqual([
    'handle',
    'appended',
    'appended',
    'appended',
    'appended',
    'done',
  ])

  await close(context)
})



test('a worker started from an address keeps its address, and its relative ones', async () => {
  const { context, page, log } = await open(URL_PAGE, 'url-worker.html')
  await playerDone(page)

  const state = await page.evaluate(() => {
    const player = window as unknown as PlayerState
    return { probes: player.probes ?? null, workerError: player.workerError ?? null }
  })

  expect(state.workerError, `the worker of the page failed; console: ${log()}`).toBeNull()

  // Wrapping a worker means loading it out of a blob, and a blob is an address nothing can be
  // resolved against: unrepaired, every line here would read "throw". The values are the ones the
  // same page produces with the extension out of the browser altogether.
  expect(state.probes).toEqual({
    location: `${new URL(URL_PAGE).origin}/js/url-worker.js`,
    relative: `${new URL(URL_PAGE).origin}/js/sibling.js`,
    sibling: 'ok',
    fetch: `${new URL(URL_PAGE).origin}/js/probe 200`,
  })

  // And the material still arrives: the repair is not bought by giving up the recording.
  const seen = await page.evaluate(() => (window as unknown as Probe).tcAppend)
  expect(seen.map((item) => item.digest)).toEqual(await fixtureDigests())

  await close(context)
})

test('a module worker keeps its own address for its own imports', async () => {
  const { context, page, log } = await open(URL_PAGE, 'url-worker.html', { hash: '#module' })
  await playerDone(page)

  const state = await page.evaluate(() => {
    const player = window as unknown as PlayerState
    return { probes: player.probes ?? null, workerError: player.workerError ?? null }
  })

  expect(state.workerError, `the module worker of the page failed; console: ${log()}`).toBeNull()

  const origin = new URL(URL_PAGE).origin
  expect(state.probes).toEqual({
    location: `${origin}/js/module-worker.mjs`,
    // A module is loaded by import() rather than by importScripts, and keeps its own address
    // through it: its relative imports and its import.meta land where they did before.
    importMeta: `${origin}/js/module-worker.mjs`,
    sibling: 'ok',
    fetch: `${origin}/js/probe 200`,
  })

  const seen = await page.evaluate(() => (window as unknown as Probe).tcAppend)
  expect(seen.map((item) => item.digest)).toEqual(await fixtureDigests())

  await close(context)
})

test('a worker address of another origin is refused exactly as the browser refuses it', async () => {
  const html = `<!doctype html><meta charset="utf-8" /><title>foreign worker</title><script>
    window.workerError = null
    try {
      window.worker = new Worker(${JSON.stringify(FOREIGN_WORKER)})
    } catch (error) {
      window.workerError = String(error)
    }
    window.allAppended = true
  </script>`

  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()
  const url = 'https://tailcut.test/foreign-worker'
  await page.route(url, (route) => route.fulfill({ body: html, contentType: 'text/html' }))
  await page.goto(url)

  const failure = await page.evaluate(() => (window as unknown as PlayerState).workerError)

  // A dedicated worker of another origin is a SecurityError, and importScripts inside a blob is
  // not: a wrapper that loaded it anyway would hand the page a worker the browser had refused it.
  expect(failure, 'the hook granted the page a worker the browser refuses').toContain(
    'SecurityError',
  )
  expect(extensionId).toBeTruthy()

  await close(context)
})

test('a page whose policy forbids blob workers keeps its worker and is told it cannot be recorded', async () => {
  const { context, page, extensionId, log } = await open(CSP_PAGE, 'url-worker.html', {
    csp: STRICT_CSP,
  })
  await playerDone(page)

  const state = await page.evaluate(() => {
    const player = window as unknown as PlayerState
    return { workerError: player.workerError ?? null, probes: player.probes ?? null }
  })

  // The whole of the mechanism is unavailable here: a blob worker cannot be started at all, and
  // the refusal of one arrives a task after the constructor has already handed the page a worker
  // that will never run. Wrapping on this page would take its player away outright.
  expect(state.workerError, `the extension cost the page its worker; console: ${log()}`).toBeNull()
  expect(state.probes, 'the page did not get through its playback').not.toBeNull()

  const seen = await page.evaluate(() => (window as unknown as Probe).tcAppend)
  expect(seen, 'nothing of such a page can be recorded, and nothing was').toEqual([])

  // The watcher gives an element a moment to have its stream named before it calls the page
  // unrecordable, and the popup asks the tab once, when it opens.
  await page.waitForTimeout(UNNAMED_MS)
  const popup = await openPopupOn(context, page, extensionId)
  await expect(popup.getByTestId('nothing')).toHaveText(
    'tailcut cannot reach the player on this page, so nothing of it was recorded.',
  )
  await expect(popup.getByTestId('save'), 'a page out of reach was offered for saving').toHaveCount(0)

  await close(context)
})

test('a page that requires trusted addresses keeps its worker, and is told the same', async () => {
  const { context, page, extensionId, log } = await open(TRUSTED_PAGE, 'trusted-worker.html', {
    csp: TRUSTED_CSP,
  })
  await playerDone(page)

  const failure = await page.evaluate(() => (window as unknown as PlayerState).workerError ?? null)
  expect(failure, `the page lost its worker; console: ${log()}`).toBeNull()

  const seen = await page.evaluate(() => (window as unknown as Probe).tcAppend)
  expect(seen, 'the page refuses the address the wrapper hands it, and nothing was recorded').toEqual(
    [],
  )

  await page.waitForTimeout(UNNAMED_MS)
  const popup = await openPopupOn(context, page, extensionId)
  await expect(popup.getByTestId('nothing')).toHaveText(
    'tailcut cannot reach the player on this page, so nothing of it was recorded.',
  )
  await expect(popup.getByTestId('save'), 'a page out of reach was offered for saving').toHaveCount(0)

  await close(context)
})

test('a worker built before the first task is left alone, and the page says so', async () => {
  const { context, page, extensionId, log } = await open(EARLY_PAGE, 'worker-early.html')
  await playerDone(page)

  const failure = await page.evaluate(() => (window as unknown as PlayerState).workerError ?? null)
  expect(failure, `the page lost its worker; console: ${log()}`).toBeNull()

  const seen = await page.evaluate(() => (window as unknown as Probe).tcAppend)
  expect(seen, 'a worker built before the answer about the policy was in was wrapped anyway').toEqual(
    [],
  )

  // The limit is a limit and not a silence: the popup says the page cannot be recorded rather
  // than showing the words that mean "wait a little longer".
  await page.waitForTimeout(UNNAMED_MS)
  const popup = await openPopupOn(context, page, extensionId)
  await expect(popup.getByTestId('nothing')).toHaveText(
    'tailcut cannot reach the player on this page, so nothing of it was recorded.',
  )
  await expect(popup.getByTestId('save'), 'a page out of reach was offered for saving').toHaveCount(0)

  await close(context)
})

test('the popup lists what was recorded out of a worker', async () => {
  const { context, page, extensionId, log } = await openWorkerPlayer()
  await playerDone(page)

  // Six seconds of playing is what triage asks of a player before it is granted a session; the
  // material is three fragments of two seconds, so it is played round twice.
  await page.evaluate(() => {
    const video = document.querySelector('video')!
    video.loop = true
    video.muted = true
    return video.play()
  })
  await page.waitForTimeout(7_000)

  const popup = await openPopupOn(context, page, extensionId)

  await expect(popup.getByTestId('title')).toHaveText('worker player')
  await expect(popup.getByTestId('host')).toHaveText('tailcut.test')
  await expect(popup.getByTestId('duration'), `page console: ${log()}`).toHaveText('0:06')
  await expect(
    popup.getByTestId('unreachable'),
    'the page was recorded, and nothing on it is out of reach',
  ).toHaveCount(0)

  await close(context)
})

test('the editor keeps worker fragments placed by SourceBuffer timestampOffset continuous', async () => {
  test.setTimeout(90_000)
  const { context, page, extensionId, log } = await open(OFFSET_PAGE, 'worker-offset.html')
  await playerDone(page)

  try {
    const state = await page.evaluate(() => ({
      error: (window as unknown as { workerError?: string }).workerError ?? null,
      buffered: (() => {
        const video = document.querySelector('video')!
        return video.buffered.length
          ? [video.buffered.start(0), video.buffered.end(video.buffered.length - 1)]
          : null
      })(),
    }))
    expect(state.error, `the worker player failed; console: ${log()}`).toBeNull()
    expect(state.buffered?.[0]).toBeCloseTo(0, 6)
    expect(state.buffered?.[1]).toBeCloseTo(6, 5)

    await page.evaluate(() => {
      const video = document.querySelector('video')!
      video.loop = true
      return video.play()
    })
    await page.waitForTimeout(7_000)

    const { editor } = await clickEdit(context, page, extensionId)
    await expect(editor.getByTestId('duration')).toHaveText('0:06')
    await expect(editor.getByTestId('gaps')).toHaveText('0 gaps')
    await expect(editor.getByTestId('frame-count')).toHaveText('144')
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)

    await editor.evaluate(() => {
      const state = window as unknown as { tcOffsetFrameTimes?: number[] }
      const video = document.querySelector('video')!
      state.tcOffsetFrameTimes = []

      const collect = (_now: number, metadata: { mediaTime: number }): void => {
        state.tcOffsetFrameTimes!.push(metadata.mediaTime)
        if (metadata.mediaTime < 4.5) video.requestVideoFrameCallback(collect)
      }
      video.requestVideoFrameCallback(collect)
    })
    await editor.getByTestId('play').click()
    await editor.waitForFunction(
      () => {
        const times = (window as unknown as { tcOffsetFrameTimes?: number[] }).tcOffsetFrameTimes
        return times !== undefined && times.length > 0 && times[times.length - 1]! >= 4.25
      },
      undefined,
      { timeout: 15_000 },
    )

    const played = await editor.evaluate(
      () => (window as unknown as { tcOffsetFrameTimes: number[] }).tcOffsetFrameTimes,
    )
    expect(played[0]).toBeLessThan(0.5)
    expect(played.at(-1)).toBeGreaterThanOrEqual(4.25)
    for (let index = 1; index < played.length; index++) {
      const step = played[index]! - played[index - 1]!
      expect(step, `preview moved backwards at frame callback ${index}`).toBeGreaterThanOrEqual(0)
      expect(step, `preview jumped at frame callback ${index}`).toBeLessThan(0.25)
    }
    for (const seam of [2, 4]) {
      const after = played.findIndex((time) => time >= seam)
      expect(after, `preview did not play across the ${seam}s seam`).toBeGreaterThan(0)
      expect(played[after]! - played[after - 1]!, `preview jumped across the ${seam}s seam`).toBeLessThan(
        0.25,
      )
    }

    await editor.getByTestId('play').click()
    await editor.getByTestId('recording-start').click()
    await editor.keyboard.press('i')
    await expect(editor.getByTestId('clip')).toHaveCount(1)

    const exported = probeFile((await exportClipWith(editor)).file)
    const video = exported.streams.find((stream) => stream.codec_type === 'video')!
    expect(Number(video.nb_read_frames)).toBe(144)
    expect(Number(exported.format.duration)).toBeCloseTo(6, 2)
  } finally {
    await close(context)
  }
})

test('the editor follows SourceBuffer sequence mode placement', async () => {
  test.setTimeout(45_000)
  const { context, page, extensionId, log } = await open(SEQUENCE_PAGE, 'worker-sequence.html')
  await playerDone(page)

  try {
    const state = await page.evaluate(() => ({
      error: (window as unknown as { workerError?: string }).workerError ?? null,
      buffered: (() => {
        const video = document.querySelector('video')!
        return video.buffered.length
          ? [video.buffered.start(0), video.buffered.end(video.buffered.length - 1)]
          : null
      })(),
    }))
    expect(state.error, `the worker sequence player failed; console: ${log()}`).toBeNull()
    expect(state.buffered?.[0]).toBeCloseTo(0, 6)
    expect(state.buffered?.[1]).toBeCloseTo(6, 5)

    await page.evaluate(() => document.querySelector('video')!.play())
    await page.waitForTimeout(7_000)

    const { editor } = await clickEdit(context, page, extensionId)
    await expect.soft(editor.getByTestId('duration')).toHaveText('0:06')
    await expect.soft(editor.getByTestId('gaps')).toHaveText('0 gaps')
    await expect.soft(editor.getByTestId('frame-count')).toHaveText('144')
  } finally {
    await close(context)
  }
})
