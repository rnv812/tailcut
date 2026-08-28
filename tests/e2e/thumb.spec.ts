import { test, expect, type Page } from '@playwright/test'
import * as esbuild from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'

const HOST = 'https://tailcut.test/thumb-host'

async function openHost(page: Page): Promise<void> {
  const built = await esbuild.build({
    entryPoints: [path.resolve('tests/e2e/page/thumb-host.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'chrome120',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'silent',
  })
  const html = await fs.readFile(path.resolve('tests/e2e/page/thumb-host.html'), 'utf8')

  await page.route('**/fixtures/**', async (route) => {
    const rel = new URL(route.request().url()).pathname.replace('/fixtures/', '')
    await route.fulfill({
      body: await fs.readFile(path.resolve('tests/fixtures', rel)),
      contentType: 'application/octet-stream',
    })
  })
  await page.route(`${HOST}.js`, (route) =>
    route.fulfill({ body: built.outputFiles[0]!.text, contentType: 'text/javascript' }),
  )
  await page.route(HOST, (route) => route.fulfill({ body: html, contentType: 'text/html' }))

  await page.setViewportSize({ width: 1_280, height: 600 })
  await page.goto(HOST)
  await page.waitForFunction(() => (window as unknown as { tcReady(): boolean }).tcReady())
  await page.waitForFunction(() => (document.querySelector('canvas')?.width ?? 0) > 500)
}

/** The box, the canvas of it and the two numbers the test reads. */
const thumb = (page: Page) => page.locator('[data-testid="thumb"]')
const shot = (page: Page) => page.locator('[data-testid="thumb-shot"]')
const seeks = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { tcSeeks(): number }).tcSeeks())
const colours = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { tcShot(): number }).tcShot())
const reports = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { tcReports(): number }).tcReports())
const sweep = (page: Page, from: number, to: number, count: number): Promise<void> =>
  page.evaluate(
    ([a, b, n]) => (window as unknown as { tcSweep(a: number, b: number, n: number): void }).tcSweep(a!, b!, n!),
    [from, to, count],
  )

/** The strip is the first canvas of the page; the box sits above it. */
async function moveTo(page: Page, x: number): Promise<void> {
  const box = (await page.locator('canvas').first().boundingBox())!
  await page.mouse.move(box.x + x, box.y + 30)
}

/**
 * The box, showing the decoded frame of that timecode.
 *
 * Both halves are read in one evaluation, and that is the point of the helper. Asked one after
 * the other they answer about two different moments: `data-exact` is still `yes` from the frame
 * the pointer has just left while the timecode already names the frame it has arrived at, and a
 * test that reads it then measures the previous stop.
 */
const settled = (page: Page, timecode: string): Promise<unknown> =>
  page.waitForFunction(
    (want) =>
      document.querySelector('[data-testid="thumb-time"]')?.textContent === want &&
      document.querySelector('[data-testid="thumb-shot"]')?.getAttribute('data-exact') === 'yes',
    timecode,
    { timeout: 5_000 },
  )

test('shows the frame under the pointer with its timecode', async ({ page }) => {
  await openHost(page)
  await expect(thumb(page)).toBeHidden()

  // Six seconds across a thousand pixels: 500 px is three seconds in, frame 72 of 24 fps material.
  await moveTo(page, 500)
  await expect(thumb(page)).toBeVisible()
  await expect(page.locator('[data-testid="thumb-time"]')).toHaveText('00:00:03:00')

  await settled(page, '00:00:03:00')
  // A decoded frame of the test pattern is many colours; an empty canvas is one.
  expect(await colours(page)).toBeGreaterThan(8)
  // And it is the shape of the material and not a guess: the fixture is 320x240, so 168 px wide
  // is 126 px tall. A box left at the 16:9 it opens with squashes every frame it ever shows.
  await expect(shot(page)).toHaveAttribute('height', '126')
})

test('drops the positions a sweep passes over instead of asking for each of them', async ({ page }) => {
  await openHost(page)
  await moveTo(page, 100)
  await settled(page, '00:00:00:14')
  const wasSeeks = await seeks(page)
  const wasReports = await reports(page)

  // A hundred positions across the strip, delivered inside one turn — see tcSweep for why the
  // driver cannot deliver them that way. A hundred reports would be a hundred renders of the
  // editor, and the first of them would send the element to 0.7 s while the hand is at 5.4.
  await sweep(page, 120, 900, 100)
  // And the position that survived the frame is the last of them: 900 px is 5.4 s, frame 129.
  await settled(page, '00:00:05:09')

  expect(await reports(page) - wasReports).toBe(1)
  // One, and not the two an unthrottled burst costs: the first position of it would be asked for
  // before the last one arrived, and the last would then wait for that seek to land.
  expect(await seeks(page) - wasSeeks).toBe(1)
})

test('costs nothing to come back to a frame already seen', async ({ page }) => {
  await openHost(page)
  await moveTo(page, 300)
  await settled(page, '00:00:01:19')
  await moveTo(page, 700)
  await settled(page, '00:00:04:04')
  const before = await seeks(page)

  await moveTo(page, 300)
  await settled(page, '00:00:01:19')

  // The count is written to the element when a picture lands, so "no seek" cannot be read off it
  // the moment the box lights up: a seek issued a moment ago has not been counted yet either, and
  // a source that had asked for the frame all over again would read the same number here. So one
  // more frame is asked for, one nobody has seen, and the count is read when that one arrives —
  // by which time a seek for the frame already in hand would have landed as well.
  await moveTo(page, 500)
  await settled(page, '00:00:03:00')
  expect(await seeks(page)).toBe(before + 1)
})

test('gets out of the way when the pointer leaves the strip', async ({ page }) => {
  await openHost(page)
  await moveTo(page, 400)
  await expect(thumb(page)).toBeVisible()

  await page.mouse.move(10, 10)
  await expect(thumb(page)).toBeHidden()
})
