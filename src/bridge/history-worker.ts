import { writeSealed } from './sync-write'

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

scope.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as ToHistoryWorker
  if (request?.type !== 'write') return

  void writeSealed(request.path, new Uint8Array(request.bytes)).then((result) => {
    const answer: FromHistoryWorker = result.ok
      ? { type: 'written', id: request.id, bytes: result.bytes }
      : { type: 'failed', id: request.id, error: result.error, quota: result.quota }
    scope.postMessage(answer)
  })
})
