import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { launchWithExtension, openExtensionPage, openPopupOn, parseClock, serveLocal, watchOn } from './helpers'

const PAGE_URL = 'https://site.test/watch'

/** Writes the settings the way the settings page does, from a page of the extension. */
async function setSettings(
  context: BrowserContext,
  extensionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html')
  await page.evaluate(async (value) => {
    const address = '/shared/settings-store.js'
    const { writeSettings }: typeof import('../../src/shared/settings-store') =
      await import(address)
    await writeSettings((current) => ({ ...current, ...value }))
  }, patch)
  await page.close()
}

/**
 * A page that keeps delivering: a minute of material, fetched as the play head needs it.
 *
 * player.html appends its six seconds once and loops the playback, so nothing new ever arrives
 * after the first second — and everything in this file is about what arrives while a setting is
 * being changed.
 */
async function watchMinute(page: Page, url: string): Promise<void> {
  await serveLocal(page, 'minute.html', url)
  await page.waitForFunction(
    () => (window as unknown as { tc?: { ready?: boolean } }).tc?.ready === true,
  )
  await page.evaluate(() => document.querySelector('video')!.play())
}

/** What the popup says this tab has on offer, in seconds. */
async function recorded(context: BrowserContext, extensionId: string, page: Page): Promise<number> {
  const popup = await openPopupOn(context, page, extensionId)
  const seconds = parseClock(await popup.getByTestId('duration').textContent())
  await popup.close()
  return seconds
}

/**
 * Bytes of history on the disk, all sessions together.
 *
 * The measure of "is anything still being recorded", and the popup's own clock is not one: what
 * it shows is the longest continuous run of a session (§6.3), so material arriving after a
 * silence starts a second run and leaves the number where it was. Bytes in the index only ever
 * grow, and they grow exactly when a piece lands.
 */
async function onDisk(context: BrowserContext, extensionId: string): Promise<number> {
  const reader = await openExtensionPage(context, extensionId, 'popup/popup.html')
  const bytes = await reader.evaluate(async () => {
    const address = '/shared/history-db.js'
    const { readTotals }: typeof import('../../src/shared/history-db') = await import(address)
    return (await readTotals()).bytes
  })
  await reader.close()
  return bytes
}

/** Longer than the batch interval: whatever was gathered before a switch has landed by now. */
const BATCH_SETTLED_MS = 3_000

test('the settings page reads and writes what the rest of the extension does', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const options = await openExtensionPage(context, extensionId, 'options/options.html')

    // The bundle loaded and drew. A page whose script Chrome refused is blank, and blank is what
    // a missing entry point, a bundle in the wrong format and a bare specifier all look like —
    // none of which the unit set of the page can see, because there is no build in it.
    await expect(options.getByTestId('group-title')).toHaveText([
      'Recording',
      'Video detection',
      'History',
      'Export',
    ])

    // Out of the index and not out of navigator.storage.estimate(). A fresh profile has recorded
    // nothing, and the browser's own estimate never answers zero: it answered 10 GiB with a real
    // ceiling of 200 MB (§7.4).
    await expect(options.getByTestId('volume')).toHaveText('0 KB')

    // A number the setting does not take, typed the way a person types it. `min` and `max` on the
    // field are advice this browser does not enforce on a typed value — which is the whole reason
    // the page holds it itself.
    await options.getByTestId('keep-days').fill('9999')
    await expect(options.getByTestId('limit-note')).toContainText('1 to 90 days')
    await expect(options.getByTestId('keep-days')).toHaveValue('90')

    await options.getByTestId('mode-off').check()

    // Under the one key everything else reads, and read back through the real store.
    await expect(async () => {
      const stored = await options.evaluate(async () => {
        const address = '/shared/settings-store.js'
        const { readSettings }: typeof import('../../src/shared/settings-store') =
          await import(address)
        return await readSettings()
      })
      expect(stored.recording.mode).toBe('off')
      expect(stored.history.keepDays).toBe(90)
    }).toPass({ timeout: 10_000 })

    // And a change made somewhere else reaches the page while it stands open: the popup has
    // quick switches of its own (§9.2) and they write the same key.
    await setSettings(context, extensionId, {
      history: { toDisk: false, keepDays: 30, ceilingBytes: 4 * 1024 ** 3 },
    })
    await expect(options.getByTestId('to-disk')).not.toBeChecked()
    await expect(options.getByTestId('keep-days')).toHaveValue('30')
  } finally {
    await context.close()
  }
})

test('switching recording off stops the copying, and switching it back on resumes it', async () => {
  // Three windows of eight to ten seconds, in real time, plus a browser: the default of thirty
  // seconds is for tests that watch nothing.
  test.setTimeout(120_000)

  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await context.newPage()
    await watchMinute(page, PAGE_URL)
    await page.waitForTimeout(10_000)

    const before = await recorded(context, extensionId, page)
    expect(before).toBeGreaterThan(8)

    // Off, with the page left exactly as it was: no reload, no navigation.
    await setSettings(context, extensionId, {
      recording: { mode: 'off', bufferSeconds: 180, allow: [], deny: [] },
    })
    // The batch that was already gathered when the switch was thrown lands after it, and it is
    // not what this is about. Sampled once it has, so that the stretch measured below is a
    // stretch in which the extension was silent from the first millisecond.
    await page.waitForTimeout(BATCH_SETTLED_MS)
    const quiet = await onDisk(context, extensionId)
    await page.waitForTimeout(8_000)

    // What was recorded is still there — a switch is not an erasure (§7.2) — and nothing was
    // added to it while the switch was off, although the page went on fetching all the while.
    const held = await recorded(context, extensionId, page)
    expect(held).toBe(before)
    expect(await onDisk(context, extensionId), 'a switched-off page went on writing').toBe(quiet)

    await setSettings(context, extensionId, {
      recording: { mode: 'all', bufferSeconds: 180, allow: [], deny: [] },
    })
    await page.waitForTimeout(8_000)

    // Recording resumed inside the same page, at the next header of the stream: the material of
    // the silent stretch is a gap, and the material after it goes to the disk like any other.
    expect(await onDisk(context, extensionId)).toBeGreaterThan(quiet)
  } finally {
    await context.close()
  }
})

test('a denied host is not recorded, and its neighbour is', async () => {
  test.setTimeout(120_000)

  const { context, extensionId } = await launchWithExtension()

  try {
    await setSettings(context, extensionId, {
      recording: { mode: 'all', bufferSeconds: 180, allow: [], deny: ['site.test'] },
    })

    const denied = await context.newPage()
    await watchOn(denied, 'player.html', PAGE_URL, 8)

    const popup = await openPopupOn(context, denied, extensionId)
    await expect(popup.getByText('Nothing recorded on this page yet.')).toBeVisible()
    await popup.close()

    const allowed = await context.newPage()
    await watchOn(allowed, 'player.html', 'https://other.test/watch', 8)

    const second = await openPopupOn(context, allowed, extensionId)
    await expect(second.getByTestId('duration')).not.toHaveText('0:00')
  } finally {
    await context.close()
  }
})

test('recording to disk switched off leaves the index empty and the page recording', async () => {
  test.setTimeout(120_000)

  const { context, extensionId } = await launchWithExtension()

  try {
    await setSettings(context, extensionId, {
      history: { toDisk: false, keepDays: 7, ceilingBytes: 4 * 1024 ** 3 },
    })

    const page = await context.newPage()
    await watchOn(page, 'player.html', PAGE_URL, 12)

    // Still a recording, and still savable: `Save recordings to disk` is about the disk and
    // nothing else. What it turns off is the history — the thing that outlives the tab.
    const popup = await openPopupOn(context, page, extensionId)
    expect(parseClock(await popup.getByTestId('duration').textContent())).toBeGreaterThan(4)

    const listed = await popup.evaluate(async () => {
      const address = '/shared/history-db.js'
      const { listSessions, readTotals }: typeof import('../../src/shared/history-db') =
        await import(address)
      return { sessions: await listSessions(), totals: await readTotals() }
    })

    // Nothing on the disk and nothing in the index. The same page under the default setting puts
    // a row there within a batch — see history.spec.ts, which watches this very fixture.
    expect(listed.sessions).toEqual([])
    expect(listed.totals.bytes).toBe(0)
  } finally {
    await context.close()
  }
})

test('shortening the buffer trims a recording that is already running', async () => {
  test.setTimeout(120_000)

  const { context, extensionId } = await launchWithExtension()

  try {
    // minute.html again, and for the same reason: this is about material that keeps arriving.
    const page = await context.newPage()
    await watchMinute(page, PAGE_URL)
    await page.waitForTimeout(20_000)

    expect(await recorded(context, extensionId, page)).toBeGreaterThan(15)

    await setSettings(context, extensionId, {
      recording: { mode: 'all', bufferSeconds: 15, allow: [], deny: [] },
    })
    // The trim runs on the frame's own tick, every two seconds.
    await page.waitForTimeout(5_000)

    const held = await recorded(context, extensionId, page)
    // A buffer long, measured from the newest material of the session — which is ahead of the
    // play head, because a player downloads ahead of itself.
    expect(held).toBeLessThanOrEqual(17)
    expect(held).toBeGreaterThan(8)
  } finally {
    await context.close()
  }
})
