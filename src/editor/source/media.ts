import type { EditContext } from '../../core/edit/context'
import type { SnapshotIndex } from '../../core/snapshot/format'
import { frameGrid } from '../../core/timeline/grid'
import {
  allGaps,
  cuttingLane,
  gapsBetween,
  laneOf,
  lanesOf,
  materialSpan,
  type Lane,
  type Span,
} from '../../core/timeline/lanes'
import { continuesRun } from '../../core/timeline/map'
import { hostOf } from '../../shared/format'
import { DEFAULTS, type ExportSettings } from '../../shared/settings'
import type { MonitorPicture, Preview } from './preview'

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

/** The picture lane the composite monitor actually owns, after overlapping ABR buffers switch. */
function monitorLane(pictures: readonly MonitorPicture[]): Lane {
  const runs: Span[] = []
  const zones: Lane['zones'] = []

  for (const picture of pictures) {
    const run = runs[runs.length - 1]
    if (run && continuesRun(run.end, picture.start)) run.end = Math.max(run.end, picture.end)
    else runs.push({ start: picture.start, end: picture.end })

    const zone = zones[zones.length - 1]
    if (
      zone &&
      zone.representation === picture.representation &&
      zone.codec === picture.codec &&
      zone.width === picture.width &&
      zone.height === picture.height
    ) {
      zone.end = Math.max(zone.end, picture.end)
    } else {
      zones.push({
        start: picture.start,
        end: picture.end,
        representation: picture.representation,
        codec: picture.codec,
        width: picture.width,
        height: picture.height,
      })
    }
  }

  return { kind: 'video', runs, gaps: gapsBetween(runs), zones }
}

/**
 * The derived layer: what is worked out from the snapshot once, on opening, and never edited.
 *
 * It is deliberately not part of the project. A frame table inside the document would be copied
 * into every step of the history, and a hundred steps of undo would hold a hundred copies of a
 * grid of tens of thousands of numbers.
 *
 * The Export settings arrive as one snapshot read by the tab, rather than field
 * by field. Two of its fields reach the model — the template a clip is named by and the format a
 * clip is born in — and a caller passing them one at a time is a caller that can drop one of them
 * without dropping the other: the name is visible on the screen and the format is not, so the
 * dropped one would be the format, and nothing would go red. Absent altogether means a tab that
 * read no settings: no template and the default format.
 */
export function deriveMaterial(
  index: SnapshotIndex,
  preview: Preview | null,
  exported?: ExportSettings,
  pictureTrackId?: string,
): EditorMaterial {
  // A Blob preview describes one picture track. A composite monitor names the ABR family it can
  // actually play, so the timeline may show that whole family while edit ownership below stays
  // on the selected track. Independent sound remains visible beside either shape.
  const monitorPictures = preview?.monitor?.pictures ?? []
  const monitorTrackIds = new Set(monitorPictures.map((part) => part.trackId))
  const visibleTracks = monitorTrackIds.size
    ? index.tracks.filter(
        (track) => monitorTrackIds.has(track.id) || !track.kinds.includes('video'),
      )
    : pictureTrackId
      ? index.tracks.filter(
          (track) => track.id === pictureTrackId || !track.kinds.includes('video'),
        )
      : index.tracks
  const rawLanes = lanesOf(visibleTracks)
  const lanes = monitorPictures.length
    ? rawLanes.map((lane) => (lane.kind === 'video' ? monitorLane(monitorPictures) : lane))
    : rawLanes
  const picture = laneOf(lanes, 'video')
  const rows = preview ? preview.frames.frames() : []
  const editFrames = preview?.editFrames ?? preview?.frames
  const editableTrackId = pictureTrackId ?? monitorPictures[0]?.trackId
  const editableZones = monitorPictures.length
    ? monitorPictures
        .filter((part) => part.trackId === editableTrackId)
        .map(({ representation, start, end, codec, width, height }) => ({
          representation,
          start,
          end,
          codec,
          width,
          height,
        }))
    : picture?.zones ?? []

  // This is the one place where monitor coverage and edit ownership are joined. The frame grid,
  // runs and length describe what the visible player can traverse; zones describe only stretches
  // owned by the selected representation, whose geometry and export source the edit uses.
  const ctx: EditContext = {
    frames: frameGrid({
      pts: Float64Array.from(rows, (frame) => frame.pts),
      durations: Float64Array.from(rows, (frame) => frame.duration),
    }),
    keyframes: editFrames ? editFrames.keyframeTimes() : new Float64Array(),
    fps: editFrames ? editFrames.fps() : 0,
    // The size of the picture the preview holds, which is the size the crop rectangle is drawn
    // over and the size the encoder will be asked for. Nothing else in the snapshot answers this:
    // `index` describes every representation, and a crop is a rectangle of the open one.
    frameSize: preview?.frameSize ?? { width: 0, height: 0 },
    newClipFormat: exported?.format ?? DEFAULTS.export.format,
    runs: picture?.runs ?? [],
    zones: editableZones,
    duration: materialSpan(lanes)?.end ?? 0,
    title: index.page.title,
    nameTemplate: exported?.nameTemplate,
    host: hostOf(index.page.url),
  }

  return { ctx, lanes, gaps: cuttingLane(lanes)?.gaps ?? [], snapGaps: allGaps(lanes) }
}
