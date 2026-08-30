import { test, expect, type Page } from '@playwright/test'
import { launchWithExtension, openPopupOn, probeFile, saveAll, serveLocal } from './helpers'

const PLAYER_URL = 'https://tailcut.test/minute'

/**
 * A minute of the fixture: ten segments of picture of six seconds each and twelve of sound of
 * 5.016. The sound runs 46 milliseconds past the picture, and the clip is measured by the picture
 * on the output timeline, so the file lasts a round minute.
 *
 * One packet of sound short of the 1293 that arrived: the first of them is the priming of the
 * encoder, and the edit list the writer states hides it. Before the move to that writer the file
 * carried it, ffmpeg counted it, and the sound of this very fixture began at −0.046440.
 */
const VIDEO_FRAMES = 600
const AUDIO_FRAMES = 1292
const CLIP_SECONDS = 60.0

/** A minute of playback is a minute of wall clock, and the save comes after it. */
const TIMEOUT_MS = 180_000

interface PageState {
  ready: boolean
  failure: string | null
  appended: { video: number[]; audio: number[] }
  seeks: number
}

const state = (page: Page): Promise<PageState> =>
  page.evaluate(() => (window as unknown as { tc: PageState }).tc)

/**
 * The defect as it was reported: a minute of watching, Save all, one file.
 *
 * The six-second check next door asks whether both tracks reach the file at all. This one asks
 * what the answer is worth over the length a person actually watches — sixty seconds of segments
 * arriving a dozen at a time while playback runs, twenty-two of them in two buffers, and a file
 * that has to hold every frame of both and say how long it is.
 */
test('a minute of watching is saved as a minute of both tracks', async () => {
  test.setTimeout(TIMEOUT_MS)

  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()
  await serveLocal(page, 'minute.html', PLAYER_URL)

  await page.waitForFunction(() => {
    const tc = (window as unknown as { tc?: PageState }).tc
    return tc?.ready === true || tc?.failure != null
  })
  expect((await state(page)).failure).toBeNull()

  await page.evaluate(() => document.querySelector('video')!.play())

  // To the end of the material, not to a stopwatch: the loader keeps ahead of the play head, and
  // where the head has been is what the extension is left holding.
  await page.waitForFunction(
    () => {
      const video = document.querySelector('video')!
      const tc = (window as unknown as { tc: PageState }).tc
      return video.ended || tc.failure != null
    },
    undefined,
    { timeout: 120_000 },
  )

  const played = await state(page)
  expect(played.failure).toBeNull()
  // Every segment of both tracks went through appendBuffer, so anything missing from the file
  // went missing inside the extension and not on the page.
  expect(played.appended.video).toHaveLength(10)
  expect(played.appended.audio).toHaveLength(12)

  const popup = await openPopupOn(context, page, extensionId)

  // The picture ends at 60.000 and the sound at 60.046; what the two of them cover at once is the
  // minute the popup promises.
  await expect(popup.getByTestId('duration')).toHaveText('1:00')

  const probed = probeFile(await saveAll(page, popup))

  expect(probed.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
    ['video', 'h264'],
    ['audio', 'aac'],
  ])
  expect(probed.streams.map((s) => Number(s.nb_read_frames))).toEqual([VIDEO_FRAMES, AUDIO_FRAMES])
  expect(Number(probed.format.duration)).toBeCloseTo(CLIP_SECONDS, 1)

  await context.close()
})
