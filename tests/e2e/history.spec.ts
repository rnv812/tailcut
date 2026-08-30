import { test, expect, type Frame, type Page } from '@playwright/test'
import {
  HISTORY_BATCH_BYTES,
  newWriterId,
  pieceName,
  piecePath,
  sessionDir,
} from '../../src/shared/history-files'
import {
  exportFirstClip,
  launchWithExtension,
  openExtensionPage,
  openPopupOn,
  probeFile,
  serveLocal,
  watchOn,
} from './helpers'

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
 * The writer in front of this worker sends one batch at a time and waits for the
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

/**
 * The bridge stands as a cross-origin frame inside somebody else's page, and Chrome partitions
 * third-party storage by the top-level site. Everything this stage is built on assumes that an
 * extension frame is not third-party to itself: one index, written by whichever frame is
 * recording, read by the popup, the sweeper and the editor alike.
 *
 * If this ever fails, the fallback is a message to the service worker per batch, and it belongs
 * in the plan rather than in a hurry.
 *
 * A database of its own and not `tailcut-history`, for two reasons that pull the same way. The
 * question is about the browser and not about our schema, so the probe carries the smallest store
 * that can answer it and creates that store itself — opened without an upgrade, a fresh profile
 * gives back a database with nothing in it and every transaction fails with NotFoundError. And
 * the pages here are recording: a store-less `tailcut-history` left at version 1 is exactly what
 * `openHistoryDb` then opens without an upgrade, so the probe would break the writing it stands
 * beside.
 */
test('the index a bridge frame writes is the index every other context reads', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const first = await context.newPage()
    await serveLocal(first, 'player.html', 'https://one.test/watch')

    const bridgeOf = async (page: Page) => {
      await page.waitForFunction(() =>
        [...document.querySelectorAll('iframe')].some((frame) => frame.dataset.tailcut === 'bridge'),
      )
      const frame = page.frames().find((one) => one.url().startsWith('chrome-extension://'))
      if (!frame) throw new Error('the bridge frame is not there')
      return frame
    }

    const write = async (frame: Frame, value: string) =>
      frame.evaluate(async (mark) => {
        const db: IDBDatabase = await new Promise((resolve, reject) => {
          const request = indexedDB.open('tailcut-partition-probe', 1)
          request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'id' })
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })
        await new Promise((resolve, reject) => {
          const tx = db.transaction('sessions', 'readwrite')
          tx.objectStore('sessions').put({ id: 'probe', key: mark, url: '', title: mark })
          tx.oncomplete = resolve
          tx.onerror = () => reject(tx.error)
        })
        db.close()
      }, value)

    const read = (target: Frame | Page) =>
      target.evaluate(async () => {
        const db: IDBDatabase = await new Promise((resolve, reject) => {
          const request = indexedDB.open('tailcut-partition-probe', 1)
          request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'id' })
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })
        const row = await new Promise<{ title?: string } | undefined>((resolve, reject) => {
          const request = db.transaction('sessions').objectStore('sessions').get('probe')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })
        db.close()
        return row?.title
      })

    await write(await bridgeOf(first), 'written by one.test')

    // A frame of another site: partitioning, if it applied, would give this one a store of its own.
    const second = await context.newPage()
    await serveLocal(second, 'player.html', 'https://two.test/watch')
    expect(await read(await bridgeOf(second))).toBe('written by one.test')

    // And a page of the extension itself, which is what the popup and the sweeper are.
    const own = await openExtensionPage(context, extensionId, 'popup/popup.html')
    expect(await read(own)).toBe('written by one.test')
  } finally {
    await context.close()
  }
})

/** The index as it stands, read from a page of the extension — which is what a reader here is. */
const indexOn = (reader: Page) =>
  reader.evaluate(async () => {
    const address = '/shared/history-db.js'
    const { listSessions, readTotals }: typeof import('../../src/shared/history-db') =
      await import(address)
    return { sessions: await listSessions(), totals: await readTotals() }
  })

test('what a tab recorded is in the index after that tab is gone', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await context.newPage()
    await watchOn(page, 'player.html', 'https://one.test/watch', 12)
    const title = await page.title()

    const reader = await openExtensionPage(context, extensionId, 'popup/popup.html')
    const listed = await indexOn(reader)

    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0]!.title).toBe(title)
    // Six seconds of material out of twelve seconds of watching: a length is media time and never
    // wall clock. The page holds one clip and looped it through, and a session that counted the
    // watching would say twice what it can offer — which is the number the popup shows and the
    // stretch the editor opens over.
    expect(listed.sessions[0]!.seconds).toBeGreaterThan(4)
    expect(listed.sessions[0]!.seconds).toBeLessThan(8)
    expect(listed.sessions[0]!.bytes).toBeGreaterThan(0)
    expect(listed.sessions[0]!.tracks.length).toBeGreaterThan(0)
    // The size of the player, measured by triage on the page and carried down the whole road —
    // watcher, content script, bridge, registry, batch, row. Opening it is a value signal that a
    // recording is worth keeping, and the fixture states it: <video width="640">.
    expect(listed.sessions[0]!.widthPx).toBe(640)
    expect(listed.totals.bytes).toBe(listed.sessions[0]!.bytes)

    await page.close()

    // The same video in a second tab merges into the same session: one row, one directory, and the
    // material of both tabs in it.
    const again = await context.newPage()
    await watchOn(again, 'player.html', 'https://one.test/watch', 12)
    await again.close()

    const after = (await indexOn(reader)).sessions
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(listed.sessions[0]!.id)
    // And the material of the second tab is in it. Its frame has a map of its own, so it wrote
    // its own copy of the stretch and the row grew by it — which is also what tells a merge apart
    // from a second row the unique key simply refused.
    expect(after[0]!.bytes).toBeGreaterThan(listed.sessions[0]!.bytes)
    // And it is still one recording long: the two tabs wrote the same stretch twice, and the
    // length of a session is what it covers and not what was written into it.
    expect(after[0]!.seconds).toBeLessThan(8)
  } finally {
    await context.close()
  }
})

/**
 * This holds discontinuous-media behavior across the whole path, not only in the map.
 *
 * A page hands the same stretch over twice as a matter of course — a rewatch, a seek back, a
 * player refilling a buffer it had let go of — and the fixture does it on demand: the same init
 * and the same three segments, a second time, into the buffer that is playing. None of it is new
 * material and none of it may reach the disk. Written down, the same seconds would be paid for
 * twice in the volume the popup shows and counted twice in the length of the session.
 *
 * The map that feeds the writer is what refuses them (`PtsMap.insert` answers whether it took the
 * chunk), and the unit set states that rule over the map. What this adds is the road: the hook
 * copies those bytes, the registry judges them, and the writer must be told nothing at all.
 */
test('a stretch handed over a second time is not written down a second time', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await context.newPage()
    await watchOn(page, 'player.html', 'https://one.test/watch', 10)

    const reader = await openExtensionPage(context, extensionId, 'popup/popup.html')
    const before = await indexOn(reader)
    expect(before.sessions, 'setup: nothing was recorded to hand over again').toHaveLength(1)
    expect(before.sessions[0]!.bytes).toBeGreaterThan(0)

    await page.evaluate(() =>
      (window as unknown as { tcAppendAgain(): Promise<void> }).tcAppendAgain(),
    )
    // Longer than the tail the writer gathers a batch for, so that a piece this produced would
    // have landed rather than be still in hand.
    await page.waitForTimeout(4_000)
    const after = await indexOn(reader)
    await page.close()

    expect(after.sessions[0]!.bytes, 'a second viewing went to disk a second time').toBe(
      before.sessions[0]!.bytes,
    )
    expect(after.sessions[0]!.seconds).toBe(before.sessions[0]!.seconds)
    expect(after.totals.bytes, 'the volume grew for material that was already there').toBe(
      before.totals.bytes,
    )
  } finally {
    await context.close()
  }
})

/**
 * The key of this session changes while it is being recorded: the page states the length of the
 * video shortly after the first segments are stored, as a real player does.
 * One video, one row — the halves must not end up apart.
 *
 * So the page is made to have two halves. It states the length long after its picture has landed,
 * and then goes on delivering: six more seconds in another representation, which is the quality
 * quality switch and the ordinary thing for a player to do after reading its
 * manifest. Without that second half there is nothing here that could come apart — the picture is
 * on disk before the move and stays there whatever the row is called afterwards, and the test
 * would be saying only that a rename renames.
 */
test('a session whose key changes on the fly stays one row', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await context.newPage()
    await watchOn(page, 'player.html', 'https://one.test/watch', 6)

    // Long after the first batches: this is the state the writer has to survive, not the one
    // where nothing has landed yet.
    await page.evaluate(() => {
      const source = (window as unknown as { tcPlayerSource?: MediaSource }).tcPlayerSource
      if (source) source.duration = 6.845
    })
    await page.waitForTimeout(3_000)

    // The second half, after the move and after the row that holds the first half is on disk.
    await page.evaluate(() =>
      (window as unknown as { tcAppendMore(): Promise<void> }).tcAppendMore(),
    )
    await page.waitForTimeout(6_000)
    await page.close()

    const reader = await openExtensionPage(context, extensionId, 'popup/popup.html')
    const sessions = await reader.evaluate(async () => {
      const address = '/shared/history-db.js'
      const { listSessions }: typeof import('../../src/shared/history-db') =
        await import(address)
      return listSessions()
    })

    expect(sessions, 'the halves of one video ended up in two rows').toHaveLength(1)
    // Under the key the length gave it, not the one that said `live`: the row followed.
    expect(sessions[0]!.key).toMatch(/\|7$/)
    // And the second half is in that row. Six seconds of picture arrived before the move and six
    // after it; a row holding only what came first would say six, and a second row for the rest
    // is what the assertion above would then be counting.
    expect(sessions[0]!.seconds, 'the material written after the move went elsewhere').toBeGreaterThan(8)
    expect(sessions[0]!.tracks.length, 'the switch after the move opened no track here').toBe(2)
  } finally {
    await context.close()
  }
})

/**
 * The complete persisted-history path in a browser: a recording from a closed tab, listed
 * in a popup opened over a page that never played anything, pinned, deleted, put back — and the
 * quick switch beside it.
 *
 * Every one of those crosses a boundary no unit set has: the index is IndexedDB written by a
 * bridge frame and read by the popup, and the pause travels the extension message, the content
 * script, the port and back.
 */
test('the popup lists what an earlier tab recorded, pins it and deletes it', async () => {
  test.setTimeout(90_000)

  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await context.newPage()
    await watchOn(page, 'player.html', 'https://one.test/watch', 12)
    await page.close()

    // A page with nothing on it: the history is what this popup has to show.
    const blank = await context.newPage()
    await serveLocal(blank, 'empty.html', 'https://two.test/empty')
    const popup = await openPopupOn(context, blank, extensionId)

    await expect(popup.getByTestId('history-row')).toHaveCount(1)
    await popup.getByTestId('history-pin').click()
    await expect(popup.getByTestId('history-pin')).toHaveText('Pinned')

    await popup.getByTestId('history-delete').click()
    await expect(popup.getByTestId('history-row')).toHaveCount(0)
    await popup.getByTestId('undo').getByRole('button').click()
    await expect(popup.getByTestId('history-row')).toHaveCount(1)

    // The quick switch, in a real browser and through the real channel: the button changes its
    // label only if the frame answered. A handler that returned without writing into the port
    // leaves this line as it was, and nothing else in the run would ever notice.
    await popup.getByTestId('pause-tab').click()
    await expect(popup.getByTestId('pause-tab')).toHaveText('Resume on this page')
  } finally {
    await context.close()
  }
})

/**
 * The whole point of keeping anything on disk: a recording of a tab that is gone opens in the
 * editor and comes out as a file, and not one byte of it is copied on the way.
 *
 * Everything below the popup is new ground for a browser. The index is built out of rows in
 * IndexedDB rather than read out of a snapshot's footer, the material is read out of the pieces
 * the recording left in OPFS, and the frame table, the preview and the export all stand on that
 * as if it were one file.
 *
 * What it does not prove is the seam: this fixture hands its material over in one burst, so one
 * batch holds all of it and the session is a single piece — measured, and the reason the read
 * that spans two files is checked where it can be arranged, in tests/core/stores.test.ts and in
 * tests/editor/history-source.test.ts. Cutting the address space here down to its first file
 * leaves this test green, and that is a true statement about this fixture rather than about
 * `composeStores`. What only a browser can say is the rest: that OPFS gives the bytes back by
 * path, that an index built out of rows carries a decoder through a frame table, and that what
 * ffprobe opens at the end is video.
 */
test('a recording of the history opens in the editor and comes out as a file', async () => {
  test.setTimeout(120_000)

  const { context, extensionId } = await launchWithExtension()

  try {
    const page = await context.newPage()
    await watchOn(page, 'player.html', 'https://one.test/watch', 20)
    await page.close()

    const blank = await context.newPage()
    await serveLocal(blank, 'empty.html', 'https://two.test/empty')
    const popup = await openPopupOn(context, blank, extensionId)

    const [editor] = await Promise.all([
      context.waitForEvent('page'),
      popup.getByTestId('history-open').click(),
    ])
    await editor.waitForLoadState()

    // The material is read straight out of the pieces: no snapshot file was written for this.
    const snapshots = await editor.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const names: string[] = []
      try {
        const dir = await root.getDirectoryHandle('snapshots')
        for await (const [name] of dir.entries()) names.push(name)
      } catch {
        // No snapshots directory at all is the same answer as an empty one.
      }
      return names
    })
    expect(snapshots).toEqual([])

    // The editor stood up over the pieces: the frame counter is the first thing it can only show
    // once it has read a frame table out of the material.
    await expect(editor.getByTestId('frame-count')).toBeVisible()
    const file = await exportFirstClip(editor)
    const probed = probeFile(file)
    expect(probed.streams[0]!.codec_name).toBe('h264')
    expect(Number(probed.format.duration)).toBeGreaterThan(1)
  } finally {
    await context.close()
  }
})
