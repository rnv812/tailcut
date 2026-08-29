import { readRangeIn } from '../../shared/history-opfs'
import { composeStores, type StoreFile } from '../../core/snapshot/stores'
import { SNAPSHOT_DIR, snapshotFileName } from '../../shared/protocol'
import type { ReadRange } from '../../core/snapshot/read'

export interface OpenFile {
  read: ReadRange
  size: number
}

/**
 * Opens the snapshot for reading, by ranges.
 *
 * A Blob and slices of it, in the document, with no worker: the file is immutable from the moment
 * its footer was written, so a Blob over it stays valid, several tabs may read it at once, and
 * nothing here can block the writer or the sweeper. A synchronous handle would be a shade faster
 * — 1.4 ms against 19.7 on ten ranges — and would take an exclusive lock on the file, which is
 * the wrong trade for a tab that is left open for half an hour.
 *
 * null means there is no such file. Storage is best-effort — `persisted()` is false and
 * `persist()` refuses, `unlimitedStorage` or not — so a snapshot really can be gone by the time
 * the tab opens, and that is a state to show rather than an error to throw.
 */
export async function openSnapshotFile(id: string): Promise<OpenFile | null> {
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(SNAPSHOT_DIR)
    const handle = await dir.getFileHandle(snapshotFileName(id))
    const file = await handle.getFile()

    return {
      size: file.size,
      read: async (at: number, length: number) =>
        new Uint8Array(await file.slice(at, at + length).arrayBuffer()),
    }
  } catch {
    return null
  }
}

/**
 * Opens the pieces of a history session as one run of bytes.
 *
 * No snapshot file is written for this: the index was built out of the rows, and the material
 * stays exactly where the recording left it. What the editor gets is the same `ReadRange` a
 * snapshot gives it, over an address space made of files (src/core/snapshot/stores.ts).
 */
export function openHistoryStores(stores: readonly StoreFile[]): ReadRange {
  return composeStores(stores, (path, at, length) => readRangeIn(path, at, length))
}
