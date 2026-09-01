import { audioSampleEntry, sampleEntryBytes, sampleEntryOf, videoSampleEntry } from '../iso/entry'
import { keyframeClassifier } from '../codec/keyframe'
import { parseInit } from '../iso/init'
import { samplesInMovie } from '../iso/movie'
import { editOffset, locateSamples, sampleRunOf, trackDefaults } from '../iso/samples'
import type { ClipSource, SourceTrack } from './plan'
import type { Located, TrackKind } from '../../shared/types'

/** One media segment and where its bytes live, wherever that is. */
export interface SourceSegment {
  bytes: Uint8Array
  at: Located
  /** SourceBuffer timeline shift in seconds for this segment. */
  timestampOffset?: number
}

export interface SourceTrackInput {
  kind: TrackKind
  initBytes: Uint8Array
  segments: readonly SourceSegment[]
}

/**
 * A recording turned into a list of samples with their addresses.
 *
 * The bytes are read to be parsed and are not kept: what stays is where every sample is, which is
 * a few dozen numbers per second of material against a megabyte of coded frames. That is what
 * lets the editor plan a clip without holding the recording, and the plan then names the ranges
 * the runner reads back.
 *
 * null when this init describes no track of that kind, or when no segment could be read: an
 * export of nothing is refused where it is asked for and not halfway through writing a file.
 */
export function sourceTrackOf(input: SourceTrackInput): SourceTrack | null {
  const entry =
    input.kind === 'video' ? videoSampleEntry(input.initBytes) : audioSampleEntry(input.initBytes)
  if (!entry) return null

  const sampleEntry = sampleEntryBytes(input.initBytes, entry.trackId)
  const declared = parseInit(input.initBytes)?.tracks.find(
    (track) => track.trackId === entry.trackId,
  )
  if (!sampleEntry || !declared || !(declared.timescale > 0)) return null

  // The walk, the ordering and the thinning of an overlap are `sampleRunOf`'s and not this
  // function's: the frame table the editor draws is built by the same call, and when the two
  // walked the segments apiece they disagreed about how many samples a recording held.
  //
  // Sample defaults live in the trex of the init, and a packager is free to state them nowhere
  // else. Ours is one of those: the sound it rewrites out of WebM carries no flags in its truns.
  const run = sampleRunOf({
    segments: input.segments.map((segment) => ({
      bytes: segment.bytes,
      source: segment.at,
      ...(segment.timestampOffset
        ? { decodeTimeOffset: Math.round(segment.timestampOffset * declared.timescale) }
        : {}),
    })),
    trackId: entry.trackId,
    kind: input.kind,
    defaults: trackDefaults(input.initBytes),
    loneTrack: true,
    ...(input.kind === 'video' ? { syncOf: keyframeClassifier(sampleEntry) ?? undefined } : {}),
  })

  if (!run.samples.length) return null

  return {
    kind: input.kind,
    timescale: declared.timescale,
    sampleEntry,
    width: entry.codedWidth,
    height: entry.codedHeight,
    editOffset: editOffset(input.initBytes, entry.trackId),
    samples: run.samples,
    dropped: run.dropped,
  }
}

/**
 * The tracks of an ordinary complete file, indexed straight out of its movie box.
 *
 * The other way material arrives, and the one the capture never sees: no init segment, no
 * fragments, one `moov` describing every sample of every track and an `mdat` holding them. What
 * comes out is the same `SourceTrack` the fragmented path produces, so the cut and the writer
 * behind it cannot tell the two apart — which is the whole point of doing it here rather than in
 * a saving path of its own.
 *
 * `total` is the length of the file the offsets are counted in, and it is not decoration: it is
 * what stops a table claiming samples past the last byte there is. Pass zero where the server
 * would not say, and the tables are believed.
 *
 * The bytes handed in need only be the movie box — a few kilobytes fetched out of a file that was
 * deliberately not downloaded (src/core/iso/locate.ts). Every address that comes back is counted
 * from the first byte of the file all the same, because that is what a chunk offset means.
 *
 * `at` is where that first byte lies in the byte source the addresses will be asked of. Zero, and
 * the source is the file itself: a reader of somebody's server, which is the plain save. It is
 * not zero when the file has been copied into a larger one — a snapshot holding an ordinary file
 * whole (src/core/snapshot/format.ts, `SnapshotTrack.whole`) — and then every sample has to be
 * addressed where it actually lies, or the editor would read the head of the snapshot as media.
 */
export function movieTracksOf(moov: Uint8Array, total: number, at = 0): SourceTrack[] {
  const declared = parseInit(moov)?.tracks ?? []
  const tracks: SourceTrack[] = []

  for (const indexed of samplesInMovie(moov, total)) {
    // A movie box of a fragmented file describes its tracks and holds no samples: that is the
    // honest answer for it, and here it means there is nothing to cut.
    if (indexed.samples.length === 0) continue

    const track = declared.find((candidate) => candidate.trackId === indexed.trackId)
    const entry = sampleEntryOf(moov, indexed.trackId)
    const bytes = sampleEntryBytes(moov, indexed.trackId)
    if (!track || !entry || !bytes || !(track.timescale > 0)) continue

    tracks.push({
      kind: track.kind,
      timescale: track.timescale,
      sampleEntry: bytes,
      width: entry.codedWidth,
      height: entry.codedHeight,
      editOffset: editOffset(moov, indexed.trackId),
      // The offsets of a movie box are already counted from the first byte of the file, so the
      // source they are placed in begins where that file does.
      samples: locateSamples(indexed.samples, { at, length: total }),
      // A complete file states each sample once. There is no re-watch to overlap with: that is a
      // property of a recording assembled out of what a player happened to fetch twice.
      dropped: 0,
    })
  }

  return tracks
}

/**
 * The tracks of a recording as one source to cut from.
 *
 * The leading slot is the picture where there is one: it is the finer scale, and `planClip`
 * measures the clip by whatever stands there: sound is cut to picture duration, not
 * other way round). A recording of sound alone leads with the sound, because it still has to be
 * exportable: the popup has offered to save such a session since the capture stage.
 *
 * A file with more than one track of a kind — two languages, two qualities — gives up all but
 * one of them: an mp4 track carries one stream and the file being written has one of each. Which
 * of them is taken is the caller's business, and this takes the first it is handed.
 */
export function clipSourceFrom(tracks: readonly SourceTrack[]): ClipSource | null {
  const lead = tracks.find((track) => track.kind === 'video') ?? tracks[0]
  if (!lead) return null

  const audio = tracks.find((track) => track !== lead && track.kind === 'audio')
  return audio ? { video: lead, audio } : { video: lead }
}

export function clipSourceOf(inputs: readonly SourceTrackInput[]): ClipSource | null {
  return clipSourceFrom(
    inputs.map(sourceTrackOf).filter((track): track is SourceTrack => track !== null),
  )
}

/**
 * An address space over buffers that have no file behind them.
 *
 * The editor cuts from a snapshot, where every sample has a real offset in a real file. Save all
 * cuts from segments held in memory, which have no offsets at all — so they are given some: one
 * `Located` per segment, laid end to end. The same plan and the same writer then serve both.
 */
export class ByteMap {
  private readonly parts: Array<{ at: number; bytes: Uint8Array }> = []
  private end = 0

  place(bytes: Uint8Array): Located {
    const at = this.end
    this.parts.push({ at, bytes })
    this.end += bytes.byteLength
    return { at, length: bytes.byteLength }
  }

  get size(): number {
    return this.end
  }

  bytesOf(at: Located): Uint8Array {
    let low = 0
    let high = this.parts.length - 1

    while (low <= high) {
      const middle = (low + high) >> 1
      const part = this.parts[middle]!

      if (at.at < part.at) high = middle - 1
      else if (at.at >= part.at + part.bytes.byteLength) low = middle + 1
      else {
        const from = at.at - part.at
        // A sample lies inside one segment, always: it was indexed out of that segment's trun. A
        // range running off the end of one is a defect in the plan, and a short buffer handed to
        // the writer would be a file with a hole in the middle of a frame.
        if (from + at.length > part.bytes.byteLength) {
          throw new RangeError('a range crosses the end of the segment it starts in')
        }
        return part.bytes.subarray(from, from + at.length)
      }
    }

    throw new RangeError('a range that belongs to no segment')
  }
}

/**
 * Where a sample's bytes are among buffers that already have addresses.
 *
 * The same question as `ByteMap.bytesOf` asked the other way round: there the addresses are handed
 * out, here they are given — the ranges a snapshot was read by, or the slices the export runner
 * fetched. `slices` must be in ascending order of `at`; the lookup is a binary search over them,
 * and it is called once per sample of a clip.
 */
export function bytesFrom(
  slices: readonly Located[],
  buffers: readonly Uint8Array[],
): (at: Located) => Uint8Array {
  return (at) => {
    let low = 0
    let high = slices.length - 1

    while (low <= high) {
      const middle = (low + high) >> 1
      const slice = slices[middle]!

      if (at.at < slice.at) high = middle - 1
      else if (at.at >= slice.at + slice.length) low = middle + 1
      else {
        const from = at.at - slice.at
        const buffer = buffers[middle]!
        if (from + at.length > buffer.byteLength) {
          throw new RangeError('the material is shorter than the plan')
        }
        return buffer.subarray(from, from + at.length)
      }
    }

    throw new RangeError('the plan names bytes that were never read')
  }
}
