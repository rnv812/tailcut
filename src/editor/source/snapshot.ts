import { isSnapshotId } from '../../shared/protocol'
import { materialOf, type Material } from '../../core/snapshot/material'
import { SnapshotReader } from '../../core/snapshot/read'
import { openSnapshotFile } from './opfs'

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
  const id = new URLSearchParams(search).get('s') ?? ''
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
