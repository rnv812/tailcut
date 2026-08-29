import { test, expect } from '@playwright/test'
import {
  HISTORY_BATCH_BYTES,
  newWriterId,
  pieceName,
  piecePath,
  sessionDir,
} from '../../src/shared/history-files'
import { launchWithExtension, openExtensionPage } from './helpers'

/** The session every write here goes into. One directory, thrown away with the profile. */
const SESSION = 'probe'

/**
 * Where the pieces go, built the way the extension builds them rather than spelled out here.
 *
 * This is the only thing that ties `src/shared/history-files.ts` to a disk. The unit set beside
 * it compares strings to strings: it says that a sequence number is padded and that two writers
 * of one session get different names, and it would say all of that just as happily about a name
 * OPFS refuses to open. Literal paths on both sides of this test would have been worse than
 * nothing — they would agree with each other while agreeing with no line of the module.
 *
 * So the writer is handed `piecePath` and the reader walks down the chain `sessionDir` names.
 * `HISTORY_DIR` reaches both sides through those two and is spelled out on neither, which is the
 * point: there is no longer a literal 'history' in this file to agree with itself.
 */
const probe = () => {
  const writer = newWriterId()
  const names = [0, 1, 2].map((seq) => pieceName(writer, seq))
  return {
    dirs: sessionDir(SESSION).split('/'),
    names,
    paths: names.map((name) => piecePath(SESSION, name)),
  }
}

/**
 * What a sealed write leaves behind, proved in a browser because there is nowhere else to prove
 * it: OPFS and the synchronous handle exist in Chrome and in no test runner.
 *
 * Three things are asserted and each of them is a decision of the design rather than a detail.
 * The bytes come back exactly as they went in — a sealed piece is written once and never revised.
 * The handle is gone by the time the answer arrives, which `removeEntry` is the only honest test
 * of: while a synchronous handle is open, removal of that file fails with
 * NoModificationAllowedError, and a sweeper that could not remove anything of a live session
 * would be a silent no-op rather than a failure. And the names are the module's own, so that the
 * directory `HISTORY_DIR` names is the directory the writer made and the name `pieceName` gives
 * out is a name OPFS will take.
 *
 * A fourth thing about the write is not asserted here and cannot be: that it was one write. The
 * alternative was built and run — the handle taken per 64 KiB segment, 128 opens of the file
 * instead of one — and every assertion below stayed green on it, because a segmented write leaves
 * behind exactly the same file with the same bytes and the same released lock. Only a clock tells
 * them apart, and that clock is `tests/e2e/history-write-cost.spec.ts` (400.7–498.0 ms segmented
 * against a bound of 80). It runs in the `measured` project, which `npm run e2e:fast` leaves out,
 * so a change to `writeSealed` that keeps the bytes right is answered by nothing until it is run.
 */
test('a piece is written sealed, read back whole, and leaves no lock behind', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await openExtensionPage(context, extensionId, 'popup/popup.html')

    // What goes into the page: the paths from the builders, and the size of a batch from the
    // module the writer takes it from.
    const input = { probe: probe(), batchBytes: HISTORY_BATCH_BYTES }

    const result = await page.evaluate(async ({ probe, batchBytes }) => {
      const worker = new Worker(chrome.runtime.getURL('bridge/history-worker.js'))
      const answer = (request: unknown, transfer: Transferable[]) =>
        new Promise<Record<string, unknown>>((resolve) => {
          worker.onmessage = (event: MessageEvent) => resolve(event.data)
          worker.postMessage(request, transfer)
        })

      // One batch, the size the extension really writes: `HISTORY_BATCH_BYTES` and not a literal
      // under a comment saying so, which would go on saying it after the writer chose otherwise.
      const bytes = new Uint8Array(batchBytes)
      for (let at = 0; at < bytes.length; at += 4093) bytes[at] = (at & 0xff) || 1
      const sent = bytes.slice()

      const first = await answer(
        { type: 'write', id: 1, path: probe.paths[0], bytes: bytes.buffer },
        [bytes.buffer],
      )

      // A second piece beside the first: the writer comes back to the directory and not to the
      // file, and the directory has to be there already.
      const second = new Uint8Array([1, 2, 3, 4])
      const secondWritten = await answer(
        { type: 'write', id: 2, path: probe.paths[1], bytes: second.buffer },
        [second.buffer],
      )

      // Down the chain `sessionDir` names, with nothing created on the way: the directories are
      // there only if the path the writer was given led to the same place.
      let dir = await navigator.storage.getDirectory()
      for (const part of probe.dirs) dir = await dir.getDirectoryHandle(part)
      const file = await (await dir.getFileHandle(probe.names[0]!)).getFile()
      const back = new Uint8Array(await file.arrayBuffer())

      let same = back.byteLength === sent.byteLength
      if (same) for (let at = 0; at < sent.length; at += 4093) same &&= back[at] === sent[at]

      // The lock: removal is refused while a handle is open on the file, so a removal that
      // succeeds is the proof that the worker closed it.
      let removed = false
      try {
        await dir.removeEntry(probe.names[0]!)
        removed = true
      } catch (cause) {
        return { failure: String(cause) }
      }

      worker.terminate()
      return { first, secondWritten, size: file.size, same, removed }
    }, input)

    expect(result.failure, 'the file could not be removed after the write').toBeUndefined()
    expect(result.first).toMatchObject({ type: 'written', id: 1, bytes: HISTORY_BATCH_BYTES })
    expect(result.secondWritten).toMatchObject({ type: 'written', id: 2, bytes: 4 })
    expect(result.size).toBe(HISTORY_BATCH_BYTES)
    expect(result.same, 'the bytes came back changed').toBe(true)
    expect(result.removed).toBe(true)
  } finally {
    await context.close()
  }
})

/**
 * Every request is answered, the impossible one included.
 *
 * The writer that Task 3 puts in front of this worker sends one batch at a time and waits for the
 * answer by number, so a request that produces no answer at all does not cost one batch: it costs
 * every batch of every session for the life of the frame, silently, on a page that goes on
 * playing. There is no consumer yet to notice, which is exactly why it is pinned now.
 *
 * The hole was before the write rather than inside it. `writeSealed` catches what it can and
 * answers, but the request is turned into a `Uint8Array` first, and the `close()` in its `finally`
 * — the call that lets go of the lock — is outside the `try` that answers, so a throw from either
 * left the promise rejected and the listener with nothing to post. Both now land in one catch
 * around the whole of the work, and this is the half of it that can be provoked from outside: a
 * length of −1 throws where the buffer is taken.
 *
 * The valid write afterwards is the other half of the claim. A worker that answered the refusal
 * and then stopped taking messages would cost the frame just as much as one that never answered.
 */
test('a request that cannot be written is refused rather than dropped', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await openExtensionPage(context, extensionId, 'popup/popup.html')

    const result = await page.evaluate(async (probe) => {
      const worker = new Worker(chrome.runtime.getURL('bridge/history-worker.js'))

      // Five seconds rather than the thirty of the test: silence is the defect under test, and it
      // deserves to be reported as silence and not as a timeout with no story in it.
      const next = (): Promise<unknown> =>
        Promise.race([
          new Promise<unknown>((resolve) => {
            worker.onmessage = (event: MessageEvent) => resolve(event.data)
          }),
          new Promise<unknown>((resolve) => setTimeout(() => resolve('nothing came back'), 5_000)),
        ])

      const refusal = next()
      worker.postMessage({ type: 'write', id: 7, path: probe.paths[2], bytes: -1 })
      const refused = await refusal

      const after = new Uint8Array([9])
      const surviving = next()
      worker.postMessage({ type: 'write', id: 8, path: probe.paths[1], bytes: after.buffer }, [
        after.buffer,
      ])
      const written = await surviving

      worker.terminate()
      return { refused, written }
    }, probe())

    expect(result.refused, 'the worker took a request it could not carry out and said nothing')
      .toMatchObject({ type: 'failed', id: 7, quota: false })
    expect(
      String((result.refused as { error?: unknown }).error),
      'the refusal says nothing about what went wrong',
    ).toMatch(/\S/)
    expect(result.written, 'one impossible request cost the frame every batch after it')
      .toMatchObject({ type: 'written', id: 8, bytes: 1 })
  } finally {
    await context.close()
  }
})
