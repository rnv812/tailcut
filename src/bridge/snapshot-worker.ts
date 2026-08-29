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

scope.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as ToSnapshotWorker
  if (request?.type !== 'write') return

  void writeSealed(request.path, new Uint8Array(request.bytes)).then((result) => {
    const answer: FromSnapshotWorker = result.ok
      ? { type: 'written', bytes: result.bytes }
      : { type: 'failed', error: result.error }
    scope.postMessage(answer)
  })
})
