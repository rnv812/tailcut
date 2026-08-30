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

/**
 * The refusal, over a session that is really there.
 *
 * It used to be measured on a banner page, and a banner is thrown out by triage before the popup
 * ever hears of it: there was no session, so no Edit button was drawn, so nothing was clicked and
 * the one assertion left — that no tab had opened — was true of a browser in which nothing had
 * happened. The whole of the refusal could have been deleted and this stayed green.
 *
 * So the page is one triage keeps and the popup lists: a player that opened its stream and never
 * got a fragment into it. The button is there, the click is real, and the answer to it is the
 * "empty" refusal in as many words.
 */
test('with no material Edit refuses in words and opens no tab', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const player = await context.newPage()
    await serveLocal(player, 'no-material.html', 'https://tailcut.test/no-material')
    await player.waitForFunction(() => (window as unknown as { headerOnly?: boolean }).headerOnly)

    const popup = await context.newPage()
    await player.bringToFront()
    // Two polls of the watcher. Creating the second tab put the player in the background for a
    // moment, and an unconfirmed session is taken out of the registry on sight of that; a hold
    // puts it back whole, and this page can never earn a promotion — nothing in it ever plays.
    await player.waitForTimeout(1_500)
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`)

    const before = context.pages().length
    const edit = popup.getByRole('button', { name: 'Edit' })
    // The session is listed, and the buttons over it are the point of the test: a page that
    // reached the popup as nothing at all would prove nothing about the refusal.
    await expect(edit, 'the session was not listed: there is no refusal to measure here').toBeVisible()
    await expect(popup.getByTestId('duration')).toHaveText('0:00')

    await edit.click()

    await expect(popup.getByTestId('edit-error')).toHaveText(
      'There is nothing to edit in this session yet.',
    )
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

/**
 * Every request to the snapshot worker is answered, the impossible one included.
 *
 * Both writer workers once shared the same failure hole: the buffer is taken out of the request
 * before `writeSealed` is entered,
 * and the `close()` in its `finally` — the call that lets go of the lock — sits outside the `try`
 * that turns a failure into an answer. A throw from either rejected the promise, the `.then` that
 * posts the answer never ran, and nothing else was listening.
 *
 * What that costs is not symmetrical between the two workers. The history writer waits for the
 * answer by number and applies a timeout; the snapshot has one already, and it is
 * `WRITE_TIMEOUT_MS` = 60 000 in src/bridge/snapshot-writer.ts. So a request the worker cannot
 * carry out is a minute of a click on `Edit` sitting there before the popup is allowed to refuse —
 * a minute of the user's, spent to learn something the worker knew in a microsecond.
 *
 * A length of −1 provokes the half of it that can be provoked from outside: the throw lands where
 * the buffer is taken. The valid write afterwards is the other half of the claim — a worker that
 * answered the refusal and then stopped taking messages would cost the click just as much.
 */
test('a snapshot that cannot be written is refused rather than dropped', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await openExtensionPage(context, extensionId, 'popup/popup.html')

    // The path comes from the builder, like every other path the extension writes.
    const paths = [snapshotPath(crypto.randomUUID()), snapshotPath(crypto.randomUUID())]

    const result = await page.evaluate(async (paths) => {
      const worker = new Worker(chrome.runtime.getURL('bridge/snapshot-worker.js'))

      // Five seconds rather than the sixty the frame would wait: silence is the defect under
      // test, and it deserves to be reported as silence rather than as a timeout with no story.
      const next = (): Promise<unknown> =>
        Promise.race([
          new Promise<unknown>((resolve) => {
            worker.onmessage = (event: MessageEvent) => resolve(event.data)
          }),
          new Promise<unknown>((resolve) => setTimeout(() => resolve('nothing came back'), 5_000)),
        ])

      const refusal = next()
      worker.postMessage({ type: 'write', path: paths[0], bytes: -1 })
      const refused = await refusal

      const after = new Uint8Array([9])
      const surviving = next()
      worker.postMessage({ type: 'write', path: paths[1], bytes: after.buffer }, [after.buffer])
      const written = await surviving

      worker.terminate()
      return { refused, written }
    }, paths)

    expect(
      result.refused,
      'the worker took a request it could not carry out and said nothing: a minute of a click',
    ).toMatchObject({ type: 'failed' })
    expect(
      String((result.refused as { error?: unknown }).error),
      'the refusal says nothing about what went wrong',
    ).toMatch(/\S/)
    expect(
      result.written,
      'one impossible request cost the worker every snapshot after it',
    ).toMatchObject({ type: 'written', bytes: 1 })
  } finally {
    await context.close()
  }
})
