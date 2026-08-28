import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { launchWithExtension, openExtensionPage, routeLocal, serveLocal } from './helpers'
import { decodeFooter, decodeIndex, FOOTER_BYTES } from '../../src/core/snapshot/format'
import { snapshotPath } from '../../src/shared/protocol'

const PLAYER_URL = 'https://tailcut.test/player'

/** Long enough for triage to let the player past its probation (six seconds) plus the poll. */
const PLAY_MS = 7_000

type PageState = { allAppended?: boolean }

/**
 * The snapshots the extension has written, by name, read inside a page of its own origin.
 *
 * This is how a test learns the name of the snapshot a freeze made. The address the popup opens
 * the editor at carries it, but the editor page itself arrives with the next task, and Chrome
 * answers an extension resource that is not there with `chrome-error://chromewebdata/` — the tab
 * keeps no trace of the address it was opened at, in `page.url()`, in `location.href` or in
 * `chrome.tabs`. That the address is built out of the identifier the bridge answered with is
 * settled in tests/popup/popup.test.tsx, where the call is visible; what is settled here is the
 * file.
 */
const snapshotsIn = async (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const names: string[] = []
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('snapshots')
      // The directory handle is iterable in Chrome; the DOM types of the build know nothing of it.
      const keys = (dir as unknown as { keys(): AsyncIterable<string> }).keys()
      for await (const name of keys) names.push(name)
    } catch {
      // No directory at all: nothing was ever frozen here.
    }
    return names
  })

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

async function recorded(): Promise<{ context: BrowserContext; player: Page; extensionId: string }> {
  const { context, extensionId } = await launchWithExtension()
  const player = await context.newPage()
  await serveLocal(player, 'player.html', PLAYER_URL)

  await player.waitForFunction(() => (window as unknown as PageState).allAppended === true, undefined, {
    timeout: 15_000,
  })
  await player.evaluate(() => {
    const video = document.querySelector('video')!
    video.loop = true
    return video.play()
  })
  await player.waitForTimeout(PLAY_MS)

  return { context, player, extensionId }
}

/** Clicks Edit in the popup and gives back the identifier of the snapshot it wrote. */
async function freeze(context: BrowserContext, player: Page, extensionId: string): Promise<string> {
  const popup = await context.newPage()
  await player.bringToFront()
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`)

  const opened = context.waitForEvent('page')
  // The popup only gets out of the way once the freeze went through and the editor tab is in
  // front: over a refusal it stays where it is with its complaint, so this is the success of the
  // freeze seen from the outside.
  const gone = popup.waitForEvent('close')
  await popup.getByRole('button', { name: 'Edit' }).click()

  const editor = await opened
  await gone
  await editor.close()

  const reader = await openExtensionPage(context, extensionId, 'popup/popup.html')
  const names = await snapshotsIn(reader)
  await reader.close()

  expect(names, 'Edit opened the editor over no snapshot at all').toHaveLength(1)
  return names[0]!.replace(/\.tcs$/, '')
}

test('the bridge writes the snapshot and a tab of the extension reads it', async () => {
  const { context, player, extensionId } = await recorded()

  try {
    const id = await freeze(context, player, extensionId)

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
  const { context, player, extensionId } = await recorded()

  try {
    const id = await freeze(context, player, extensionId)
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
