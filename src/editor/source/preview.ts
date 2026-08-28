import { assembleMp4 } from '../../core/export/assemble'
import { planPreview } from '../../core/export/plan'
import { bytesFrom, clipSourceOf, type SourceSegment, type SourceTrackInput }
  from '../../core/export/source'
import { framesOf, FrameTable, retimeToPlan } from '../../core/timeline/frames'
import type { Material, MaterialTrack } from '../../core/snapshot/material'
import type { SnapshotReader } from '../../core/snapshot/read'
import type { TrackKind } from '../../shared/types'

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
