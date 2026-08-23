import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'

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
  streams: Array<{
    codec_type: string
    codec_name: string
    nb_read_frames: string
    /** Picture only, and read out of the sample entry and the box beside it. */
    width?: number
    height?: number
    profile?: string
    pix_fmt?: string
  }>
}

/**
 * Runs ffprobe over every frame of a file and hands back what it said, complaints and all.
 *
 * -count_frames drives ffprobe through every frame instead of the headers alone: material laid
 * out wrongly inside mdat leaves the boxes intact and shows up only when the frames are actually
 * read — as complaints in stderr, with the exit code still zero. So stderr is a finding and not
 * plumbing, and this is the one reader that returns it rather than asserting it away.
 */
function runProbe(file: string): { status: number | null; stdout: string; stderr: string } {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-count_frames',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,nb_read_frames,width,height,profile,pix_fmt',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )

  expect(probe.error).toBeUndefined()
  return { status: probe.status, stdout: probe.stdout, stderr: probe.stderr }
}

/**
 * Reads a saved file back through ffprobe, insisting that it had nothing to complain about.
 * See runProbe for why an empty stderr is part of what is being checked.
 */
export function probeFile(file: string): Probed {
  const probe = runProbe(file)

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

/** One frame of the picture as raw RGB, taken out of a file however the arguments say. */
function decodeOneFrame(args: string[], what: string): Buffer {
  const run = spawnSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })

  expect(run.error).toBeUndefined()
  expect(run.status, `${what}: ${run.stderr.toString()}`).toBe(0)

  return run.stdout
}

/**
 * The frame shown at `at` seconds, reached by seeking — which is to say, by the sync sample
 * information of the container and nothing else.
 *
 * -ss before -i is an input seek: the demuxer looks up the last sample marked as one that can be
 * decoded on its own, starts there and decodes forward. That is the whole of what the keyframe
 * flags are for, and it is why this and the reading below have to agree.
 */
export function frameBySeeking(file: string, at: number): Buffer {
  return decodeOneFrame(
    [
      '-v', 'error',
      '-ss', String(at),
      '-i', file,
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ],
    `seeking to ${at}s`,
  )
}

/** The same frame, reached by decoding the file from its first frame and counting forward. */
export function frameByPlaying(file: string, at: number): Buffer {
  return decodeOneFrame(
    [
      '-v', 'error',
      '-i', file,
      '-vf', `select='gte(t\\,${at})'`,
      '-vsync', '0',
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ],
    `playing up to ${at}s`,
  )
}

/**
 * Seeking into the saved file lands on the frame that belongs there.
 *
 * A sample entry says what the codec is; it says nothing about which frames a player may start
 * from, and that is the trun's business. Get it wrong in either direction and the file still
 * decodes from end to end: mark every frame as a keyframe and a seek starts mid-prediction and
 * shows a smear, mark none and a seek finds nowhere to start and shows nothing at all. Both are
 * invisible until somebody drags the play head, which is the first thing anybody does.
 *
 * The times are taken inside a group of pictures on purpose — a seek to a keyframe would come out
 * right whatever the flags said.
 */
export function seekingLandsRight(file: string, times: number[]): void {
  for (const at of times) {
    const seeked = frameBySeeking(file, at)
    const played = frameByPlaying(file, at)

    expect(played.byteLength, `nothing decodes at ${at}s at all`).toBeGreaterThan(0)
    expect(seeked.byteLength, `seeking to ${at}s found no frame to start from`).toBe(
      played.byteLength,
    )
    expect(
      seeked.equals(played),
      `the frame at ${at}s comes out differently when seeked to than when played up to`,
    ).toBe(true)
  }
}

/**
 * Decodes every frame of every stream of a file and throws the result away.
 *
 * ffprobe reads a file; this one plays it through. A track whose samples are described wrongly
 * gets past the headers and past a frame count, and only a decoder run over the whole thing
 * turns it into words on stderr — which is why the empty stderr is the assertion here.
 */
export function decodeFile(file: string): void {
  const run = runDecode(file)

  expect(run.status, run.stderr).toBe(0)
  expect(run.stderr, 'decoding the saved file produces warnings').toBe('')
}

/** The same decode, handing back what it said instead of insisting it said nothing. */
function runDecode(file: string): { status: number | null; stderr: string } {
  const run = spawnSync('ffmpeg', ['-v', 'warning', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8',
  })

  expect(run.error).toBeUndefined()
  return { status: run.status, stderr: run.stderr }
}

/** Everything a reader and a decoder can say about a saved file, none of it turned into a verdict. */
export interface FileFacts {
  /** Weight of the file on disk. */
  bytes: number
  /** What the format box says the clip lasts, in seconds; NaN when it says nothing. */
  duration: number
  streams: Probed['streams']
  /** Exit code and complaints of the frame-by-frame read. */
  probeStatus: number | null
  probeStderr: string
  /** Exit code and complaints of a decode from end to end. */
  decodeStatus: number | null
  decodeStderr: string
}

/**
 * Reads a saved file every way the suite knows how and reports the facts.
 *
 * Deliberately assertion-free past the two spawns: a matrix of codecs is answered by a table of
 * what each one produced, and a helper that threw on the first complaint would leave the rest of
 * the row unmeasured. The caller decides which of these facts is a failure.
 */
export function inspectFile(file: string): FileFacts {
  const probe = runProbe(file)
  const decode = runDecode(file)
  const probed = probe.status === 0 ? (JSON.parse(probe.stdout) as Probed) : undefined

  return {
    bytes: fsSync.statSync(file).size,
    duration: Number(probed?.format?.duration ?? NaN),
    streams: probed?.streams ?? [],
    probeStatus: probe.status,
    probeStderr: probe.stderr,
    decodeStatus: decode.status,
    decodeStderr: decode.stderr,
  }
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
  /** Frame size the browser found in the file; zero when it found no picture. */
  frameWidth: number
  frameHeight: number
  /** Colours in one frame read back out of a canvas: one is a blank field, more is a picture. */
  frameColours: number
  frameError: string | null
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

const REMUX_URL = `${PLAYBACK_ORIGIN}/remux`

/** What Media Source Extensions made of a saved file: see tests/e2e/page/remux.html. */
export interface Remuxed {
  supported: boolean
  error: string | null
  appended: boolean
  duration: number
  reached: number
  ended: boolean
  width: number
  height: number
}

/**
 * Feeds a saved file back through Media Source Extensions and reports what happened.
 *
 * The reason for a second trip through a browser is that the two readings are not the same
 * reading. `<video src>` hands the file to a full demuxer, which takes what it needs out of the
 * coded frames and forgives a container that describes them badly; MSE parses the boxes and
 * refuses what it cannot make sense of. An init segment missing the box that describes its codec
 * gets past the first and not past the second — so this is where a sample entry written wrongly
 * turns into a failure instead of into a file that happens to work in one player.
 *
 * `type` is offered to the page through the fragment of the address, which is not sent to the
 * network and needs no escaping beyond the encoding.
 */
export async function playThroughMse(file: string, type: string): Promise<Remuxed> {
  const browser = await chromium.launch({ headless: false })

  try {
    const page = await browser.newPage()
    const bytes = await fs.readFile(file)

    await page.route(`${PLAYBACK_ORIGIN}/saved.mp4`, async (route) => {
      await route.fulfill({ body: bytes, contentType: 'video/mp4' })
    })
    await page.route(REMUX_URL, async (route) => {
      await route.fulfill({
        body: await fs.readFile(path.resolve('tests/e2e/page/remux.html'), 'utf8'),
        contentType: 'text/html',
      })
    })

    await page.goto(`${REMUX_URL}#${encodeURIComponent(type)}`)

    await page.waitForFunction(
      () => {
        const state = (window as unknown as { tc: Remuxed }).tc
        return state.ended || state.error != null
      },
      undefined,
      { timeout: PLAYBACK_TIMEOUT_MS },
    )

    return await page.evaluate(() => (window as unknown as { tc: Remuxed }).tc)
  } finally {
    await browser.close()
  }
}
