/**
 * The one place in the extension that calls createSyncAccessHandle.
 *
 * Measured across four contexts: a dedicated worker has it, a document has not, a SharedWorker
 * has not, and the MV3 service worker has not. So the coordinator of sessions cannot write the
 * snapshot even though it is the natural place for it — only this file can.
 *
 * The synchronous handle is not chosen for speed. `createWritable()` writes into a swap file and
 * commits on close: on a full disk it throws and loses everything written before the throw, which
 * on a hundred-megabyte batch is the whole batch. The synchronous handle keeps every byte up to
 * the write that failed, and the file stays readable.
 */

/** The DOM lib knows nothing of the worker-only handle, so its shape is declared here. */
interface SyncAccessHandle {
  truncate(size: number): void
  write(buffer: BufferSource, options?: { at?: number }): number
  flush(): void
  close(): void
}

type SyncCapableFile = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncAccessHandle>
}

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  postMessage(message: unknown): void
}

export type ToSnapshotWorker = { type: 'write'; path: string; bytes: ArrayBuffer }

export type FromSnapshotWorker =
  | { type: 'written'; bytes: number }
  | { type: 'failed'; error: string }

const scope = self as unknown as WorkerScope

/** Walks down a path, making the directories it names. */
async function directoryFor(parts: string[]): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory()
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
  return dir
}

async function write(request: ToSnapshotWorker): Promise<FromSnapshotWorker> {
  const parts = request.path.split('/')
  const name = parts.pop()
  if (!name) return { type: 'failed', error: 'no file name in the path' }

  let access: SyncAccessHandle | undefined
  try {
    const dir = await directoryFor(parts)
    const handle = (await dir.getFileHandle(name, { create: true })) as SyncCapableFile
    access = await handle.createSyncAccessHandle()

    // One write and one flush. The batch arrived as a single buffer for exactly this: the
    // dispersion of the whole operation is in the flush, and a flush per segment turns a
    // hundred-millisecond write into three seconds.
    access.truncate(0)
    const written = access.write(new Uint8Array(request.bytes), { at: 0 })
    access.flush()

    return { type: 'written', bytes: written }
  } catch (cause) {
    return { type: 'failed', error: String(cause) }
  } finally {
    // Closing releases the exclusive lock. Left open, it refuses a second writer and refuses the
    // sweeper that removes old snapshots — with NoModificationAllowedError and no explanation.
    access?.close()
  }
}

scope.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as ToSnapshotWorker
  if (request?.type !== 'write') return
  void write(request).then((result) => scope.postMessage(result))
})
