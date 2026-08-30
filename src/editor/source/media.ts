import type { EditContext } from '../../core/edit/context'
import type { SnapshotIndex } from '../../core/snapshot/format'
import { frameGrid } from '../../core/timeline/grid'
import {
  allGaps,
  cuttingLane,
  laneOf,
  lanesOf,
  materialSpan,
  type Lane,
  type Span,
} from '../../core/timeline/lanes'
import { hostOf } from '../../shared/format'
import { DEFAULTS, type ExportSettings } from '../../shared/settings'
import type { Preview } from './preview'

export interface EditorMaterial {
  /** Everything the model needs to know about the material, and nothing it can edit. */
  ctx: EditContext
  lanes: Lane[]
  /**
   * The holes of the lane the cut follows — the picture where there is one. This is what is
   * counted out loud: the picture and the sound stop a few milliseconds apart, and one break of
   * the recording shown as two gaps is a lie about the recording.
   */
  gaps: Span[]
  /** The holes of every lane, as targets to stick to: two near edges are two chances to hit. */
  snapGaps: Span[]
}

/**
 * The derived layer: what is worked out from the snapshot once, on opening, and never edited.
 *
 * It is deliberately not part of the project. A frame table inside the document would be copied
 * into every step of the history, and a hundred steps of undo would hold a hundred copies of a
 * grid of tens of thousands of numbers.
 *
 * The Export group of §9.4 arrives whole, as the one thing the tab read it as, rather than field
 * by field. Two of its fields reach the model — the template a clip is named by and the format a
 * clip is born in — and a caller passing them one at a time is a caller that can drop one of them
 * without dropping the other: the name is visible on the screen and the format is not, so the
 * dropped one would be the format, and nothing would go red. Absent altogether means a tab that
 * read no settings: no template, and the format of §7.4.
 */
export function deriveMaterial(
  index: SnapshotIndex,
  preview: Preview | null,
  exported?: ExportSettings,
  pictureTrackId?: string,
): EditorMaterial {
  // A frame grid describes one picture track. When the caller names that track, showing another
  // picture's zones beside it would offer stretches this editor cannot seek or cut until the
  // representation is opened. Independent sound remains visible beside every picture.
  const visibleTracks = pictureTrackId
    ? index.tracks.filter(
        (track) => track.id === pictureTrackId || !track.kinds.includes('video'),
      )
    : index.tracks
  const lanes = lanesOf(visibleTracks)
  const picture = laneOf(lanes, 'video')
  const rows = preview ? preview.frames.frames() : []

  // This is the one place where the two halves of an EditContext are joined, and they come from
  // different material on purpose: the grid from the open representation (the only one there are
  // frames of), the runs, the zones and the length from the whole recording (which is what the
  // timeline draws). See the note on EditContext for what may and may not be assumed of that.
  const ctx: EditContext = {
    frames: frameGrid({
      pts: Float64Array.from(rows, (frame) => frame.pts),
      durations: Float64Array.from(rows, (frame) => frame.duration),
    }),
    keyframes: preview ? preview.frames.keyframeTimes() : new Float64Array(),
    fps: preview ? preview.frames.fps() : 0,
    // The size of the picture the preview holds, which is the size the crop rectangle is drawn
    // over and the size the encoder will be asked for. Nothing else in the snapshot answers this:
    // `index` describes every representation, and a crop is a rectangle of the open one.
    frameSize: preview?.frameSize ?? { width: 0, height: 0 },
    newClipFormat: exported?.format ?? DEFAULTS.export.format,
    runs: picture?.runs ?? [],
    zones: picture?.zones ?? [],
    duration: materialSpan(lanes)?.end ?? 0,
    title: index.page.title,
    nameTemplate: exported?.nameTemplate,
    host: hostOf(index.page.url),
  }

  return { ctx, lanes, gaps: cuttingLane(lanes)?.gaps ?? [], snapGaps: allGaps(lanes) }
}
