/**
 * The one place in the extension that calls createSyncAccessHandle.
 *
 * Measured across four contexts: a dedicated worker has it, a document has not, a SharedWorker
 * has not, and the MV3 service worker has not. Two workers need it — the snapshot of one session
 * and the pieces of the history — and a second copy of these twenty lines would be a second
 * chance to hold the lock a moment too long, which nothing in the program would report.
 *
 * The synchronous handle is not chosen for speed. `createWritable()` writes into a swap file and
 * commits on close: on a full disk it throws and loses everything written before the throw, and
 * reopening it with `keepExistingData` copies the whole file into the swap again — 2.2 ms per
 * megabyte already lying there, which makes appending to a growing file quadratic. The
 * synchronous handle keeps every byte up to the write that failed, and its open costs the same
 * 1.3–2.4 ms whatever the file weighs.
 */

/**
 * The DOM lib knows nothing of the worker-only handle, so its shape is declared here.
 *
 * `write` takes what the standard says it takes — a view over any buffer, shared or not. Narrowed
 * to `BufferSource` it would refuse the plain `Uint8Array` every caller here holds, because that
 * type says nothing about which kind of buffer is under it.
 */
export interface SyncAccessHandle {
  truncate(size: number): void
  write(buffer: AllowSharedBufferSource, options?: { at?: number }): number
  flush(): void
  close(): void
}

type SyncCapableFile = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncAccessHandle>
}

export type SealedWrite =
  | { ok: true; bytes: number }
  | { ok: false; error: string; quota: boolean }

/**
 * Storage has refused because it is full — as opposed to any other way a write can fail.
 *
 * Told apart because the answers differ. A quota refusal is acted on by throwing the batch away
 * and asking the sweeper to make room; anything else is a defect, and retrying it would only
 * write the same failure again. Chrome reports it as a DOMException named QuotaExceededError from
 * `write()` and from `truncate()` alike, and it comes whole: there is no short write, and the
 * file stays at the last size that succeeded.
 */
export function isQuotaError(cause: unknown): boolean {
  return (cause as { name?: unknown } | null)?.name === 'QuotaExceededError'
}

/** Walks down a path, making the directories it names. */
async function directoryFor(parts: string[]): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory()
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
  return dir
}

/**
 * Writes a file whole and lets go of it: open, write, flush, close, all inside this call.
 *
 * The handle does not outlive the write, and that is the whole of the contract. While one is
 * open, this file refuses a second `createSyncAccessHandle`, refuses `createWritable` and —
 * the one that matters — refuses `removeEntry` with NoModificationAllowedError, so a sweeper
 * would silently fail to evict anything of a session that is still recording. Reopening costs
 * 1.3–2.4 ms whatever the file weighs, which buys that back many times over.
 *
 * `flush()` is called although it does not protect against what people expect it to: a SIGKILL
 * of all ten browser processes left an unflushed file whole. It protects against the machine
 * going down, it costs 2.2 ms once per batch rather than once per segment, and without it the
 * file's length is not promised to anybody until the browser feels like promising it — which is
 * exactly what the index row is about to claim.
 */
export async function writeSealed(path: string, bytes: Uint8Array): Promise<SealedWrite> {
  const parts = path.split('/')
  const name = parts.pop()
  if (!name) return { ok: false, error: 'no file name in the path', quota: false }

  let access: SyncAccessHandle | undefined
  try {
    const dir = await directoryFor(parts)
    const handle = (await dir.getFileHandle(name, { create: true })) as SyncCapableFile
    access = await handle.createSyncAccessHandle()

    // One write and one flush. The batch arrived as a single buffer for exactly this: the
    // dispersion of the whole operation is in the flush, and a flush per segment turns a
    // ten-millisecond write into three seconds.
    access.truncate(0)
    const written = access.write(bytes, { at: 0 })
    access.flush()

    return { ok: true, bytes: written }
  } catch (cause) {
    return { ok: false, error: String(cause), quota: isQuotaError(cause) }
  } finally {
    access?.close()
  }
}
