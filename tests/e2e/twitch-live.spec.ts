import { test, expect } from '@playwright/test'
import { clickEdit, launchWithExtension, openPopupOn } from './helpers'

const LIVE = process.env.TAILCUT_TWITCH_LIVE === '1'
const URL = process.env.TAILCUT_TWITCH_URL ?? 'https://www.twitch.tv/bratishkinoff'

test('records and plays a real Twitch stream without timeline jumps', async () => {
  test.skip(!LIVE, 'live Twitch is diagnostic and opt-in')
  test.setTimeout(180_000)

  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()
  const messages: string[] = []
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`))

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const video = page.locator('video').first()
    await video.waitFor({ state: 'attached', timeout: 60_000 })
    await video.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true
      await element.play().catch(() => {})
    })
    await page.waitForTimeout(30_000)

    const sourceState = await video.evaluate((element: HTMLVideoElement) => ({
      currentTime: element.currentTime,
      duration: element.duration,
      paused: element.paused,
      readyState: element.readyState,
      buffered: Array.from({ length: element.buffered.length }, (_, index) => [
        element.buffered.start(index),
        element.buffered.end(index),
      ]),
    }))
    console.log(`Twitch source: ${JSON.stringify(sourceState)}`)

    const popup = await openPopupOn(context, page, extensionId)
    console.log(`Twitch popup: ${(await popup.locator('body').innerText()).slice(0, 2_000)}`)
    await popup.close()

    const { editor } = await clickEdit(context, page, extensionId)
    await expect(editor.getByTestId('frame-count')).toBeVisible({ timeout: 60_000 })
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
    console.log(
      `Twitch editor: duration=${await editor.getByTestId('duration').innerText()} ` +
        `gaps=${await editor.getByTestId('gaps').innerText()} ` +
        `frames=${await editor.getByTestId('frame-count').innerText()}`,
    )

    await editor.evaluate(() => {
      const state = window as unknown as {
        tcTwitchFrames?: Array<{ wall: number; media: number; current: number; frame: number }>
      }
      const video = document.querySelector('video')!
      state.tcTwitchFrames = []
      const collect = (wall: number, metadata: VideoFrameCallbackMetadata): void => {
        state.tcTwitchFrames!.push({
          wall,
          media: metadata.mediaTime,
          current: video.currentTime,
          frame: Number(document.querySelector('[data-testid="frame"]')?.textContent),
        })
        if (state.tcTwitchFrames!.length < 600) video.requestVideoFrameCallback(collect)
      }
      video.requestVideoFrameCallback(collect)
    })
    await editor.getByTestId('play').click()
    await editor.waitForTimeout(12_000)

    const played = await editor.evaluate(
      () =>
        (window as unknown as {
          tcTwitchFrames: Array<{ wall: number; media: number; current: number; frame: number }>
        }).tcTwitchFrames,
    )
    const clockJumps = played.slice(1).flatMap((sample, index) => {
      const previous = played[index]!
      const wall = (sample.wall - previous.wall) / 1_000
      const media = sample.media - previous.media
      const current = sample.current - previous.current
      return media - wall > 0.15 || media < 0 || current - wall > 0.15 || current < 0
        ? [{ index: index + 1, wall, media, current }]
        : []
    })
    const caretJumps = played.slice(1).flatMap((sample, index) => {
      const previous = played[index]!
      const media = sample.media - previous.media
      const frames = sample.frame - previous.frame
      // A delayed callback advances both clocks. The original Twitch defect instead advanced the
      // source-frame caret by almost a GOP while the monitor clock moved less than 250 ms.
      return Number.isFinite(frames) && frames > 30 && media < 0.25
        ? [{ index: index + 1, media, frames }]
        : []
    })
    console.log(`Twitch preview clock jumps: ${JSON.stringify(clockJumps.slice(0, 30))}`)
    console.log(`Twitch preview caret jumps: ${JSON.stringify(caretJumps.slice(0, 30))}`)
    expect(clockJumps).toEqual([])
    expect(caretJumps).toEqual([])
  } catch (cause) {
    console.log(`Twitch page console: ${messages.slice(-50).join('\n')}`)
    throw cause
  } finally {
    await context.close()
  }
})
