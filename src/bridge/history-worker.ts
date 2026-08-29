import { isQuotaError, writeSealed } from './sync-write'

/**
 * The writer of the history: one piece per batch, one file per piece, nothing ever revised.
 *
 * It lives as long as the frame does, unlike the snapshot worker, which is created for one freeze
 * and terminated after it. A worker per batch would cost a start-up of its own every two seconds
 * on a page that is recording; a worker per frame costs one, and it is started only by a frame
 * that has something to write.
 */

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  postMessage(message: unknown): void
}

export type ToHistoryWorker = {
  type: 'write'
  /**
   * Which write this is. The answer carries it back, so a writer that ever has two batches in
   * flight can tell the answers apart — today it never does, and this is what makes that a fact
   * rather than an assumption nobody wrote down.
   */
  id: number
  path: string
  bytes: ArrayBuffer
}

export type FromHistoryWorker =
  | { type: 'written'; id: number; bytes: number }
  /** `quota` — storage is full: the batch is dropped and the sweeper is asked for room. */
  | { type: 'failed'; id: number; error: string; quota: boolean }

const scope = self as unknown as WorkerScope

/**
 * Carries out one request and always has something to say about it.
 *
 * Every step is inside the one `try`, and that is the point of the shape rather than caution.
 * The caller of this worker is a queue of one that waits for the answer by number (`HistoryWriter`
 * in src/bridge/history-writer.ts): a request answered by nothing does not lose one batch, it
 * stops every later batch of every session for the life of the frame, on a page that goes on
 * playing and reports nothing. Two steps here can fail outside what `writeSealed` answers for —
 * taking the buffer out of the request, which happens before it is entered, and the `close()` in
 * its `finally`, which is the call that lets go of the lock and sits outside the `try` that turns
 * a failure into an answer. Both reject the promise, and both used to reach nobody.
 *
 * `isQuotaError` is asked here too, because a refusal thrown while the handle is being closed is
 * still a full disk, and the writer answers a full disk by waiting rather than by giving up.
 */
async function carryOut(request: ToHistoryWorker): Promise<FromHistoryWorker> {
  try {
    const result = await writeSealed(request.path, new Uint8Array(request.bytes))
    return result.ok
      ? { type: 'written', id: request.id, bytes: result.bytes }
      : { type: 'failed', id: request.id, error: result.error, quota: result.quota }
  } catch (cause) {
    return { type: 'failed', id: request.id, error: String(cause), quota: isQuotaError(cause) }
  }
}

scope.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as ToHistoryWorker
  if (request?.type !== 'write') return

  void carryOut(request).then((answer) => scope.postMessage(answer))
})
