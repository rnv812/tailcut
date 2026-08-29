import { test, expect } from '@playwright/test'
import { launchWithExtension, openExtensionPage, serveLocal } from './helpers'
import { HISTORY_BATCH_BYTES, HISTORY_DIR } from '../../src/shared/history-files'

const PAGE_URL = 'https://tailcut.test/watched'

declare global {
  interface Window {
    watched: boolean
    failure: string | null
    report: {
      droppedFrames: number
      totalFrames: number
      longTasks: number
      longestTaskMs: number
      maxGapMs: number
      appends: number
      appendP50Ms: number
      pushedBytes: number
      playedSeconds: number
    } | null
  }
}

/**
 * The first constraint of this project, measured on the code that has to keep it: the page pays
 * nothing for being recorded to disk.
 *
 * The assertions about the page are absolute rather than a ratio against a run without the
 * extension, and that is deliberate. The four things below are not "smaller than the baseline"
 * quantities — a dropped frame is a dropped frame, and a long task on the page's main thread is a
 * stutter whoever caused it. The measurement they come from ran four ways on the probe (idle,
 * 10 MB every 2 s, 2 MB every second, 300 KB every 200 ms) and every one of them gave 0 dropped,
 * 0 long tasks and an appendBuffer median of 0.2 ms: the frame of the extension is a process of
 * its own and the worker another, and neither shares a thread with the page.
 *
 * The other half of the test is the load, and it is the half that was missing. A bench that
 * dribbles a quarter of a megabyte through the writer never reaches the byte threshold, so what
 * gets measured is a two-second tail flush of 230 KB — and a build where writing a batch got ten
 * times dearer would pass it without a wobble. So the page is made to deliver 4K's worth of bytes
 * a second, and what is asserted is not that something was written but that the eight-mebibyte
 * batch went down, again and again, at the size it is supposed to go down at.
 */
test('a page pays nothing while its material is written to disk in full batches', async () => {
  // Twenty-five seconds of watching, a browser to start and a hundred and thirty megabytes to
  // write: the default of thirty seconds is for tests that do none of that.
  test.setTimeout(180_000)

  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await context.newPage()
    await serveLocal(page, 'watched.html', PAGE_URL)

    await page.waitForFunction(() => window.watched || window.failure !== null, null, {
      timeout: 120_000,
    })

    const result = await page.evaluate(() => ({ failure: window.failure, report: window.report }))
    expect(result.failure, 'the watching page did not finish').toBeNull()

    const report = result.report!
    expect(report.playedSeconds, 'the page did not actually play').toBeGreaterThan(15)
    expect(report.totalFrames).toBeGreaterThan(300)
    // The bench itself, before anything is said about the extension: without this much through
    // the hook there are no full batches to have paid for.
    expect(report.pushedBytes, 'the bench did not deliver the load').toBeGreaterThan(96 * 1024 * 1024)

    expect(report.droppedFrames, 'frames were dropped while writing to disk').toBe(0)
    expect(report.longTasks, 'the page main thread was blocked while writing to disk').toBe(0)
    // Two frame periods at 60 Hz. A gap wider than that is a frame the page did not draw.
    expect(report.maxGapMs).toBeLessThan(34)
    // Measured at 0.2 ms with and without writing; one millisecond is five times that.
    expect(report.appendP50Ms).toBeLessThan(1)

    // …and this is what it was paying for. The directory is the one the writer makes, named by the
    // module that names it for the writer: a literal here would agree with itself and with nothing
    // else, and the refusal below would then say "nothing was written" about a directory that had
    // merely been renamed.
    const extensionPage = await openExtensionPage(context, extensionId, 'popup/popup.html')
    const pieces = await extensionPage.evaluate(async (dir) => {
      const root = await navigator.storage.getDirectory()

      // The absence of the directory is an answer and not an accident: it is made by the first
      // piece that lands, so there being none means no piece ever landed. Handed back as null
      // rather than allowed to throw, because a NotFoundError raised inside a page and rethrown by
      // the runner names neither the directory nor what its absence means, and this is the shape
      // the whole measurement takes when writing to disk is off.
      let history: FileSystemDirectoryHandle
      try {
        history = await root.getDirectoryHandle(dir)
      } catch {
        return null
      }

      const files: Array<{ name: string; size: number }> = []
      for await (const [, sessionDir] of history.entries()) {
        for await (const [name, handle] of (sessionDir as FileSystemDirectoryHandle).entries()) {
          const file = await (handle as FileSystemFileHandle).getFile()
          files.push({ name, size: file.size })
        }
      }
      return files
    }, HISTORY_DIR)

    expect(
      pieces,
      `nothing was written to disk at all: the extension made no ${HISTORY_DIR}/ directory, so no` +
        ' batch ever landed — the writer is switched off, or it never heard of the material',
    ).not.toBeNull()

    const written = pieces!.reduce((total, piece) => total + piece.size, 0)
    expect(written, 'the material did not reach the disk').toBeGreaterThan(96 * 1024 * 1024)

    // Sizes and not merely a count: the batch is what was priced at 9.6 ms (p95 11.5), and a test
    // that is green over pieces of a quarter of a megabyte proves nothing about it.
    const full = pieces!.filter((piece) => piece.size >= HISTORY_BATCH_BYTES)
    expect(full.length, 'the eight-mebibyte batch never went down').toBeGreaterThanOrEqual(8)
    // And none of them went down late: a batch closes on the first chunk that fills it, so the
    // overshoot is one segment and never more.
    expect(Math.max(...full.map((piece) => piece.size))).toBeLessThan(
      HISTORY_BATCH_BYTES + 256 * 1024,
    )
  } finally {
    await context.close()
  }
})
