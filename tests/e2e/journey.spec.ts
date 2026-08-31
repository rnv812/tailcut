import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  exportFirstClip,
  launchWithExtension,
  openExtensionPage,
  openPopupOn,
  probeFile,
  serveLocal,
  watchOn,
} from './helpers'

/**
 * The stage, end to end: watch something, close everything, start the browser again, and cut a
 * clip out of what was watched yesterday.
 *
 * One profile and two launches. Everything this stage is for lives in the profile — the pieces in
 * OPFS, the index in IndexedDB — and a second launch over the same directory is the same browser
 * started again, which is the one way to see the repair run and the history survive.
 */
test('what was watched before the browser was closed is still there after it opens', async () => {
  test.setTimeout(180_000)

  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tailcut-journey-'))

  try {
    {
      const { context } = await launchWithExtension({ userDataDir: profile })
      const page = await context.newPage()
      await watchOn(page, 'player.html', 'https://one.test/watch', 20)
      // Everything closes, the tab and the browser: whatever was in the frame's memory is gone,
      // and what is on disk is all there is.
      await context.close()
    }

    const { context, extensionId } = await launchWithExtension({ userDataDir: profile })
    try {
      const blank = await context.newPage()
      await serveLocal(blank, 'empty.html', 'https://two.test/empty')

      const popup = await openPopupOn(context, blank, extensionId)
      await expect(popup.getByTestId('history-row')).toHaveCount(1)
      // The volume shown is the index's own sum, and it is not zero after a restart: the totals
      // row survived, and the repair did not decide the disk was empty.
      const bytesOnDisk = Number(await popup.getByTestId('in-use').getAttribute('data-bytes'))
      expect(bytesOnDisk).toBeGreaterThan(0)

      const [editor] = await Promise.all([
        context.waitForEvent('page'),
        popup.getByTestId('history-open').click(),
      ])
      await editor.waitForLoadState()

      const file = await exportFirstClip(editor)
      const probed = probeFile(file)
      expect(probed.streams[0]!.codec_name).toBe('h264')
      expect(Number(probed.format.duration)).toBeGreaterThan(1)
    } finally {
      await context.close()
    }
  } finally {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

/**
 * A batch the browser died in the middle of leaves a file with no row; a row whose file went
 * leaves a promise of material that is not there. The repair takes both, and the totals come out
 * matching the rows.
 *
 * In two halves, because the two answers ripen at different speeds. A row whose file is gone is
 * dropped by the repair that runs on the browser starting, whatever its age, and that is what is
 * waited for below. A file with no row is left alone for a minute — it may be a batch being
 * written this second — and nothing here can wait that out or backdate a file: OPFS writes
 * `lastModified` itself. So the second half asks for a repair of its own, with no grace at all.
 * That the delay is an argument of `repair` rather than a constant alone is exactly what makes
 * this askable without reaching into anybody's settings for it.
 */
test('the repair reconciles the index with the disk at start-up', async () => {
  test.setTimeout(180_000)

  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tailcut-repair-'))

  try {
    let sessionId = ''
    let missing = ''
    {
      const { context, extensionId } = await launchWithExtension({ userDataDir: profile })
      const page = await context.newPage()
      await watchOn(page, 'player.html', 'https://one.test/watch', 12)
      // A second batch, and it is what makes the comparison at the end mean anything. The fixture
      // hands its material over in one burst, so a session of it is a single piece — take that
      // piece's file away and the repair leaves no rows and no files, and "every row has its
      // file" is then a statement about two empty lists. Six more seconds in another
      // representation, a tail later, is a second piece that has to survive all of this.
      await page.evaluate(() => (window as unknown as { tcAppendMore(): Promise<void> }).tcAppendMore())
      await page.waitForTimeout(4_000)
      await page.close()

      const surgeon = await openExtensionPage(context, extensionId, 'popup/popup.html')
      const damaged = await surgeon.evaluate(async () => {
        const address = '/shared/history-db.js'
        const { listSessions, piecesOf }: typeof import('../../src/shared/history-db') =
          await import(address)
        const [session] = await listSessions()
        if (!session) throw new Error('nothing was recorded, so there is nothing to damage')
        const pieces = await piecesOf(session.id)
        const [piece] = pieces
        if (!piece) throw new Error('the session has no piece on disk to take away')
        if (pieces.length < 2) throw new Error('one piece only: taking it leaves nothing to check')

        const root = await navigator.storage.getDirectory()
        const dir = await (await root.getDirectoryHandle('history')).getDirectoryHandle(session.id)

        // A file no row knows about: a batch whose row never got written.
        const orphan = await dir.getFileHandle('zzzz-999999.tcm', { create: true })
        const writable = await orphan.createWritable()
        await writable.write(new Uint8Array(1_000))
        await writable.close()

        // And the other way round: the file of a row, taken away.
        await dir.removeEntry(piece.file)
        return { id: session.id, missing: piece.file }
      })
      sessionId = damaged.id
      missing = damaged.missing
      await context.close()
    }

    const { context, extensionId } = await launchWithExtension({ userDataDir: profile })
    try {
      const inspector = await openExtensionPage(context, extensionId, 'popup/popup.html')

      const filesOfRows = (id: string) =>
        inspector.evaluate(async (one) => {
          const address = '/shared/history-db.js'
          const { piecesOf }: typeof import('../../src/shared/history-db') = await import(address)
          return (await piecesOf(one)).map((piece) => piece.file)
        }, id)

      // The half that needs no waiting out: the repair a browser start runs drops the row whose
      // file is gone whatever the age of either. Polled rather than slept on, because the walk of
      // the directory takes as long as it takes.
      //
      // Which of the two doors it comes through is the browser's business and was measured rather
      // than assumed: `chrome.runtime.onStartup` does not reach an extension loaded from the
      // command line — Chrome installs such an extension afresh on every launch, so the second
      // launch over this profile arrives at `onInstalled`, which repairs for the reason written
      // beside it. Taking the repair out of one listener leaves this green; out of both turns it
      // red. So what is pinned here is that a start repairs, not which listener does it.
      await expect
        .poll(async () => (await filesOfRows(sessionId)).includes(missing), { timeout: 30_000 })
        .toBe(false)

      const state = await inspector.evaluate(async (id) => {
        // And the other half, asked for by hand: the orphan was made seconds ago, and the repair
        // that ran at start-up was right to leave it alone. With no grace there is nothing to
        // wait for, and nothing was changed anywhere to arrange that.
        const address = '/shared/history-db.js'
        const { piecesOf, sessionById, readTotals }: typeof import('../../src/shared/history-db') =
          await import(address)

        const root = await navigator.storage.getDirectory()
        const dir = await (await root.getDirectoryHandle('history')).getDirectoryHandle(id)
        const before: string[] = []
        for await (const [name] of dir.entries()) before.push(name)

        const sweeperAt = '/sw/sweeper.js'
        const { repair, liveIo }: typeof import('../../src/sw/sweeper') = await import(sweeperAt)
        await repair(liveIo(), 0)

        const session = await sessionById(id)
        const pieces = await piecesOf(id)

        const names: string[] = []
        for await (const [name] of dir.entries()) names.push(name)

        return {
          orphanWasPresent: before.includes('zzzz-999999.tcm'),
          rows: pieces.map((piece) => piece.file).sort(),
          files: names.sort(),
          bytes: session?.bytes ?? 0,
          totals: (await readTotals()).bytes,
        }
      }, sessionId)

      // Every row has its file and every file has its row — of a session that still has both,
      // which is what the second batch above is for.
      expect(state.rows.length, 'the repair left the session with nothing').toBeGreaterThan(0)
      expect(state.orphanWasPresent, 'the start-up repair took the fresh orphan first').toBe(true)
      expect(state.rows).toEqual(state.files)
      expect(state.files).not.toContain('zzzz-999999.tcm')
      expect(state.totals).toBe(state.bytes)
      expect(state.totals).toBeGreaterThan(0)
    } finally {
      await context.close()
    }
  } finally {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
