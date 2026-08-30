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
