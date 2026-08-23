import { test, expect, type Page } from '@playwright/test'
import {
  frameTimes,
  launchWithExtension,
  openPopupOn,
  probeFile,
  saveAll,
  serveLocal,
} from './helpers'

const PLAYER_URL = 'https://tailcut.test/minute'

/** Frames of the fixture are 0.1 seconds apart, samples of its sound 0.046. */
const VIDEO_STEP = 0.1
const AUDIO_STEP = 1024 / 22050

/** Room for the rounding of two timescales; anything past it is a hole and not a rounding. */
const NO_HOLE = 0.05

const TIMEOUT_MS = 120_000

interface PageState {
  ready: boolean
  failure: string | null
  appended: { video: number[]; audio: number[] }
  seeks: number
}

const state = (page: Page): Promise<PageState> =>
  page.evaluate(() => (window as unknown as { tc: PageState }).tc)

const seekTo = (page: Page, seconds: number): Promise<void> =>
  page.evaluate((at) => {
    document.querySelector('video')!.currentTime = at
  }, seconds)

/** Waits until the play head has crossed a mark, with the page's own failure as a way out. */
async function playUntil(page: Page, seconds: number): Promise<void> {
  await page.waitForFunction(
    (mark) => {
      const video = document.querySelector('video')!
      const tc = (window as unknown as { tc: PageState }).tc
      return video.currentTime >= mark || tc.failure != null
    },
    seconds,
    { timeout: 60_000 },
  )
  expect((await state(page)).failure).toBeNull()
}

/** The popup's own "m:ss" read back as seconds. */
function secondsOf(shown: string): number {
  const [minutes, seconds] = shown.split(':')
  return Number(minutes) * 60 + Number(seconds)
}

/** The largest step between one frame and the next: a hole in playback shows up here. */
function widestStep(times: number[]): number {
  let widest = 0
  for (let i = 1; i < times.length; i++) widest = Math.max(widest, times[i]! - times[i - 1]!)
  return widest
}

/**
 * What the user does next after saving: seeking.
 *
 * A rewind lands on material already recorded, a jump forward lands past the end of it, and what
 * the session is left holding is two stretches with a hole between them. A file made of both
 * would play the first stretch, jump a quarter of a minute of nothing and go on — or stop there,
 * depending on the player. The file has to be one unbroken stretch instead, and the frames in it
 * have to follow one another without a step longer than a frame.
 */
test('a file saved after seeking has no hole in it', async () => {
  test.setTimeout(TIMEOUT_MS)

  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()
  await serveLocal(page, 'minute.html', PLAYER_URL)

  await page.waitForFunction(() => {
    const tc = (window as unknown as { tc?: PageState }).tc
    return tc?.ready === true || tc?.failure != null
  })

  await page.evaluate(() => document.querySelector('video')!.play())
  await playUntil(page, 10)

  // Back into what has been watched: the player has it buffered and asks for nothing new.
  await seekTo(page, 2)
  await playUntil(page, 6)

  // Forward over what has not: the loader jumps to the new place, and the recording is left with
  // a hole where the video was never played.
  await seekTo(page, 40)
  await playUntil(page, 46)

  const played = await state(page)
  expect(played.seeks).toBe(2)
  // Both sides of the hole really were recorded — otherwise the check below would pass on a
  // session that never had two stretches to choose between.
  expect(Math.min(...played.appended.video)).toBe(0)
  expect(Math.max(...played.appended.video)).toBeGreaterThanOrEqual(7)

  const popup = await openPopupOn(context, page, extensionId)
  // The material is in two pieces and the file will hold one of them. The popup says so in a
  // line, and — this is the point — the length beside it is the length of that one piece: the
  // sum of the two would promise a clip half of which no file will ever contain.
  await expect(popup.getByTestId('omits')).toHaveText(
    'Recording has gaps: the longest piece is saved.',
  )
  const promised = secondsOf(await popup.getByTestId('duration').innerText())

  const file = await saveAll(page, popup)
  const probed = probeFile(file)

  // What was promised against what was written. Whole segments go into the file, so it may run a
  // little past the stretch they were chosen over; shorter than the promise is the failure.
  expect(promised).toBeLessThanOrEqual(Number(probed.format.duration) + 1)
  expect(promised, 'the popup promised a clip of nothing').toBeGreaterThan(10)

  expect(probed.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
    ['video', 'h264'],
    ['audio', 'aac'],
  ])

  const picture = frameTimes(file, 'v')
  const sound = frameTimes(file, 'a')

  // One unbroken stretch of each: the saved file holds the longer of the two runs and not both of
  // them stitched over the hole.
  expect(widestStep(picture)).toBeLessThan(VIDEO_STEP + NO_HOLE)
  expect(widestStep(sound)).toBeLessThan(AUDIO_STEP + NO_HOLE)

  // And it is the stretch the jump forward opened, not a second or two of leftovers.
  const covered = picture[picture.length - 1]! - picture[0]!
  expect(covered).toBeGreaterThan(12)

  // What the file says it lasts is what its frames add up to. The sound is cut into pieces of its
  // own and starts a shade before the picture, so the clip is measured from the earlier of them.
  const from = Math.min(picture[0]!, sound[0]!)
  const until = Math.max(picture[picture.length - 1]! + VIDEO_STEP, sound[sound.length - 1]! + AUDIO_STEP)
  expect(Number(probed.format.duration)).toBeCloseTo(until - from, 1)

  await context.close()
})
