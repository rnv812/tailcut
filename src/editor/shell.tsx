import type { Material } from '../core/snapshot/material'
import type { SnapshotReader } from '../core/snapshot/read'
import type { ExportSettings } from '../shared/settings'
import type { SaveOptions } from './export/exporter'
import type { Preview } from './source/preview'
import type { SnapshotFailure } from './source/snapshot'
import { Workbench } from './workbench'

/**
 * What §9.4 has to say to an open editor, read once when the tab opened.
 *
 * It travels with the ready state rather than beside it because it is read before the workbench
 * is shown at all: the template is part of the context every clip is named against, and a context
 * that changed under a session would take the clips with it.
 */
export interface EditorOptions extends SaveOptions {
  /** The template a new clip is named by; absent — the name stage 2 built. */
  nameTemplate?: string
  /**
   * §9.4 as the tab read it when it opened: the whole Export group.
   *
   * The format a new clip is born in, the codec the ladder is asked for, the quality it is asked
   * at, and whether a start off a key frame is rewritten. Four settings that stage 4 gives
   * meaning to, and they arrive together because they are read together — one `readSettings` in
   * `main.tsx`, before the first frame is drawn.
   */
  export?: ExportSettings
}

/** §9.4 with nothing to say: every field of it is optional, so absent and empty are one state. */
const NO_OPTIONS: EditorOptions = {}

export type EditorState =
  | { status: 'opening' }
  | { status: 'failed'; reason: SnapshotFailure }
  | {
      status: 'ready'
      reader: SnapshotReader
      material: Material
      /** 'building' while the preview is being assembled; null when the snapshot has no picture. */
      preview: Preview | 'building' | null
      options?: EditorOptions
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

  return (
    <Workbench
      reader={state.reader}
      material={state.material}
      preview={state.preview}
      options={state.options ?? NO_OPTIONS}
    />
  )
}
