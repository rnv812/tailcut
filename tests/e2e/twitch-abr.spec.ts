import { test, expect } from '@playwright/test'
import { clickEdit, launchWithExtension, routeLocal } from './helpers'

const PLAYER_URL = 'https://tailcut.test/twitch-abr'

function secondsOf(timecode: string): number {
  const [hours, minutes, seconds] = timecode.split(':').map(Number)
  return (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0)
}

test('plays through a low-high-low ABR switch without skipping the middle', async () => {
  test.setTimeout(90_000)
  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await context.newPage()
    await routeLocal(page, 'player.html', PLAYER_URL)
    await page.goto(PLAYER_URL)
    await page.waitForFunction(() => (window as unknown as { allAppended?: boolean }).allAppended)
    await page.evaluate(async () => {
      const api = window as unknown as {
        tcAppendMore(): Promise<void>
        tcAppendReturn(): Promise<void>
      }
      await api.tcAppendMore()
      await api.tcAppendReturn()
      const video = document.querySelector('video')!
      video.muted = true
      await video.play()
    })
    await page.waitForTimeout(6_000)

    const { editor } = await clickEdit(context, page, extensionId)
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
    await expect(editor.getByTestId('frame-count')).toBeVisible()
    const snapshot = await editor.evaluate(async () => {
      const id = new URL(location.href).searchParams.get('s')!
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('snapshots')
      const file = await (await dir.getFileHandle(`${id}.tcs`)).getFile()
      const tail = new Uint8Array(await file.slice(file.size - 32).arrayBuffer())
      const view = new DataView(tail.buffer)
      const at = Number(view.getBigUint64(8, true))
      const length = Number(view.getBigUint64(16, true))
      const index = JSON.parse(await file.slice(at, at + length).text()) as {
        tracks: Array<{ id: string; bufferId: string; representation: string; chunks: unknown[] }>
      }
      return index.tracks.map((track) => ({
        id: track.id,
        bufferId: track.bufferId,
        representation: track.representation,
        chunks: track.chunks.length,
      }))
    })
    expect(snapshot).toHaveLength(2)
    expect(new Set(snapshot.map((track) => track.bufferId)).size).toBe(1)
    expect(new Set(snapshot.map((track) => track.representation)).size).toBe(2)
    expect(snapshot.map((track) => track.chunks).sort((a, b) => a - b)).toEqual([1, 4])
    await expect(editor.getByTestId('frame-count')).toHaveText('204')

    const played = await editor.evaluate(async () => {
      const play = document.querySelector<HTMLButtonElement>('[data-testid="play"]')!
      const readout = document.querySelector<HTMLElement>('[data-testid="timecode"]')!
      const values: Array<{ wall: number; timecode: string }> = []
      play.click()
      await new Promise<void>((resolve, reject) => {
        const started = performance.now()
        const timeout = window.setTimeout(() => reject(new Error('monitor did not finish')), 16_000)
        const sample = (): void => {
          values.push({ wall: performance.now() - started, timecode: readout.textContent ?? '' })
          if (readout.textContent?.startsWith('00:00:11:')) {
            window.clearTimeout(timeout)
            resolve()
          } else {
            window.setTimeout(sample, 50)
          }
        }
        sample()
      })
      return values
    })

    const times = played.map((sample) => secondsOf(sample.timecode))
    const jumps = times.slice(1).filter((time, at) => time - times[at]! > 1)
    expect(jumps, `source-time jumps: ${JSON.stringify(jumps)}`).toEqual([])
    expect(played.at(-1)!.wall).toBeGreaterThan(9_000)
  } finally {
    await context.close()
  }
})
