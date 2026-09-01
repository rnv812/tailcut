import { audioSampleEntry, videoSampleEntry } from '../iso/entry'
import type { MuxTrack } from '../mux'
import { assembleMp4 } from './assemble'
import { planPreview } from './plan'
import { ByteMap, clipSourceOf, type SourceTrackInput } from './source'

/**
 * What a stream of the registry contains, asked of its init and not of the caller.
 *
 * `MuxTrack` says nothing about kind: it is one SourceBuffer of a page, and a muxed init puts
 * the picture and the sound into that one buffer. The init knows, and the sample entries are
 * where it says so — so both are looked for, and a muxed stream comes out as two inputs over
 * exactly the same segments.
 */
function inputsOf(track: MuxTrack, map: ByteMap): SourceTrackInput[] {
  const segments = track.segments.map((bytes, index) => ({
    bytes,
    at: map.place(bytes),
    ...(track.timestampOffsets?.[index]
      ? { timestampOffset: track.timestampOffsets[index] }
      : {}),
  }))
  const inputs: SourceTrackInput[] = []

  if (videoSampleEntry(track.initBytes)) {
    inputs.push({ kind: 'video', initBytes: track.initBytes, segments })
  }
  if (audioSampleEntry(track.initBytes)) {
    inputs.push({ kind: 'audio', initBytes: track.initBytes, segments })
  }

  return inputs
}

/**
 * Everything the session holds, as an ordinary mp4.
 *
 * Uses the same plan and writer as editor export and preview, asked for all material instead of a
 * piece of it. Each path therefore sees real sample
 * tables, one edit list of one entry, and the priming of the sound hidden by it rather than left
 * hanging before zero. With this the fragmented writer has no caller left in the program.
 *
 * An empty buffer when there is nothing to build one from: the bytes come from a foreign page,
 * and material the parser cannot make sense of is dropped rather than thrown about.
 */
export function saveAllMp4(tracks: readonly MuxTrack[]): Uint8Array {
  const map = new ByteMap()
  const source = clipSourceOf(tracks.flatMap((track) => inputsOf(track, map)))
  if (!source) return new Uint8Array(0)

  return assembleMp4(planPreview(source), (at) => map.bytesOf(at))
}
