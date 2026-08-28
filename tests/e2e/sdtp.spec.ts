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
import { findBox } from '../../src/core/iso/reader'
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
 * (14496-12 §8.6.4) and it says nothing the trun beside it contradicts, but it is a box a reader
 * has to walk past to reach the trun behind it — and a save of such a page is the shape the
 * whole path is least often run over.
 *
 * The fragmented writer copied fragments whole and byte for byte, so every one of those tables
 * reached the saved file and ffmpeg, which keeps one per stream, said "Duplicated SDTP atom" over
 * each after the first. The progressive writer reads the samples out and states tables of its own,
 * so it carries none of the site's boxes through and the file it writes draws nothing at all —
 * which is what is asserted below, against material that provably still has the box in it.
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

  /** Every fragment the page was actually served, so the test can prove what it was made of. */
  const served: Uint8Array[] = []

  // Registered after routeLocal, so it wins: Playwright tries its handlers newest first.
  await page.route('**/fixtures/h264/chunk-stream0-*.m4s', async (route) => {
    const rel = new URL(route.request().url()).pathname.replace('/fixtures/', '')
    const bytes = new Uint8Array(await fs.readFile(path.resolve('tests/fixtures', rel)))
    const shaped = withSdtp(bytes)
    served.push(shaped)
    await route.fulfill({ body: Buffer.from(shaped), contentType: 'video/mp4' })
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

  // The material really was what this is about. Without this the test would run over fragments
  // shaped like every other one in the suite and prove nothing at all — and it would go on
  // passing if `withSdtp` ever stopped putting the box in.
  expect(served.length, 'the page fetched none of the fragments this test shapes').toBe(3)
  for (const fragment of served) {
    expect(
      findBox(fragment, ['moof', 'traf', 'sdtp']),
      'a fragment the page was served carries no sdtp',
    ).not.toBeNull()
  }

  // And the file that came out of them says nothing at all. The writer reads the samples and
  // states tables of its own, so none of the site's boxes travels into the file: where the
  // fragmented writer left one "Duplicated SDTP atom" per fragment after the first, there is now
  // not a word. Asserted as silence rather than through `decodeFile`, which tolerates that line
  // by name for the sake of the writer this one replaced.
  expect(decodeWarnings(file), 'the saved file draws a complaint out of ffmpeg').toBe('')

  // And it decoded, which the line above does not say: silence is also what a decode that never
  // started sounds like.
  decodeFile(file)

  await context.close()
})
