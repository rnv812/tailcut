import { useEffect, useState } from 'preact/hooks'
import { heldByQuality, type Clip } from '../../core/edit/clip'
import type { EditContext } from '../../core/edit/context'
import type { Doc } from '../../core/edit/project'
import type { SessionAction } from '../../core/edit/session'
import { formatTimecode } from '../../core/timeline/timecode'
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
 * §8.3: the clip has run up against a change of quality and stopped there for good.
 *
 * A sentence, and deliberately nothing else. There is no button because there is nothing a
 * button could do: the two sides of the boundary are two resolutions, one track of an MP4 carries
 * one, and bringing them to one is an encoder's job — stage 4. A handle that stops without a word
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
export function Clips({ doc, ctx, selectedId, playhead, fps, dispatch }: ClipsProps) {
  return (
    <section class="tc-clips" data-testid="clips">
      <h2>Position</h2>
      <TimecodeField
        id="playhead-field"
        label="Playhead"
        seconds={playhead}
        fps={fps}
        onCommit={(time) => dispatch({ type: 'seek', time })}
      />

      <h2>Clips</h2>
      {doc.clips.length === 0 && (
        <p class="muted" data-testid="no-clips">
          No clips yet. I marks the start of one, O marks its end.
        </p>
      )}

      <ul class="tc-clip-list">
        {doc.clips.map((clip) => (
          <li
            key={clip.id}
            data-testid="clip"
            data-id={clip.id}
            class={clip.id === selectedId ? 'tc-clip selected' : 'tc-clip'}
            onClick={() => dispatch({ type: 'selectClip', id: clip.id })}
          >
            <NameField clip={clip} dispatch={dispatch} />

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
              <span class="tc-clip-length" data-testid={`length-${clip.id}`}>
                {formatTimecode(clip.out - clip.in, fps)}
              </span>
            </div>

            {qualityNote(clip, ctx)}

            {/*
              The controls stop the click from reaching the row. The row selects the clip, and a
              click that both removes a clip and selects it sends two actions and two steps of
              history for one press — and the second is a selection of something that is gone.
            */}
            <div class="tc-clip-options">
              <label class="option">
                <input
                  type="checkbox"
                  data-testid={`sound-${clip.id}`}
                  checked={clip.sound}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => dispatch({ type: 'toggleSound', id: clip.id })}
                />
                Sound
              </label>
              <button
                type="button"
                data-testid={`remove-${clip.id}`}
                onClick={(event) => {
                  event.stopPropagation()
                  dispatch({ type: 'removeClip', id: clip.id })
                }}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

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
    </section>
  )
}
