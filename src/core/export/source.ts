import { audioSampleEntry, sampleEntryBytes, videoSampleEntry } from '../iso/entry'
import { parseInit } from '../iso/init'
import { editOffset, samplesInSegment, trackDefaults } from '../iso/samples'
import { locateSamples, type ClipSource, type SourceSample, type SourceTrack } from './plan'
import type { Located, TrackKind } from '../../shared/types'

/** One media segment and where its bytes live, wherever that is. */
export interface SourceSegment {
  bytes: Uint8Array
  at: Located
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

  // Sample defaults live in the trex of the init, and a packager is free to state them nowhere
  // else. Ours is one of those: the sound it rewrites out of WebM carries no flags in its truns.
  const defaults = trackDefaults(input.initBytes)
  const samples: SourceSample[] = []

  for (const segment of input.segments) {
    const tracks = samplesInSegment(segment.bytes, defaults)
    // A single-track segment sometimes numbers its traf with something of its own; there is only
    // one track it could be about, so it is taken as that one.
    const found =
      tracks.find((track) => track.trackId === entry.trackId) ??
      (tracks.length === 1 ? tracks[0] : undefined)
    if (!found) continue

    for (const sample of locateSamples(found.samples, segment.at)) samples.push(sample)
  }

  if (!samples.length) return null

  // The map keeps its chunks in order of media time, but a caller is free to hand them over in
  // any order at all, and the writer lays samples down exactly as they arrive.
  samples.sort((a, b) => a.dts - b.dts)

  return {
    kind: input.kind,
    timescale: declared.timescale,
    sampleEntry,
    width: entry.codedWidth,
    height: entry.codedHeight,
    editOffset: editOffset(input.initBytes, entry.trackId),
    samples,
  }
}

/**
 * The tracks of a recording as one source to cut from.
 *
 * The leading slot is the picture where there is one: it is the finer scale, and `planClip`
 * measures the clip by whatever stands there (§8.2 — the sound is cut to the picture and not the
 * other way round). A recording of sound alone leads with the sound, because it still has to be
 * exportable: the popup has offered to save such a session since the capture stage.
 */
export function clipSourceOf(inputs: readonly SourceTrackInput[]): ClipSource | null {
  const tracks = inputs.map(sourceTrackOf).filter((track): track is SourceTrack => track !== null)

  const lead = tracks.find((track) => track.kind === 'video') ?? tracks[0]
  if (!lead) return null

  const audio = tracks.find((track) => track !== lead && track.kind === 'audio')
  return audio ? { video: lead, audio } : { video: lead }
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
