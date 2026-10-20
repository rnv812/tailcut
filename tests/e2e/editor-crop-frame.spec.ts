import { test, expect } from '@playwright/test'
import { clickEdit, recordPlayer } from './helpers'

test('keeps the crop overlay on the coded picture and off the transport', async () => {
  test.setTimeout(120_000)
  const { context, player, extensionId } = await recordPlayer(
    'editor-host.html',
    'https://tailcut.test/crop-frame',
  )

  try {
    const { editor } = await clickEdit(context, player, extensionId)
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
    await editor.keyboard.press('i')
    await expect(editor.getByTestId('crop-host')).toBeVisible()

    const boxes = await editor.evaluate(() => {
      const rect = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      }
      return { video: rect('video'), crop: rect('[data-testid="crop-host"]') }
    })

    // The overlay used to cover the whole 980×396 player slot while this fixture's picture was
    // 320×240 inside it. A drag then multiplied screen movement by the wrong scale and included
    // the transport in the crop. Equality of all four sides holds the coordinate system itself.
    expect(boxes.crop).toEqual(boxes.video)
  } finally {
    await context.close()
  }
})

test('asks the encoder about a crop dragged thirty times in a row once, not thirty times', async () => {
  // `isConfigSupported` is not a lookup in Chromium: a software H.264 question builds and
  // initializes a real OpenH264 encoder to answer it. Forty of those in flight at 1080p took the
  // renderer from 34 MB to 845 MB. So what is counted here is the questions themselves, and how
  // many of them were open at once, while the frame is pulled to thirty different sizes.
  test.setTimeout(120_000)
  const { context, player, extensionId } = await recordPlayer(
    'editor-host.html',
    'https://tailcut.test/crop-storm',
  )

  try {
    const { editor } = await clickEdit(context, player, extensionId)
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
    await editor.keyboard.press('i')
    await expect(editor.getByTestId('crop-host')).toBeVisible()

    // Wrapped in place: the probe looks the function up on every question, so a wrapper put on
    // after the tab opened still sees every one of them. Each answer is held back a quarter of a
    // second, which is about what building a 1080p software encoder costs; this fixture is
    // 320×240, and its answers come back before the next drag has even started.
    await editor.evaluate(() => {
      const counted = window as unknown as { tcAsked: string[]; tcOpen: number; tcPeak: number }
      counted.tcAsked = []
      counted.tcOpen = 0
      counted.tcPeak = 0
      const original = VideoEncoder.isConfigSupported.bind(VideoEncoder)
      VideoEncoder.isConfigSupported = async (config: VideoEncoderConfig) => {
        counted.tcAsked.push(`${config.width}x${config.height}`)
        counted.tcOpen += 1
        counted.tcPeak = Math.max(counted.tcPeak, counted.tcOpen)
        try {
          const answer = await original(config)
          await new Promise((done) => setTimeout(done, 250))
          return answer
        } finally {
          counted.tcOpen -= 1
        }
      }
    })

    const drags = 30
    const report = async (what: string) => {
      await expect(editor.getByTestId('export-selected')).toBeEnabled()
      // Long enough for any question still queued behind the drags to have been asked.
      await editor.waitForTimeout(1_500)
      const asked = await editor.evaluate(() => {
        const counted = window as unknown as { tcAsked: string[]; tcPeak: number }
        const seen = { asked: counted.tcAsked, peak: counted.tcPeak }
        counted.tcAsked = []
        counted.tcPeak = 0
        return seen
      })
      console.log(
        `crop storm, ${what}: ${asked.asked.length} questions over ` +
          `${new Set(asked.asked).size} sizes, ${asked.peak} open at once`,
      )
      return { sizes: new Set(asked.asked).size, peak: asked.peak }
    }

    // Thirty drags by the real pointer. How many of them settle depends on how fast this machine
    // turns a drag round — under parallel workers a CDP round trip alone can outlast the settle
    // delay — so the claim here is the one that holds at any speed: one question open at a time.
    for (let at = 0; at < drags; at++) {
      const handle = (await editor.getByTestId('crop-handle-se').boundingBox())!
      const x = handle.x + handle.width / 2
      const y = handle.y + handle.height / 2
      await editor.mouse.move(x, y)
      await editor.mouse.down()
      await editor.mouse.move(x - 3, y - 2, { steps: 4 })
      await editor.mouse.up()
    }
    expect((await report('by the pointer')).peak).toBe(1)

    // Thirty more at the pace of a hand that does not stop: a frame apart, in the page. These
    // are one burst, and one burst is one question, about where it ended. Two sizes are allowed
    // for a burst whose last drag landed just as the settle delay ran out.
    await editor.evaluate(async (count) => {
      const pointer = (target: Element, type: string, x: number, y: number) =>
        target.dispatchEvent(
          new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }),
        )
      for (let at = 0; at < count; at++) {
        const handle = document.querySelector('[data-testid="crop-handle-se"]')!
        const box = handle.getBoundingClientRect()
        const x = box.x + box.width / 2
        const y = box.y + box.height / 2
        pointer(handle, 'pointerdown', x, y)
        pointer(handle, 'pointermove', x + 3, y + 2)
        pointer(handle, 'pointerup', x + 3, y + 2)
        await new Promise((done) => setTimeout(done, 16))
      }
    }, drags)
    const burst = await report('in one burst')
    expect(burst.sizes).toBeGreaterThan(0)
    expect(burst.sizes).toBeLessThanOrEqual(2)
    expect(burst.peak).toBe(1)
  } finally {
    await context.close()
  }
})
