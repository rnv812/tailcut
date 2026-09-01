import { PtsMap } from '../timeline/map'
import type { Chunk, Located, Run, TrackKind } from '../../shared/types'
import type { SnapshotIndex, SnapshotTrack } from './format'

/**
 * The map holds bytes; a snapshot holds their place in the file, and the editor reads them out
 * of it by range. Nothing in the editor ever looks at these bytes — the field exists because
 * that is the shape PtsMap works on, and reusing PtsMap is the point.
 */
const NO_BYTES = new Uint8Array(0)

export interface PlacedChunk extends Chunk {
  source: Located
}

export interface PlacedRun extends Run {
  chunks: PlacedChunk[]
}

export interface MaterialTrack {
  track: SnapshotTrack
  kinds: TrackKind[]
  runs: PlacedRun[]
  /** Sum of the runs, in seconds; the gaps between them are not counted. */
  duration: number
  bytes: number
  span: { start: number; end: number } | null
}

export interface Material {
  tracks: MaterialTrack[]
  /** The representation the editor opens on: the picture with the most material behind it. */
  video: MaterialTrack | null
  /** The sound to go with it; null when one track carries both kinds. */
  audio: MaterialTrack | null
  /** Every representation the session recorded, in the order the snapshot lists them. */
  representations: string[]
  duration: number
  bytes: number
}

/**
 * One track of the snapshot, measured.
 *
 * The runs come off PtsMap and out of nowhere else. Written a second time here, the boundary of a
 * run would be decided by a second copy of GAP_TOLERANCE_SECONDS, and the timeline would disagree
 * with the popup about where the material breaks — the popup would promise a length the editor
 * could not draw.
 */
export function trackMaterialOf(track: SnapshotTrack): MaterialTrack {
  const map = new PtsMap()
  let bytes = 0

  for (const entry of track.chunks) {
    const chunk: PlacedChunk = {
      start: entry.start,
      end: entry.end,
      bytes: NO_BYTES,
      source: entry.data,
      ...(entry.timestampOffset === undefined
        ? {}
        : { timestampOffset: entry.timestampOffset }),
    }
    map.insert(chunk)
    bytes += entry.data.length
  }

  return {
    track,
    kinds: track.kinds,
    runs: map.runs() as PlacedRun[],
    duration: map.duration(),
    bytes,
    span: map.span(),
  }
}

/**
 * The holes between the runs: where the material was never watched.
 *
 * Declared once for the whole program and taken structurally, so that anything with a start and
 * an end fits: a `Run` off the map here, a `Span` of the timeline in `core/timeline/lanes.ts`,
 * which re-exports this very function. Runs are expected in time order and without overlaps.
 */
export function gapsBetween(
  runs: readonly { start: number; end: number }[],
): Array<{ start: number; end: number }> {
  const gaps: Array<{ start: number; end: number }> = []
  for (let at = 1; at < runs.length; at++) {
    gaps.push({ start: runs[at - 1]!.end, end: runs[at]!.start })
  }
  return gaps
}

/** The one with the most material behind it; nothing when none of them has any. */
function richest(tracks: MaterialTrack[], kind: TrackKind): MaterialTrack | null {
  let best: MaterialTrack | null = null
  for (const track of tracks) {
    if (!track.kinds.includes(kind) || track.duration <= 0) continue
    if (!best || track.duration > best.duration) best = track
  }
  return best
}

/** The independent sound beside a picture; a muxed picture already carries its own. */
function soundFor(tracks: MaterialTrack[], video: MaterialTrack | null): MaterialTrack | null {
  if (video?.kinds.includes('audio')) return null
  return richest(
    tracks.filter((track) => !track.kinds.includes('video')),
    'audio',
  )
}

/**
 * Opens one recorded picture track without hiding the rest of the snapshot.
 *
 * A track id, rather than a representation string, is the stable identity here: two source
 * buffers are allowed to describe the same codec and size, while their bytes are still distinct.
 * An unknown or empty picture is ignored so a stale UI choice cannot strand valid material.
 */
export function selectPicture(material: Material, trackId: string): Material {
  const video = material.tracks.find(
    (track) =>
      track.track.id === trackId && track.kinds.includes('video') && track.duration > 0,
  )
  if (!video || video === material.video) return material

  return {
    ...material,
    video,
    audio: soundFor(material.tracks, video),
    duration: video.duration,
  }
}

export function materialOf(index: SnapshotIndex): Material {
  const tracks = index.tracks.map(trackMaterialOf)
  const video = richest(tracks, 'video')
  // A muxed init puts both kinds into one buffer, and then the picture track is the sound track.
  // Another muxed representation is not its companion: it is another picture with other bytes.
  const audio = soundFor(tracks, video)

  let bytes = 0
  for (const track of tracks) bytes += track.bytes

  return {
    tracks,
    video,
    audio,
    representations: [...new Set(index.tracks.map((track) => track.representation))],
    duration: video?.duration ?? audio?.duration ?? 0,
    bytes,
  }
}
