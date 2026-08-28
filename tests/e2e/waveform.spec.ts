import { test, expect, type Page } from '@playwright/test'
import * as esbuild from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'

const HOST = 'https://tailcut.test/waveform-host'

interface Piece {
  start: number
  buckets: number
  loudest: number
}
interface Reported {
  covered: number
  done: boolean
  refused: boolean
  pieces: Piece[]
}

const bundle = async (entry: string, format: 'iife'): Promise<string> => {
  const built = await esbuild.build({
    entryPoints: [path.resolve(entry)],
    bundle: true,
    write: false,
    format,
    target: 'chrome120',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'silent',
  })
  return built.outputFiles[0]!.text
}

/** The stand, its worker and the fixtures, all under one invented origin. */
async function openHost(page: Page): Promise<void> {
  const host = await bundle('tests/e2e/page/waveform-host.tsx', 'iife')
  const worker = await bundle('src/editor/source/waveform-worker.ts', 'iife')
  const html = await fs.readFile(path.resolve('tests/e2e/page/waveform-host.html'), 'utf8')

  await page.route('**/fixtures/**', async (route) => {
    const rel = new URL(route.request().url()).pathname.replace('/fixtures/', '')
    await route.fulfill({
      body: await fs.readFile(path.resolve('tests/fixtures', rel)),
      contentType: 'application/octet-stream',
    })
  })
  await page.route(`${HOST}-worker.js`, (route) =>
    route.fulfill({ body: worker, contentType: 'text/javascript' }),
  )
  await page.route(`${HOST}.js`, (route) =>
    route.fulfill({ body: host, contentType: 'text/javascript' }),
  )
  await page.route(HOST, (route) => route.fulfill({ body: html, contentType: 'text/html' }))

  await page.setViewportSize({ width: 1280, height: 600 })
  await page.goto(HOST)
  await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).tcStart))
}

const start = (page: Page, kind: string, drop: number[] = []): Promise<void> =>
  page.evaluate(
    ([k, d]) => (window as unknown as { tcStart(kind: string, drop: number[]): Promise<void> }).tcStart(k as string, d as number[]),
    [kind, drop],
  )

const wave = (page: Page): Promise<Reported | null> =>
  page.evaluate(() => (window as unknown as { tcWave(): Reported | null }).tcWave())

const settled = async (page: Page): Promise<Reported> => {
  await page.waitForFunction(
    () => (window as unknown as { tcWave(): Reported | null }).tcWave()?.done === true,
    undefined,
    { timeout: 20_000 },
  )
  return (await wave(page))!
}

test('reads the sound of a captured minute, slice by slice', async ({ page }) => {
  await openHost(page)
  await start(page, 'aac')

  // The wave shows up long before it is finished: that is the whole point of the slicing.
  await page.waitForFunction(
    () => ((window as unknown as { tcWave(): Reported | null }).tcWave()?.covered ?? 0) > 0,
    undefined,
    { timeout: 5_000 },
  )
  const partial = (await wave(page))!
  expect(partial.done).toBe(false)

  const done = await settled(page)
  expect(done.refused).toBe(false)
  expect(done.pieces).toHaveLength(1)
  // A minute of a 440 Hz tone: sixty seconds of buckets, and the loudest of them is the loudest
  // of the material. The fixture is not at full scale — ffmpeg puts its peak at −17.9 dBFS, which
  // is 16 of 127 — and both sides of that are pinned on purpose. The decode has to reproduce the
  // amplitude of what was recorded and not merely produce something: a guessed configuration
  // decodes thousands of frames, reports no error and correlates with the source at 0.037, and
  // what it puts out sits on the floor.
  expect(done.pieces[0]!.buckets).toBeGreaterThan(5_900)
  expect(done.pieces[0]!.loudest).toBeGreaterThanOrEqual(15)
  expect(done.pieces[0]!.loudest).toBeLessThanOrEqual(18)
  expect(done.covered).toBeGreaterThan(59)

  // More than one report: the interface was given something to draw before the reading ended.
  expect(await page.evaluate(() => (window as unknown as { tcSlices(): number }).tcSlices())).toBeGreaterThan(2)
})

test('leaves a hole in the material as a hole in the wave', async ({ page }) => {
  await openHost(page)
  // Segments five and six thrown away: twenty to thirty seconds were never watched.
  await start(page, 'aac', [5, 6])

  const done = await settled(page)
  expect(done.pieces).toHaveLength(2)
  expect(done.pieces[0]!.start).toBe(0)
  expect(done.pieces[0]!.buckets).toBeLessThan(2_100)
  expect(done.pieces[1]!.start).toBeGreaterThan(29)
})

test('reads Opus that came in through WebM', async ({ page }) => {
  await openHost(page)
  await start(page, 'opus')

  const done = await settled(page)
  expect(done.refused).toBe(false)
  // −20.6 dBFS on this fixture by ffmpeg's reckoning, which is 12 of 127. Pinned both ways for
  // the reason the AAC test states, and for one more: Opus handed no description decodes without
  // complaint and without applying its pre-skip.
  expect(done.pieces[0]!.loudest).toBeGreaterThanOrEqual(11)
  expect(done.pieces[0]!.loudest).toBeLessThanOrEqual(14)
  expect(done.covered).toBeGreaterThan(5)
})

test('draws the wave over the sound lane', async ({ page }) => {
  await openHost(page)
  await start(page, 'aac')
  await settled(page)
  await page.waitForTimeout(50)

  const found = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const context = canvas.getContext('2d')!
    const palette = (window as unknown as { tcPalette: { wave: string } }).tcPalette
    const want = [1, 3, 5].map((at) => parseInt(palette.wave.slice(at, at + 2), 16))
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data

    for (let at = 0; at < data.length; at += 4) {
      if (data[at] === want[0] && data[at + 1] === want[1] && data[at + 2] === want[2]) return true
    }
    return false
  })

  expect(found).toBe(true)
})

test('keeps the interface answering while it reads', async ({ page }) => {
  await openHost(page)
  const measured = page.evaluate(() => (window as unknown as { tcJitter(ms: number): Promise<number> }).tcJitter(1_500))
  await start(page, 'aac')

  // Measured at eighteen milliseconds — one frame. A hundred is a wide margin for a loaded
  // machine, and a failure here means the decoding has moved back onto the main thread.
  expect(await measured).toBeLessThan(100)
})

test('has nothing to draw and no complaint when the recording has no sound', async ({ page }) => {
  await openHost(page)
  await start(page, 'silent')

  const done = await settled(page)
  expect(done.pieces).toEqual([])
  expect(done.refused).toBe(false)
  // No sound lane at all: the timeline is a lane shorter, not a lane with an empty wave in it.
  expect(await page.evaluate(() => (window as unknown as { tcLanes(): string[] }).tcLanes())).toEqual([
    'video',
  ])
})
