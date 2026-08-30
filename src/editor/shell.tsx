import type { Material } from '../core/snapshot/material'
import type { SnapshotReader } from '../core/snapshot/read'
import type { ExportSettings } from '../shared/settings'
import type { SaveOptions } from './export/exporter'
import type { Preview } from './source/preview'
import type { SnapshotFailure } from './source/snapshot'
import { Workbench } from './workbench'

export type EditorFailure = SnapshotFailure | 'open-failed' | 'preview-failed'

export type PreviewState = Preview | 'building' | 'failed' | null

/**
 * What §9.4 has to say to an open editor, read once when the tab opened.
 *
 * It travels with the ready state rather than beside it because it is read before the workbench
 * is shown at all: the template is part of the context every clip is named against, and a context
 * that changed under a session would take the clips with it.
 */
export interface EditorOptions extends SaveOptions {
  /**
   * §9.4 as the tab read it when it opened: the whole Export group, and not a field of it.
   *
   * The template a new clip is named by, the format it is born in, the codec the ladder is asked
   * for, the quality it is asked at, and whether a start off a key frame is rewritten. They
   * arrive together because they are read together — one `readSettings` in `main.tsx`, before the
   * first frame is drawn — and they travel on as one group for a second reason: two of them reach
   * the model, one of them shows on the screen, and a group handed over field by field is a group
   * that can lose the invisible one in silence. Absent — a tab that read no settings at all.
   */
  export?: ExportSettings
}

/** §9.4 with nothing to say: every field of it is optional, so absent and empty are one state. */
const NO_OPTIONS: EditorOptions = {}

export type EditorState =
  | { status: 'opening' }
  | { status: 'failed'; reason: EditorFailure }
  | {
      status: 'ready'
      reader: SnapshotReader
      material: Material
      /** `null` means no picture; `failed` means picture exists but no preview could be assembled. */
      preview: PreviewState
      options?: EditorOptions
    }

/**
 * What the editor says when there is nothing to edit.
 *
 * Every refusal gets its own sentence. A blank screen would make a reclaimed snapshot, an
 * interrupted write, a bad address and an assembly failure look alike, although each needs a
 * different response.
 */
export const FAILURE_TEXT: Record<EditorFailure, string> = {
  'no-id': 'This page opens from the tailcut popup. Press Edit on a recording to open it here.',
  missing:
    'This recording is no longer in storage. The browser reclaims space on its own, and a snapshot is not kept forever.',
  unfinished:
    'This recording was not finished being written. It was interrupted partway, and there is nothing to open.',
  empty: 'This recording holds no material to edit yet.',
  'open-failed':
    'tailcut could not open this recording because storage or editor settings could not be read.',
  'preview-failed':
    'tailcut could not build a preview from this recording. Its picture material may be incomplete.',
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
