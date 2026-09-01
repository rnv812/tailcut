import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  clickEdit,
  frameTimes,
  launchWithExtension,
  routeLocal,
} from './helpers'

const PLAYER_URL = 'https://tailcut.test/youtube-gap'

/** Largest distance between adjacent timestamps. */
function widestStep(times: number[]): number {
  let widest = 0
  for (let index = 1; index < times.length; index++) {
    widest = Math.max(widest, times[index]! - times[index - 1]!)
  }
  return widest
}

type Packet = { pts_time: string; data_hash: string }

/** Coded packet identity and clock, so the post-gap content is compared rather than its index. */
function packets(file: string, stream: 'v' | 'a'): Array<{ pts: number; hash: string }> {
  const result = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', stream,
      '-show_packets',
      '-show_entries', 'packet=pts_time,data_hash',
      '-show_data_hash', 'md5',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return (JSON.parse(result.stdout).packets as Packet[]).map((packet) => ({
    pts: Number(packet.pts_time),
    hash: packet.data_hash,
  }))
}

const fixture = (relative: string): string => path.resolve('tests/fixtures', relative)
const concatenated = (...files: string[]): string => `concat:${files.map(fixture).join('|')}`

async function checkResume(soundShift: number): Promise<void> {
  test.setTimeout(90_000)
  const { context, extensionId } = await launchWithExtension()

  try {
    const player = await context.newPage()
    await routeLocal(player, 'youtube-gap.html', `${PLAYER_URL}*`)
    await player.goto(`${PLAYER_URL}?soundShift=${soundShift}`)

    const unsupported = await player.evaluate(
      () => !MediaSource.isTypeSupported('video/mp4; codecs="av01.0.00M.08"'),
    )
    test.skip(unsupported, 'this browser has no AV1 MSE support')

    await player.waitForFunction(
      () => (window as unknown as { allAppended?: boolean }).allAppended === true,
      undefined,
      { timeout: 15_000 },
    )
    expect(
      await player.evaluate(() => (window as unknown as { failure?: string | null }).failure),
    ).toBeNull()
    await player.evaluate(() => document.querySelector('video')!.play())
    await player.waitForTimeout(7_000)

    const { editor } = await clickEdit(context, player, extensionId)
    await expect(editor.getByTestId('gaps')).toHaveText('1 gap')
    await expect(editor.getByTestId('frame-count')).toHaveText('40')
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)

    // Play the actual editor blob across the seam before inspecting it off disk. Packet tables
    // alone can stay internally consistent while a browser stalls or seeks at the join.
    const played = await editor.evaluate(async () => {
      const video = document.querySelector('video')!
      const times: number[] = []
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('preview did not finish')), 10_000)
        const collect = (_now: number, metadata: { mediaTime: number }): void => {
          times.push(metadata.mediaTime)
          if (metadata.mediaTime >= 3.8) {
            window.clearTimeout(timeout)
            resolve()
          } else {
            video.requestVideoFrameCallback(collect)
          }
        }
        video.requestVideoFrameCallback(collect)
        void video.play()
      })
      return times
    })
    expect(played.length).toBeGreaterThan(30)
    expect(widestStep(played)).toBeLessThan(0.15)

    const [download] = await Promise.all([
      editor.waitForEvent('download'),
      editor.evaluate(() => {
        const link = document.createElement('a')
        link.href = document.querySelector('video')!.src
        link.download = 'youtube-gap-preview.mp4'
        link.click()
      }),
    ])
    const file = await download.path()
    expect(file).not.toBeNull()

    const picture = frameTimes(file!, 'v')
    const sound = frameTimes(file!, 'a')
    expect(picture).toHaveLength(40)
    expect(sound.length).toBeGreaterThanOrEqual(190)

    // Match the first post-seek coded units by their bytes, not by an assumed packet count. Opus
    // carries preroll at the head of its WebM segment, so a fixed index can point to warm-up and
    // let a shifted content seam pass. Copying into MP4 preserves both AV1 and Opus packet bytes.
    const sourcePicture = packets(
      concatenated('av1/init-stream0.m4s', 'av1/chunk-stream0-00003.m4s'),
      'v',
    ).find((packet) => packet.pts >= 4)!
    const sourceSounds = packets(
      concatenated(
        'webm/init-stream1.webm',
        'webm/chunk-stream1-00003.webm',
        'webm/chunk-stream1-00004.webm',
      ),
      'a',
    )
    // An early tail contains prefetched packets which precede the resumed picture and were never
    // heard after the player's seek. The first packet at the picture boundary is the first one
    // that should remain. A late tail has no such packets, so its first packet is the boundary.
    const sourceSound = sourceSounds.find((packet) => packet.pts + soundShift >= 4)!
    const outputPicture = packets(file!, 'v').find(
      (packet) => packet.hash === sourcePicture.hash,
    )!
    const outputSound = packets(file!, 'a').find((packet) => packet.hash === sourceSound.hash)!
    expect(outputPicture, 'the first AV1 packet after the seek is absent').toBeDefined()
    expect(outputSound, 'the first audible Opus packet after the seek is absent').toBeDefined()
    expect(Math.abs(outputPicture.pts - outputSound.pts)).toBeLessThan(0.03)

    // No two-second hole remains in either output clock.
    expect(widestStep(picture)).toBeLessThan(0.15)
    expect(widestStep(sound)).toBeLessThan(0.05)
  } finally {
    await context.close()
  }
}

test('aligns Opus prefetched before the first AV1 picture after a gap', async () => {
  await checkResume(-0.2)
})

test('aligns Opus that resumes after the first AV1 picture following a gap', async () => {
  await checkResume(0.2)
})
