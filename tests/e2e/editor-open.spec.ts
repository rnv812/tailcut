import { test, expect } from '@playwright/test'
import { clickEdit, openExtensionPage, recordPlayer } from './helpers'
import { editorUrl } from '../../src/shared/protocol'

test('Edit opens an editor tab over the material of the page', async () => {
  const { context, player, extensionId } = await recordPlayer()

  try {
    const { editor } = await clickEdit(context, player, extensionId)

    await expect(editor.getByTestId('title')).toHaveText('test player')
    await expect(editor.getByTestId('host')).toHaveText('tailcut.test')
    // The fixture is six seconds of picture with no gaps in it.
    await expect(editor.getByTestId('duration')).toHaveText('0:06')
    await expect(editor.getByTestId('gaps')).toHaveText('0 gaps')
    await expect(editor.getByTestId('track')).toHaveCount(1)
    await expect(editor.getByTestId('track')).toContainText('avc1')

    for (const pane of ['player', 'inspector', 'timeline']) {
      await expect(editor.getByTestId(pane)).toBeVisible()
    }

    const transport = await editor.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      const row = rect('.transport')
      const play = rect('[data-testid="play"]')
      const video = rect('video')
      const controls = [...document.querySelectorAll<HTMLElement>('.transport button, .transport input')]
      const controlCenters = controls.map((control) => {
        const box = control.getBoundingClientRect()
        return box.top + box.height / 2
      })
      return {
        rowCenter: row.left + row.width / 2,
        playCenter: play.left + play.width / 2,
        videoCenter: video.left + video.width / 2,
        controlCenterSpread: Math.max(...controlCenters) - Math.min(...controlCenters),
        controlsFitOneLine: controls.every((control) => {
          const box = control.getBoundingClientRect()
          return box.top >= row.top && box.bottom <= row.bottom
        }),
      }
    })
    expect(transport.controlsFitOneLine).toBe(true)
    expect(Math.abs(transport.playCenter - transport.rowCenter)).toBeLessThanOrEqual(1)
    expect(Math.abs(transport.playCenter - transport.videoCenter)).toBeLessThanOrEqual(1)
    expect(transport.controlCenterSpread).toBeLessThanOrEqual(1)

    await expect(editor.getByTestId('return-source')).toBeVisible()
    expect(new URL(editor.url()).searchParams.get('tab')).not.toBeNull()

    await expect.poll(() => editor.evaluate(() => {
      const pane = document.querySelector('[data-testid="timeline"]')!.getBoundingClientRect()
      const strip = document.querySelector('.tc-timeline')!.getBoundingClientRect()
      const canvas = document.querySelector('.tc-timeline canvas')!.getBoundingClientRect()
      return {
        paneLeft: Math.round(pane.left),
        paneRight: Math.round(pane.right),
        viewport: document.documentElement.clientWidth,
        strip: Math.round(strip.width),
        canvas: Math.round(canvas.width),
      }
    })).toEqual({
      paneLeft: 0,
      paneRight: await editor.evaluate(() => document.documentElement.clientWidth),
      viewport: await editor.evaluate(() => document.documentElement.clientWidth),
      strip: expect.any(Number),
      canvas: expect.any(Number),
    })

    const widths = await editor.evaluate(() => ({
      strip: document.querySelector('.tc-timeline')!.getBoundingClientRect().width,
      canvas: document.querySelector('.tc-timeline canvas')!.getBoundingClientRect().width,
    }))
    expect(Math.abs(widths.strip - widths.canvas)).toBeLessThanOrEqual(1)

    const fitted = async () => editor.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('.tc-timeline')!
      const canvas = strip.querySelector('canvas')!.getBoundingClientRect()
      const scale = Number(strip.dataset.viewScale)
      return {
        stripWidth: strip.getBoundingClientRect().width,
        canvasWidth: canvas.width,
        materialWidth: 6 / scale,
        start: Number(strip.dataset.viewStart),
      }
    })

    await expect.poll(fitted).toMatchObject({
      stripWidth: expect.any(Number),
      canvasWidth: expect.any(Number),
      materialWidth: expect.any(Number),
      start: 0,
    })
    let view = await fitted()
    expect(Math.abs(view.stripWidth - view.canvasWidth)).toBeLessThanOrEqual(1)
    expect(Math.abs(view.canvasWidth - view.materialWidth)).toBeLessThanOrEqual(1)

    const timeline = editor.locator('.tc-timeline canvas')
    const box = (await timeline.boundingBox())!
    await editor.mouse.move(box.x + box.width / 2, box.y + 20)
    await editor.mouse.wheel(0, 1)
    await editor.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

    view = await fitted()
    expect(Math.abs(view.stripWidth - view.canvasWidth)).toBeLessThanOrEqual(1)
    expect(Math.abs(view.canvasWidth - view.materialWidth)).toBeLessThanOrEqual(1)
    expect(view.start).toBe(0)
  } finally {
    await context.close()
  }
})

test('a clip is born by the Export settings the tab read when it opened', async () => {
  const { context, player, extensionId } = await recordPlayer()

  try {
    // Written before the editor opens because the tab reads settings once in `main.tsx`
    // and a template written afterwards would reach nothing. This is the only test on either
    // side of the browser that walks the whole wire: storage, `readSettings`, `EditorOptions`,
    // `deriveMaterial`, the context, the reducer, the name in the panel. Cut it anywhere and a
    // clip goes back to its default name, taking the format a clip is born in with it. That
    // choice has no visible output until the export inspector renders it.
    const writer = await openExtensionPage(context, extensionId, 'popup/popup.html')
    await writer.evaluate(async () => {
      const address = '/shared/settings-store.js'
      const { writeSettings }: typeof import('../../src/shared/settings-store') = await import(address)
      await writeSettings((current) => ({
        ...current,
        export: { ...current.export, nameTemplate: '{host} at {in}', format: 'webp' },
      }))
    })
    await writer.close()

    const { editor } = await clickEdit(context, player, extensionId)
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)

    await editor.keyboard.press('i')
    await expect(editor.getByTestId('clip')).toHaveCount(1)
    await expect(editor.getByTestId('name-c1')).toHaveValue('tailcut.test at 00.00')
  } finally {
    await context.close()
  }
})

test('the editor survives a reload of its tab and the closing of the source', async () => {
  const { context, player, extensionId } = await recordPlayer()

  try {
    const { editor } = await clickEdit(context, player, extensionId)
    await expect(editor.getByTestId('duration')).toHaveText('0:06')

    // F5 in the editor is the most ordinary thing there is, and the snapshot has to open again
    // out of the same file.
    await editor.reload()
    await expect(editor.getByTestId('duration')).toHaveText('0:06')

    await player.close()
    await editor.reload()
    await expect(
      editor.getByTestId('duration'),
      'the snapshot died with the page, which is precisely what it must not do',
    ).toHaveText('0:06')
  } finally {
    await context.close()
  }
})

test('an address with no snapshot says where the editor is opened from', async () => {
  const { context, player, extensionId } = await recordPlayer()

  try {
    const bare = await openExtensionPage(context, extensionId, 'editor/editor.html')
    await expect(bare.getByTestId('failure')).toContainText('opens from the tailcut popup')

    // A name that is not in storage: the file is not found, and that is a different answer.
    const missing = await openExtensionPage(
      context,
      extensionId,
      editorUrl('00000000-0000-4000-8000-000000000000'),
    )
    await expect(missing.getByTestId('failure')).toContainText('no longer in storage')

    // A name of the wrong shape never reaches storage at all.
    const bogus = await openExtensionPage(context, extensionId, 'editor/editor.html?s=../../etc')
    await expect(bogus.getByTestId('failure')).toContainText('opens from the tailcut popup')

    await player.close()
  } finally {
    await context.close()
  }
})

test('an interrupted snapshot is told apart from a missing one', async () => {
  const { context, player, extensionId } = await recordPlayer()

  try {
    const { editor, snapshotId } = await clickEdit(context, player, extensionId)

    // Cut the footer off: exactly what an interrupted write leaves behind.
    await editor.evaluate(async (id: string) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('snapshots')
      const handle = await dir.getFileHandle(`${id}.tcs`)
      const file = await handle.getFile()
      const kept = await file.slice(0, file.size - 64).arrayBuffer()
      const writable = await handle.createWritable()
      await writable.write(kept)
      await writable.close()
    }, snapshotId)

    await editor.reload()
    await expect(editor.getByTestId('failure')).toContainText('not finished being written')
  } finally {
    await context.close()
  }
})
