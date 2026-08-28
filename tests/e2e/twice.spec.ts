import { test, expect } from '@playwright/test'
import { launchWithExtension, openPopupOn, playInBrowser, probeFile, saveAll, decodeFile } from './helpers'
import { serveMedia, servePage } from './server'

/** Past the six seconds triage gives a player to prove itself, and well short of the twenty the file lasts. */
const WATCH_MS = 8_000

/** Long enough for the verdict, the two ranged reads and the session to arrive. */
const SETTLE_MS = 1_500

interface Held {
  currentTime: number
  duration: number
  buffered: Array<[number, number]>
}

interface State {
  above: Held
  below: Held
  bothOnScreen: boolean
}

/**
 * One file on a page twice, with the lower copy watched.
 *
 * The case is ordinary — https://www.w3schools.com/html/html5_video.asp shows one clip in two
 * examples, and so does any page that repeats a video beside its transcript — and it used to
 * come out as an empty popup. One file is one source, and the account of it was taken from
 * whichever element the walk of the page reached first; the copy above has never been played, so
 * the file was never promoted and nothing was ever offered.
 */
test('saves the file the lower of two elements played, not what the idle one above it says', async () => {
  test.setTimeout(150_000)

  const media = await serveMedia()
  const site = await servePage('twice.html', media.origin, 'watched.mp4')
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  try {
    await page.goto(site.origin)
    await page.evaluate(() => (window as unknown as { tcPlayBelow: () => Promise<void> }).tcPlayBelow())
    await page.waitForTimeout(WATCH_MS)
    await page.evaluate(() => (window as unknown as { tcPause: () => void }).tcPause())
    await page.waitForTimeout(SETTLE_MS)

    const state = await page.evaluate(() =>
      (window as unknown as { tcState: () => State }).tcState(),
    )

    // The premise. Both copies are on screen, so neither is refused for being out of sight; the
    // one above was never started, and the one below ran past the grace period.
    expect(state.bothOnScreen, 'the two elements did not share a viewport').toBe(true)
    expect(state.above.currentTime, 'the copy above was played after all').toBe(0)
    expect(state.below.currentTime).toBeGreaterThan(6)

    const popup = await openPopupOn(context, page, extensionId)
    await site.close()

    // One file is one session however many elements the page hangs it on.
    await expect(popup.getByTestId('title')).toBeVisible()
    expect(await popup.getByTestId('recent').count(), 'one file came out as two sessions').toBe(0)

    const shown = await popup.getByTestId('duration').textContent()
    const [minutes, seconds] = (shown ?? '0:00').split(':').map(Number)
    const promised = (minutes ?? 0) * 60 + (seconds ?? 0)

    // What the watched element holds, and not the empty account of the idle one.
    const held = state.below.buffered[0]![1]
    expect(promised).toBeGreaterThan(6)
    expect(Math.abs(promised - held)).toBeLessThan(1.5)

    const file = await saveAll(page, popup)
    const probed = probeFile(file)
    const duration = Number(probed.format.duration)

    expect(probed.streams.map((stream) => stream.codec_name)).toEqual(['h264', 'aac'])
    expect(Math.abs(duration - held)).toBeLessThan(1)
    decodeFile(file)

    const played = await playInBrowser(file)
    expect(played.error).toBeNull()
    expect(played.ended, 'the saved file did not play through to its end').toBe(true)
    expect(played.videoBytes).toBeGreaterThan(0)
    expect(played.audioBytes).toBeGreaterThan(0)
  } finally {
    await context.close()
    await media.close()
  }
})
