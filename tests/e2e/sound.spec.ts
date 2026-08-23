import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { launchWithExtension, serveLocal } from './helpers'

const PLAYER_URL = 'https://tailcut.test/two-track'

/**
 * How long the player has to run for triage to let it through the probation period
 * (BALANCED.gracePeriodSeconds = 6). A second of slack for the polling of the watcher.
 */
const PLAY_MS = 7_000

type PageState = { allAppended?: boolean; failure?: string | null }

interface Probed {
  format: { duration: string }
  streams: Array<{ codec_type: string; codec_name: string; nb_read_frames: string }>
}

/**
 * The whole path end to end: a page with a picture buffer and a sound buffer, the hook, the
 * bridge, the registry, the muxer, and a file on disk that ffprobe agrees is a film with sound.
 * Every part of it is under a test of its own; this one is here because the parts have already
 * been fitted together wrongly once — the moov of one track over the fragments of both.
 */
test('the saved file carries both tracks of the page', async () => {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()
  await serveLocal(page, 'two-track.html', PLAYER_URL)

  await page.waitForFunction(
    () => {
      const state = window as unknown as PageState
      return state.allAppended === true || state.failure != null
    },
    undefined,
    { timeout: 15_000 },
  )
  expect(await page.evaluate(() => (window as unknown as PageState).failure ?? null)).toBeNull()

  await page.evaluate(() => document.querySelector('video')!.play())
  await page.waitForTimeout(PLAY_MS)

  // The popup asks the active tab, so the player has to stay the active one: opened as an
  // ordinary tab, the popup would be asking itself.
  const popup = await context.newPage()
  await page.bringToFront()
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`)

  // Picture 0…6, sound 0…6.0232: six seconds is what both tracks cover at once.
  await expect(popup.getByTestId('duration')).toHaveText('0:06')

  // The download is started by the bridge — the extension frame inside the player tab.
  const started = page.waitForEvent('download')
  await popup.getByRole('button', { name: 'Save all' }).click()
  const file = await (await started).path()

  const probe = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-count_frames',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,nb_read_frames',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )

  expect(probe.error).toBeUndefined()
  expect(probe.status, probe.stderr).toBe(0)
  expect(probe.stderr, 'ffprobe complains about reading the saved file').toBe('')

  const probed = JSON.parse(probe.stdout) as Probed

  expect(probed.streams.map((stream) => [stream.codec_type, stream.codec_name])).toEqual([
    ['video', 'h264'],
    ['audio', 'aac'],
  ])
  // Everything the page loaded, both tracks whole: 144 frames of picture at 24 a second and 260
  // frames of sound of 1024 samples each at 44100.
  expect(probed.streams.map((stream) => Number(stream.nb_read_frames))).toEqual([144, 260])

  const seconds = Number(probed.format.duration)
  expect(seconds).toBeGreaterThan(5.9)
  expect(seconds).toBeLessThan(6.1)

  await context.close()
})
