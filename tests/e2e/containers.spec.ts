import { test, expect } from '@playwright/test'
import {
  decodeFile,
  frameTimes,
  launchWithExtension,
  openPopupOn,
  playInBrowser,
  probeFile,
  saveAll,
  serveLocal,
} from './helpers'

const PLAYER_URL = 'https://tailcut.test/two-container'

/**
 * How long the player has to run for triage to let it through the probation period
 * (BALANCED.gracePeriodSeconds = 6). A second of slack for the polling of the watcher.
 */
const PLAY_MS = 7_000

/** Real-time playback of the saved clip on top of everything else the test does. */
const TIMEOUT_MS = 120_000

type PageState = { allAppended?: boolean; failure?: string | null }

/**
 * A page whose picture comes in one container and whose sound comes in another.
 *
 * This is the ordinary shape of the web and not a corner of it: a site serves its video as
 * fragmented mp4 and its audio as audio/webm; codecs="opus", two SourceBuffers of one
 * MediaSource, two grammars. A saved clip is one file, so the two have to be made one somewhere,
 * and every piece of that is under a test of its own. What is checked here is that the pieces
 * fitted together give the user a file that plays — with sound.
 */
test('a clip whose sound came in WebM saves as one file that plays', async () => {
  test.setTimeout(TIMEOUT_MS)

  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()
  await serveLocal(page, 'two-container.html', PLAYER_URL)

  await page.waitForFunction(
    () => {
      const state = window as unknown as PageState
      return state.allAppended === true || state.failure != null
    },
    undefined,
    { timeout: 15_000 },
  )
  // A browser that refused the WebM buffer outright would leave the page reporting the refusal
  // rather than a clip, and everything below would be measuring the mp4 track on its own.
  expect(await page.evaluate(() => (window as unknown as PageState).failure ?? null)).toBeNull()

  await page.evaluate(() => document.querySelector('video')!.play())
  await page.waitForTimeout(PLAY_MS)

  const popup = await openPopupOn(context, page, extensionId)

  // Picture 0…6, sound 0…6.001: six seconds is what both tracks cover at once, and the popup
  // offers what can be cut and not what was collected.
  await expect(popup.getByTestId('duration')).toHaveText('0:06')

  const file = await saveAll(page, popup)
  const probed = probeFile(file)

  expect(probed.streams.map((stream) => [stream.codec_type, stream.codec_name])).toEqual([
    ['video', 'h264'],
    ['audio', 'aac'],
  ])
  // Picture is copied; sound is converted from Opus to AAC for editing applications.
  expect(Number(probed.streams[0]!.nb_read_frames)).toBe(144)
  expect(frameTimes(file, 'a').at(-1)).toBeCloseTo(6, 1)

  const seconds = Number(probed.format.duration)
  expect(seconds).toBeGreaterThan(5.9)
  expect(seconds).toBeLessThan(6.1)

  // Read through by a decoder and not only by a parser: sound described wrongly gets past the
  // headers and past a frame count, and turns into words on stderr only here.
  decodeFile(file)

  // And the last word belongs to a browser, which is where the file is going to be opened.
  const played = await playInBrowser(file)

  expect(played.error).toBeNull()
  expect(played.ended, 'playback did not reach the end of the clip').toBe(true)
  expect(played.duration).toBeGreaterThan(5.9)
  expect(played.reached).toBeGreaterThan(5.5)
  // The browser found a sound track and decoded it. A file whose audio it could not make sense of
  // would still open, still report a duration and still run to the end — in silence.
  expect(played.audioTracks).toBe(1)
  expect(played.audioBytes, 'the browser decoded no sound at all').toBeGreaterThan(0)
  expect(played.videoBytes, 'the browser decoded no picture at all').toBeGreaterThan(0)

  await context.close()
})
