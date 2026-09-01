import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import {
  clickEdit,
  collectDownloads,
  decodeFile,
  frameTimes,
  launchWithExtension,
  probeFile,
  routeLocal,
  typeInto,
} from './helpers'

/**
 * The same run twice: over a page shaped the way YouTube delivers, and over youtube.com itself.
 *
 * The assertions are one function called by both, and the offline leg is not a rehearsal of the
 * live one. It asks the same questions of material that cannot change under the test, it needs no
 * network, it is in the default suite, and it is the release gate. The live leg is diagnostic:
 * it goes out to somebody else's page, which changes more often than tests do, and a
 * red build over a redesigned consent dialog tells nobody anything. Before a release:
 *
 *   TAILCUT_LIVE=1 npx playwright test youtube
 *
 * What the live leg adds is the day's real bytes: a DASH init from YouTube's own packager with an
 * inherited `elst` of its own, whatever codec the machine and the day agree on, a consent wall in
 * the way, and a real page title travelling into a file name. What it does not add is depth — see
 * WATCH_MS.
 */
const LIVE = process.env.TAILCUT_LIVE === '1'

/** Long-lived and licensed for reuse; another can be named through the environment. */
const WATCH_URL = process.env.TAILCUT_LIVE_URL ?? 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'

/**
 * How long the live leg watches.
 *
 * An automated browser comes to YouTube with an empty profile and no account, and the player
 * keeps a short buffer ahead of the play head: twenty-five seconds of watching leaves the
 * extension with something on the order of twenty seconds of material, not with the whole video.
 * That is the honest limit of that leg — it proves the road and not the depth, so what it asserts
 * is a floor and not a number.
 */
const WATCH_MS = 25_000

/** Less than that and there is nothing to cut, and the run has learned nothing. */
const ENOUGH_SECONDS = 5

/** Six seconds of fixture, looped past the probation period of triage plus the watcher poll. */
const PLAY_MS = 7_000

const SHAPED_URL = 'https://tailcut.test/youtube-shaped'

/**
 * The pairing YouTube actually serves: AV1 picture in mp4, Opus sound in WebM, a SourceBuffer and
 * an init segment apiece. The fixtures were made for exactly this pairing (tools/make-fixtures.sh
 * says so beside both sets) and `codecs.spec.ts` already saves it; here it stands in for the page
 * so that everything downstream of the recording is exercised without a network.
 *
 * Fed through the generic page rather than a page of its own: `codecs.html` takes its feeds out of
 * the fragment of the address, and one more copy of it with two constants baked in would be a
 * fourth page that says nothing new.
 */
const FEEDS = [
  {
    mime: 'video/mp4; codecs="av01.0.00M.08"',
    init: '/fixtures/av1/init-stream0.m4s',
    chunks: [1, 2, 3].map((n) => `/fixtures/av1/chunk-stream0-0000${n}.m4s`),
  },
  {
    mime: 'audio/webm; codecs="opus"',
    init: '/fixtures/webm/init-stream1.webm',
    chunks: [1, 2, 3, 4].map((n) => `/fixtures/webm/chunk-stream1-0000${n}.webm`),
  },
]

/**
 * The title the shaped page wears, and the name the file has to come out under.
 *
 * It includes non-Latin text, spaces and punctuation common in real page titles. Nothing here is
 * forbidden to a file system: what a title does to a file name when it *is* forbidden has its own
 * tests (tests/core/naming.test.ts), and repeating them through a browser would only make this run
 * longer and no more truthful.
 */
const SHAPED_TITLE = '夜の放送 — tailcut'

type PageState = { allAppended?: boolean; failure?: string | null; unsupported?: string | null }

/**
 * Records what the page gave, cuts two seconds out of the middle of it and reads the file back.
 *
 * The cut is typed and not dragged: the material differs between the two legs, and a timecode
 * does not depend on where the pixels landed.
 */
async function cutAndExport(
  context: BrowserContext,
  player: Page,
  extensionId: string,
  leg: string,
): Promise<{ file: string; name: string }> {
  const popup = await context.newPage()
  await player.bringToFront()
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`)

  const shown = await popup.getByTestId('duration').innerText()
  const [minutes, seconds] = shown.split(':')
  const buffered = Number(minutes) * 60 + Number(seconds)
  console.log(`  ${leg}: ${buffered} s of buffer to cut from`)
  expect(buffered, 'the page gave no material at all').toBeGreaterThanOrEqual(ENOUGH_SECONDS)
  await popup.close()

  const { editor } = await clickEdit(context, player, extensionId)
  await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
  // The material has been indexed: the line the panel shows while it is still reading is gone
  // while the index is loading. The button itself says nothing yet: with no clips it is disabled
  // either way, and
  // asking it here would be asking about the empty document rather than about the recording.
  await expect(editor.getByTestId('export-note')).toHaveCount(0)

  await typeInto(editor, 'playhead-field', '00:00:02:00')
  await editor.keyboard.press('i')
  await typeInto(editor, 'out-c1', '00:00:04:00')
  await expect(editor.getByTestId('out-c1')).toHaveValue('00:00:04:00')
  await expect(editor.getByTestId('export-selected')).toBeEnabled()

  const [clip] = await collectDownloads(editor, 1, () =>
    editor.getByTestId('export-selected').click(),
  )
  await expect(editor.getByTestId('job-state')).toHaveText('Saved')

  const probed = probeFile(clip!.file)

  console.log(
    `  ${leg}: ${probed.streams.map((s) => `${s.codec_type} ${s.codec_name}`).join(', ')}, ` +
      `${probed.format.duration} s, «${clip!.name}»`,
  )

  // What the day served is not this run's business; that it came out as a readable clip is.
  expect(probed.streams.some((stream) => stream.codec_type === 'video')).toBe(true)
  expect(Number(probed.format.duration)).toBeGreaterThan(1)
  expect(Number(probed.format.duration)).toBeLessThan(4)
  const pictureTimes = frameTimes(clip!.file, 'v')
  const soundTimes = frameTimes(clip!.file, 'a')
  expect(pictureTimes.length).toBeGreaterThan(0)
  expect(soundTimes.length).toBeGreaterThan(0)
  expect(Math.abs(pictureTimes[0]! - soundTimes[0]!)).toBeLessThan(0.05)
  expect(Math.abs(pictureTimes.at(-1)! - soundTimes.at(-1)!)).toBeLessThan(0.1)
  // The fallback name means the title never reached the file: the page had one in both legs.
  expect(clip!.name).not.toBe('tailcut.mp4')
  decodeFile(clip!.file)

  return clip!
}

test('records, edits and exports a clip from a page shaped like YouTube', async () => {
  test.setTimeout(180_000)

  const { context, extensionId } = await launchWithExtension()

  try {
    const player = await context.newPage()
    await routeLocal(player, 'codecs.html', SHAPED_URL)
    await player.goto(`${SHAPED_URL}#${encodeURIComponent(JSON.stringify(FEEDS))}`)
    // Set after the load and not written into the page: the content script re-reads the title
    // twice a second, which is how a single-page application's late title reaches a session at
    // all — so this exercises that path as well as giving the file a name.
    await player.evaluate((title) => {
      document.title = title
    }, SHAPED_TITLE)

    const unsupported = await player.evaluate(
      () => (window as unknown as PageState).unsupported ?? null,
    )
    // A machine with no AV1 decoder is not a defect of the extension, and a run that reported it
    // as one would be claiming a pairing it never played.
    test.skip(unsupported !== null, `this browser will not take ${unsupported}`)

    await player.waitForFunction(
      () => (window as unknown as PageState).allAppended === true,
      undefined,
      { timeout: 15_000 },
    )
    await player.evaluate(() => {
      const video = document.querySelector('video')!
      video.loop = true
      return video.play()
    })
    await player.waitForTimeout(PLAY_MS)

    const clip = await cutAndExport(context, player, extensionId, 'shaped')

    // Only the offline leg can say this: the title is known here, and on YouTube it is whatever
    // the day serves.
    expect(clip.name.startsWith(SHAPED_TITLE)).toBe(true)
  } finally {
    await context.close()
  }
})

test('records, edits and exports a clip from a real YouTube page', async () => {
  test.skip(!LIVE, 'live sites are not part of the offline suite: run with TAILCUT_LIVE=1')
  test.setTimeout(300_000)

  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await context.newPage()
    await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded' })

    // The consent wall stands between a fresh profile and the player, and its wording moves. Both
    // spellings are tried and neither is insisted on: on an account that has answered once, and
    // in the countries that never ask, there is no dialog at all.
    for (const name of [/accept all/i, /reject all/i]) {
      const button = page.getByRole('button', { name }).first()
      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {})
        break
      }
    }

    await page.waitForSelector('video', { timeout: 60_000 })
    await page.evaluate(async () => {
      const video = document.querySelector('video')!
      video.muted = true
      await video.play().catch(() => {})
    })

    await page.waitForTimeout(WATCH_MS)
    await cutAndExport(context, page, extensionId, 'live')
  } finally {
    await context.close()
  }
})
