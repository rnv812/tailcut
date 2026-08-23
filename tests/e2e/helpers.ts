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
