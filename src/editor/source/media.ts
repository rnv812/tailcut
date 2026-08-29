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
 */
export function deriveMaterial(
  index: SnapshotIndex,
  preview: Preview | null,
  nameTemplate?: string,
): EditorMaterial {
  const lanes = lanesOf(index.tracks)
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
    runs: picture?.runs ?? [],
    zones: picture?.zones ?? [],
    duration: materialSpan(lanes)?.end ?? 0,
    title: index.page.title,
    nameTemplate,
    host: hostOf(index.page.url),
  }

  return { ctx, lanes, gaps: cuttingLane(lanes)?.gaps ?? [], snapGaps: allGaps(lanes) }
}
