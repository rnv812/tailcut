import { test, expect, type Frame, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchWithExtension, routeLocal, serveLocal } from './helpers'
import { sessionKey } from '../../src/core/session-key'

const PAGE_URL = 'https://tailcut.test/player'
/** A second address tells working "on any site" apart from working on one familiar host. */
const OTHER_PAGE_URL = 'https://some-random-site.example/player'
/** A foreign top page embedding the same player in a nested frame. */
const EMBED_URL = 'https://embedder.example/watch'

/** A policy violation in the form tests/e2e/page/player.html writes it down. */
type Violation = { directive: string; blockedURI: string }

type Probe = {
  bridgeAtScriptStart?: boolean
  bridgeReady?: string[]
  cspViolations: Violation[]
}
type PlayerState = { appended: number; allAppended?: boolean }

/** Waits for a frame fitting the condition; gives back undefined if none ever appeared. */
async function waitForFrame(
  page: Page,
  match: (frame: Frame) => boolean,
  timeout = 5_000,
): Promise<Frame | undefined> {
  const deadline = Date.now() + timeout
  for (;;) {
    const frame = page.frames().find(match)
    if (frame) return frame
    if (Date.now() > deadline) return undefined
    await page.waitForTimeout(100)
  }
}

/** Waits for a frame on the extension origin; undefined if it never stood up. */
const waitForExtensionFrame = (page: Page, extensionId: string) =>
  waitForFrame(page, (frame) => frame.url().includes(extensionId))

type LocalPage = { url: string; html: string }

/**
 * Opens a local page; the rest are laid out under their own addresses so that the page can embed
 * them. A CSP violation is visible only in the console of the page. It is collected so that a
 * failure tells a policy refusal apart from a mistake in the insertion.
 */
async function openPage(entry: LocalPage, ...embedded: LocalPage[]) {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  const consoleLog: string[] = []
  page.on('console', (msg) => consoleLog.push(`${msg.type()}: ${msg.text()}`))
  page.on('pageerror', (err) => consoleLog.push(`pageerror: ${err.message}`))

  for (const inner of embedded) await routeLocal(page, inner.html, inner.url)
  await serveLocal(page, entry.html, entry.url)

  return { context, page, extensionId, consoleLog, log: () => consoleLog.join(' | ') || '(empty)' }
}

/** Opens the test player as the top document under the given address. */
const openPlayer = (url: string) => openPage({ url, html: 'player.html' })

/** Opens a foreign page embedding the same player in a nested frame. */
const openEmbeddedPlayer = () =>
  openPage({ url: EMBED_URL, html: 'embed.html' }, { url: PAGE_URL, html: 'player.html' })

/**
 * Waits for handshakes in the given document and gives back the origins of their senders;
 * null — not one arrived in the time allowed.
 */
async function handshakes(target: Page | Frame, timeout = 5_000): Promise<string[] | null> {
  return target
    .waitForFunction(
      () => {
        const ready = (window as unknown as Probe).bridgeReady
        return ready && ready.length > 0 ? ready : null
      },
      undefined,
      { timeout },
    )
    .then((value) => value.jsonValue())
    .catch(() => null)
}

async function bridgeFrame(page: Page, extensionId: string, log: () => string): Promise<Frame> {
  const frame = await waitForExtensionFrame(page, extensionId)
  expect(
    frame,
    `the extension iframe should appear despite frame-src none; page console: ${log()}`,
  ).toBeTruthy()
  await frame!.waitForLoadState('domcontentloaded')
  return frame!
}

/** A session summary in the form the bridge answers a tc:list request with. */
type Summary = {
  key: string
  url: string
  title: string
  duration: number
  bytes: number
  omits?: string
}

/** The media fragments tests/e2e/page/player.html appends. */
const CHUNKS = [
  'h264/chunk-stream0-00001.m4s',
  'h264/chunk-stream0-00002.m4s',
  'h264/chunk-stream0-00003.m4s',
]

/** Weight of the fragments on disk: that many bytes have to reach the registry. */
async function chunkBytes(): Promise<number> {
  const sizes = await Promise.all(
    CHUNKS.map(async (rel) => (await fs.stat(path.resolve('tests/fixtures', rel))).size),
  )
  return sizes.reduce((total, size) => total + size, 0)
}

/**
 * Asks the bridge for the list of sessions through the same channel the popup uses: a message
 * with a MessageChannel port, the answer arriving in the port. null — it did not answer in time.
 */
function listSessions(page: Page, timeout = 3_000): Promise<Summary[] | null> {
  return page.evaluate(async (limit) => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-tailcut]')!
    const channel = new MessageChannel()

    return new Promise<Summary[] | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), limit)
      channel.port1.onmessage = (event) => {
        clearTimeout(timer)
        resolve(event.data)
      }
      iframe.contentWindow!.postMessage({ type: 'tc:list' }, '*', [channel.port2])
    })
  }, timeout)
}

/**
 * Waits until the registry comes to the expected shape and gives back the last thing seen. The
 * wait is only there for the road the segments travel to the bridge; the verdict is passed by the
 * check in the test itself — on a wait that ran out it gets whatever the registry managed to
 * gather and shows it in the message.
 */
async function sessionsWhen(
  page: Page,
  ready: (sessions: Summary[]) => boolean,
  timeout = 5_000,
): Promise<Summary[] | null> {
  const deadline = Date.now() + timeout
  let last: Summary[] | null = null
  for (;;) {
    last = await listSessions(page)
    if (last && ready(last)) return last
    if (Date.now() > deadline) return last
    await page.waitForTimeout(100)
  }
}

/** Waits until the player of the page has appended every one of its segments. */
const playerDone = (page: Page) =>
  page.waitForFunction(() => (window as unknown as PlayerState).allAppended === true)

/** The session the player of the test page gathers: three fragments of two seconds in a row. */
async function playerSession(url: string): Promise<Summary> {
  return {
    // The key the popup will later ask the registry for this session by: the address of the page
    // is not one — the referral marks are cut out of it and the codecs appended. The player of
    // the page plays a single avc1 video track, and the length is unknown at this stage.
    key: sessionKey({ url, codecs: ['avc1'], durationSeconds: Infinity }),
    url,
    // The title the bridge can learn only from tc:context: on its own origin it does not see one,
    // and the referrer carries the address alone. An empty string here would mean the context
    // never arrived.
    title: 'test player',
    duration: 6,
    bytes: await chunkBytes(),
  }
}

/**
 * One session, whole: six seconds of material and nothing a save would leave behind. The summary
 * describes the file the popup offers, so an omission here would mean the registry gathered
 * something other than the three fragments of the page.
 */
const oneCompleteSession = (sessions: Summary[]): boolean =>
  sessions.length === 1 && sessions[0]!.duration === 6 && sessions[0]!.omits === undefined

test('the bridge stands up on a page with a strict CSP and gathers its segments into a session', async () => {
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)
  await playerDone(page)

  // The whole road at once: the wrappers in the MAIN world, the relaying by the content script,
  // the parsing of the boxes in the bridge and the laying out on the timeline. Exact figures
  // rather than "something gathered": the length comes from the moof and the timescale, the
  // weight from the bytes themselves. A registry that gathered junk gives neither.
  expect(
    await sessionsWhen(page, oneCompleteSession),
    `the bridge should gather a session out of the page's segments; page console: ${log()}`,
  ).toEqual([await playerSession(PAGE_URL)])

  // A page with a strict CSP has to go on playing: the bridge does not disturb its own MSE.
  expect(await page.evaluate(() => (window as unknown as PlayerState).appended)).toBe(4)

  await context.close()
})

test('the policy of the page works: it forbids an ordinary frame and not the extension frame', async () => {
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)
  await playerDone(page)

  // The negative control for the whole set. The other checks prove that the extension frame
  // stands up in spite of `frame-src 'none'`, but on their own they are green on a page with no
  // policy at all: a typo in the meta or a change in Chrome's behaviour would turn the main test
  // of the architecture into an empty one, silently. Here the page inserts an ordinary frame with
  // its own hands — and it must be forbidden by the very policy the bridge lives beside.
  const plain = await page.evaluate(async (url) => {
    const probe = window as unknown as Probe
    const before = probe.cspViolations.length

    const iframe = document.createElement('iframe')
    // The address is the same as the page's own, and it is served by the test. That way the check
    // also catches a weakened meta: without `frame-src 'none'` the policy falls back to
    // `default-src 'self'`, its own origin turns out to be allowed, and the frame really loads.
    iframe.src = url
    document.body.appendChild(iframe)

    await new Promise((resolve) => setTimeout(resolve, 1_000))

    // A forbidden frame is left with an opaque origin and has no document; had it loaded from its
    // address, the origin would be the page's own and the title would read.
    let title: string
    try {
      title = iframe.contentDocument?.title ?? '(no document)'
    } catch {
      title = '(no document)'
    }
    return { violations: probe.cspViolations.slice(before), title }
  }, PAGE_URL)

  expect(
    plain.violations,
    `frame-src 'none' did not fire: the page inserted an ordinary frame without a violation; console: ${log()}`,
  ).toEqual([{ directive: 'frame-src', blockedURI: PAGE_URL }])
  expect(plain.title, 'a frame forbidden by the policy loaded its document anyway').toBe(
    '(no document)',
  )
  expect(
    page.frames().filter((frame) => frame !== page.mainFrame() && frame.url() === PAGE_URL),
    'a frame forbidden by the policy turned up among the frames of the page',
  ).toEqual([])

  // And under that same live policy the bridge stands beside it and answers.
  expect(
    await sessionsWhen(page, oneCompleteSession),
    `the extension frame stopped answering under a working policy; console: ${log()}`,
  ).toEqual([await playerSession(PAGE_URL)])

  await context.close()
})

test('the bridge gathers a session on any origin, not only on a familiar one', async () => {
  // The same player on a stranger's host: the extension is declared on <all_urls>, and the
  // address of the session has to come from the page itself. A registry that knows one address
  // would give somebody else's here.
  const { context, page, extensionId, log } = await openPlayer(OTHER_PAGE_URL)
  await bridgeFrame(page, extensionId, log)
  await playerDone(page)

  expect(
    await sessionsWhen(page, oneCompleteSession),
    `the bridge should gather a session on any origin; page console: ${log()}`,
  ).toEqual([await playerSession(OTHER_PAGE_URL)])

  await context.close()
})

test('the bridge is invisible on the page and takes up no room', async () => {
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)

  const placement = await page.evaluate(() => {
    const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-tailcut]')
    const iframe = frames[0]!
    const rect = iframe.getBoundingClientRect()
    const style = getComputedStyle(iframe)
    return {
      count: frames.length,
      width: rect.width,
      height: rect.height,
      visibility: style.visibility,
      position: style.position,
      pointerEvents: style.pointerEvents,
      inDocumentElement: iframe.parentElement === document.documentElement,
      ariaHidden: iframe.getAttribute('aria-hidden'),
    }
  })

  expect(placement).toEqual({
    count: 1,
    width: 0,
    height: 0,
    visibility: 'hidden',
    position: 'fixed',
    pointerEvents: 'none',
    inDocumentElement: true,
    ariaHidden: 'true',
  })

  await context.close()
})

test('the bridge stands up before the first script of the page', async () => {
  // Waiting for the frame "eventually" costs nothing: the player starts buffering from its own
  // script, and a bridge that stood up after DOMContentLoaded would miss the beginning.
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)

  expect(
    await page.evaluate(() => (window as unknown as Probe).bridgeAtScriptStart),
    `the bridge should be in the DOM by the time of the page's first script; page console: ${log()}`,
  ).toBe(true)

  await context.close()
})

// The extension is declared on <all_urls>, so the handshake is checked at both addresses: on a
// single test address a hard-wired targetOrigin is indistinguishable from "any parent", and the
// page learns of the bridge from this message alone — on every other site it would go missing
// silently.
for (const url of [PAGE_URL, OTHER_PAGE_URL]) {
  const host = new URL(url).host

  test(`the bridge greets the page once loaded (${host})`, async () => {
    const { context, page, extensionId, log } = await openPlayer(url)
    await bridgeFrame(page, extensionId, log)

    expect(
      await handshakes(page),
      `the bridge should send tc:ready to the page on ${host}; page console: ${log()}`,
    ).toEqual([`chrome-extension://${extensionId}`])

    await context.close()
  })
}

test('the bridge of a nested frame greets its own frame, not the top page', async () => {
  // A player in a nested frame is the most ordinary layout there is (embedded YouTube, Vimeo,
  // JW). The bridge is declared on all_frames and stands up inside such a frame; the document
  // that inserted it is the one that must know of it — otherwise the player never learns of the
  // bridge, and the top page gets a handshake from a bridge it has no reason to address.
  const { context, page, extensionId, log } = await openEmbeddedPlayer()

  const player = await waitForFrame(page, (frame) => frame.url() === PAGE_URL)
  expect(player, `the frame with the player should appear; page console: ${log()}`).toBeTruthy()

  expect(
    await handshakes(player!),
    `the bridge should send tc:ready to its own frame; page console: ${log()}`,
  ).toEqual([`chrome-extension://${extensionId}`])

  // The top page hears only its own bridge: a second handshake would mean the bridge of the
  // nested frame knocking upwards, past its own document.
  expect(
    await handshakes(page),
    `the top page got a handshake that was not its own; page console: ${log()}`,
  ).toEqual([`chrome-extension://${extensionId}`])

  await context.close()
})

test('foreign messages open no sessions and do not bring the bridge down', async () => {
  const { context, page, extensionId, consoleLog, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)
  await playerDone(page)

  const before = await sessionsWhen(page, oneCompleteSession)
  expect(before, `setup: the bridge should gather the player's session; console: ${log()}`).toEqual([
    await playerSession(PAGE_URL),
  ])

  await page.evaluate(async () => {
    const target = document.querySelector<HTMLIFrameElement>('iframe[data-tailcut]')!.contentWindow!

    // On live pages the windows are flooded with messages from bundlers, analytics and adverts,
    // and the bytes in a tc:append arrive from an arbitrary site and need not be a segment at
    // all. An exception on any of them would stop everything that follows from being taken in:
    // the bridge has one listener.
    target.postMessage(null, '*')
    target.postMessage({ type: 'tc:drm', sourceId: 's' }, '*')
    target.postMessage({ type: 'tc:source', sourceId: 's', objectUrl: 'blob:x' }, '*')
    target.postMessage({ type: 'webpackHotUpdate' }, '*')

    const junk = new ArrayBuffer(1543)
    new Uint8Array(junk).fill(0xa5)
    target.postMessage(
      { type: 'tc:append', sourceId: 'junk', bufferId: 'b', mime: 'video/mp4', bytes: junk },
      '*',
      [junk],
    )

    await new Promise((resolve) => setTimeout(resolve, 500))
  })

  expect(
    await listSessions(page),
    `the registry suffered from foreign messages; console: ${log()}`,
  ).toEqual(before)
  expect(
    consoleLog.filter((line) => line.startsWith('pageerror')),
    `the bridge must not fall over on foreign messages; page console: ${log()}`,
  ).toEqual([])

  await context.close()
})

test('a second source of the same video fills in the session instead of opening a new one', async () => {
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)
  await playerDone(page)

  const before = await sessionsWhen(page, oneCompleteSession)
  expect(before, `setup: the bridge should gather the player's session; console: ${log()}`).toEqual([
    await playerSession(PAGE_URL),
  ])

  // A second player of the same clip on the same page — a restart after a seek, or a second
  // <video>. The address and the codecs are the same, so it is the same session, and the repeated
  // fragment is already on its map. It also shows that the bytes travel by transfer: the buffer
  // is detached at the sender.
  const detached = await page.evaluate(async () => {
    const target = document.querySelector<HTMLIFrameElement>('iframe[data-tailcut]')!.contentWindow!
    const load = async (rel: string): Promise<ArrayBuffer> =>
      (await fetch(`/fixtures/${rel}`)).arrayBuffer()

    const segments = [
      await load('h264/init-stream0.m4s'),
      await load('h264/chunk-stream0-00001.m4s'),
    ]
    for (const bytes of segments) {
      target.postMessage(
        { type: 'tc:append', sourceId: 'second', bufferId: 'sb', mime: 'video/mp4', bytes },
        '*',
        [bytes],
      )
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
    return segments.every((bytes) => bytes.byteLength === 0)
  })

  expect(detached, `the buffer did not travel by transfer; page console: ${log()}`).toBe(true)
  expect(
    await listSessions(page),
    `the material of one clip scattered across sessions; console: ${log()}`,
  ).toEqual(before)

  await context.close()
})
