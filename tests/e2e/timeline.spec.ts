import { test, expect, type Page } from '@playwright/test'
import * as esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const HOST = 'https://tailcut.test/timeline-host'

/** Bundles the stand and serves it under an invented address. Nothing of dist is involved. */
async function openHost(page: Page): Promise<void> {
  const built = await esbuild.build({
    entryPoints: [path.resolve('tests/e2e/page/timeline-host.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'chrome120',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'silent',
  })
  const script = built.outputFiles[0]!.text
  const html = await readFile(path.resolve('tests/e2e/page/timeline-host.html'), 'utf8')

  await page.route(`${HOST}.js`, (route) => route.fulfill({ body: script, contentType: 'text/javascript' }))
  await page.route(HOST, (route) => route.fulfill({ body: html, contentType: 'text/html' }))
  await page.setViewportSize({ width: 1280, height: 700 })
  await page.goto(HOST)
  await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).tcBench))
  // The canvas is only given a width inside a paint, so this is the wait for the first frame —
  // and for the repaint after the host has measured itself.
  await page.waitForFunction(() => (document.querySelector('canvas')?.width ?? 0) > 1000)
}

/** The colour of one CSS pixel of the canvas, as three numbers. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ([px, py]) => {
      const canvas = document.querySelector('canvas')!
      const context = canvas.getContext('2d')!
      const ratio = window.devicePixelRatio || 1
      const data = context.getImageData(Math.round(px! * ratio), Math.round(py! * ratio), 1, 1).data
      return [data[0]!, data[1]!, data[2]!]
    },
    [x, y],
  )
}

const rgb = (hex: string): number[] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))

test('draws the material of the session at first sight', async ({ page }) => {
  await openHost(page)

  // Named rather than indexed: under noUncheckedIndexedAccess a Record hands back `undefined`,
  // and three non-null assertions on the palette would be three chances to read a colour the
  // stand never published.
  const palette = await page.evaluate(
    () => (window as unknown as { tcPalette: { fill: Record<string, string> } }).tcPalette,
  )
  // x = 45 is 6.75 s at the opening zoom: inside the first run, and clear of the zone boundaries
  // (whole seconds) and of the markers (3 s, 17 s, …), both of which paint over a lane.
  expect(await pixel(page, 45, 24 + 16)).toEqual(rgb(palette.fill['run-video']!))
  // The second lane, at the same time.
  expect(await pixel(page, 45, 24 + 48 + 6 + 16)).toEqual(rgb(palette.fill['run-audio']!))
  // The playhead at 61.2 s of 180 across 1200 px.
  expect(await pixel(page, Math.round((61.2 / 180) * 1200), 4)).toEqual(rgb(palette.fill.playhead!))
})

test('lays out and paints three minutes of material well inside a frame', async ({ page }) => {
  await openHost(page)

  const segments = await page.evaluate(() => (window as unknown as Record<string, number>).tcSegments)
  expect(segments).toBeGreaterThan(300)

  const times = await page.evaluate(() => (window as unknown as Record<string, (steps: number) => number[]>).tcBench!(200))
  const sorted = [...times].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!
  console.log(`layout+paint: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`)

  // A frame is 16.7 ms and the timeline is not the only thing in it: the whole of the drawing
  // has to fit in a quarter of it, or a zoom on real material stutters.
  expect(median).toBeLessThan(4)
  expect(p95).toBeLessThan(12)
})
