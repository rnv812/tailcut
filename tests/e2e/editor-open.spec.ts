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
