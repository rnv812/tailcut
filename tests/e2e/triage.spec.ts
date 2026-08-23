import { test, expect, type Frame, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchWithExtension, serveLocal } from './helpers'
import { sessionKey } from '../../src/core/session-key'

const BANNER_URL = 'https://tailcut.test/banner'
const PLAYER_URL = 'https://tailcut.test/player'
/** A banner and a real player on one page: a verdict about one must not touch the other. */
const MIXED_URL = 'https://tailcut.test/mixed'

/** A verdict in the form the content script sends it to the bridge in. */
type SeenVerdict = { sourceId: string; verdict: string }
/** The tie between a stream and the address from createObjectURL: it matches a verdict to an element. */
type SeenSource = { sourceId: string; objectUrl: string }

/** What the listener the test plants in every document of the page has gathered. */
type Probe = { tcVerdict: SeenVerdict[]; tcSource: SeenSource[]; tcAppend: number }
type PageState = { allAppended?: boolean }

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

    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data !== 'object') return

      if (data.type === 'tc:verdict') {
        probe.tcVerdict.push({ sourceId: String(data.sourceId), verdict: String(data.verdict) })
      } else if (data.type === 'tc:source') {
        probe.tcSource.push({ sourceId: String(data.sourceId), objectUrl: String(data.objectUrl) })
      } else if (data.type === 'tc:append') {
        probe.tcAppend++
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
