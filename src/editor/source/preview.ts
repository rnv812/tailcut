import { assembleMp4 } from '../../core/export/assemble'
import { planPreview } from '../../core/export/plan'
import {
  bytesFrom,
  clipSourceFrom,
  clipSourceOf,
  movieTracksOf,
  type SourceSegment,
  type SourceTrackInput,
} from '../../core/export/source'
import { framesOf, framesOfTrack, FrameTable, retimeToPlan, type Frame }
  from '../../core/timeline/frames'
import type { SnapshotTrack } from '../../core/snapshot/format'
import type { Material, MaterialTrack } from '../../core/snapshot/material'
import type { SnapshotReader } from '../../core/snapshot/read'
import type { Located, TrackKind } from '../../shared/types'

export interface Preview {
  /** Object URL of the file the `<video>` plays. */
  url: string
  bytes: number
  /**
   * The frames of the picture, on both clocks: `pts` is the session, `out` is this file. There is
   * no third number and no origin — the difference between the two is whatever the plan did.
   */
  frames: FrameTable
  release(): void
}

interface Loaded {
  kind: TrackKind
  initBytes: Uint8Array
  segments: SourceSegment[]
}

/**
 * One track of the snapshot, read into memory and still addressed by where it lies in the file.
 *
 * The addresses matter as much as the bytes: the plan names samples by them, the frame table
 * carries them through, and the export later asks the same file for the same ranges.
 */
async function load(
  reader: SnapshotReader,
  track: MaterialTrack,
  kind: TrackKind,
): Promise<Loaded> {
  const chunks = track.runs.flatMap((run) => run.chunks)
  const [initBytes, segments] = await Promise.all([
    reader.bytesOf(track.track.init),
    // One read for the whole run: the chunks of a track lie next to each other in the snapshot.
    reader.bytesOfMany(chunks.map((chunk) => chunk.source)),
  ])

  return {
    kind,
    initBytes,
    segments: segments.map((bytes, at) => ({ bytes, at: chunks[at]!.source })),
  }
}

/** The assembled file and its frame table, wrapped as the thing the player is handed. */
function previewOf(file: Uint8Array, frames: Frame[]): Preview {
  const url = URL.createObjectURL(
    new Blob([file as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }),
  )

  return {
    url,
    bytes: file.byteLength,
    frames: FrameTable.of(frames),
    release: () => URL.revokeObjectURL(url),
  }
}

/**
 * The preview of material that arrived as an ordinary complete file.
 *
 * No init segment and no fragments to walk: the snapshot holds the file whole, its movie box
 * describes every sample of every track, and the index is read straight out of it. From there on
 * it is the same three steps as below — the export plan, the clip writer, the frame table retimed
 * to what the plan laid down — because the point of doing it this way round is that a preview and
 * a clip cannot come out differently.
 *
 * The whole of the material is read in one call. It is what the fragmented path does too, and for
 * an ordinary file there is nothing else to be done: the samples of every stretch lie in the one
 * `mdat`, and the file was copied into the snapshot precisely so that the editor would not have
 * to go back to somebody's server for them.
 */
async function fileMaterialPreview(
  reader: SnapshotReader,
  track: SnapshotTrack,
  whole: Located,
): Promise<Preview | null> {
  const bytes = await reader.bytesOf(whole)
  // Short of the file: the snapshot was truncated under us. A plan over it would name samples
  // that are not there, and the writer would throw halfway through a frame.
  if (bytes.byteLength !== whole.length) return null

  const from = track.init.at - whole.at
  const moov = bytes.subarray(from, from + track.init.length)

  // Addressed where the file actually lies, and not from its own first byte: the samples are
  // read back out of the snapshot, which has the index and everything before it in front.
  const source = clipSourceFrom(movieTracksOf(moov, whole.length, whole.at))
  if (!source) return null

  const plan = planPreview(source)
  const file = assembleMp4(plan, bytesFrom([whole], [bytes]))
  if (!file.byteLength) return null

  const shown = plan.tracks.find((one) => one.kind === 'video')
  return previewOf(file, shown ? retimeToPlan(framesOfTrack(source.video), shown) : [])
}

/**
 * The file the editor plays.
 *
 * Assembled by the export plan and the clip writer — the same two the Export button uses, over the
 * whole of the material instead of a range of it. That is the point of it being this way round: a
 * preview built by some other muxer would be a second container with second rules, and a frame
 * that looked right in the tab would say nothing about the file on disk. Here it says everything.
 *
 * The gaps are closed by the plan, so the file is continuous and playback has nothing to jump.
 * Where a hole could not be closed — the picture stopped and the sound did not — the frame in
 * front of the seam simply lasts longer, which is what the recording actually contained.
 */
export async function buildPreview(
  reader: SnapshotReader,
  material: Material,
): Promise<Preview | null> {
  const picture = material.video
  if (!picture?.span) return null

  // Material that was never intercepted, held in the snapshot as the file it came in.
  const whole = picture.track.whole
  if (whole) return fileMaterialPreview(reader, picture.track, whole)

  const declared = picture.track.info.tracks.find((track) => track.kind === 'video')
  if (!declared || !(declared.timescale > 0)) return null

  const loaded: Loaded[] = [await load(reader, picture, 'video')]
  // A muxed init carries the sound in these very segments under a track number of its own:
  // reading them a second time would double the peak for nothing.
  if (!material.audio && picture.kinds.includes('audio')) {
    loaded.push({ ...loaded[0]!, kind: 'audio' })
  }
  if (material.audio?.span) loaded.push(await load(reader, material.audio, 'audio'))

  const source = clipSourceOf(
    loaded.map(
      (one): SourceTrackInput => ({
        kind: one.kind,
        initBytes: one.initBytes,
        segments: one.segments,
      }),
    ),
  )
  if (!source) return null

  const plan = planPreview(source)

  // One address to one buffer, ascending: a muxed track appears twice in `loaded` and names the
  // same segments both times, and bytesFrom searches this list.
  const placed = [
    ...new Map(loaded.flatMap((one) => one.segments).map((one) => [one.at.at, one])).values(),
  ].sort((a, b) => a.at.at - b.at.at)

  const file = assembleMp4(
    plan,
    bytesFrom(
      placed.map((one) => one.at),
      placed.map((one) => one.bytes),
    ),
  )
  if (!file.byteLength) return null

  const shown = plan.tracks.find((track) => track.kind === 'video')
  const frames = shown
    ? retimeToPlan(
        framesOf({
          init: loaded[0]!.initBytes,
          trackId: declared.trackId,
          timescale: declared.timescale,
          segments: loaded[0]!.segments.map((one) => ({ bytes: one.bytes, source: one.at })),
        }),
        shown,
      )
    : []

  return previewOf(file, frames)
}
