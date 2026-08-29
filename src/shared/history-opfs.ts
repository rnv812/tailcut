import { HISTORY_DIR, PIECE_SUFFIX } from './history-files'
import { SNAPSHOT_DIR, snapshotFileName } from './protocol'

/**
 * What is actually on the disk, as opposed to what the index says is there.
 *
 * Asked in exactly two places: by the repair at start-up, which is where the two are reconciled,
 * and by removal, which is the sweeper's. Nothing else walks OPFS — the occupied volume is a
 * running sum in the index, because a walk of 300 directories and 1800 files costs 685–1086 ms
 * and §9.2 promises a popup that computes nothing.
 */
export interface PieceFile {
  name: string
  size: number
  /** Wall clock. How the repair tells an orphan from a file being written right now. */
  lastModified: number
}

async function directory(
  path: readonly string[],
  create = false,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    let dir = await navigator.storage.getDirectory()
    for (const part of path) dir = await dir.getDirectoryHandle(part, { create })
    return dir
  } catch {
    // Nothing has ever been written, or storage refused: an empty answer, not an exception. Every
    // caller here is a tidy-up, and a tidy-up that throws stops the one after it.
    return null
  }
}

async function filesIn(dir: FileSystemDirectoryHandle): Promise<PieceFile[]> {
  const files: PieceFile[] = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue
    try {
      const file = await (handle as FileSystemFileHandle).getFile()
      files.push({ name, size: file.size, lastModified: file.lastModified })
    } catch {
      // Being written at this very moment, or gone between the listing and the read. Left out:
      // the repair may not act on what it could not measure.
    }
  }
  return files
}

export async function listSessionIds(): Promise<string[]> {
  const root = await directory([HISTORY_DIR])
  if (!root) return []

  const ids: string[] = []
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === 'directory') ids.push(name)
  }
  return ids
}

export async function listPieceFiles(id: string): Promise<PieceFile[]> {
  const dir = await directory([HISTORY_DIR, id])
  if (!dir) return []
  return (await filesIn(dir)).filter((file) => file.name.endsWith(PIECE_SUFFIX))
}

/**
 * Removes one piece. False — it would not go.
 *
 * The one refusal that happens in practice is a synchronous handle open on the file, which
 * answers NoModificationAllowedError: a piece is written and let go inside one operation
 * (sync-write.ts), so this is a race of milliseconds rather than a state — and the answer to it
 * is to keep the row and come back next time.
 */
export async function removePiece(id: string, file: string): Promise<boolean> {
  const dir = await directory([HISTORY_DIR, id])
  if (!dir) return false
  try {
    await dir.removeEntry(file)
    return true
  } catch {
    return false
  }
}

export async function removeSessionFiles(id: string): Promise<boolean> {
  const root = await directory([HISTORY_DIR])
  if (!root) return false
  try {
    await root.removeEntry(id, { recursive: true })
    return true
  } catch {
    return false
  }
}

export async function listSnapshotFiles(): Promise<PieceFile[]> {
  const dir = await directory([SNAPSHOT_DIR])
  return dir ? filesIn(dir) : []
}

export async function removeSnapshotFile(id: string): Promise<boolean> {
  const dir = await directory([SNAPSHOT_DIR])
  if (!dir) return false
  try {
    await dir.removeEntry(snapshotFileName(id))
    return true
  } catch {
    return false
  }
}

/** Everything, gone: the `Clear` of §9.4, next to the volume it clears. */
export async function clearStorage(): Promise<void> {
  const root = await navigator.storage.getDirectory().catch(() => null)
  if (!root) return
  for (const name of [HISTORY_DIR, SNAPSHOT_DIR]) {
    await root.removeEntry(name, { recursive: true }).catch(() => undefined)
  }
}
