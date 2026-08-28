import type { Material } from '../core/snapshot/material'
import type { SnapshotReader } from '../core/snapshot/read'
import type { Preview } from './source/preview'
import type { SnapshotFailure } from './source/snapshot'
import { Workbench } from './workbench'

export type EditorState =
  | { status: 'opening' }
  | { status: 'failed'; reason: SnapshotFailure }
  | {
      status: 'ready'
      reader: SnapshotReader
      material: Material
      /** 'building' while the preview is being assembled; null when the snapshot has no picture. */
      preview: Preview | 'building' | null
    }

/**
 * What the editor says when there is nothing to edit.
 *
 * Four states and four sentences. A blank screen would be the same screen for a snapshot the
 * browser reclaimed, a write that was cut off and an address somebody typed — and the three want
 * three different things done about them.
 */
export const FAILURE_TEXT: Record<SnapshotFailure, string> = {
  'no-id': 'This page opens from the tailcut popup. Press Edit on a recording to open it here.',
  missing:
    'This recording is no longer in storage. The browser reclaims space on its own, and a snapshot is not kept forever.',
  unfinished:
    'This recording was not finished being written. It was interrupted partway, and there is nothing to open.',
  empty: 'This recording holds no material to edit yet.',
}

export function Shell({ state }: { state: EditorState }) {
  if (state.status === 'opening') {
    return <div class="pad muted">Opening the recording…</div>
  }

  if (state.status === 'failed') {
    return (
      <div class="pad failure" data-testid="failure" role="alert">
        {FAILURE_TEXT[state.reason]}
      </div>
    )
  }

  return <Workbench reader={state.reader} material={state.material} preview={state.preview} />
}
