import { test, expect } from '@playwright/test'
import { launchWithExtension, openExtensionPage } from './helpers'

/**
 * The shape of the write, proved in a browser because there is nowhere else to prove it: OPFS and
 * the synchronous handle exist in Chrome and in no test runner.
 *
 * Three things are asserted and each of them is a decision of the design rather than a detail.
 * The bytes come back exactly as they went in — a sealed piece is written once and never revised.
 * The handle is gone by the time the answer arrives, which `removeEntry` is the only honest test
 * of: while a synchronous handle is open, removal of that file fails with
 * NoModificationAllowedError, and a sweeper that could not remove anything of a live session
 * would be a silent no-op rather than a failure. And the cost stays where it was measured: 8 MiB
 * in about ten milliseconds, on a worker that is already up — the start of it and the first touch
 * of OPFS in a fresh profile cost more than the write itself and are no part of it, which is why
 * a byte goes down before anything is timed.
 */
test('a piece is written sealed, read back whole, and leaves no lock behind', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await openExtensionPage(context, extensionId, 'popup/popup.html')

    const result = await page.evaluate(async () => {
      const worker = new Worker(chrome.runtime.getURL('bridge/history-worker.js'))
      const answer = (request: unknown, transfer: Transferable[]) =>
        new Promise<Record<string, unknown>>((resolve) => {
          worker.onmessage = (event: MessageEvent) => resolve(event.data)
          worker.postMessage(request, transfer)
        })

      // Eight mebibytes: the batch this extension actually writes.
      const batch = () => {
        const bytes = new Uint8Array(8 * 1024 * 1024)
        for (let at = 0; at < bytes.length; at += 4093) bytes[at] = (at & 0xff) || 1
        return bytes
      }

      // A byte first, and it is not idle: it starts the worker, makes the directory and touches
      // OPFS for the first time in this profile. None of the three is the cost of a write, and
      // all three land in the first measurement if they are not taken out of it — a first write
      // costs 30–47 ms alone against the 10 of the ones after it, and 58–91 ms while the rest of
      // the set runs beside it, where it was once seen at 880.
      const warm = new Uint8Array([1])
      await answer(
        { type: 'write', id: 0, path: 'history/probe/warm.tcm', bytes: warm.buffer },
        [warm.buffer],
      )

      const bytes = batch()
      const sent = bytes.slice()

      const started = performance.now()
      const first = await answer(
        { type: 'write', id: 1, path: 'history/probe/aaaa-000000.tcm', bytes: bytes.buffer },
        [bytes.buffer],
      )
      let writeMs = performance.now() - started

      // Two more of the same size, and the cheapest of the three is what the bound below is put
      // on. A run of the whole set puts four browsers on this machine, and a stall in any one
      // measurement says nothing about the shape of the write.
      for (let n = 1; n <= 2; n++) {
        const again = batch()
        const at = performance.now()
        await answer(
          { type: 'write', id: 10 + n, path: `history/probe/again-00000${n}.tcm`, bytes: again.buffer },
          [again.buffer],
        )
        writeMs = Math.min(writeMs, performance.now() - at)
      }

      // A second piece beside the first: the writer comes back to the directory and not to the
      // file, and the directory has to be there already.
      const second = new Uint8Array([1, 2, 3, 4])
      const secondWritten = await answer(
        { type: 'write', id: 2, path: 'history/probe/aaaa-000001.tcm', bytes: second.buffer },
        [second.buffer],
      )

      const root = await navigator.storage.getDirectory()
      const dir = await (await root.getDirectoryHandle('history')).getDirectoryHandle('probe')
      const file = await (await dir.getFileHandle('aaaa-000000.tcm')).getFile()
      const back = new Uint8Array(await file.arrayBuffer())

      let same = back.byteLength === sent.byteLength
      if (same) for (let at = 0; at < sent.length; at += 4093) same &&= back[at] === sent[at]

      // The lock: removal is refused while a handle is open on the file, so a removal that
      // succeeds is the proof that the worker closed it.
      let removed = false
      try {
        await dir.removeEntry('aaaa-000000.tcm')
        removed = true
      } catch (cause) {
        removed = false
        return { failure: String(cause) }
      }

      worker.terminate()
      return { first, secondWritten, size: file.size, same, removed, writeMs }
    })

    expect(result.failure, 'the file could not be removed after the write').toBeUndefined()
    expect(result.first).toMatchObject({ type: 'written', id: 1, bytes: 8 * 1024 * 1024 })
    expect(result.secondWritten).toMatchObject({ type: 'written', id: 2, bytes: 4 })
    expect(result.size).toBe(8 * 1024 * 1024)
    expect(result.same, 'the bytes came back changed').toBe(true)
    expect(result.removed).toBe(true)
    // Measured on a warm worker: 9.9–12.7 ms for this size on a free machine, 17–37 with the
    // whole working set running beside it. The bound is ten times the worst of those, and it is
    // not a performance assertion: it is the tripwire on a write that has stopped being one
    // write — a handle reopened per segment, a copy of the file per batch, a read back to check.
    //
    // What it does not catch is a fall back to createWritable, and saying so is the point of
    // measuring: on a file this size and freshly made, createWritable costs 16–19 ms, which is
    // inside any bound this test could keep. Its price is paid on the second visit to a file
    // rather than the first — reopening with keepExistingData copies what is already there into
    // the swap, measured at 3.9, 6.3 and 9.6 ms to add the same megabyte to a file of one, two
    // and three — and a sealed piece is never visited twice. That the pieces stay sealed is what
    // the assertions above hold: one write per file, and no handle left behind after it.
    expect(result.writeMs).toBeLessThan(400)
  } finally {
    await context.close()
  }
})
