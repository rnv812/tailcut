import { test, expect } from '@playwright/test'
import { launchWithExtension, openExtensionPage, THROTTLING_OFF, watchOn } from './helpers'

/**
 * The tail of a batch lands in the one browser of this suite that is allowed to throttle at all.
 *
 * Playwright hands every launch it makes three switches — background timers, occluded windows,
 * backgrounded renderers — so the whole suite runs in a Chrome that never throttles anything.
 * This launch takes all three back, which is the Chrome every user has, and asks the plain
 * question: does the two-second tail still put a piece on disk.
 *
 * What it does not do is provoke the 1 Hz clamp `HISTORY_TAIL_MS` is sized against, and that was
 * measured rather than assumed. Headless Chromium answers `visible` from `document.visibilityState`
 * for every page it holds — a tab behind another tab included — so page-level background
 * throttling never begins; and the bridge frame's own 200 ms interval was timed at 200 ms per tick
 * with the three switches taken back, with the tab behind another one, and again fifteen seconds
 * into that. The clamp belongs to a browser a person is looking at, and no headless run stands in
 * for one.
 *
 * So what is pinned here is the launch rather than the clamp, and pinned out of Chrome's own
 * mouth: `ignoreDefaultArgs` takes a default back by exact string, and a Playwright that renames
 * one of the three would leave the switch on, this test an unlabelled duplicate of
 * `history.spec.ts`, and nobody any the wiser.
 */
test('a batch lands from a frame Chrome is free to throttle', async () => {
  const { context, extensionId } = await launchWithExtension({ throttled: true })

  try {
    // chrome://version prints the command line the browser was actually given: the one place the
    // taking-back can be read back. Read before anything is recorded, so that a launch which is
    // not the one this test is about fails before it has spent twelve seconds pretending.
    const version = await context.newPage()
    await version.goto('chrome://version')
    const commandLine = (await version.locator('#command_line').textContent()) ?? ''
    for (const flag of THROTTLING_OFF) {
      expect(commandLine, `${flag} was not taken back: this browser throttles nothing`).not.toContain(
        flag,
      )
    }
    await version.close()

    // Long enough for a tail to be due several times over, and far short of a batch being full:
    // what is being measured is the timer and not the byte threshold. The fixture is six seconds
    // and 231 KB, which is exactly the wrong size for the byte threshold and the right one here.
    const page = await context.newPage()
    await watchOn(page, 'player.html', 'https://slow.test/watch', 12)

    const reader = await openExtensionPage(context, extensionId, 'popup/popup.html')
    const pieces = await reader.evaluate(async () => {
      const address = '/shared/history-db.js'
      const { listSessions, piecesOf }: typeof import('../../src/shared/history-db') =
        await import(address)
      const [session] = await listSessions()
      return session ? (await piecesOf(session.id)).length : 0
    })

    expect(pieces, 'the tail never arrived from a frame Chrome was free to throttle').toBeGreaterThan(
      0,
    )
  } finally {
    await context.close()
  }
})
