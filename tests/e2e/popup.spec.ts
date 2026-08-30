import { chromium, test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { launchWithExtension, serveLocal } from './helpers'
import type { SessionSummary } from '../../src/shared/protocol'

const PLAYER_URL = 'https://tailcut.test/player'

/**
 * How long the player has to run for triage to let it past its probation
 * (BALANCED.gracePeriodSeconds = 6). The spare second is for the imprecision of the watcher poll.
 */
const PLAY_MS = 7_000

type PageState = { allAppended?: boolean }

/** Opens a page with a player and lets it gather material: three fragments of two seconds. */
async function recorded(
  htmlFile = 'player.html',
  url = PLAYER_URL,
): Promise<{ context: BrowserContext; page: Page; extensionId: string }> {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()
  await serveLocal(page, htmlFile, url)

  await page.waitForFunction(() => (window as unknown as PageState).allAppended === true, undefined, {
    timeout: 15_000,
  })

  // The looping is as in triage.spec.ts: the page holds exactly six seconds of material, right on
  // the threshold, and without a repeat the played counter never reaches it.
  await page.evaluate(() => {
    const video = document.querySelector('video')!
    video.loop = true
    return video.play()
  })
  await page.waitForTimeout(PLAY_MS)

  return { context, page, extensionId }
}

/**
 * Opens the popup. A real extension popup is not a tab: the user's page stays the active one, and
 * that is the tab the popup asks for its list. Playwright opens it as an ordinary tab, so the
 * active one is given back to the player — otherwise the popup would be asking itself.
 */
async function openPopup(context: BrowserContext, page: Page, extensionId: string): Promise<Page> {
  const popup = await context.newPage()
  await page.bringToFront()
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`)
  return popup
}

/** The address the popup is served its own dist build under. Invented, like the player's. */
const POPUP_URL = 'https://tailcut.test/popup/popup.html'

/** The summary the "tab" answers the popup with on the test's command. */
const SUMMARY: SessionSummary = {
  key: 'https://site.example/watch|avc1|inf',
  url: 'https://site.example/watch?v=abc',
  title: 'Clip — site.example',
  duration: 6,
  bytes: 1_543_210,
  lastAt: 1_700_000_000_000,
}

/** A second session of the same page: another video of a feed, left behind with its material. */
const OLDER: SessionSummary = {
  key: 'https://site.example/watch|vp09|inf',
  url: 'https://site.example/watch?v=older',
  title: 'The previous video',
  duration: 300,
  bytes: 90_000_000,
  lastAt: 1_699_999_000_000,
}

/** Answers the popup the way the tab does: the sessions, and what is known about the page. */
type Answer = (sessions: SessionSummary[], unreachable?: boolean) => Promise<void>

/** Window fields the offline popup harness plants for the page to answer through. */
type Harness = { __answer: (value: unknown) => void; __save: { ok: boolean } }

/**
 * Opens the popup out of dist without running the extension, leaving the tab's answer to the
 * test: the waiting state here is not instantaneous, as it is with a live content script, but
 * lasts exactly until answer is called. What is measured meanwhile is the real markup of the
 * popup by a real engine — there is nowhere else to take the height Chrome opens the popup window
 * at from.
 */
async function offlinePopup(): Promise<{
  browser: Browser
  popup: Page
  answer: Answer
  refuseSave: () => Promise<void>
}> {
  const browser = await chromium.launch()
  const popup = await browser.newPage()

  await popup.route('**/popup/*', async (route) => {
    const file = path.basename(new URL(route.request().url()).pathname)
    const body = await readFile(path.resolve('dist/popup', file), 'utf8')
    const contentType = file.endsWith('.js') ? 'text/javascript' : 'text/html'
    await route.fulfill({ body, contentType })
  })

  await popup.addInitScript(() => {
    const asked = new Promise((resolve) => {
      Object.assign(window, { __answer: resolve })
    })
    // Of all of chrome.* the popup needs one tab and its answers: the rest has nothing to do with
    // the markup, and a live tab has no way of stretching its silence out for the measurement.
    Object.assign(window, {
      __save: { ok: true },
      chrome: {
        tabs: {
          query: async () => [{ id: 1 }],
          sendMessage: (_tabId: number, message: { type?: string } | null) =>
            message?.type === 'tc:save'
              ? Promise.resolve((window as unknown as Harness).__save)
              : asked,
        },
      },
    })
  })

  await popup.goto(POPUP_URL)

  const answer: Answer = (sessions, unreachable) =>
    popup.evaluate(
      ([list, out]) => {
        ;(window as unknown as Harness).__answer({ sessions: list, unreachable: out })
      },
      [sessions, unreachable] as [SessionSummary[], boolean | undefined],
    )

  /** The bridge refuses: the session is gone, or there is nothing in it to cut. */
  const refuseSave = () =>
    popup.evaluate(() => {
      ;(window as unknown as Harness).__save = { ok: false }
    })

  return { browser, popup, answer, refuseSave }
}

test('the popup shows what was gathered and saves it as an mp4 file', async () => {
  const { context, page, extensionId } = await recorded()
  const popup = await openPopup(context, page, extensionId)

  await expect(popup.getByTestId('duration')).toHaveText('0:06')
  await expect(popup.getByTestId('title')).toHaveText('test player')
  await expect(popup.getByTestId('host')).toHaveText('tailcut.test')

  const button = popup.getByRole('button', { name: 'Save all' })
  await expect(button).toBeEnabled()

  // The download is started by the bridge — the extension frame inside the player tab, not the
  // popup itself.
  const started = page.waitForEvent('download')
  await button.click()
  const download = await started

  // Chrome takes the file extension from the type of the blob, and the name under Playwright is
  // replaced with a GUID: what is checked here is the extension — what the file lands on the
  // user's disk with. The rules of the name are taken apart separately, in
  // tests/bridge/bridge.test.ts.
  expect(download.suggestedFilename(), 'the file was not saved with an mp4 extension').toMatch(
    /\.mp4$/,
  )

  const file = await download.path()
  const probe = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-count_frames',
      '-show_entries', 'format=duration:stream=nb_read_frames',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )

  expect(probe.error).toBeUndefined()
  expect(probe.status, probe.stderr).toBe(0)
  expect(probe.stderr, 'ffprobe complains about parsing the saved file').toBe('')

  const probed = JSON.parse(probe.stdout) as {
    format: { duration: string }
    streams: Array<{ nb_read_frames: string }>
  }

  // Six seconds of material at 24 frames a second: everything gathered was saved, whole.
  expect(Number(probed.format.duration)).toBeGreaterThan(5.5)
  expect(Number(probed.format.duration)).toBeLessThan(6.5)
  expect(probed.streams.map((stream) => Number(stream.nb_read_frames))).toEqual([144])

  // The same download through the eyes of Chrome: the extension started it, it ran to the end and
  // wrote exactly as many bytes as the bridge assembled. A blob address revoked too early would
  // leave "interrupted" here and a file half the length.
  const [sw] = context.serviceWorkers()
  const item = await sw!.evaluate(
    async () => (await chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] }))[0] ?? null,
  )
  expect(item, 'Chrome knows of no download at all').not.toBeNull()
  expect(item).toMatchObject({ state: 'complete', mime: 'video/mp4', byExtensionName: 'tailcut' })
  expect(item!.fileSize, 'not all of it reached the disk').toBe(statSync(file).size)

  await context.close()
})

test('the popup shows the title a page filled in after recording had started', async () => {
  // At document_start there is no <title> yet, and this page — like every single-page application
  // — sets one only once the video has loaded. Told the page context once, the extension would
  // sign the session with nothing, and the popup would say "Untitled" for a video that has a
  // perfectly good name.
  const { context, page, extensionId } = await recorded(
    'late-title.html',
    'https://tailcut.test/late-title',
  )
  const popup = await openPopup(context, page, extensionId)

  await expect(popup.getByTestId('title')).toHaveText('The video that named itself late')

  await context.close()
})

test('the badge shows what was gathered on the tab', async () => {
  const { context, page } = await recorded()
  const [sw] = context.serviceWorkers()

  // The recount is set on an alarm and outlives the sleep of the service worker: a setInterval
  // would fall asleep with it, and the badge would freeze on its first value.
  const period = await sw!.evaluate(async () => (await chrome.alarms.get('tc:badge'))?.periodInMinutes ?? null)
  expect(period, 'there is nobody to recount the badge: no alarm is set').toBeCloseTo(1 / 6, 5)

  await page.bringToFront()
  // The same handler as the scheduled one, only without the wait for the next due time.
  await sw!.evaluate(() => chrome.alarms.create('tc:badge', { when: Date.now() }))

  const badgeText = async () =>
    sw!.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      return chrome.action.getBadgeText({ tabId: tab!.id! })
    })

  await expect.poll(badgeText, { timeout: 10_000 }).toBe('6s')

  await context.close()
})

test('the popup opens at its full height, not as a "Loading…" strip', async () => {
  const { browser, popup, answer } = await offlinePopup()
  const bodyHeight = () => popup.evaluate(() => document.body.getBoundingClientRect().height)

  const loading = popup.getByText('Loading…')
  await expect(loading).toBeVisible()
  const strip = (await loading.boundingBox())!.height
  const waiting = await bodyHeight()

  await answer([SUMMARY])
  await expect(popup.getByTestId('title')).toHaveText(SUMMARY.title)
  const ready = await bodyHeight()

  // Without a floor on the height the body of the popup hugs the single "Loading…" line: the
  // window opens at its height and jumps when the tab's answer arrives.
  expect(waiting, 'the popup opened as a strip one line high').toBeGreaterThan(strip)
  // The exact height of the ready popup depends on the system font, so what is checked is not
  // equality but the order of things: the popup opened at roughly its own height rather than
  // doubling on the answer.
  expect(ready, 'the popup doubled in height on the answer of the tab').toBeLessThan(waiting * 2)

  await browser.close()
})

test('the popup reaches the other sessions of the page', async () => {
  const { browser, popup, answer } = await offlinePopup()

  await answer([SUMMARY, OLDER])
  await expect(popup.getByTestId('title')).toHaveText(SUMMARY.title)

  // Show the first session alone and every other one on the page is invisible and out of reach.
  const rows = popup.getByTestId('session')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(OLDER.title)

  await rows.first().click()

  // The picked one takes the top block, and the one that stood there moves down into the list.
  await expect(popup.getByTestId('title')).toHaveText(OLDER.title)
  await expect(popup.getByTestId('duration')).toHaveText('5:00')
  await expect(popup.getByTestId('session')).toContainText(SUMMARY.title)

  await browser.close()
})

test('the popup explains a gapped save, and only while that recording is selected', async () => {
  const { browser, popup, answer } = await offlinePopup()

  // The length shown is already the length of the joined file; the notice explains why a seek in
  // the recording will not be a pause in the saved clip.
  await answer([{ ...SUMMARY, omits: 'gap' }, OLDER])
  await expect(popup.getByTestId('omits')).toHaveText(
    'Recording gaps are joined in the saved clip.',
  )

  // The notice belongs to the session it was sent about: the one picked out of the list will be
  // saved whole, and a line left over from the previous one would be a warning about nothing.
  await popup.getByTestId('session').first().click()
  await expect(popup.getByTestId('title')).toHaveText(OLDER.title)
  await expect(popup.getByTestId('omits')).toHaveCount(0)

  await browser.close()
})

test('the popup says a save that failed failed', async () => {
  const { browser, popup, answer, refuseSave } = await offlinePopup()

  await answer([SUMMARY])
  await expect(popup.getByTestId('title')).toHaveText(SUMMARY.title)
  await refuseSave()

  await popup.getByRole('button', { name: 'Save all' }).click()

  // Nothing downloads on a refusal. Without a word about it the user cannot tell the failure from
  // a slow save, and waits for a file that will never appear.
  await expect(popup.getByTestId('error')).toBeVisible()

  await browser.close()
})
