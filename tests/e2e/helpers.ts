import { chromium, expect, type BrowserContext, type Download, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { unexpectedWarnings } from '../support/media'

const EXT = path.resolve('dist')

/**
 * Every browser this suite launches runs headless, and every one of them is the full Chromium.
 *
 * The two go together and neither works without the other. Playwright's own `headless: true`
 * quietly swaps the binary for `chrome-headless-shell`, which has no extension support at all:
 * the browser starts, `--load-extension` is ignored, and the wait for a service worker runs out.
 * `channel: 'chromium'` asks for the ordinary Chromium build instead, whose headless mode is
 * Chrome's own and carries extensions, the downloads API, MSE and a decoder.
 *
 * It is not a weaker browser. The frame a test reads back off a canvas is decoded the same way:
 * on the same clip, the same 320×240 frame came out with a mean channel value of 123.79 headed
 * and 123.67 headless. What it saves is the drawing of it — 648 s over the suite headed against
 * 586 s headless, and rather more than that on the launches themselves: the two tests of
 * `load.spec.ts` together fell from 0.8 s to 0.5 s, `hook.spec.ts` from 11.7 s to 4.9 s.
 *
 * `HEADED=1` puts the windows back, for the run a person needs to watch.
 */
const HEADLESS = process.env.HEADED !== '1'
const CHANNEL = 'chromium' as const

/**
 * Features Playwright turns off in every browser it launches, spelled out here word for word.
 *
 * It is copied out of `chromiumSwitches.ts` of the installed playwright-core, and it is copied
 * because the argument can only be taken back whole: `ignoreDefaultArgs` drops a default argument
 * by exact string, and `--disable-features=` is one argument carrying all of them. A version of
 * Playwright that adds a feature to this list stops matching, the default lands after all, and
 * the canary in `snapshot.spec.ts` is what says so.
 */
const DISABLED_BY_PLAYWRIGHT = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'BoundaryEventDispatchTracksNodeRemoval',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
]

/** The feature the suite needs back, and the one thing that differs from the list above. */
const PARTITIONING = 'ThirdPartyStoragePartitioning'

/** The argument Playwright passes, exactly as it passes it: what `ignoreDefaultArgs` takes back. */
const DISABLE_DEFAULT = `--disable-features=${DISABLED_BY_PLAYWRIGHT.join(',')}`

/**
 * Flags every launch of the suite gets, with or without the extension.
 *
 * ThirdPartyStoragePartitioning is on in Chrome from version 115 and off in Playwright, which
 * disables it by default. Without turning it back on, a test of OPFS shared between the bridge
 * frame and a tab of the extension is green in the suite and false in a browser.
 *
 * Enabling it is not enough, and that was measured rather than reasoned about: with
 * `--enable-features=ThirdPartyStoragePartitioning` beside the default disable list, the canary
 * in `snapshot.spec.ts` still found a third-party frame's own storage under a second site — a
 * feature named in both lists is disabled, whichever comes first. So the default argument is
 * taken back whole and passed again without that one name; everything else Playwright turns off
 * stays off, because those switches are load-bearing for the rest of the suite.
 */
const SHARED_ARGS = [
  `--enable-features=${PARTITIONING}`,
  `--disable-features=${DISABLED_BY_PLAYWRIGHT.filter((name) => name !== PARTITIONING).join(',')}`,
]

/**
 * The three arguments Playwright passes to keep Chrome from throttling work it thinks is idle.
 *
 * Spelled out here for the same reason `DISABLE_DEFAULT` is: `ignoreDefaultArgs` takes a default
 * back by exact string. These three are separate arguments rather than one list, so taking them
 * back costs three strings and no filtering.
 */
export const THROTTLING_OFF = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

export interface LaunchOptions {
  /**
   * A profile to reuse. OPFS and IndexedDB live in the profile, so two launches over one
   * directory are the same browser started twice — which is the only honest way to test that a
   * recording outlives the browser and that the repair runs at start-up.
   */
  userDataDir?: string
  /**
   * Leave Chrome's throttling of background work switched on.
   *
   * Playwright turns three of them off by default — background timers, occluded windows and
   * backgrounded renderers — so the whole suite runs in a browser where a hidden cross-origin
   * frame keeps its timers. Every user runs in one where it does not: measured, such a frame's
   * timers are clamped to 1 Hz.
   */
  throttled?: boolean
}

/**
 * One launch for both modes. Everything apart from the two arguments that load the extension has
 * to match: the overhead measurement in `overhead.spec.ts` compares these two launches against
 * each other, and any other difference in the settings it would put down to the extension.
 */
async function launch(args: string[], options: LaunchOptions = {}): Promise<BrowserContext> {
  // A profile that was handed in belongs to the caller: it is the point of the launch — the same
  // directory opened twice — and this must neither invent it nor throw it away afterwards.
  const borrowed = options.userDataDir !== undefined
  const userDataDir = options.userDataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'tailcut-')))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: HEADLESS,
    channel: CHANNEL,
    args: [...SHARED_ARGS, ...args],
    ignoreDefaultArgs: options.throttled ? [DISABLE_DEFAULT, ...THROTTLING_OFF] : [DISABLE_DEFAULT],
    acceptDownloads: true,
  })

  // A profile weighs megabytes and a run of the suite launches dozens: without the cleaning up,
  // gigabytes gather in the temporary directory over a month, and the first to notice is
  // `overhead.spec.ts` — a clogged /tmp moves the numbers it measures.
  if (!borrowed) {
    context.on('close', () => {
      // The event arrives before the browser has finished writing the profile out, hence the
      // retries; a failure is swallowed on purpose — tidying up is no reason to fail a test.
      void fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
        .catch(() => {})
    })
  }

  return context
}

export async function launchWithExtension(options: LaunchOptions = {}): Promise<{
  context: BrowserContext
  extensionId: string
}> {
  const context = await launch(
    [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    options,
  )

  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker')

  return { context, extensionId: new URL(sw.url()).host }
}

/** The same browser without the extension — the baseline the overhead is measured against. */
export async function launchWithoutExtension(): Promise<BrowserContext> {
  return launch([])
}

/** Opens a page of the extension in a tab of its own — a second document on the extension origin. */
export async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  path: string,
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/${path}`)
  return page
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

/** What formatDuration wrote, back as a number of seconds: `m:ss` and `h:mm:ss` alike. */
export function parseClock(text: string | null): number {
  const parts = (text ?? '').trim().split(':').map(Number)
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return NaN
  return parts.reduce((total, part) => total * 60 + part, 0)
}

/** Long enough for triage to let a player past its probation (six seconds), plus the poll. */
const PROBATION_MS = 7_000

type PageState = { allAppended?: boolean }

/**
 * Opens a test page with a player on a tab that is already there, and lets it gather material for
 * as long as it is asked to. The looping is what carries the played counter past the probation:
 * the fixture holds exactly six seconds.
 */
export async function watchOn(
  page: Page,
  htmlFile: string,
  url: string,
  seconds: number,
): Promise<void> {
  await serveLocal(page, htmlFile, url)

  await page.waitForFunction(
    () => (window as unknown as PageState).allAppended === true,
    undefined,
    { timeout: 15_000 },
  )
  await page.evaluate(() => {
    const video = document.querySelector('video')!
    video.loop = true
    return video.play()
  })
  await page.waitForTimeout(seconds * 1_000)
}

/** The same, on a browser of its own: what the tests of the earlier stages ask for. */
export async function recordPlayer(
  htmlFile = 'player.html',
  url = 'https://tailcut.test/player',
): Promise<{ context: BrowserContext; player: Page; extensionId: string }> {
  const { context, extensionId } = await launchWithExtension()
  const player = await context.newPage()
  await watchOn(player, htmlFile, url, PROBATION_MS / 1_000)

  return { context, player, extensionId }
}

/** Presses Edit in the popup and gives back the editor tab it opened, with the snapshot's name. */
export async function clickEdit(
  context: BrowserContext,
  player: Page,
  extensionId: string,
): Promise<{ editor: Page; snapshotId: string }> {
  const popup = await context.newPage()
  await player.bringToFront()
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`)

  const opened = context.waitForEvent('page')
  await popup.getByRole('button', { name: 'Edit' }).click()

  const editor = await opened
  await editor.waitForLoadState('domcontentloaded')
  const snapshotId = new URL(editor.url()).searchParams.get('s')

  expect(snapshotId, 'Edit did not open the editor with a snapshot').toBeTruthy()
  await popup.close()

  return { editor, snapshotId: snapshotId! }
}

/**
 * One clip out of whatever the editor has open, and the file it landed in.
 *
 * The shortest path from material to a saved file: a mark in, a mark out a couple of seconds
 * later, Export. Written once because three sets walk it — the editor over the history, the
 * journey through a restart, and the sweep — and three copies of it would part company on the
 * first renamed button.
 */
export async function exportFirstClip(editor: Page): Promise<string> {
  await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)

  await typeInto(editor, 'playhead-field', '00:00:00:12')
  await editor.keyboard.press('i')
  await expect(editor.getByTestId('clip')).toHaveCount(1)
  await expect(editor.getByTestId('export')).toBeEnabled()

  await typeInto(editor, 'out-c1', '00:00:02:12')
  await expect(editor.getByTestId('out-c1')).toHaveValue('00:00:02:12')

  const [saved] = await collectDownloads(editor, 1, () => editor.getByTestId('export').click())
  await expect(editor.getByTestId('job-state').first()).toHaveText('Saved')

  return saved!.file
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
    .map((line) => line.trim().replace(/,$/, ''))
    // The blank line at the end of the output is dropped before the number is read out of it, and
    // not by `Number.isFinite` afterwards: `Number('')` is 0, not NaN, so the filter let the blank
    // through as a frame standing at the start of the file. Every file this helper has ever been
    // asked about came back one frame longer than it is, with a duplicate at time zero.
    .filter((text) => text !== '' && text !== 'N/A')
    .map(Number)
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
 * gets past the headers and past a frame count, and only a decoder run over the whole thing turns
 * it into words on stderr — which is why what ffmpeg said is the assertion here.
 *
 * Not the whole of what it said. What is benign is named one line at a time, with the reason, in
 * `unexpectedWarnings`; everything else is a defect. The line that list exists for — a fragment
 * carrying its own sample-dependency table — no longer reaches a saved file, because the writer
 * behind a save states its own tables and carries none of the site's boxes through; sdtp.spec.ts
 * saves that very material and insists on silence.
 */
export function decodeFile(file: string): void {
  const run = runDecode(file)

  expect(run.status, run.stderr).toBe(0)
  expect(unexpectedWarnings(run.stderr), 'decoding the saved file produces warnings').toEqual([])
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
 * extension does while a finished clip is being played would belong in the answer.
 *
 * Two flags. `AudioVideoTracks` turns on the track lists — `HTMLMediaElement.audioTracks` is
 * behind it in Chromium, and without it a page has no way of saying how many audio tracks a file
 * was found to have. `--disable-audio-output` keeps the browser away from the machine's sound
 * device: playback is clocked by the audio output, and on a host without one the clock crawls —
 * measured here on a plain ffmpeg-made clip of five seconds that reached 1.02 s in twenty, having
 * nothing to do with tailcut at all. A clip with sound in it then never fires `ended`, and the
 * suite reads a fact about the host as a fact about the file.
 *
 * It is not a weakening, and the callers are what keep it honest: what they read is `audioBytes`,
 * the count of bytes the audio decoder actually consumed, and the decoder runs the same without a
 * device to play into. Measured on the same clip: 46 230 bytes decoded and `ended` at 5.000 s with
 * the flag, against 11 162 bytes and a stall without it. Take the decoding away and every scenario
 * with sound fails on `audioBytes > 0` instead of passing quietly. The element itself stays
 * unmuted — a muted element is the case where the decoder may never be asked for a byte.
 */
export async function playInBrowser(file: string): Promise<Playback> {
  const browser = await chromium.launch({
    headless: HEADLESS,
    channel: CHANNEL,
    args: ['--enable-blink-features=AudioVideoTracks', '--disable-audio-output'],
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

/**
 * Types a timecode into one of the editor's boxes, commits it, and waits for the box to let go.
 *
 * The turn of the event loop between the filling and the Enter is not decoration. The Enter
 * handler on the node is the one the last render put there and it closes over the text of that
 * render; filled and pressed inside one turn it commits the text from before the fill — observed
 * committing nothing at all under four workers (Task 14, and `enter` in editor-keys.spec.ts says
 * the same thing about the same field).
 *
 * The focus at the end matters as much as the Enter. The editor turns its whole keyboard off
 * while a text field has the focus (Task 14) — otherwise `s` in a clip's name would split the
 * clip — so a press of `i` straight after typing would arrive in the box as a letter and mark
 * nothing. The field gives the focus back on Enter by itself (Task 13), and this insists on it
 * rather than trusting it: blurring the box from here instead would make it let go whether the
 * field did or not, and the regression would surface lines later as a wrong clip count with the
 * reader sent looking at the reducer. Measured — take the blur out of the field's Enter handler
 * and this line is what goes red, in both of the runs that use it.
 */
export async function typeInto(editor: Page, testid: string, text: string): Promise<void> {
  await editor.getByTestId(testid).fill(text)
  await editor.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0))),
  )
  await editor.getByTestId(testid).press('Enter')
  await expect(editor.getByTestId(testid)).not.toBeFocused()
}

/**
 * The frame at a given place in the file, counted from the first frame the file shows.
 *
 * Counted and not timed, because a frame has a number and does not have an instant. This is the
 * only way in this file to point at one particular frame, of a clip or of the recording, and
 * `frameByPlaying(file, at)` is not a second one: that is `select='gte(t,at)'`, the first frame
 * **not earlier** than `at` — the frame *on screen* at that instant, which is a different
 * question with a different right answer at every boundary. Ask it for a frame boundary and a
 * float a hair over the boundary takes the next frame; nudge it half a frame the way a seek in
 * the browser is nudged (`FrameTable.seekTimeOf`, Task 6) and it takes the next frame every
 * time, on every frame, silently. Half a frame belongs to `currentTime` and to nothing else.
 *
 * A second of the session is turned into a frame number by multiplying by the frame rate, which
 * is what `sourceFrame` in the end-to-end run does.
 *
 * The count starts after the edit list has done its work — ffmpeg drops the head the list hides
 * — so index zero is the frame the user asked for and not the key frame before it.
 */
export function frameByIndex(file: string, index: number): Buffer {
  return decodeOneFrame(
    [
      '-v', 'error',
      '-i', file,
      '-vf', `select='eq(n\\,${index})'`,
      '-vsync', '0',
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ],
    `frame ${index}`,
  )
}

/**
 * Runs `act`, waits for a given number of downloads out of one extension page, and gives back
 * where each landed together with **the name the extension asked Chrome to save it under**.
 *
 * The action is passed in rather than done by the caller afterwards, because two things have to
 * be in place before it runs and one of them is not a listener: three clips are written at once
 * (§8.6), so a `waitForEvent` per file would miss the ones that arrive while it is being set up
 * again — and the name has to be caught on its way past.
 *
 * The name needs catching because it does not survive the download. Under Playwright every
 * download is redirected to an artifact of its own and named by a GUID: `suggestedFilename()`
 * carries the GUID, and so does `filename` on Chrome's own `DownloadItem` — measured on this
 * suite, both were `f5ec0166-…-cb8019041987.mp4` for a file the extension asked to call «test
 * player with a hole 00.00.mp4». The only place the asked-for name still exists is the call
 * itself, so the call is what is watched: `chrome.downloads.download` is wrapped in the page,
 * the wrapper notes `filename` against the id Chrome hands back, and the id is what ties it to
 * the artifact on disk. The real download still happens — the wrapper delegates and adds nothing
 * to what is under test but a note in the margin.
 *
 * For an extension page, therefore, and no other: `chrome.downloads` is what it reads.
 */
export async function collectDownloads(
  page: Page,
  count: number,
  act: () => Promise<unknown>,
  timeoutMs = 60_000,
): Promise<Array<{ file: string; name: string }>> {
  await page.evaluate(() => {
    const noted = ((window as unknown as Named).tcNames ??= {})
    if ((window as unknown as Named).tcWrapped) return
    ;(window as unknown as Named).tcWrapped = true

    const downloads = chrome.downloads as unknown as {
      download: (options: { filename?: string }, then?: (id?: number) => void) => void
    }
    const real = downloads.download.bind(chrome.downloads)

    downloads.download = (options, then) =>
      real(options, (id?: number) => {
        if (id !== undefined && options.filename) noted[id] = options.filename
        then?.(id)
      })
  })

  const arrived: Array<Promise<{ file: string; id: number | null }>> = []

  const landed = new Promise<Array<{ file: string; id: number | null }>>((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off('download', onDownload)
      reject(new Error(`only ${arrived.length} of ${count} downloads arrived`))
    }, timeoutMs)

    function onDownload(download: Download): void {
      arrived.push(
        download.path().then(async (file) => {
          if (!file) throw new Error('the download left no file on disk')
          return { file, id: await idOfDownloadTo(page, file) }
        }),
      )

      if (arrived.length < count) return
      clearTimeout(timer)
      page.off('download', onDownload)
      resolve(Promise.all(arrived))
    }

    page.on('download', onDownload)
  })

  await act()
  const files = await landed
  const noted = await page.evaluate(() => (window as unknown as Named).tcNames ?? {})

  return files.map(({ file, id }) => {
    const name = id === null ? null : noted[id]
    expect(name, `Chrome knows of no name for the file it wrote to ${file}`).toBeTruthy()
    return { file, name: name! }
  })
}

/** Where the wrapper above keeps what it saw, on the page it wrapped. */
interface Named {
  tcNames?: Record<number, string>
  tcWrapped?: boolean
}

/** Chrome's own id for the download that landed on a given path, or null if it knows of none. */
function idOfDownloadTo(page: Page, file: string): Promise<number | null> {
  return page.evaluate(
    async (path) => (await chrome.downloads.search({ filename: path }))[0]?.id ?? null,
    file,
  )
}
