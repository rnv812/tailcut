import { useEffect, useState } from 'preact/hooks'
import type { EncodingChoice } from '../../core/encode/codec'
import type { Estimate } from '../../core/encode/estimate'
import { heldByQuality, type Clip, type ClipMode } from '../../core/edit/clip'
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
  /**
   * What the selected clip costs, worked out by the tab. Null when nothing is selected.
   *
   * One estimate and not a map, because there is one to have: the path of a clip runs through
   * `planClip`/`planFrames` and through the probe's answer, and doing that for every row on every
   * keystroke would be the frame table walked six times a render. So the price is written under
   * the **selected** row and nowhere else — which is also where a person is looking when they
   * change the format, the mode or the frame.
   */
  estimate: Estimate | null
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

/**
 * The rungs, in the words a person reads.
 *
 * Said out loud because this is the only place anybody learns that a crop changed the rung — and
 * with it constant quality. Keyed by `EncodingChoice['kind']`, so a fourth rung added to
 * the ladder is a compile error here rather than a blank in a sentence.
 */
const RUNG_TEXT: Record<EncodingChoice['kind'], string> = {
  'hevc-hw': 'HEVC in hardware',
  'h264-hw': 'H.264 in hardware',
  'h264-sw': 'H.264 in software',
}

/**
 * The two source codecs that need warnings, in the words a person reads.
 *
 * Two and no more: VP8 and H.264 really are made smaller by being encoded again, and a warning
 * over them would be a warning that means nothing.
 */
const SOURCE_TEXT: Record<string, string> = { av01: 'AV1', vp09: 'VP9' }

/**
 * What this clip's settings cost, in a sentence, before anything is pressed.
 *
 * Four different sentences for four different truths, and none of them says a number it cannot
 * stand behind. The rung is named because a crop can change it: below roughly 130×34 the
 * hardware encoders refuse and the software one accepts, and with the rung goes constant quality.
 *
 * **No weight is printed here.** The bytes are the Export panel's line (`weightNote`, queue.tsx),
 * and one number under two headings is two sentences about one clip which are free to drift
 * apart. This one says what the work *is*: the rung, the picture, the kind of quality, the
 * seconds and the two codec warnings.
 */
function costNote(clip: Clip, estimate: Estimate, dispatch: (action: SessionAction) => void) {
  if (estimate.kind === 'copy') {
    return (
      <p class="muted" data-testid={`cost-${clip.id}`}>
        Copied from the recording as it is, in a moment. The picture is untouched.
      </p>
    )
  }

  if (estimate.kind === 'none') {
    // The button belongs inside this branch and not beside it: here `estimate` is narrowed to the
    // one variant that has something to offer, and a sibling of `costNote` would be reading
    // `estimate.kind` off an `Estimate | null` all over again.
    return (
      <>
        <p class="tc-clip-note" data-testid={`cost-${clip.id}`}>
          {estimate.reason === 'no-encoder'
            ? `This machine has no encoder for ${estimate.geometry.width} × ${estimate.geometry.height} at ${Math.round(estimate.geometry.framerate)} fps. Drop the crop to save the clip as it was recorded.`
            : 'There is no picture in this clip to re-encode.'}
        </p>
        {estimate.reason === 'no-encoder' && (
          <button
            type="button"
            data-testid={`drop-crop-${clip.id}`}
            onClick={(event) => {
              event.stopPropagation()
              // Two actions, not one: dropping the frame and putting the mode back are two
              // different changes to the document, and a seventh action made for one button
              // would undo them together. Ctrl+Z takes them back one at a time, which is what
              // the user watched happen.
              dispatch({ type: 'clearCrop', id: clip.id })
              dispatch({ type: 'setMode', id: clip.id, mode: 'original' })
            }}
          >
            Drop the crop and copy
          </button>
        )}
      </>
    )
  }

  if (estimate.kind === 'webp') {
    return (
      <p class="muted" data-testid={`cost-${clip.id}`}>
        {estimate.frames} frames at {estimate.geometry.width} × {estimate.geometry.height} — several
        times the same clip as MP4, and with no sound. It is a picture that loops.{' '}
        {estimate.seconds === null
          ? 'The first one will show how fast this machine is.'
          : `About ${Math.ceil(estimate.seconds)} s.`}
      </p>
    )
  }

  // "A fixed bitrate", never "constant quality": openh264 has no quantizer mode at all, and it
  // was measured writing 1.97 Mbit/s when asked for 0.4. What that means for the size is the
  // Export panel's sentence — "no smaller than" — and it is said there once.
  const quality =
    estimate.rung === 'h264-sw'
      ? 'a fixed bitrate, because the software rung has no constant quality to offer'
      : 'constant quality: bits go where the picture is hard, not where the clock says'

  return (
    <p class="muted" data-testid={`cost-${clip.id}`}>
      Re-encoded as {RUNG_TEXT[estimate.rung]}, {estimate.frames} frames at{' '}
      {estimate.geometry.width} × {estimate.geometry.height}, with {quality}.{' '}
      {estimate.seconds === null
        ? 'The first clip will show how fast this machine is.'
        : `About ${Math.ceil(estimate.seconds)} s.`}{' '}
      The sound is copied, not re-encoded.
      {estimate.inflates && (
        // This is said here because after the export it is too late to say it. A recording
        // already packed by AV1 or VP9 is not made smaller by being packed again by an older
        // codec — it is made bigger, and it loses detail on the way.
        <span class="tc-clip-warn" data-testid={`inflates-${clip.id}`}>
          {' '}
          This recording is already {SOURCE_TEXT[estimate.sourceCodec] ?? estimate.sourceCodec}:
          re-encoding it will more likely grow the file than shrink it. Original copies it as it
          is, for nothing.
        </span>
      )}
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
  estimate,
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

                <label class="option tc-clip-select">
                  <span class="label">Video</span>
                  <select
                    data-testid={`mode-${clip.id}`}
                    value={clip.mode}
                    disabled={clip.crop !== null || clip.format === 'webp'}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      dispatch({
                        type: 'setMode',
                        id: clip.id,
                        mode: (event.target as HTMLSelectElement).value as ClipMode,
                      })
                    }
                  >
                    <option value="original">Original</option>
                    <option value="optimize">Optimize</option>
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

            {clip.id === selectedId && estimate && costNote(clip, estimate, dispatch)}
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
