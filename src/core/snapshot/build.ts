import {
  adler32,
  encodeFooter,
  encodeIndex,
  SNAPSHOT_VERSION,
  type SnapshotIndex,
  type SnapshotPage,
  type SnapshotTrack,
} from './format'
import type { Chunk, InitInfo, Located, TrackKind } from '../../shared/types'

/**
 * One track of the session as the snapshot needs it. Structural on purpose: core knows nothing of
 * the registry in the bridge, and the bridge hands this over with snapshotSourceOf().
 */
export interface SnapshotSourceTrack {
  id: string
  bufferId: string
  representation: string
  kinds: TrackKind[]
  info: InitInfo
  initBytes: Uint8Array
  /** In time order, as the map holds them. */
  chunks: Chunk[]
  /**
   * `initBytes` is not an init segment but an ordinary complete file, and this is where its movie
   * box lies inside it — see `SnapshotTrack.whole`.
   *
   * Such a track has no segments to place: one `mdat` holds the samples of every stretch, and the
   * chunks below name the stretches of media time without carrying bytes of their own. So the
   * file is laid out once, as any init would be, and every chunk is pointed at all of it.
   */
  movie?: Located
}

export interface SnapshotSource {
  page: SnapshotPage
  tracks: SnapshotSourceTrack[]
}

export interface SnapshotMeta {
  id: string
  capturedAt: number
  producer: string
}

export interface SnapshotPlan {
  /** In the order they are written; the writer concatenates them once and hands them over. */
  parts: Uint8Array[]
  index: SnapshotIndex
  bytes: number
}

/**
 * What to write and in what order.
 *
 * A pure pass over the session: it lays the init segments and the chunks out in one stream, works
 * out where each of them lands, and describes the result. No byte is copied — the same views the
 * map holds come out in `parts`, and the one copy of the material happens later, in the frame,
 * where it can be handed to the worker by transfer.
 *
 * That matters for correctness and not only for speed. The page goes on recording and triage goes
 * on evicting while the user is choosing in the popup, so the layout and the copy have to happen
 * in one synchronous turn: a plan read before an eviction and copied after it would describe
 * bytes that are no longer on the map.
 */
export function planSnapshot(source: SnapshotSource, meta: SnapshotMeta): SnapshotPlan {
  const parts: Uint8Array[] = []
  const tracks: SnapshotTrack[] = []
  let at = 0

  const place = (bytes: Uint8Array) => {
    const located = { at, length: bytes.byteLength }
    parts.push(bytes)
    at += bytes.byteLength
    return located
  }

  for (const track of source.tracks) {
    const placed = place(track.initBytes)
    // A whole file goes down in one piece and its movie box is named inside it, where it already
    // lies; everything else is an init segment followed by the media segments of its map.
    const whole = track.movie ? placed : undefined
    const init = track.movie
      ? { at: placed.at + track.movie.at, length: track.movie.length }
      : placed
    const chunks = track.chunks.map((chunk) => ({
      start: chunk.start,
      end: chunk.end,
      data: whole ?? place(chunk.bytes),
    }))

    tracks.push({
      id: track.id,
      bufferId: track.bufferId,
      representation: track.representation,
      kinds: track.kinds,
      init,
      info: track.info,
      chunks,
      // Left off entirely on the ordinary path: an undefined field is dropped by JSON.stringify,
      // and a snapshot of captured segments carries no trace of a shape it is not.
      ...(whole ? { whole } : {}),
    })
  }

  const index: SnapshotIndex = {
    format: 'tailcut/snapshot',
    version: SNAPSHOT_VERSION,
    id: meta.id,
    capturedAt: meta.capturedAt,
    producer: meta.producer,
    page: source.page,
    stores: [{ kind: 'inline' }],
    tracks,
  }

  const indexBytes = encodeIndex(index)
  const indexAt = place(indexBytes)
  parts.push(encodeFooter(indexAt, adler32(indexBytes)))

  let bytes = 0
  for (const part of parts) bytes += part.byteLength

  return { parts, index, bytes }
}
