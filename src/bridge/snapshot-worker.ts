import { writeSealed } from './sync-write'

/**
 * The writer of one snapshot: the freeze of §9.2 made into a file.
 *
 * It writes the same way the history does — see sync-write.ts, which holds the one call to
 * createSyncAccessHandle in the extension — and differs from it in life span alone. This worker
 * is created for a freeze and terminated after it (src/bridge/snapshot-writer.ts); the history
 * keeps one for the life of the frame.
 */

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  postMessage(message: unknown): void
}

export type ToSnapshotWorker = { type: 'write'; path: string; bytes: ArrayBuffer }

export type FromSnapshotWorker =
  | { type: 'written'; bytes: number }
  | { type: 'failed'; error: string }

const scope = self as unknown as WorkerScope

/**
 * Carries out one request and always has something to say about it.
 *
 * The same shape as the history worker's `carryOut`, and for a reason of its own. Two steps here
 * can fail outside what `writeSealed` answers for — taking the buffer out of the request, which
 * happens before it is entered, and the `close()` in its `finally`, which is the call that lets go
 * of the lock and sits outside the `try` that turns a failure into an answer. Both reject the
 * promise, and a `.then` without a `.catch` behind it posts nothing at all.
 *
 * What the silence costs differs between the two workers, and here it is the dearer one. The
 * history writer waits for its answer by number and loses every later batch to a request that is
 * never answered; the snapshot loses one file, but it loses it on a click, and the frame that made
 * that click waits out `WRITE_TIMEOUT_MS` — a full minute (src/bridge/snapshot-writer.ts) — before
 * the popup is allowed to say no. The timeout is the answer to a worker that died without a word,
 * which is what it was written for; it should not also be the answer to one that is alive and
 * knows the answer already.
 *
 * `isQuotaError` is not asked, unlike in the history worker: a snapshot is written once on a click
 * and a refusal ends it either way — there is no batch to drop and no backoff to keep.
 */
async function carryOut(request: ToSnapshotWorker): Promise<FromSnapshotWorker> {
  try {
    const result = await writeSealed(request.path, new Uint8Array(request.bytes))
    return result.ok
      ? { type: 'written', bytes: result.bytes }
      : { type: 'failed', error: result.error }
  } catch (cause) {
    return { type: 'failed', error: String(cause) }
  }
}

scope.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as ToSnapshotWorker
  if (request?.type !== 'write') return

  void carryOut(request).then((answer) => scope.postMessage(answer))
})
