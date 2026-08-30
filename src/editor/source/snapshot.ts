import { isSnapshotId } from '../../shared/protocol'
import { historyIndexOf } from '../../core/history/index'
import { piecesOf, sessionById, setUsed } from '../../shared/history-db'
import { materialOf, type Material } from '../../core/snapshot/material'
import { SnapshotReader } from '../../core/snapshot/read'
import { openHistoryStores, openSnapshotFile } from './opfs'

/**
 * Why the editor has nothing to show. Four distinct answers, because they ask four different
 * things of the user: open the editor from the popup, record again, record again after a crash,
 * watch something before cutting it.
 */
export type SnapshotFailure = 'no-id' | 'missing' | 'unfinished' | 'empty'

export type LoadedSnapshot =
  | { ok: true; reader: SnapshotReader; material: Material }
  | { ok: false; reason: SnapshotFailure }

export async function loadSnapshot(search: string): Promise<LoadedSnapshot> {
  const params = new URLSearchParams(search)

  // Two doors, and the address says which. `h` is a recording of the history, read out of the
  // index and the pieces on disk; `s` is a snapshot file written by the freeze of a page.
  const history = params.get('h')
  if (history) return loadHistory(history)

  const id = params.get('s') ?? ''
  // The identifier goes straight into a file name, so only the shape the extension itself mints
  // is accepted: a typed address is not a way into the rest of the storage.
  if (!isSnapshotId(id)) return { ok: false, reason: 'no-id' }

  const file = await openSnapshotFile(id)
  if (!file) return { ok: false, reason: 'missing' }

  const reader = await SnapshotReader.open(file.read, file.size)
  // The footer is written last, so a file without a sound one is a write that was cut off: the
  // tab was closed, or the browser stopped in the middle. There is no half-snapshot to salvage.
  if (!reader) return { ok: false, reason: 'unfinished' }

  const material = materialOf(reader.index)
  if (!material.video && !material.audio) return { ok: false, reason: 'empty' }

  return { ok: true, reader, material }
}

async function loadHistory(id: string): Promise<LoadedSnapshot> {
  // The identifier travels through the address bar and from there into a path, so only the shape
  // the extension itself mints is accepted.
  if (!isSnapshotId(id)) return { ok: false, reason: 'no-id' }

  const session = await sessionById(id).catch(() => undefined)
  // Swept out under an address the user had open, or an index that would not open at all.
  if (!session || session.deletedAt) return { ok: false, reason: 'missing' }

  const pieces = await piecesOf(id).catch(() => [])
  const composed = historyIndexOf(session, pieces, {
    capturedAt: Date.now(),
    producer: `tailcut ${chrome.runtime.getManifest().version}`,
  })
  if (!composed.index.tracks.length) return { ok: false, reason: 'empty' }

  const reader = SnapshotReader.over(openHistoryStores(composed.stores), composed.index)
  const material = materialOf(reader.index)
  if (!material.video && !material.audio) return { ok: false, reason: 'empty' }

  // Opening the editor over a recording is the user saying "this one" out loud, which puts
  // such a session second only to what is pinned. It is also what keeps the sweeper from taking
  // the material out from under an editing session. It is a value signal, not a lock.
  void setUsed(id, Date.now()).catch(() => undefined)

  return { ok: true, reader, material }
}
