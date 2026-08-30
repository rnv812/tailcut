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
  // The playhead is a DOM line so a presented video frame moves it immediately, without waiting
  // behind the canvas repaint used for the static lanes and ruler.
  const [canvas, playhead] = await Promise.all([
    page.locator('canvas').boundingBox(),
    page.locator('[data-testid="timeline-playhead"]').boundingBox(),
  ])
  const playheadX = await page.evaluate(() =>
    (window as unknown as Stand & { tcXAt: (time: number) => number }).tcXAt(61.2),
  )
  expect(canvas).not.toBeNull()
  expect(playhead).not.toBeNull()
  expect(Math.abs(playhead!.x - (canvas!.x + playheadX))).toBeLessThan(1.5)
  expect(playhead!.width).toBeCloseTo(1, 1)
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

test('measures the drawing area once on mount, and again only when it changes', async ({ page }) => {
  await openHost(page)
  const reported = () => page.evaluate(() => (window as unknown as { tcResizes: number[] }).tcResizes)

  // One report and not two. The component measures its host when the effect runs and then hands
  // the host to a ResizeObserver, which answers immediately with the size it already has; the
  // second answer is the same width, and passing it on is a render of the whole editor for a
  // screen that did not change. This is where that can be seen at all — happy-dom's observer
  // never calls back, so the unit test has to stage the observation this browser really makes.
  expect(await reported()).toHaveLength(1)

  await page.setViewportSize({ width: 900, height: 700 })
  await page.waitForFunction(() => (window as unknown as { tcResizes: number[] }).tcResizes.length > 1)

  // And a width that really changed is passed on — once.
  const widths = await reported()
  expect(widths).toHaveLength(2)
  expect(widths[1]).toBeLessThan(widths[0]!)
})

/** The window the stand exposes for the test to read and to drive. */
type View = { start: number; scale: number; widthPx: number }
type Stand = {
  tcView: () => View
  tcSetView: (view: View) => void
  tcTimeAt: (x: number) => number
}

test('Alt plus a wheel notch leaves the time under the pointer where it was', async ({ page }) => {
  await openHost(page)
  const box = (await page.locator('canvas').boundingBox())!

  await page.mouse.move(box.x + 400, box.y + 60)
  const before = await page.evaluate(() => (window as unknown as Stand).tcTimeAt(400))
  const scaleBefore = await page.evaluate(() => (window as unknown as Stand).tcView().scale)

  await page.keyboard.down('Alt')
  await page.mouse.wheel(0, -240)
  await page.keyboard.up('Alt')
  await page.waitForFunction(
    (was) => (window as unknown as Stand).tcView().scale < was,
    scaleBefore,
  )

  const after = await page.evaluate(() => (window as unknown as Stand).tcTimeAt(400))
  expect(Math.abs(after - before)).toBeLessThan(0.005)
})

test('a vertical wheel pans horizontally through time', async ({ page }) => {
  await openHost(page)
  const box = (await page.locator('canvas').boundingBox())!

  await page.evaluate(() => {
    const stand = window as unknown as Stand
    stand.tcSetView({ ...stand.tcView(), start: 20, scale: 0.05 })
  })
  await page.waitForFunction(() => (window as unknown as Stand).tcView().scale === 0.05)
  const before = await page.evaluate(() => (window as unknown as Stand).tcView())

  await page.mouse.move(box.x + 400, box.y + 60)
  await page.mouse.wheel(0, 120)
  await page.waitForFunction(
    (start) => (window as unknown as Stand).tcView().start > start,
    before.start,
  )

  const after = await page.evaluate(() => (window as unknown as Stand).tcView())
  expect(after.start).toBeCloseTo(before.start + 120 * before.scale, 3)
})

test('dragging the material moves it under the hand', async ({ page }) => {
  await openHost(page)
  const box = (await page.locator('canvas').boundingBox())!

  // Zoomed in first: at the opening zoom the whole material is on the screen and there is
  // nowhere to pan to, which is the clamp doing its job and not a drag failing.
  await page.evaluate(() => {
    const stand = window as unknown as Stand
    stand.tcSetView({ ...stand.tcView(), start: 20, scale: 0.05 })
  })
  await page.waitForFunction(() => (window as unknown as Stand).tcView().scale === 0.05)

  const before = await page.evaluate(() => (window as unknown as Stand).tcView())

  await page.mouse.move(box.x + 400, box.y + 60)
  await page.mouse.down()
  await page.mouse.move(box.x + 300, box.y + 60, { steps: 4 })
  await page.mouse.up()

  const after = await page.evaluate(() => (window as unknown as Stand).tcView())
  expect(after.start).toBeCloseTo(before.start + 100 * before.scale, 3)
})

type Handles = {
  tcClips: () => { id: string; in: number; out: number }[]
  tcXAt: (time: number) => number
  tcHandle: (id: string, edge: 'in' | 'out') => { x: number; y: number }
}

/** Drags the given handle of the given clip to the given time and returns the clip afterwards. */
async function dragHandle(
  page: Page,
  id: string,
  edge: 'in' | 'out',
  toTime: number,
  modifier?: 'Alt',
): Promise<{ id: string; in: number; out: number }> {
  const box = (await page.locator('canvas').boundingBox())!
  const from = await page.evaluate(
    ([clip, side]) => (window as unknown as Handles).tcHandle(clip as string, side as 'in' | 'out'),
    [id, edge],
  )
  const x = await page.evaluate((time) => (window as unknown as Handles).tcXAt(time), toTime)

  await page.mouse.move(box.x + from.x, box.y + from.y)
  await page.mouse.down()
  if (modifier) await page.keyboard.down(modifier)
  await page.mouse.move(box.x + x, box.y + from.y, { steps: 4 })
  await page.mouse.up()
  if (modifier) await page.keyboard.up(modifier)

  return page.evaluate(
    (clip) => (window as unknown as Handles).tcClips().find((candidate) => candidate.id === clip)!,
    id,
  )
}

test('the out handle catches the edge of the hole it was dragged near', async ({ page }) => {
  await openHost(page)

  const clip = await dragHandle(page, 'c3', 'out', 31.95)

  // 32 s is where the recording of the stand stops for two seconds. A hole is the one edge a cut
  // must not cross, so it wins the tie against the zone that ends at the same instant, and it
  // beats the keyframe at 31.52 by being nearer.
  expect(clip.out).toBeCloseTo(32, 6)
})

test('the out handle catches a keyframe standing clear of the edges of the material', async ({ page }) => {
  await openHost(page)

  // 27.52 s is a keyframe of the stand and nothing else: the nearest hole is four and a half
  // seconds away, the zone boundaries either side of it are half a second off, and the in point
  // of the next clip stands on one of them. Drag onto it and the keyframe is what is caught —
  // which the branch that looks for keyframes is the only thing that can do. Without it the
  // handle lands on the zone boundary at 28 instead.
  const clip = await dragHandle(page, 'c3', 'out', 27.52)

  expect(clip.out).toBeCloseTo(27.52, 6)
})

test('alt lets the handle go where it likes, but still on a frame', async ({ page }) => {
  await openHost(page)

  const clip = await dragHandle(page, 'c3', 'out', 31.95, 'Alt')

  // It went, and it went where the hand was: a handle that never moved is also a handle that
  // never caught the edge of the hole, and that is not what this test is asking about. The
  // nearest frame to 31.95 is 31.96, which is not 32 and is not where the hand was either — a
  // free handle still lands on a frame.
  expect(clip.out).toBeGreaterThan(31.5)
  expect(Math.abs(clip.out - 32)).toBeGreaterThan(0.001)
  expect(Math.abs(clip.out * 25 - Math.round(clip.out * 25))).toBeLessThan(1e-6)
})
