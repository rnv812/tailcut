import { test, expect, type Page } from '@playwright/test'
import { clickEdit, openExtensionPage, recordPlayer, routeLocal, serveLocal, launchWithExtension } from './helpers'
import { decodeFooter, decodeIndex, FOOTER_BYTES } from '../../src/core/snapshot/format'
import { snapshotPath } from '../../src/shared/protocol'

const PLAYER_URL = 'https://tailcut.test/player'

/** Reads a whole file out of OPFS inside the page and hands the bytes back to the test. */
const readOpfs = async (page: Page, file: string): Promise<number[] | null> =>
  page.evaluate(async (rel: string) => {
    const parts = rel.split('/')
    const name = parts.pop()!
    try {
      let dir = await navigator.storage.getDirectory()
      for (const part of parts) dir = await dir.getDirectoryHandle(part)
      const handle = await dir.getFileHandle(name)
      return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())]
    } catch {
      return null
    }
  }, file)

test('the bridge writes the snapshot and a tab of the extension reads it', async () => {
  const { context, player, extensionId } = await recordPlayer()

  try {
    const { editor, snapshotId: id } = await clickEdit(context, player, extensionId)
    await editor.close()

    const reader = await openExtensionPage(context, extensionId, 'popup/popup.html')
    const bytes = await readOpfs(reader, snapshotPath(id))

    expect(bytes, 'the snapshot is not in the storage of the extension').not.toBeNull()

    const file = new Uint8Array(bytes!)
    const footer = decodeFooter(file.subarray(file.byteLength - FOOTER_BYTES), file.byteLength)
    expect(footer, 'the footer of the snapshot does not match its size').not.toBeNull()

    const index = decodeIndex(file.subarray(footer!.index.at, footer!.index.at + footer!.index.length))
    expect(index, 'the index of the snapshot does not parse').not.toBeNull()
    expect(index!.id).toBe(id)
    expect(index!.page.url).toBe(PLAYER_URL)
    expect(index!.tracks).toHaveLength(1)
    // Three segments of the fixture: six seconds of picture, exactly what the page poured in.
    expect(index!.tracks[0]!.chunks).toHaveLength(3)
    expect(index!.tracks[0]!.chunks[0]!.start).toBe(0)
  } finally {
    await context.close()
  }
})

test('the snapshot outlives the tab it was taken from', async () => {
  const { context, player, extensionId } = await recordPlayer()

  try {
    const { editor, snapshotId: id } = await clickEdit(context, player, extensionId)
    await editor.close()
    await player.close()

    const reader = await openExtensionPage(context, extensionId, 'popup/popup.html')
    const bytes = await readOpfs(reader, snapshotPath(id))

    expect(bytes, 'the snapshot died with the page, which is the one thing it exists not to do').not.toBeNull()
    expect(bytes!.length).toBeGreaterThan(100_000)
  } finally {
    await context.close()
  }
})

test('with no material Edit refuses and opens no tab', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const player = await context.newPage()
    await serveLocal(player, 'banner.html', 'https://tailcut.test/banner')
    await player.waitForTimeout(3_000)

    const popup = await context.newPage()
    await player.bringToFront()
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`)

    const before = context.pages().length
    const edit = popup.getByRole('button', { name: 'Edit' })
    // A clip triage threw out never reaches the popup at all: there is no button because there
    // is no session.
    if (await edit.count()) {
      await edit.click()
      await expect(popup.getByTestId('edit-error')).toBeVisible()
    } else {
      await expect(popup.getByText('Nothing recorded on this page yet.')).toBeVisible()
    }
    expect(context.pages().length, 'an editor tab opened over nothing to edit').toBe(before)
  } finally {
    await context.close()
  }
})

/**
 * The canary of the flag itself.
 *
 * Everything above rests on extension origins being exempt from storage partitioning. If the flag
 * is not actually in force, that claim is never tested and the suite is green over a browser the
 * user does not have. This is the control: an ordinary web iframe of one origin, embedded under
 * two different sites, must NOT see its own marker across them.
 */
test('storage partitioning really is in force', async () => {
  const { context } = await launchWithExtension()

  try {
    const marker = async (top: string, action: 'write' | 'read'): Promise<string> => {
      const page = await context.newPage()
      await routeLocal(page, 'partitioned-inner.html', 'https://shared.example/inner')
      await serveLocal(page, 'partitioned-outer.html', top)

      const frame = page.frameLocator('#inner')
      await frame.locator('#ready').waitFor()
      await page.evaluate((what) => {
        ;(document.querySelector('#inner') as HTMLIFrameElement).contentWindow!.postMessage(what, '*')
      }, action)

      const result = await page.waitForFunction(
        () => (window as unknown as { markerResult?: string }).markerResult,
      )
      const text = String(await result.jsonValue())
      await page.close()
      return text
    }

    expect(await marker('https://a.example/top', 'write')).toBe('written')
    expect(
      await marker('https://b.example/top', 'read'),
      'a third-party iframe found its own storage under another site: the flag is not in force',
    ).toBe('missing')
  } finally {
    await context.close()
  }
})
