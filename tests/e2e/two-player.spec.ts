import { test, expect, type Page } from '@playwright/test'
import {
  decodeFile,
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

/** Moves the popup onto the other session of the page — the one waiting in Recent. */
async function pickTheOther(popup: Page): Promise<void> {
  await popup.getByTestId('session').first().click()
}

/**
 * Two players on one page, four SourceBuffers, every one of them fed in slices.
 *
 * A SourceBuffer is handed a byte stream and not a list of segments, so the segments are put back
 * together inside the registry — and that reassembly is per buffer. One for the page, or one per
 * media source, and four streams arriving at once would be spliced into one another: a picture
 * assembled out of somebody else's sound. The two players are told apart by their codecs, so a
 * single byte of one landing in the other's file shows up as a stream that has no business there.
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

  // Two players, two codec sets, two sessions: one is shown and the other waits in Recent.
  await expect(popup.getByTestId('session')).toHaveCount(1)

  // Both sessions belong to the same page and are signed with its title, so which is which is
  // settled by what is inside the two files rather than by the name over them.
  const first = await saveAll(page, popup)
  await pickTheOther(popup)
  const second = await saveAll(page, popup)

  const byCodec = new Map(
    [first, second].map((file) => [streamsOf(file).map((s) => s[1]).join('+'), file]),
  )

  // Two files, and in each of them exactly the two streams its own player fed. Material crossing
  // from one to the other shows up here as a third stream or as a codec that has no business in
  // that file.
  expect([...byCodec.keys()].sort()).toEqual(['h264+aac', 'vp9+opus'])

  const alpha = byCodec.get('h264+aac')!
  const beta = byCodec.get('vp9+opus')!

  expect(streamsOf(alpha)).toEqual([
    ['video', 'h264'],
    ['audio', 'aac'],
  ])
  expect(streamsOf(beta)).toEqual([
    ['video', 'vp9'],
    ['audio', 'opus'],
  ])

  // Every frame the page fed that player, and not one frame more: 144 of picture at 24 a second
  // over six seconds, and 260 of sound of 1024 samples each at 44100.
  expect(framesOf(alpha)).toEqual([144, 260])

  // The vp9 track runs four seconds against six of Opus, so four is what the two cover at once —
  // 96 frames of picture, and the sound of the clusters that reach into those four seconds.
  const [betaPicture, betaSound] = framesOf(beta)
  expect(betaPicture).toBe(96)
  expect(betaSound).toBeGreaterThanOrEqual(200)

  // Neither file merely opens: both are decoded frame by frame without a word of complaint.
  decodeFile(alpha)
  decodeFile(beta)

  await context.close()
})
