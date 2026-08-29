import { SNAPSHOT_VERSION, type SnapshotIndex, type SnapshotTrack, type Store } from '../snapshot/format'
import { continuesRun } from '../timeline/map'
import { piecePath } from '../../shared/history-files'
import type { HistoryPiece, HistoryTrack } from './layout'
import type { Located } from '../../shared/types'

/** Two pieces of one stretch this close together are one piece, as PtsMap counts it. */
const SAME_CHUNK_TOLERANCE_SECONDS = 0.001

/** Everything about a session that is not its material: what the index row holds. */
export interface HistoryFacts {
  id: string
  key: string
  url: string
  title: string
  createdAt: number
  lastSeenAt: number
  tracks: HistoryTrack[]
}

export interface HistoryMeta {
  capturedAt: number
  producer: string
}

export interface ComposedHistory {
  index: SnapshotIndex
  /** The files that make up the address space, in the order their bytes are laid out. */
  stores: Array<{ path: string; bytes: number }>
  /** Total length of that space: what a reader is opened over. */
  size: number
}

/** A stretch of media time, in the same seconds everything else in this program counts in. */
export interface Span {
  start: number
  end: number
}

/**
 * The media time a session covers, once these parts are counted in too.
 *
 * The length of a recording is the time some material of it exists for, and that is a union
 * rather than a sum. A sum is wrong twice over, and both ways are ordinary: a piece carries the
 * picture and the sound of one stretch, and a switch of quality (§6.2) opens a second
 * representation of the picture over the same seconds — so adding parts up counts a second two
 * and three times. And the same session is written by two tabs (§6.1), whose maps are
 * independent: the overlap arrives twice, and a session watched once would say it was watched for
 * twice as long.
 *
 * Naming one track the lead and counting only that one answers the first case and fails the
 * second, and it fails worse: the lead is chosen once, so the length of a session freezes at the
 * moment the player switches quality and never moves again.
 *
 * Joined by the same tolerance PtsMap runs by, so that the popup, the editor and this agree about
 * what a hole is.
 */
export function coveredWith(
  covered: readonly Span[],
  parts: ReadonlyArray<{ start: number; end: number }>,
): Span[] {
  const all = [...covered, ...parts]
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start)

  const merged: Span[] = []
  for (const span of all) {
    const last = merged[merged.length - 1]
    if (last && continuesRun(last.end, span.start)) {
      if (span.end > last.end) last.end = span.end
      continue
    }
    merged.push({ start: span.start, end: span.end })
  }

  return merged
}

/** How much material that is, in media seconds. A gap is not recorded time. */
export function secondsOf(covered: readonly Span[]): number {
  let seconds = 0
  for (const span of covered) seconds += span.end - span.start
  return seconds
}

/**
 * The pieces of a session read as one snapshot.
 *
 * Nothing is copied and nothing is written: the index the editor works from is built in memory
 * out of the rows, and the material stays in the files it was written to. That is the whole
 * difference between opening a session out of the history and freezing one out of a page — the
 * freeze has to copy, because its material is in a frame that is about to close.
 *
 * The order of the pieces is the order they were written, which their names carry: a writer's
 * identity and a padded sequence number. It matters twice — the address space is built by laying
 * them end to end, and where two writers wrote the same stretch the earlier one is kept.
 */
export function historyIndexOf(
  session: HistoryFacts,
  pieces: readonly HistoryPiece[],
  meta: HistoryMeta,
): ComposedHistory {
  const ordered = [...pieces].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

  const stores: Array<{ path: string; bytes: number }> = []
  const base = new Map<string, number>()
  let size = 0
  for (const piece of ordered) {
    base.set(piece.file, size)
    stores.push({ path: piecePath(session.id, piece.file), bytes: piece.bytes })
    size += piece.bytes
  }

  const placed = (file: string, at: number, length: number): Located => ({
    at: (base.get(file) ?? 0) + at,
    length,
  })

  const tracks: SnapshotTrack[] = []
  for (const track of session.tracks) {
    const chunks: Array<{ start: number; end: number; data: Located }> = []

    for (const piece of ordered) {
      for (const part of piece.parts) {
        if (part.representation !== track.representation) continue
        chunks.push({
          start: part.start,
          end: part.end,
          data: placed(piece.file, part.at, part.length),
        })
      }
    }

    // A track that has an init on disk and no material yet: the batch carrying its first segment
    // was lost, or the page opened the buffer and fed it nothing. An empty track in the index
    // would be a lane in the editor with nothing under it.
    if (!chunks.length) continue

    chunks.sort((a, b) => a.start - b.start)
    const kept: typeof chunks = []
    for (const chunk of chunks) {
      const last = kept[kept.length - 1]
      // The same rule PtsMap inserts by: a matching start is a second copy of one piece, and the
      // one already there was written first.
      if (last && Math.abs(last.start - chunk.start) < SAME_CHUNK_TOLERANCE_SECONDS) continue
      kept.push(chunk)
    }

    tracks.push({
      id: track.representation,
      bufferId: track.bufferId,
      representation: track.representation,
      kinds: track.kinds,
      init: placed(track.init.file, track.init.at, track.init.length),
      info: track.info,
      chunks: kept,
    })
  }

  const index: SnapshotIndex = {
    format: 'tailcut/snapshot',
    version: SNAPSHOT_VERSION,
    id: session.id,
    capturedAt: meta.capturedAt,
    producer: meta.producer,
    page: {
      sessionKey: session.key,
      url: session.url,
      title: session.title,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      // A refusal at the ingest boundary is a fact about a page being watched, and by the time a
      // session is read back out of the history there is no page. What was collected is what is
      // here, and the editor says the same thing about it either way.
      refusedTracks: false,
    },
    stores: stores.map((store): Store => ({ kind: 'file', path: store.path, bytes: store.bytes })),
    tracks,
  }

  return { index, stores, size }
}
