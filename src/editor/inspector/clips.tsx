import { useEffect, useState } from 'preact/hooks'
import { heldByQuality, type Clip } from '../../core/edit/clip'
import type { EditContext } from '../../core/edit/context'
import type { Doc } from '../../core/edit/project'
import type { SessionAction } from '../../core/edit/session'
import { formatTimecode } from '../../core/timeline/timecode'
import type { ExportFormat } from '../../shared/settings'
import { Icon } from '../icon'
import { TimecodeField } from './timecode-field'

export interface ClipsProps {
  doc: Doc
  /** The material, for the one question the panel asks of it: what is this clip up against. */
  ctx: EditContext
  selectedId: string | null
  /** Media time, so it can be typed at like any other boundary. */
  playhead: number
  fps: number
  dispatch: (action: SessionAction) => void
  /** The right inspector edits one selection; the media panel owns the full list. */
  selectedOnly?: boolean
  showPosition?: boolean
  showMarkers?: boolean
}

export interface ClipBinProps {
  doc: Doc
  selectedId: string | null
  fps: number
  onSelect: (clip: Clip) => void
  dispatch: (action: SessionAction) => void
}

/** Fast navigation over clips and markers, separate from the selected clip's properties. */
export function ClipBin({ doc, selectedId, fps, onSelect, dispatch }: ClipBinProps) {
  return (
    <section class="tc-media-bin" data-testid="clip-bin">
      <div class="tc-panel-heading">
        <div>
          <h2>Clips</h2>
          <p class="muted">Choose a clip to see and edit it everywhere.</p>
        </div>
        <span class="tc-count" aria-label={`${doc.clips.length} clips`}>{doc.clips.length}</span>
      </div>

      {doc.clips.length === 0 && (
        <div class="tc-empty" data-testid="no-bin-clips">
          <strong>No clips yet</strong>
          <span>Move the playhead, then choose Set In and Set Out.</span>
        </div>
      )}

      <ul class="tc-bin-list">
        {doc.clips.map((clip, index) => (
          <li
            key={clip.id}
            data-testid="clip"
            data-id={clip.id}
            class={clip.id === selectedId ? 'tc-bin-clip selected' : 'tc-bin-clip'}
          >
            <button
              type="button"
              data-testid={`clip-go-${clip.id}`}
              aria-current={clip.id === selectedId ? 'true' : undefined}
              onClick={() => onSelect(clip)}
            >
              <span class="tc-bin-index">{String(index + 1).padStart(2, '0')}</span>
              <span class="tc-bin-copy">
                <strong>{clip.name}</strong>
                <span>
                  {formatTimecode(clip.in, fps)} – {formatTimecode(clip.out, fps)}
                </span>
              </span>
              <span class="tc-bin-duration">{formatTimecode(clip.out - clip.in, fps)}</span>
            </button>
          </li>
        ))}
      </ul>

      <div class="tc-panel-heading tc-marker-heading">
        <div>
          <h2>Markers</h2>
          <p class="muted">Click a marker to jump to it.</p>
        </div>
        <span class="tc-count" aria-label={`${doc.markers.length} markers`}>{doc.markers.length}</span>
      </div>

      {doc.markers.length === 0 && (
        <p class="muted tc-bin-empty" data-testid="no-markers">No markers yet.</p>
      )}
      <ul class="tc-marker-list">
        {doc.markers.map((marker) => (
          <li key={marker.id} data-testid="marker" class="tc-marker">
            <button
              type="button"
              class="tc-marker-go"
              data-testid={`marker-${marker.id}`}
              onClick={() => dispatch({ type: 'seek', time: marker.time })}
            >
              {marker.label} · {formatTimecode(marker.time, fps)}
            </button>
            <button
              type="button"
              class="tc-icon-button"
              aria-label={`Remove ${marker.label}`}
              data-testid={`drop-${marker.id}`}
              onClick={() => dispatch({ type: 'removeMarker', id: marker.id })}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The name of a clip, with its own text.
 *
 * The model refuses an empty name — a clip has to be called something — and a box wired straight
 * to the model would therefore snap back the moment the last letter was deleted. So the letters
 * live here and only a name worth having is sent.
 */
function NameField({ clip, dispatch }: { clip: Clip; dispatch: (action: SessionAction) => void }) {
  const [text, setText] = useState(clip.name)
  useEffect(() => setText(clip.name), [clip.name])

  return (
    <input
      data-testid={`name-${clip.id}`}
      class="tc-clip-name"
      value={text}
      spellcheck={false}
      onInput={(event) => {
        const next = (event.target as HTMLInputElement).value
        setText(next)
        if (next.trim()) dispatch({ type: 'renameClip', id: clip.id, name: next })
      }}
    />
  )
}

/**
 * The clip has run up against a change of quality and stopped there for good.
 *
 * A sentence, and deliberately nothing else. There is no button because there is nothing a
 * button could do: the two sides of the boundary are two resolutions, one track of an MP4 carries
 * one, and bringing them to one is an encoder's job. A handle that stops without a word
 * reads as a bug, which is the whole reason this line exists. A clip nowhere near a boundary
 * gets `null` from `heldByQuality` and no line.
 */
function qualityNote(clip: Clip, ctx: EditContext) {
  const held = heldByQuality(clip, ctx)
  if (!held) return null
  const quality = held.height > 0 ? `${held.height}p` : held.representation

  return (
    <p class="tc-clip-note" data-testid={`held-${clip.id}`}>
      Clip stops where the recording switches to {quality}.
    </p>
  )
}

/** The clips of the recording, the markers, and the playhead above them. */
export function Clips({
  doc,
  ctx,
  selectedId,
  playhead,
  fps,
  dispatch,
  selectedOnly = false,
  showPosition = true,
  showMarkers = true,
}: ClipsProps) {
  // Keep every card mounted so an async estimate or a form edit is not discarded when selection
  // changes. The focused inspector hides the others; the standalone panel used elsewhere lists all.
  const shownClips = doc.clips

  return (
    <section class="tc-clips" data-testid="clips">
      {showPosition && (
        <>
          <h2>Position</h2>
          <TimecodeField
            id="playhead-field"
            label="Playhead"
            seconds={playhead}
            fps={fps}
            onCommit={(time) => dispatch({ type: 'seek', time })}
          />
        </>
      )}

      <h2>{selectedOnly ? 'Clip settings' : 'Clips'}</h2>
      {doc.clips.length === 0 && (
        <p class="muted" data-testid="no-clips">
          No clips yet. I marks the start of one, O marks its end.
        </p>
      )}
      {selectedOnly && doc.clips.length > 0 && selectedId === null && (
        <p class="muted tc-select-prompt" data-testid="select-clip-prompt">
          Select a clip in the media panel or on the timeline to edit its boundaries and export settings.
        </p>
      )}

      <ul class="tc-clip-list">
        {shownClips.map((clip) => (
          <li
            key={clip.id}
            data-testid={selectedOnly ? 'clip-properties' : 'clip'}
            data-id={clip.id}
            class={clip.id === selectedId ? 'tc-clip selected' : 'tc-clip'}
            hidden={selectedOnly && clip.id !== selectedId}
            onClick={() => dispatch({ type: 'selectClip', id: clip.id })}
          >
            <div class="tc-clip-header" data-testid={`clip-header-${clip.id}`}>
              <NameField clip={clip} dispatch={dispatch} />
              <button
                type="button"
                class="tc-clip-remove"
                data-testid={`remove-${clip.id}`}
                aria-label="Remove clip"
                title="Remove clip"
                onClick={(event) => {
                  event.stopPropagation()
                  dispatch({ type: 'removeClip', id: clip.id })
                }}
              >
                <Icon name="trash" />
              </button>
            </div>

            <section class="tc-clip-section" data-testid={`clip-range-${clip.id}`}>
              <div class="tc-clip-section-heading">
                <h3>Range</h3>
                <span class="tc-clip-duration">
                  <span>Duration</span>
                  <strong class="tc-clip-length" data-testid={`length-${clip.id}`}>
                    {formatTimecode(clip.out - clip.in, fps)}
                  </strong>
                </span>
              </div>
              <div class="tc-clip-times">
                <TimecodeField
                  id={`in-${clip.id}`}
                  label="In"
                  seconds={clip.in}
                  fps={fps}
                  onCommit={(time) => dispatch({ type: 'trim', id: clip.id, edge: 'in', time, typed: true })}
                />
                <TimecodeField
                  id={`out-${clip.id}`}
                  label="Out"
                  seconds={clip.out}
                  fps={fps}
                  onCommit={(time) => dispatch({ type: 'trim', id: clip.id, edge: 'out', time, typed: true })}
                />
              </div>
              {qualityNote(clip, ctx)}
            </section>

            {/*
              The controls stop the click from reaching the row. The row selects the clip, and a
              click that both removes a clip and selects it sends two actions and two steps of
              history for one press — and the second is a selection of something that is gone.
            */}
            <section class="tc-clip-section" data-testid={`clip-output-${clip.id}`}>
              <h3>Output</h3>
              <div class="tc-clip-options">
                <label class="option tc-clip-select">
                  <span class="label">Format</span>
                  <select
                    data-testid={`format-${clip.id}`}
                    value={clip.format}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      dispatch({
                        type: 'setFormat',
                        id: clip.id,
                        format: (event.target as HTMLSelectElement).value as ExportFormat,
                      })
                    }
                  >
                    <option value="mp4">MP4</option>
                    <option value="webp">Animated WebP</option>
                  </select>
                </label>

                <label class="option tc-clip-sound">
                  <input
                    type="checkbox"
                    data-testid={`sound-${clip.id}`}
                    checked={clip.sound && clip.format !== 'webp'}
                    disabled={clip.format === 'webp'}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => dispatch({ type: 'toggleSound', id: clip.id })}
                  />
                  Sound
                </label>

              </div>
            </section>

          </li>
        ))}
      </ul>

      {showMarkers && (
        <>
      {/* Markers exist to be dropped in a hurry and therefore to be dropped by mistake. M puts
          one down and refuses a second on the same frame, so without this list — and without
          Shift+M beside it — a wrong marker would stay in the project for good. */}
      <h2>Markers</h2>
      {doc.markers.length === 0 && (
        <p class="muted" data-testid="no-markers">
          No markers. M drops one at the playhead, Shift+M takes that one away.
        </p>
      )}

      <ul class="tc-marker-list">
        {doc.markers.map((marker) => (
          <li key={marker.id} data-testid="marker" class="tc-marker">
            <button
              type="button"
              class="tc-marker-go"
              data-testid={`marker-${marker.id}`}
              onClick={() => dispatch({ type: 'seek', time: marker.time })}
            >
              {marker.label} · {formatTimecode(marker.time, fps)}
            </button>
            <button
              type="button"
              data-testid={`drop-${marker.id}`}
              onClick={() => dispatch({ type: 'removeMarker', id: marker.id })}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
        </>
      )}
    </section>
  )
}
