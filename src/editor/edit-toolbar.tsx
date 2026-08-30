import type { ComponentChildren } from 'preact'
import { ZOOM_KEY_STEP } from '../core/edit/keymap'
import type { SessionAction } from '../core/edit/session'
import { formatTimecode } from '../core/timeline/timecode'
import { Icon, type IconName } from './icon'

export interface EditToolbarSelection {
  in: number
  out: number
}

export interface EditToolbarProps {
  selected: boolean
  selection?: EditToolbarSelection | null
  /** Source frame rate. The timecode formatter applies the project's fallback when omitted. */
  fps?: number
  snapping: boolean
  canUndo: boolean
  canRedo: boolean
  dispatch: (action: SessionAction) => void
  onHelp: () => void
}

interface ToolButtonProps {
  testId: string
  title: string
  disabled?: boolean
  pressed?: boolean
  icon: IconName
  onClick: () => void
  children?: ComponentChildren
}

function ToolButton({
  testId,
  title,
  disabled = false,
  pressed,
  icon,
  onClick,
  children,
}: ToolButtonProps) {
  return (
    <button
      type="button"
      class="tc-edit-tool"
      data-testid={testId}
      title={title}
      aria-label={title}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <Icon name={icon} />
      {children && <span>{children}</span>}
    </button>
  )
}

export function EditToolbar({
  selected,
  selection,
  fps = 0,
  snapping,
  canUndo,
  canRedo,
  dispatch,
  onHelp,
}: EditToolbarProps) {
  return (
    <section class="tc-edit-tools" aria-label="Edit tools" data-testid="edit-toolbar">
      <p class="tc-edit-workflow" data-testid="edit-workflow">
        1. Move the playhead · 2. Mark or split a clip · 3. Export your clips
      </p>

      {selection ? (
        <dl class="tc-edit-selection" data-testid="selection-summary" aria-label="Selected clip range">
          <div>
            <dt>In</dt>
            <dd data-testid="selection-in">{formatTimecode(selection.in, fps)}</dd>
          </div>
          <div>
            <dt>Out</dt>
            <dd data-testid="selection-out">{formatTimecode(selection.out, fps)}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd data-testid="selection-duration">
              {formatTimecode(selection.out - selection.in, fps)}
            </dd>
          </div>
        </dl>
      ) : (
        <p class="tc-edit-no-selection" data-testid="no-selection">
          Previewing the whole recording. Move the playhead, then use Set In to start a clip.
        </p>
      )}

      <div class="tc-edit-tool-row">
        <div class="tc-edit-tool-group" role="group" aria-label="Clip editing">
          <ToolButton
            testId="new-clip"
            title="Create a new clip at the playhead"
            icon="plus"
            onClick={() => dispatch({ type: 'addClip' })}
          >
            New clip
          </ToolButton>
          <ToolButton
            testId="split"
            title="Split the selected clip at the playhead (S)"
            icon="split"
            disabled={!selected}
            onClick={() => dispatch({ type: 'splitClip' })}
          />
          <ToolButton
            testId="add-marker"
            title="Add a marker at the playhead (M)"
            icon="marker"
            onClick={() => dispatch({ type: 'addMarker' })}
          />
          <ToolButton
            testId="delete-clip"
            title="Delete the selected clip (Delete)"
            icon="trash"
            disabled={!selected}
            onClick={() => dispatch({ type: 'removeClip' })}
          />
        </div>

        <div class="tc-edit-tool-group" role="group" aria-label="History">
          <ToolButton
            testId="undo"
            title="Undo (Ctrl+Z)"
            icon="undo"
            disabled={!canUndo}
            onClick={() => dispatch({ type: 'undo' })}
          />
          <ToolButton
            testId="redo"
            title="Redo (Ctrl+Shift+Z or Ctrl+Y)"
            icon="redo"
            disabled={!canRedo}
            onClick={() => dispatch({ type: 'redo' })}
          />
        </div>

        <div class="tc-edit-tool-group" role="group" aria-label="Timeline view">
          <ToolButton
            testId="zoom-out"
            title="Zoom out around the playhead (−)"
            icon="zoom-out"
            onClick={() => dispatch({ type: 'zoomStep', factor: ZOOM_KEY_STEP })}
          />
          <ToolButton
            testId="fit-selection"
            title="Fit the selected clip (Z)"
            icon="fit-selection"
            disabled={!selected}
            onClick={() => dispatch({ type: 'zoomToSelection' })}
          />
          <ToolButton
            testId="fit-all"
            title="Fit the whole recording (F)"
            icon="fit-all"
            onClick={() => dispatch({ type: 'fitAll' })}
          />
          <ToolButton
            testId="zoom-in"
            title="Zoom in around the playhead (+)"
            icon="zoom-in"
            onClick={() => dispatch({ type: 'zoomStep', factor: 1 / ZOOM_KEY_STEP })}
          />
        </div>

        <div class="tc-edit-tool-group" role="group" aria-label="Editor options">
          <ToolButton
            testId="toggle-snapping"
            title={`Turn timeline snapping ${snapping ? 'off' : 'on'} (N)`}
            icon="snap"
            pressed={snapping}
            onClick={() => dispatch({ type: 'toggleSnapping' })}
          />
          <ToolButton
            testId="keyboard-help"
            title="Open keyboard shortcuts (?)"
            icon="help"
            onClick={onHelp}
          />
        </div>
      </div>
    </section>
  )
}
