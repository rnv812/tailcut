import { test, expect, type Frame, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchWithExtension, serveLocal } from './helpers'
import { sessionKey } from '../../src/core/session-key'

const BANNER_URL = 'https://tailcut.test/banner'
const PLAYER_URL = 'https://tailcut.test/player'
/** A banner and a real player on one page: a verdict about one must not touch the other. */
const MIXED_URL = 'https://tailcut.test/mixed'
/** A player the page leaves above the window for a moment while it lays itself out. */
const SCROLLED_URL = 'https://tailcut.test/scrolled'
/** A player inside an open shadow root — the layout of tv.apple.com. */
const SHADOW_URL = 'https://tailcut.test/shadow'
/** The same player behind a closed shadow root: nothing can reach it, ours included. */
const CLOSED_SHADOW_URL = 'https://tailcut.test/closed-shadow'
/** A page that asks the browser for a key system, the way a protected player does. */
const DRM_URL = 'https://tailcut.test/drm'

/** A verdict in the form the content script sends it to the bridge in. */
type SeenVerdict = { sourceId: string; verdict: string }
/** The tie between a stream and the address from createObjectURL: it matches a verdict to an element. */
type SeenSource = { sourceId: string; objectUrl: string }

/** What the listener the test plants in every document of the page has gathered. */
type Probe = {
  tcVerdict: SeenVerdict[]
  tcSource: SeenSource[]
  tcAppend: number
  tcDrm: number
}
type PageState = { allAppended?: boolean; headStart?: boolean }
/** What tests/e2e/page/scrolled.html offers the test: one fragment appended on demand. */
type StepPage = { appendSegment: (index: number) => Promise<void> }
/** The address of the stream a page publishes for the test when the element is out of reach. */
type NamedSource = { playerSrc?: string }
/** What tests/e2e/page/drm.html offers the test: the moment the player asks for keys. */
type DrmPage = { askForKeys: () => void; keysAsked?: boolean; keysError: string | null }

/** A session summary in the form the bridge answers a tc:list request with. */
type Summary = {
  key: string
  url: string
  title: string
  duration: number
  bytes: number
  omits?: string
}

/** The media fragments the player of the test pages appends. */
const CHUNKS = [
  'h264/chunk-stream0-00001.m4s',
  'h264/chunk-stream0-00002.m4s',
  'h264/chunk-stream0-00003.m4s',
]

/** Weight of the fragments on disk: that many bytes have to stay in the registry. */
async function chunkBytes(): Promise<number> {
  const sizes = await Promise.all(
    CHUNKS.map(async (rel) => (await fs.stat(path.resolve('tests/fixtures', rel))).size),
  )
  return sizes.reduce((total, size) => total + size, 0)
}

/**
 * Opens the page with the extension and a message listener planted before any script of its own.
 * The listener goes into every document, the bridge frame included: the verdict travels there,
 * while the tie between a source and an address is visible only in the window of the page itself.
 */
async function open(htmlFile: string, url: string) {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  const consoleLog: string[] = []
  page.on('console', (msg) => consoleLog.push(`${msg.type()}: ${msg.text()}`))
  page.on('pageerror', (err) => consoleLog.push(`pageerror: ${err.message}`))

  await page.addInitScript(() => {
    const probe = window as unknown as Probe
    probe.tcVerdict = []
    probe.tcSource = []
    probe.tcAppend = 0
    probe.tcDrm = 0

    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data !== 'object') return

      if (data.type === 'tc:verdict') {
        probe.tcVerdict.push({ sourceId: String(data.sourceId), verdict: String(data.verdict) })
      } else if (data.type === 'tc:source') {
        probe.tcSource.push({ sourceId: String(data.sourceId), objectUrl: String(data.objectUrl) })
      } else if (data.type === 'tc:append') {
        probe.tcAppend++
      } else if (data.type === 'tc:drm') {
        probe.tcDrm++
      }
    })
  })

  await serveLocal(page, htmlFile, url)

  return {
    context,
    page,
    extensionId,
    log: () => consoleLog.join(' | ') || '(empty)',
  }
}

/** Gives back the document of the bridge; the test plants the page's listener in it as well. */
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

/** Waits until the page has appended every one of its segments. */
const pageDone = (page: Page) =>
  page.waitForFunction(() => (window as unknown as PageState).allAppended === true, undefined, {
    timeout: 15_000,
  })

/** Stream identifier of the <video> standing under the given selector. */
function sourceIdOf(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const probe = window as unknown as Probe
    const video = document.querySelector<HTMLVideoElement>(sel)!
    return probe.tcSource.find((source) => source.objectUrl === video.src)?.sourceId ?? ''
  }, selector)
}

/**
 * Stream identifier of the player the page names itself. The element of such a page lives inside
 * a shadow root, where a query from the outside does not reach — which is the whole point of it,
 * so the address comes from the page rather than from the element.
 */
function namedSourceId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = window as unknown as Probe & NamedSource
    return probe.tcSource.find((source) => source.objectUrl === probe.playerSrc)?.sourceId ?? ''
  })
}

/** The last verdict about the given source; undefined — nothing came about it at all. */
const latest = (seen: SeenVerdict[], sourceId: string): string | undefined =>
  [...seen].reverse().find((item) => item.sourceId === sourceId)?.verdict

/**
 * Waits until the verdicts at the bridge come to the expected shape and gives back the last thing
 * seen. The wait is only there for the probation; the verdict is passed by the check in the test
 * itself — on a wait that ran out it gets whatever the bridge managed to hear and shows it in the
 * message.
 */
async function verdictsWhen(
  bridge: Frame,
  ready: (seen: SeenVerdict[]) => boolean,
  timeout = 15_000,
): Promise<SeenVerdict[]> {
  const deadline = Date.now() + timeout
  for (;;) {
    const seen = await bridge.evaluate(() => (window as unknown as Probe).tcVerdict)
    if (ready(seen) || Date.now() > deadline) return seen
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
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

/** Waits until the registry comes to the expected shape and gives back the last thing seen. */
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

/** The session the player of the test page gathers: three fragments of two seconds in a row. */
async function playerSession(url: string, title: string): Promise<Summary> {
  return {
    key: sessionKey({ url, codecs: ['avc1'], durationSeconds: Infinity }),
    url,
    title,
    duration: 6,
    bytes: await chunkBytes(),
  }
}

/**
 * One session, whole: six seconds of material and nothing that a save would leave behind. The
 * summary describes the file the popup offers, so a session with a piece missing out of it is
 * not the one this page collected.
 */
const oneCompleteSession = (sessions: Summary[]): boolean =>
  sessions.length === 1 && sessions[0]!.duration === 6 && sessions[0]!.omits === undefined

test('a banner leaves no trace in the registry', async () => {
  const { context, page, extensionId, log } = await open('banner.html', BANNER_URL)
  const bridge = await bridgeFrame(page, extensionId, log)
  await pageDone(page)

  // The bytes of the banner have to reach the bridge: the hook in the MAIN world always copies,
  // and the isolated world takes the decision. Without checking that, an empty registry would
  // prove nothing.
  await bridge
    .waitForFunction(() => (window as unknown as Probe).tcAppend >= 2, undefined, { timeout: 5_000 })
    .catch(() => undefined)
  expect(
    await bridge.evaluate(() => (window as unknown as Probe).tcAppend),
    `the segments of the banner never reached the bridge; page console: ${log()}`,
  ).toBe(2)

  const banner = await sourceIdOf(page, '#v')
  expect(banner, `the stream of the banner is tied to no address; page console: ${log()}`).not.toBe(
    '',
  )

  const seen = await verdictsWhen(bridge, (list) => latest(list, banner) === 'reject', 5_000)
  expect(latest(seen, banner), `the banner got no rejection; page console: ${log()}`).toBe('reject')
  expect(
    seen.map((item) => item.verdict),
    'a silent looping autoplay the size of a preview must not live to be promoted',
  ).not.toContain('promote')

  // A rejection erases what was gathered: the session opened by the first init segment does not
  // live to reach the popup.
  expect(
    await sessionsWhen(page, (sessions) => sessions.length === 0),
    `the material of the banner stayed in the registry; page console: ${log()}`,
  ).toEqual([])

  await context.close()
})

test('a real player lives to have a session', async () => {
  const { context, page, extensionId, log } = await open('player.html', PLAYER_URL)
  const bridge = await bridgeFrame(page, extensionId, log)
  await pageDone(page)

  // The probation is measured in time actually played, and the page holds exactly six seconds of
  // material — right on the threshold. Looping leaves room to spare, and the controls are in
  // place, so the banner rule (silent + looping + no controls) will not fire.
  await page.evaluate(() => {
    const video = document.querySelector('video')!
    video.loop = true
    return video.play()
  })

  const player = await sourceIdOf(page, 'video')
  const seen = await verdictsWhen(bridge, (list) => latest(list, player) === 'promote')

  expect(latest(seen, player), `the player was never promoted; page console: ${log()}`).toBe(
    'promote',
  )
  expect(
    seen.filter((item) => item.verdict === 'reject'),
    'a real player must get no rejection',
  ).toEqual([])

  expect(
    await sessionsWhen(page, oneCompleteSession),
    `the bridge should have kept the session of the player; page console: ${log()}`,
  ).toEqual([await playerSession(PLAYER_URL, 'test player')])

  await context.close()
})

test('a rejection of the banner does not touch the player on the same page', async () => {
  const { context, page, extensionId, log } = await open('mixed.html', MIXED_URL)
  const bridge = await bridgeFrame(page, extensionId, log)
  await pageDone(page)

  await page.evaluate(() => document.querySelector<HTMLVideoElement>('#player')!.play())

  const banner = await sourceIdOf(page, '#banner')
  const player = await sourceIdOf(page, '#player')
  expect(
    new Set([banner, player]).size,
    `the two players of the page should get different streams; page console: ${log()}`,
  ).toBe(2)

  const seen = await verdictsWhen(
    bridge,
    (list) => latest(list, banner) === 'reject' && latest(list, player) === 'promote',
  )
  expect(latest(seen, banner), `the banner got no rejection; page console: ${log()}`).toBe('reject')
  expect(latest(seen, player), `the player was never promoted; page console: ${log()}`).toBe(
    'promote',
  )

  // The verdict is addressed: the banner has a stream and a session of its own (the codecs in the
  // key differ), and the bridge has to erase its material without touching the neighbour's. A
  // rejection that took the neighbour with it would leave the registry empty; one that took
  // nothing would leave two sessions.
  expect(
    await sessionsWhen(page, oneCompleteSession),
    `the rejection of the banner should not have touched the player session; page console: ${log()}`,
  ).toEqual([await playerSession(MIXED_URL, 'banner and player')])

  await context.close()
})

test('a player the page scrolls out of sight for a moment keeps its recording', async () => {
  const { context, page, extensionId, log } = await open('scrolled.html', SCROLLED_URL)
  const bridge = await bridgeFrame(page, extensionId, log)

  // The head of the stream — the init segment and the first fragment — is in before anything
  // else happens, which is where rutube and dzen put theirs: measured at 1.85 to 2.96 seconds,
  // and no site of the survey ever sent a second init.
  await page.waitForFunction(() => (window as unknown as PageState).headStart === true, undefined, {
    timeout: 15_000,
  })
  await page.evaluate(() => {
    const video = document.querySelector('video')!
    video.loop = true
    return video.play()
  })

  const player = await sourceIdOf(page, 'video')
  expect(player, `the stream of the player is tied to no address; page console: ${log()}`).not.toBe(
    '',
  )

  // The page lays itself out and leaves the player above the window: on rutube and dzen this
  // happens around four seconds in, with the element at rect.top ≈ −740 px, and it lasts a poll
  // of the watcher or two. Off the screen is a rejection, and the player has not played its six
  // seconds yet, so nothing about it is confirmed.
  await page.evaluate(() => window.scrollTo(0, 1200))
  const rejected = await verdictsWhen(bridge, (list) => latest(list, player) === 'reject')
  expect(latest(rejected, player), `the player got no rejection; page console: ${log()}`).toBe(
    'reject',
  )

  // The player goes on downloading through all of it: a fragment arrives under the verdict.
  await page.evaluate(() => (window as unknown as StepPage).appendSegment(1))

  // And the page settles: the element is back in the window and the verdict turns.
  await page.evaluate(() => window.scrollTo(0, 0))
  const held = await verdictsWhen(bridge, (list) => latest(list, player) === 'hold')
  expect(latest(held, player), `the player never came back from the rejection; ${log()}`).toBe(
    'hold',
  )
  await page.evaluate(() => (window as unknown as StepPage).appendSegment(2))

  const seen = await verdictsWhen(bridge, (list) => latest(list, player) === 'promote')
  expect(latest(seen, player), `the player was never promoted; page console: ${log()}`).toBe(
    'promote',
  )

  // Everything the player sent is there: the fragment from before the rejection, the one that
  // arrived under it, and the one after it. A verdict of a moment costs the recording nothing —
  // which is the whole of the difference between a file and «Nothing recorded on this page yet».
  expect(
    await sessionsWhen(page, oneCompleteSession),
    `the moment of rejection took the recording with it; page console: ${log()}`,
  ).toEqual([await playerSession(SCROLLED_URL, 'scrolled player')])

  await context.close()
})

test('a player inside an open shadow root is found and recorded', async () => {
  const { context, page, extensionId, log } = await open('shadow.html', SHADOW_URL)
  const bridge = await bridgeFrame(page, extensionId, log)
  await pageDone(page)

  // The element plays, is the size of a player and has its controls — everything triage asks for.
  // The only unusual thing about it is where it lives: document.querySelectorAll('video') finds
  // nothing on this page, and on tv.apple.com it found nothing either.
  await page.evaluate(() => {
    const video = document.getElementById('host')!.shadowRoot!.querySelector('video')!
    video.loop = true
    return video.play()
  })

  const player = await namedSourceId(page)
  expect(player, `the stream of the player is tied to no address; page console: ${log()}`).not.toBe(
    '',
  )

  const seen = await verdictsWhen(bridge, (list) => latest(list, player) === 'promote')
  expect(latest(seen, player), `the player in the shadow root got no verdict; ${log()}`).toBe(
    'promote',
  )

  expect(
    await sessionsWhen(page, oneCompleteSession),
    `the session of the player in the shadow root is missing; page console: ${log()}`,
  ).toEqual([await playerSession(SHADOW_URL, 'shadow player')])

  await context.close()
})

test('a player inside a closed shadow root is refused rather than recorded unjudged', async () => {
  const { context, page, extensionId, log } = await open('closed-shadow.html', CLOSED_SHADOW_URL)
  const bridge = await bridgeFrame(page, extensionId, log)
  await pageDone(page)

  // The bytes reach the bridge all the same — the hook in the MAIN world knows nothing of the
  // DOM. Without checking that, an empty registry would prove nothing at all.
  await bridge
    .waitForFunction(() => (window as unknown as Probe).tcAppend >= 4, undefined, { timeout: 5_000 })
    .catch(() => undefined)
  expect(
    await bridge.evaluate(() => (window as unknown as Probe).tcAppend),
    `the segments never reached the bridge; page console: ${log()}`,
  ).toBeGreaterThanOrEqual(4)

  const player = await namedSourceId(page)
  expect(player, `the stream of the player is tied to no address; page console: ${log()}`).not.toBe(
    '',
  )

  // A closed root cannot be entered: element.shadowRoot is null on the host and the browser
  // offers nothing else to ask. So the element is never measured — and the answer to that must be
  // a refusal and not silence, because the bridge keeps whatever it is not told to drop.
  const seen = await verdictsWhen(bridge, (list) => latest(list, player) === 'reject', 5_000)
  expect(latest(seen, player), `the unreachable stream got no verdict at all; ${log()}`).toBe(
    'reject',
  )
  expect(
    seen.map((item) => item.verdict),
    'nothing that was never measured may be promoted',
  ).not.toContain('promote')

  expect(
    await sessionsWhen(page, (sessions) => sessions.length === 0),
    `material nobody judged stayed in the registry; page console: ${log()}`,
  ).toEqual([])

  await context.close()
})

test('a page that asks for a key system is left with nothing at all', async () => {
  const { context, page, extensionId, log } = await open('drm.html', DRM_URL)
  const bridge = await bridgeFrame(page, extensionId, log)
  await pageDone(page)

  // The clip plays out its probation first, exactly as the trailer of tv.apple.com does before
  // that page ever mentions EME. A session that has served it is confirmed, and a rejection of a
  // confirmed session is the freeze of §5.5: recording stops and everything collected stays. So
  // this is the state in which a refusal by verdict alone leaves the material of the page behind.
  await page.evaluate(() => {
    const video = document.querySelector('video')!
    video.loop = true
    return video.play()
  })

  const player = await sourceIdOf(page, 'video')
  const seen = await verdictsWhen(bridge, (list) => latest(list, player) === 'promote')
  expect(latest(seen, player), `setup: the player was never promoted; ${log()}`).toBe('promote')
  expect(
    await sessionsWhen(page, oneCompleteSession),
    `setup: the material has to be in the registry first; page console: ${log()}`,
  ).toEqual([await playerSession(DRM_URL, 'clearkey player')])

  // And now the player asks the browser for a key system — nothing else about the page changes.
  // There is no circumvention in this: the refusal is on the request itself, before a single key
  // is handed out, and the material here is the same unencrypted fixture as everywhere else.
  await page.evaluate(() => (window as unknown as DrmPage).askForKeys())
  await page.waitForFunction(() => (window as unknown as DrmPage).keysAsked === true, undefined, {
    timeout: 15_000,
  })

  expect(
    await page.evaluate(() => (window as unknown as DrmPage).keysError),
    'the page never got its key system, so nothing was refused for the right reason',
  ).toBeNull()
  expect(
    await bridge.evaluate(() => (window as unknown as Probe).tcDrm),
    `the report of the key request never reached the bridge; page console: ${log()}`,
  ).toBeGreaterThan(0)

  // Everything goes with it, the six seconds already earned included. §2 promises the user that
  // a protected page is refused outright, and a session left in the list is an offer to save it.
  expect(
    await sessionsWhen(page, (sessions) => sessions.length === 0),
    `the material of a page with DRM stayed in the registry; page console: ${log()}`,
  ).toEqual([])

  await context.close()
})
