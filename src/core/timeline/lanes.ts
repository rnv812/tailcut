import type { TrackInfo, TrackKind } from '../../shared/types'
import type { SnapshotTrack } from '../snapshot/format'
import { gapsBetween } from '../snapshot/material'
import { continuesRun } from './map'

/** A stretch of the session's presentation time, in seconds. */
export interface Span {
  start: number
  end: number
}

/**
 * A stretch recorded at one quality (§6.2). A change of representation is a change of the init
 * segment, so the picture inside a zone is one codec at one size, and a clip that crosses a
 * boundary crosses into another file's worth of setup — which is why the boundary is drawn.
 *
 * A hole in the recording does not end a zone. Nothing about the setup changed while nothing was
 * being recorded, and a zone cut in two by a pause would forbid the one thing §8.2 is for: a clip
 * that runs across a gap and has the gap collapsed out of it on the way to disk.
 */
export interface Zone extends Span {
  representation: string
  codec: string
  width: number
  height: number
}

/** One row of the timeline: everything of one kind of media that the snapshot holds. */
export interface Lane {
  kind: TrackKind
  /** Continuous stretches, in time order, no overlaps. */
  runs: Span[]
  /** The holes between the runs, in time order. */
  gaps: Span[]
  /** Quality zones, in time order; a zone never spans a change of representation — but it does
   *  span a gap, because a pause in the recording changes no quality. */
  zones: Zone[]
}

/** The kinds a lane is built for, in the order the lanes are drawn. */
const KINDS: readonly TrackKind[] = ['video', 'audio']

interface Piece extends Span {
  representation: string
  info: TrackInfo
}

/**
 * Every chunk of every track of this kind, in time order.
 *
 * A snapshot track is one SourceBuffer, and a page that switches quality leaves several of them
 * behind, each with its own stretch of the same timeline. Sorting them together is what makes
 * one lane out of the lot.
 */
function piecesOf(tracks: readonly SnapshotTrack[], kind: TrackKind): Piece[] {
  const pieces: Piece[] = []

  for (const track of tracks) {
    if (!track.kinds.includes(kind)) continue
    // kinds is what the ingest decided; info is what the init segment actually declared. Without
    // the second one a lane would have no codec and no size to show.
    const info = track.info.tracks.find((candidate) => candidate.kind === kind)
    if (!info) continue

    for (const chunk of track.chunks) {
      if (chunk.end <= chunk.start) continue
      pieces.push({
        start: chunk.start,
        end: chunk.end,
        representation: track.representation,
        info,
      })
    }
  }

  pieces.sort((a, b) => a.start - b.start || a.end - b.end)
  return pieces
}

function runsOf(pieces: readonly Piece[]): Span[] {
  const runs: Span[] = []

  for (const piece of pieces) {
    const last = runs[runs.length - 1]
    if (last && continuesRun(last.end, piece.start)) {
      if (piece.end > last.end) last.end = piece.end
      continue
    }
    runs.push({ start: piece.start, end: piece.end })
  }

  return runs
}

/**
 * The quality zones of a lane: ascending, touching at most at their ends, never overlapping.
 *
 * Note what is *not* asked here: `continuesRun`. That is the whole difference between this and
 * `runsOf` above — a run is broken by a hole, a zone is broken only by a change of the init
 * segment. Ask both questions in one place and the two ideas collapse into one, and with them the
 * ability to cut across a gap.
 *
 * What *is* asked is that the zones come out disjoint, which the pieces are not obliged to be.
 * A switch of quality overlaps by design — the new representation is buffered over the tail of
 * the old one — and a seek backwards replays a stretch at whichever quality is going then, so
 * `piecesOf` can hand over 480p 0–6 followed by 720p 4–10. Both readers of a zone answer nonsense
 * about an instant covered twice: `zoneAt` does a `find` and returns whichever came first,
 * `homeZone` picks by distance and can pick the far one. So a zone starts no earlier than the end
 * of the one before it, and a piece the previous zone already swallowed makes no zone at all.
 */
function zonesOf(pieces: readonly Piece[]): Zone[] {
  const zones: Zone[] = []

  for (const piece of pieces) {
    const last = zones[zones.length - 1]
    if (last && last.representation === piece.representation) {
      if (piece.end > last.end) last.end = piece.end
      continue
    }
    const start = last ? Math.max(piece.start, last.end) : piece.start
    if (piece.end <= start) continue
    zones.push({
      start,
      end: piece.end,
      representation: piece.representation,
      codec: piece.info.codec,
      width: piece.info.width,
      height: piece.info.height,
    })
  }

  return zones
}

// The holes between runs are worked out in exactly one place, and it is not this one: the same
// question is asked of a snapshot's runs by the editor shell (Task 5). Imported and re-exported
// here so that a caller of the timeline layer does not have to know where it lives, and so that
// the two answers can never differ by a rounding or by an off-by-one at the ends.
export { gapsBetween }

/** Turns the tracks of a snapshot into the rows the timeline draws. */
export function lanesOf(tracks: readonly SnapshotTrack[]): Lane[] {
  const lanes: Lane[] = []

  for (const kind of KINDS) {
    const pieces = piecesOf(tracks, kind)
    if (!pieces.length) continue
    const runs = runsOf(pieces)
    lanes.push({ kind, runs, gaps: gapsBetween(runs), zones: zonesOf(pieces) })
  }

  return lanes
}

export function laneOf(lanes: readonly Lane[], kind: TrackKind): Lane | undefined {
  return lanes.find((lane) => lane.kind === kind)
}

/**
 * The lane a break of the recording is counted on.
 *
 * The picture and the sound stop at slightly different instants, so one break of the recording
 * appears in both lists; adding the lists up tells the user two gaps where there was one. The cut
 * follows the picture — §8.2 pulls both tracks back by the smaller of the two holes, and the
 * picture is the finer scale — so the picture is where a hole is counted, and where there is no
 * picture, the one lane there is.
 */
export function cuttingLane(lanes: readonly Lane[]): Lane | undefined {
  return laneOf(lanes, 'video') ?? lanes[0]
}

/** From the earliest run of any lane to the latest. */
export function materialSpan(lanes: readonly Lane[]): Span | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY

  for (const lane of lanes) {
    const first = lane.runs[0]
    const last = lane.runs[lane.runs.length - 1]
    if (!first || !last) continue
    if (first.start < start) start = first.start
    if (last.end > end) end = last.end
  }

  return start <= end ? { start, end } : null
}

/**
 * The holes of every lane, in time order.
 *
 * The picture and the sound do not break in the same places — that is the whole reason §8.2
 * pulls both tracks back by the smaller of the two gaps — so a handle that is to stick to the
 * edge of a hole has to see both lists. For counting holes out loud this is the wrong list and
 * `cuttingLane` is the right one: as targets to stick to, two edges a few milliseconds apart are
 * two chances to land exactly; as a number on the screen they are one hole counted twice.
 */
export function allGaps(lanes: readonly Lane[]): Span[] {
  const gaps = lanes.flatMap((lane) => lane.gaps)
  gaps.sort((a, b) => a.start - b.start || a.end - b.end)
  return gaps
}
