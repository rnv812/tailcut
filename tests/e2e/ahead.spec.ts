import { test, expect } from '@playwright/test'
import {
  inspectFile,
  launchWithExtension,
  openPopupOn,
  playInBrowser,
  routeLocal,
  saveAll,
} from './helpers'

const PLAYER_URL = 'https://tailcut.test/ahead'

/**
 * How long the player has to run for triage to let it through the probation period
 * (BALANCED.gracePeriodSeconds = 6). A second of slack for the polling of the watcher.
 */
const PLAY_MS = 7_000

/** Real-time playback of a twelve-second clip on top of everything else the test does. */
const TIMEOUT_MS = 180_000

type PageState = { allAppended?: boolean; failure?: string | null; unsupported?: string | null }

/**
 * Sound cut into longer pieces than the picture, and downloaded further ahead of it.
 *
 * Every page in this suite that has both kinds of media delivers them in step, and that is the
 * one thing a real site does not do. YouTube packages its sound in pieces of five and ten seconds
 * where its picture goes in two and four, and it keeps the sound buffer seconds ahead of the
 * picture one. The last piece of sound then begins inside the picture and ends well past the end
 * of it — and a clip is cut out of the stretch where both are there at once.
 *
 * Taken whole, that piece is the tail of a file that shows nothing. A save off the real site
 * promised twenty seconds and wrote twenty-nine, the last ten of them a frozen frame with the
 * sound running on over it. This is the same shape in miniature: twelve seconds of picture in
 * two six-second segments, fifteen of sound in three five-second ones.
 */
test('a clip is not given a tail of sound over a picture that has run out', async () => {
  test.setTimeout(TIMEOUT_MS)

  const feeds = [
    {
      mime: 'video/mp4; codecs="avc1.4d400b"',
      init: '/fixtures/minute/init-stream0.m4s',
      // Six seconds apiece: 0…12.
      chunks: [1, 2].map((n) => `/fixtures/minute/chunk-stream0-0000${n}.m4s`),
    },
    {
      mime: 'audio/mp4; codecs="mp4a.40.2"',
      init: '/fixtures/minute/init-stream1.m4s',
      // Five seconds apiece: 0…15.0465, the last one mostly past the picture.
      chunks: [1, 2, 3].map((n) => `/fixtures/minute/chunk-stream1-0000${n}.m4s`),
    },
  ]

  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()
  await routeLocal(page, 'codecs.html', PLAYER_URL)
  await page.goto(`${PLAYER_URL}#${encodeURIComponent(JSON.stringify(feeds))}`)

  await page.waitForFunction(
    () => {
      const state = window as unknown as PageState
      return state.allAppended === true || state.failure != null || state.unsupported != null
    },
    undefined,
    { timeout: 15_000 },
  )
  const state = await page.evaluate(() => {
    const page = window as unknown as PageState
    return { failure: page.failure ?? null, unsupported: page.unsupported ?? null }
  })
  expect(state.unsupported).toBeNull()
  expect(state.failure).toBeNull()

  await page.evaluate(() => document.querySelector('video')!.play())
  await page.waitForTimeout(PLAY_MS)

  const popup = await openPopupOn(context, page, extensionId)

  // Sound to 10.031 and picture to 12: ten seconds is what the file plays with both of its
  // tracks, and that is what the popup offers. Before the last segment of sound was left behind
  // it offered twelve — of a file that ran for fifteen.
  await expect(popup.getByTestId('duration')).toHaveText('0:10')

  const file = await saveAll(page, popup)
  const facts = inspectFile(file)
  const played = await playInBrowser(file)
  await context.close()

  expect(facts.probeStatus, facts.probeStderr).toBe(0)
  expect(facts.probeStderr, 'ffprobe complains about reading the saved file').toBe('')
  expect(facts.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
    ['video', 'h264'],
    ['audio', 'aac'],
  ])
  // Two segments of picture at ten frames a second, and two of the three of sound: 108 frames of
  // 1024 samples at 22050 apiece. The third would have added another 108 and three seconds of
  // nothing to look at.
  expect(facts.streams.map((s) => Number(s.nb_read_frames))).toEqual([120, 216])

  // The whole file, not the promise: it runs as long as the picture does and no longer.
  expect(facts.duration).toBeGreaterThan(11.9)
  expect(facts.duration).toBeLessThan(12.1)

  expect(facts.decodeStatus, facts.decodeStderr).toBe(0)
  expect(facts.decodeStderr, 'decoding the saved file produces warnings').toBe('')

  expect(played.error).toBeNull()
  expect(played.ended, 'playback did not reach the end of the clip').toBe(true)
  expect(played.audioTracks).toBe(1)
  expect(played.audioBytes, 'the browser decoded no sound at all').toBeGreaterThan(0)
  expect(played.videoBytes, 'the browser decoded no picture at all').toBeGreaterThan(0)
  expect(played.frameColours, 'the browser drew a blank frame').toBeGreaterThan(1)
})
