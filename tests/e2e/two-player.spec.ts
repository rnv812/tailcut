import { test, expect, type Page } from '@playwright/test'
import {
  decodeFile,
  frameTimes,
  launchWithExtension,
  openPopupOn,
  probeFile,
  saveAll,
  serveLocal,
} from './helpers'

const PAGE_URL = 'https://tailcut.test/two-player'

/**
 * How long the players have to run for triage to let them through the probation period
 * (BALANCED.gracePeriodSeconds = 6). A second of slack for the polling of the watcher.
 */
const PLAY_MS = 7_000

/** Two saves and two runs of ffprobe over every frame of both files. */
const TIMEOUT_MS = 120_000

type PageState = { allAppended?: boolean; failure?: string | null }

/** What a file holds, in the form worth comparing: the kind and the codec of every stream. */
const streamsOf = (file: string): string[][] =>
  probeFile(file).streams.map((s) => [s.codec_type, s.codec_name])

const framesOf = (file: string): number[] =>
  probeFile(file).streams.map((s) => Number(s.nb_read_frames))

/** Saves the other live recording through its own stable row action. */
async function saveTheOther(player: Page, popup: Page): Promise<string> {
  const started = player.waitForEvent('download')
  await popup.getByTestId('session-save').first().click()
  const download = await started
  expect(download.suggestedFilename()).toMatch(/\.mp4$/)
  const file = await download.path()
  expect(file, 'the other recording left no file on disk').not.toBeNull()
  return file!
}

/**
 * Two players on one page, four SourceBuffers, every one of them fed in slices.
 *
 * A SourceBuffer is handed a byte stream and not a list of segments, so the segments are put back
 * together inside the registry — and that reassembly is per buffer. One for the page, or one per
 * media source, and four streams arriving at once would be spliced into one another: a picture
 * assembled out of somebody else's sound. Their different lengths distinguish the exports
 * after both source codec combinations have been converted to H.264/AAC.
 */
test('two players on one page save as two files, neither holding the other', async () => {
  test.setTimeout(TIMEOUT_MS)

  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()
  await serveLocal(page, 'two-player.html', PAGE_URL)

  await page.waitForFunction(
    () => {
      const state = window as unknown as PageState
      return state.allAppended === true || state.failure != null
    },
    undefined,
    { timeout: 30_000 },
  )
  expect(await page.evaluate(() => (window as unknown as PageState).failure ?? null)).toBeNull()

  await page.evaluate(() => {
    for (const video of document.querySelectorAll('video')) void video.play()
  })
  await page.waitForTimeout(PLAY_MS)

  const popup = await openPopupOn(context, page, extensionId)

  // Two players, two codec sets, two sessions in one recordings list.
  await expect(popup.getByTestId('session')).toHaveCount(1)

  // Both sessions belong to the same page and are signed with its title, so which is which is
  // settled by what is inside the two files rather than by the name over them.
  const first = await saveAll(page, popup)
  const second = await saveTheOther(page, popup)

  const byFrames = new Map(
    [first, second].map((file) => [framesOf(file)[0]!, file]),
  )

  expect([...byFrames.keys()].sort((a, b) => a - b)).toEqual([96, 144])

  const alpha = byFrames.get(144)!
  const beta = byFrames.get(96)!

  expect(streamsOf(alpha)).toEqual([
    ['video', 'h264'],
    ['audio', 'aac'],
  ])
  expect(streamsOf(beta)).toEqual([
    ['video', 'h264'],
    ['audio', 'aac'],
  ])

  // Every frame the page fed that player, and not one frame more: 144 of picture at 24 a second
  // over six seconds, and 260 of sound of 1024 samples each at 44100 — less the first packet of
  // the sound, which is the priming of the encoder and is hidden by the edit list.
  expect(framesOf(alpha)).toEqual([144, 259])

  // The second picture runs four seconds against six of sound. Conversion must retain
  // only the sound beneath those four seconds, without borrowing the first player's tail.
  const [betaPicture] = framesOf(beta)
  expect(betaPicture).toBe(96)
  expect(frameTimes(beta, 'a').at(-1)).toBeGreaterThan(3.9)
  expect(frameTimes(beta, 'a').at(-1)).toBeLessThan(4.05)

  // Neither file merely opens: both are decoded frame by frame without a word of complaint.
  decodeFile(alpha)
  decodeFile(beta)

  await context.close()
})
