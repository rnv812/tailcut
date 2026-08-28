import { test, expect, type BrowserContext, type Frame, type Page } from '@playwright/test'
import {
  launchWithExtension,
  openPopupOn,
  probeFile,
  routeLocal,
  saveAll,
  serveLocal,
} from './helpers'

/**
 * The ordinary layout of the web: the page the user is on carries somebody else's player in a
 * frame. An article, a documentation page, a landing page, a forum post — the video comes from
 * one site and the page around it from another.
 *
 * Recording such a player has always worked: the hook stands up in the frame like anywhere else,
 * and the material lands in the registry of that frame. Measured on a page holding nothing but an
 * iframe with an embedded player: one source, 126 appends, 4 014 954 bytes of AV1 and Opus over
 * 27 seconds — while the popup said "Nothing recorded on this page yet", because it asked the top
 * frame and the top frame had nothing.
 */
const EMBEDDER_URL = 'https://embedder.example/watch'
const PLAYER_URL = 'https://tailcut.test/player'
const SECOND_PLAYER_URL = 'https://other-site.example/player'
const TWO_EMBEDS_URL = 'https://two.example/lesson'
const CROWDED_URL = 'https://crowded.example/article'

/**
 * How long the players have to run for triage to let them past probation
 * (BALANCED.gracePeriodSeconds = 6). The spare second is for the imprecision of the watcher poll.
 */
const PLAY_MS = 7_000

type PlayerState = { allAppended?: boolean }

/** Waits for the frame at an address; fails the test if it never appeared. */
async function frameAt(page: Page, url: string): Promise<Frame> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const frame = page.frames().find((candidate) => candidate.url() === url)
    if (frame) return frame
    expect(Date.now(), `no frame ever loaded ${url}`).toBeLessThan(deadline)
    await page.waitForTimeout(100)
  }
}

/**
 * Opens a page that embeds players at the given addresses and lets every one of them gather its
 * material: three fragments of two seconds, played through once so that triage keeps them.
 */
async function embedding(
  topHtml: string,
  topUrl: string,
  playerUrls: string[],
): Promise<{ context: BrowserContext; page: Page; extensionId: string }> {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  for (const url of playerUrls) await routeLocal(page, 'player.html', url)
  // Frames of advertising, for the pages that carry a crowd of them: they hold no video and no
  // bridge worth asking, and the extension has no way of knowing that before it asks.
  await page.route('https://filler.example/**', async (route) => {
    await route.fulfill({ body: '<!doctype html><title>advert</title>', contentType: 'text/html' })
  })
  await serveLocal(page, topHtml, topUrl)

  const players = await Promise.all(playerUrls.map((url) => frameAt(page, url)))
  for (const player of players) {
    await player.waitForFunction(
      () => (window as unknown as PlayerState).allAppended === true,
      undefined,
      { timeout: 15_000 },
    )
    // The looping is as in popup.spec.ts: the page holds exactly six seconds of material, right
    // on the threshold, and without a repeat the played counter never reaches it.
    await player.evaluate(() => {
      const video = document.querySelector('video')!
      video.loop = true
      return video.play()
    })
  }
  await page.waitForTimeout(PLAY_MS)

  return { context, page, extensionId }
}

test('the popup shows the recording of a player the page only embeds, and saves it', async () => {
  const { context, page, extensionId } = await embedding('embed.html', EMBEDDER_URL, [PLAYER_URL])
  const popup = await openPopupOn(context, page, extensionId)

  await expect(popup.getByTestId('duration')).toHaveText('0:06')

  // Signed by the frame that recorded it and not by the page around it. The title of the top page
  // would be the same for every embed it carries, and the file is named after this title in the
  // bridge — a name shown here that the file does not carry is a promise broken on disk.
  await expect(popup.getByTestId('title')).toHaveText('test player')
  await expect(popup.getByTestId('host')).toHaveText('tailcut.test')

  // And the save has to travel back to the same frame: the material never left it.
  const probed = probeFile(await saveAll(page, popup))
  expect(Number(probed.format.duration)).toBeGreaterThan(5.5)
  expect(Number(probed.format.duration)).toBeLessThan(6.5)
  expect(probed.streams.map((stream) => Number(stream.nb_read_frames))).toEqual([144])

  await context.close()
})

test('two embeds on one page make two sessions, each saved out of its own frame', async () => {
  const { context, page, extensionId } = await embedding('two-embeds.html', TWO_EMBEDS_URL, [
    PLAYER_URL,
    SECOND_PLAYER_URL,
  ])
  const popup = await openPopupOn(context, page, extensionId)

  // One at the top and one in the list below it. Merged into a single session the second player
  // would be unreachable; shown as one row apiece, both can be saved.
  const rows = popup.getByTestId('session')
  await expect(rows).toHaveCount(1)

  const first = await popup.getByTestId('host').textContent()
  expect(['tailcut.test', 'other-site.example'], 'the popup opened on neither embed').toContain(
    first,
  )
  const firstFile = probeFile(await saveAll(page, popup))
  expect(Number(firstFile.format.duration)).toBeGreaterThan(5.5)

  await rows.first().click()

  // The other embed now stands in the block above, and it is a different address — the two frames
  // did not answer with one another's session.
  const second = await popup.getByTestId('host').textContent()
  expect(second, 'both rows of the popup are the same recording').not.toBe(first)
  await expect(popup.getByTestId('duration')).toHaveText('0:06')

  // The save of the second one is the whole point: sent to the frame the first came from, it
  // would come back "This recording is no longer on the page" over a session recording on.
  const secondFile = probeFile(await saveAll(page, popup))
  expect(Number(secondFile.format.duration)).toBeGreaterThan(5.5)
  await expect(popup.getByTestId('error')).toHaveCount(0)

  await context.close()
})

test('the badge counts a recording that lives inside an embed', async () => {
  const { context, page } = await embedding('embed.html', EMBEDDER_URL, [PLAYER_URL])
  const [sw] = context.serviceWorkers()

  await page.bringToFront()
  // The same handler as the scheduled one, only without the wait for the next due time.
  await sw!.evaluate(() => chrome.alarms.create('tc:badge', { when: Date.now() }))

  const badgeText = async () =>
    sw!.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      return chrome.action.getBadgeText({ tabId: tab!.id! })
    })

  // The badge is the only sign that anything is being recorded at all: counted off the top frame
  // alone it stayed empty over a tab with six seconds of video in it, and the user had no reason
  // to open the popup that had something to show.
  await expect.poll(badgeText, { timeout: 10_000 }).toBe('6s')

  await context.close()
})

test('the badge counts a crowded page without a round trip over every frame of it', async () => {
  test.setTimeout(90_000)

  const { context, page } = await embedding('crowded.html', CROWDED_URL, [PLAYER_URL])
  const [sw] = context.serviceWorkers()

  const frames = page.frames().length
  expect(frames, 'the page under test is not crowded').toBeGreaterThan(50)

  await page.bringToFront()

  const badgeText = async () =>
    sw!.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      return chrome.action.getBadgeText({ tabId: tab!.id! })
    })

  // The recording has to be on the badge before the counting starts: what is measured here is a
  // recount of a page whose player is already known, which is every recount but the first.
  await expect.poll(badgeText, { timeout: 20_000 }).toBe('6s')

  // Counted inside the worker, because that is where the cost is: an injection into every frame
  // to enumerate them, and a message to every frame to ask it. Wall-clock time would measure the
  // machine as much as the extension; these two numbers are the work itself.
  await sw!.evaluate(() => {
    const counted = { asked: 0, injected: 0 }
    Object.assign(globalThis, { counted })

    const ask = chrome.tabs.sendMessage.bind(chrome.tabs)
    chrome.tabs.sendMessage = ((...args: Parameters<typeof ask>) => {
      counted.asked += 1
      return ask(...args)
    }) as typeof chrome.tabs.sendMessage

    const inject = chrome.scripting.executeScript.bind(chrome.scripting)
    chrome.scripting.executeScript = ((...args: Parameters<typeof inject>) => {
      counted.injected += 1
      return inject(...args)
    }) as typeof chrome.scripting.executeScript
  })

  const counted = () =>
    sw!.evaluate(() => (globalThis as unknown as { counted: { asked: number; injected: number } }).counted)

  // The same handler as the scheduled one, only without the wait for the next due time.
  await sw!.evaluate(() => chrome.alarms.create('tc:badge', { when: Date.now() }))
  await expect.poll(async () => (await counted()).asked, { timeout: 20_000 }).toBeGreaterThan(0)
  // Long enough for a round that asked every frame to have finished asking.
  await page.waitForTimeout(1_000)

  const cost = await counted()
  console.log(`  one recount of ${frames} frames: ${cost.asked} messages, ${cost.injected} injections`)

  // Measured on a news page of 154 frames: 154 injections and 154 messages every ten seconds, 60
  // to 90 ms of extension work, on a page with no video anywhere in it. The frames that record
  // say so now, and the recount asks those and the main one — two messages here, whatever the
  // page is carrying.
  expect(cost.injected, 'the badge enumerates every frame of the tab again').toBe(0)
  expect(cost.asked, 'the badge asks a message per frame again').toBeLessThan(frames / 4)

  // And it is still right: the whole point of asking every frame was the player inside an embed.
  await expect.poll(badgeText, { timeout: 10_000 }).toBe('6s')

  await context.close()
})

test('the popup finds the one recording on a page of fifty frames, and opens at once', async () => {
  const { context, page, extensionId } = await embedding('crowded.html', CROWDED_URL, [PLAYER_URL])

  const frames = page.frames().length
  expect(frames, 'the page under test is not crowded').toBeGreaterThan(50)

  const started = Date.now()
  const popup = await openPopupOn(context, page, extensionId)
  await expect(popup.getByTestId('title')).toHaveText('test player')
  const elapsed = Date.now() - started

  // The frames are asked all at once, so the round costs the slowest of them and not the sum:
  // measured on this page, 1–5 ms to enumerate the frames and 11–13 ms for the whole round, with
  // the slowest single frame at 10 ms. The ceiling here is the popup's own loading under
  // Playwright and is deliberately loose; what it catches is a round asked frame by frame with a
  // deadline apiece, which on this page would be half a minute.
  expect(elapsed, 'the popup no longer opens at once on a page full of frames').toBeLessThan(5_000)

  await context.close()
})
