import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  decodeFile,
  launchWithExtension,
  openPopupOn,
  probeFile,
  routeLocal,
  saveAll,
} from './helpers'
import { decodeWarnings } from '../support/media'
import { withSdtp } from '../support/fragments'

const PLAYER_URL = 'https://tailcut.test/player'

/**
 * How long the player has to run for triage to let it past probation
 * (BALANCED.gracePeriodSeconds = 6). The spare second is for the imprecision of the watcher poll.
 */
const PLAY_MS = 7_000

type PageState = { allAppended?: boolean }

/**
 * A site whose fragments carry their own sample-dependency tables.
 *
 * rutube's packager writes an `sdtp` into every fragment it sends. It is legal there
 * (14496-12 §8.6.4), it says nothing the trun beside it contradicts, and our muxer copies
 * fragments whole and byte for byte — so it reaches the saved file, and ffmpeg, which keeps one
 * such table per stream, says "Duplicated SDTP atom" over every one after the first.
 *
 * The file is right and every frame of it decodes. What was wrong was the suite: `decodeFile`
 * demanded an empty stderr, so this whole shape of material — a real site's, on every save — was
 * a shape no end-to-end test could be written over. The warnings that a correct file draws are
 * now named one at a time, with the reason, and this is the material that draws one.
 *
 * The segments are the ordinary h264 fixtures with the box put in, rather than a set of their
 * own: the frames, the timing and the codec are the ones every other test uses, and the one thing
 * that differs is the one thing under test.
 */
test('saves a recording whose fragments brought their own sdtp, and the file decodes whole', async () => {
  test.setTimeout(120_000)

  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  await routeLocal(page, 'player.html', PLAYER_URL)
  // Registered after routeLocal, so it wins: Playwright tries its handlers newest first.
  await page.route('**/fixtures/h264/chunk-stream0-*.m4s', async (route) => {
    const rel = new URL(route.request().url()).pathname.replace('/fixtures/', '')
    const bytes = new Uint8Array(await fs.readFile(path.resolve('tests/fixtures', rel)))
    await route.fulfill({ body: Buffer.from(withSdtp(bytes)), contentType: 'video/mp4' })
  })
  await page.goto(PLAYER_URL)

  await page.waitForFunction(() => (window as unknown as PageState).allAppended === true, undefined, {
    timeout: 15_000,
  })
  await page.evaluate(() => {
    const video = document.querySelector('video')!
    video.loop = true
    return video.play()
  })
  await page.waitForTimeout(PLAY_MS)

  const popup = await openPopupOn(context, page, extensionId)
  await expect(popup.getByTestId('duration')).toHaveText('0:06')

  const file = await saveAll(page, popup)
  const probed = probeFile(file)

  // Not a frame lost to the box the site put there: 144 of picture at 24 a second.
  expect(probed.streams.map((stream) => stream.codec_type)).toEqual(['video'])
  expect(probed.streams.map((stream) => Number(stream.nb_read_frames))).toEqual([144])

  // The saved file really carries what this is about. Without it the test would pass over a file
  // shaped like every other one in the suite and prove nothing at all.
  expect(
    decodeWarnings(file),
    'the saved file no longer carries the box this test is about',
  ).toContain('Duplicated SDTP atom')

  // And that is the whole of what ffmpeg has to say about it.
  decodeFile(file)

  await context.close()
})
