import { test, expect } from '@playwright/test'
import { launchWithExtension, openExtensionPage, watchOn } from './helpers'

test('a full disk lowers the ceiling, and the sweeper frees room by value', async () => {
  test.setTimeout(120_000)

  const { context, extensionId } = await launchWithExtension()

  try {
    const first = await context.newPage()
    await watchOn(first, 'player.html', 'https://long.test/watch', 12)
    await first.close()

    const second = await context.newPage()
    await watchOn(second, 'player.html', 'https://short.test/watch', 12)
    await second.close()

    const reader = await openExtensionPage(context, extensionId, 'popup/popup.html')
    const before = await reader.evaluate(async () => {
      const address = '/shared/history-db.js'
      const { listSessions, readTotals, setPinned }: typeof import('../../src/shared/history-db') =
        await import(address)
      const sessions = await listSessions()
      // Pinned material is never evicted regardless of its computed value, the one ordering rule
      // a rule and not a weight.
      if (sessions[0]) await setPinned(sessions[0].id, true)
      return {
        ids: sessions.map((one) => one.id),
        bytes: (await readTotals()).bytes,
      }
    })
    expect(before.ids).toHaveLength(2)
    expect(before.bytes).toBeGreaterThan(0)

    // What the writer says when storage has refused it. The service worker lowers the effective
    // ceiling to below what is occupied and sweeps.
    await reader.evaluate(() => chrome.runtime.sendMessage({ type: 'tc:sweep', full: true }))

    const state = async () =>
      reader.evaluate(async () => {
        const address = '/shared/history-db.js'
        const { listSessions, readTotals }: typeof import('../../src/shared/history-db') =
          await import(address)
        const sessions = await listSessions()

        const root = await navigator.storage.getDirectory()
        const dirs: string[] = []
        try {
          const history = await root.getDirectoryHandle('history')
          for await (const [name] of history.entries()) dirs.push(name)
        } catch {
          // No history directory at all is the same answer as an empty one.
        }

        const totals = await readTotals()
        return {
          ids: sessions.map((one) => one.id),
          rowBytes: sessions.reduce((sum, one) => sum + one.bytes, 0),
          totals: totals.bytes,
          full: totals.fullAt > 0,
          dirs,
        }
      })

    await expect.poll(async () => (await state()).ids.length, { timeout: 30_000 }).toBe(1)

    const after = await state()
    // The pinned one stayed, the other went whole — files and rows together.
    expect(after.ids).toEqual([before.ids[0]])
    expect(after.dirs).toEqual([before.ids[0]])
    // And the index still agrees with itself: the running total is the sum of the rows.
    expect(after.totals).toBe(after.rowBytes)
    expect(after.totals).toBeLessThan(before.bytes)
    // The interface uses this mark to report a full disk: the refusal is written where it
    // outlives the worker, instead of a retry every thirty seconds that nobody can see. Read out
    // of the index because that is where it lives — the settings page and the popup will show it
    // from there (Tasks 10 and 11).
    expect(after.full).toBe(true)
  } finally {
    await context.close()
  }
})
