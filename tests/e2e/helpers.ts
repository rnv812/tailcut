import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'

const EXT = path.resolve('dist')

/**
 * One launch for both modes. Everything apart from the two arguments that load the extension has
 * to match: the overhead measurement in `overhead.spec.ts` compares these two launches against
 * each other, and any other difference in the settings it would put down to the extension.
 */
async function launch(args: string[]): Promise<BrowserContext> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tailcut-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    acceptDownloads: true,
  })

  // A profile weighs megabytes and a run of the suite launches dozens: without the cleaning up,
  // gigabytes gather in the temporary directory over a month, and the first to notice is
  // `overhead.spec.ts` — a clogged /tmp moves the numbers it measures.
  context.on('close', () => {
    // The event arrives before the browser has finished writing the profile out, hence the
    // retries; a failure is swallowed on purpose — tidying up is no reason to fail a test.
    void fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      .catch(() => {})
  })

  return context
}

export async function launchWithExtension(): Promise<{
  context: BrowserContext
  extensionId: string
}> {
  const context = await launch([`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`])

  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker')

  return { context, extensionId: new URL(sw.url()).host }
}

/** The same browser without the extension — the baseline the overhead is measured against. */
export async function launchWithoutExtension(): Promise<BrowserContext> {
  return launch([])
}

/**
 * Lays a local page and the fixtures out under an invented address without opening the page.
 * Kept apart from the navigation for a page that embeds another: both are laid out under their
 * own addresses beforehand, and only the outer one is opened.
 */
export async function routeLocal(page: Page, htmlFile: string, url: string): Promise<void> {
  await page.route('**/fixtures/**', async (route) => {
    const rel = new URL(route.request().url()).pathname.replace('/fixtures/', '')
    const body = await fs.readFile(path.resolve('tests/fixtures', rel))
    await route.fulfill({ body, contentType: 'video/mp4' })
  })

  await page.route(url, async (route) => {
    const body = await fs.readFile(path.resolve('tests/e2e/page', htmlFile), 'utf8')
    await route.fulfill({ body, contentType: 'text/html' })
  })
}

/** Serves a local page and the fixtures under an invented address and opens it. */
export async function serveLocal(page: Page, htmlFile: string, url: string): Promise<void> {
  await routeLocal(page, htmlFile, url)
  await page.goto(url)
}

/**
 * Opens the popup over the tab that is playing.
 *
 * The popup asks the active tab, so the player has to stay the active one: opened as an ordinary
 * tab, the popup would be asking itself.
 */
export async function openPopupOn(
  context: BrowserContext,
  player: Page,
  extensionId: string,
): Promise<Page> {
  const popup = await context.newPage()
  await player.bringToFront()
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`)
  return popup
}

/** Clicks Save all and gives back the path the file landed on. */
export async function saveAll(player: Page, popup: Page): Promise<string> {
  // The download is started by the bridge — the extension frame inside the player tab, not the
  // popup — so the event arrives on the page and not on the window that was clicked.
  const started = player.waitForEvent('download')
  await popup.getByRole('button', { name: 'Save all' }).click()

  const download = await started
  expect(download.suggestedFilename(), 'the file was not saved with an mp4 extension').toMatch(
    /\.mp4$/,
  )

  const file = await download.path()
  expect(file, 'the download left no file on disk').not.toBeNull()
  return file!
}

export interface Probed {
  format: { duration: string }
  streams: Array<{ codec_type: string; codec_name: string; nb_read_frames: string }>
}

/**
 * Reads a saved file back through ffprobe.
 *
 * -count_frames drives ffprobe through every frame instead of the headers alone: material laid
 * out wrongly inside mdat leaves the boxes intact and shows up only when the frames are actually
 * read — as complaints in stderr, with the exit code still zero. An empty stderr is therefore
 * part of what is being checked, not a detail of how it is checked.
 */
export function probeFile(file: string): Probed {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-count_frames',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,nb_read_frames',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )

  expect(probe.error).toBeUndefined()
  expect(probe.status, probe.stderr).toBe(0)
  expect(probe.stderr, 'ffprobe complains about reading the saved file').toBe('')

  return JSON.parse(probe.stdout) as Probed
}

/** Presentation times of every frame of one stream, in the order the file holds them. */
export function frameTimes(file: string, stream: 'v' | 'a'): number[] {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', stream,
      '-show_entries', 'frame=best_effort_timestamp_time',
      '-of', 'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  )

  expect(probe.error).toBeUndefined()
  expect(probe.status, probe.stderr).toBe(0)
  expect(probe.stderr, 'ffprobe complains about reading the frames of the saved file').toBe('')

  return probe.stdout
    .split('\n')
    .map((line) => Number(line.trim().replace(/,$/, '')))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b)
}

/**
 * Decodes every frame of every stream of a file and throws the result away.
 *
 * ffprobe reads a file; this one plays it through. A track whose samples are described wrongly
 * gets past the headers and past a frame count, and only a decoder run over the whole thing
 * turns it into words on stderr — which is why the empty stderr is the assertion here.
 */
export function decodeFile(file: string): void {
  const run = spawnSync('ffmpeg', ['-v', 'warning', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8',
  })

  expect(run.error).toBeUndefined()
  expect(run.status, run.stderr).toBe(0)
  expect(run.stderr, 'decoding the saved file produces warnings').toBe('')
}

const PLAYBACK_ORIGIN = 'https://tailcut.test'
const PLAYBACK_URL = `${PLAYBACK_ORIGIN}/playback`

/** Long enough for a clip of a few seconds to run through in real time, and no longer. */
const PLAYBACK_TIMEOUT_MS = 60_000

/** What a browser made of a saved file: see tests/e2e/page/playback.html. */
export interface Playback {
  error: string | null
  ended: boolean
  reached: number
  duration: number
  audioBytes: number
  videoBytes: number
  audioTracks: number | null
}

/**
 * Plays a saved file through to the end in a browser and reports what happened.
 *
 * A browser of its own, without the extension: what is under test is the file, and nothing the
 * extension does while a finished clip is being played would belong in the answer. The flag turns
 * on the track lists — `HTMLMediaElement.audioTracks` is behind it in Chromium, and without it a
 * page has no way of saying how many audio tracks a file was found to have.
 */
export async function playInBrowser(file: string): Promise<Playback> {
  const browser = await chromium.launch({
    headless: false,
    args: ['--enable-blink-features=AudioVideoTracks'],
  })

  try {
    const page = await browser.newPage()
    const bytes = await fs.readFile(file)

    await page.route(`${PLAYBACK_ORIGIN}/saved.mp4`, async (route) => {
      await route.fulfill({ body: bytes, contentType: 'video/mp4' })
    })
    await page.route(PLAYBACK_URL, async (route) => {
      await route.fulfill({
        body: await fs.readFile(path.resolve('tests/e2e/page/playback.html'), 'utf8'),
        contentType: 'text/html',
      })
    })

    await page.goto(PLAYBACK_URL)
    // A click and not a call to play(): an unmuted element starts on a user gesture alone, and
    // the sound has to be unmuted or the audio decoder may never be asked for a byte.
    await page.getByRole('button', { name: 'play' }).click()

    await page.waitForFunction(
      () => {
        const state = (window as unknown as { tc: Playback }).tc
        return state.ended || state.error != null
      },
      undefined,
      { timeout: PLAYBACK_TIMEOUT_MS },
    )

    return await page.evaluate(() => (window as unknown as { tc: Playback }).tc)
  } finally {
    await browser.close()
  }
}
