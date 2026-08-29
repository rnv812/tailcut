import { test, expect } from '@playwright/test'
import {
  HISTORY_BATCH_BYTES,
  newWriterId,
  pieceName,
  piecePath,
} from '../../src/shared/history-files'
import { launchWithExtension, openExtensionPage } from './helpers'

/** How many batches of the real size go down. The warm-up before them is not one of them. */
const WRITES = 5

/**
 * What one batch may cost before it has stopped being one write.
 *
 * Nearly four times the worst honest sample seen on an idle machine (21.9 ms) and a fifth of the
 * cheapest the segmented write ever produced (389.7). Both halves of that were measured rather than
 * reasoned about; the numbers are in the comment on the test.
 */
const BOUND_MS = 80

/**
 * The size every number here was measured at.
 *
 * What gets written is `HISTORY_BATCH_BYTES`, and the test asserts that the two are the same
 * before it times anything. They are one number today, and the assertion is there for the day they
 * are not: `BOUND_MS` is a bound on eight mebibytes and on no other amount — at a quarter of the
 * size it would stop separating the segmented write from the honest one, at four times it would
 * fail an honest write — so a batch cut at another number has to be re-measured rather than
 * silently priced against numbers taken elsewhere.
 */
const MEASURED_AT_BYTES = 8 * 1024 * 1024

/**
 * The price of a sealed write, measured where a measurement can still fail.
 *
 * One number is asserted and it names one regression, which is the only one it can see: a batch
 * that has stopped going down as a single write. The alternative was built and run rather than
 * imagined — the handle taken per 64 KiB segment instead of once per file, which for these eight
 * mebibytes is 128 opens, 128 flushes and 128 closes, and which is the shape the writer would drift
 * into if the batch stopped arriving as one buffer. It cost 389.7–522.1 ms against the 8.9–21.9 of
 * the write as it stands. Eighty is the line between them, and it is far from both.
 *
 * Two regressions it does not catch, and both of those were built and run too, because a bound
 * that names failures it cannot see is worse than no bound at all. Reading the file back after the
 * flush and comparing it byte for byte costs 17.7–20.4 ms. Writing through `createWritable`
 * instead of the synchronous handle costs 19.5–23.2 ms on a file this size and freshly made — the
 * price of that one is paid on the second visit to a file, where reopening with `keepExistingData`
 * copies what is already there into the swap, and a sealed piece is never visited twice. Both sit
 * inside the spread of an honest write, and no bound this test could hold would separate them from
 * it.
 *
 * What `tests/e2e/history.spec.ts` holds is the rest of the write and not this part of it, and the
 * line between the two was drawn by breaking the code rather than by reading it. Under the
 * segmented handle above, that set stays green in every assertion it makes — the bytes come back
 * unchanged, the file is the size it was handed, the lock is gone by the time the answer arrives,
 * and a segmented write keeps all three. The one thing that goes red is the bound below. So the
 * shape of the write — one open, one write, one flush per file — is held by this measurement and
 * by nothing else, and this measurement is in the `measured` project, which `npm run e2e:fast`
 * does not run: whoever touches `writeSealed` has to run it by hand.
 *
 * The cheapest of five is what the assertion stands on, and that is not a way around a bad sample.
 * The regression above multiplies every write by thirty or more, so the cheapest of them witnesses
 * it as plainly as the dearest; a stall of the machine lifts one sample and says nothing about the
 * shape of anything. The warm-up before them is not idle either: it starts the worker, makes the
 * directory and touches OPFS for the first time in this profile, and those three cost more than
 * the write does — 30–47 ms alone, and once 880 — so they are spent before the clock starts.
 */
test('a batch of eight mebibytes goes down as one write', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    expect(
      HISTORY_BATCH_BYTES,
      'the batch is no longer the size BOUND_MS and the numbers around it were measured at',
    ).toBe(MEASURED_AT_BYTES)

    const page = await openExtensionPage(context, extensionId, 'popup/popup.html')

    // The paths come from the builders, like every other path the extension writes: see the note
    // in tests/e2e/history.spec.ts.
    const writer = newWriterId()
    const paths = Array.from({ length: WRITES + 1 }, (_, seq) =>
      piecePath('cost', pieceName(writer, seq)),
    )

    // What goes into the page: the paths, and the size of a batch taken from the module the
    // writer takes it from rather than from a literal beside a comment claiming it is the one the
    // extension writes. If the batch is ever cut at another number, this times that number.
    const input = { paths, batchBytes: HISTORY_BATCH_BYTES }

    const samples = await page.evaluate(async ({ paths, batchBytes }) => {
      const worker = new Worker(chrome.runtime.getURL('bridge/history-worker.js'))
      const answer = (request: unknown, transfer: Transferable[]) =>
        new Promise<Record<string, unknown>>((resolve) => {
          worker.onmessage = (event: MessageEvent) => resolve(event.data)
          worker.postMessage(request, transfer)
        })

      // One batch, the size the extension really writes. Filled sparsely — the write is what is
      // being timed, and filling every byte of it costs more than the write.
      const batch = () => {
        const bytes = new Uint8Array(batchBytes)
        for (let at = 0; at < bytes.length; at += 4093) bytes[at] = (at & 0xff) || 1
        return bytes
      }

      const warm = new Uint8Array([1])
      await answer({ type: 'write', id: 0, path: paths[0], bytes: warm.buffer }, [warm.buffer])

      const measured: number[] = []
      for (let n = 1; n < paths.length; n++) {
        const bytes = batch()
        const at = performance.now()
        const written = await answer(
          { type: 'write', id: n, path: paths[n], bytes: bytes.buffer },
          [bytes.buffer],
        )
        measured.push(performance.now() - at)
        // A refusal that went unread would be timed as a very fast write.
        if (written.type !== 'written' || written.bytes !== batchBytes) {
          throw new Error(`the write did not land: ${JSON.stringify(written)}`)
        }
      }

      worker.terminate()
      return measured
    }, input)

    const cheapest = Math.min(...samples)
    const mib = HISTORY_BATCH_BYTES / 1024 / 1024
    console.log(
      `  ${mib} MiB sealed: ${samples.map((ms) => ms.toFixed(1)).join('  ')} ms` +
        ` — cheapest ${cheapest.toFixed(1)}, bound ${BOUND_MS}`,
    )

    expect(
      cheapest,
      'the batch is no longer going down as one write — see the segmented handle in the comment',
    ).toBeLessThan(BOUND_MS)
  } finally {
    await context.close()
  }
})
