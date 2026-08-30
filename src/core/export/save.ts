import { audioSampleEntry, videoSampleEntry } from '../iso/entry'
import type { MuxTrack } from '../mux'
import { assembleMp4 } from './assemble'
import { AUDIO_WARMUP_PACKETS, planPreview, type ClipSource, type SourceTrack } from './plan'
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
  const segments = track.segments.map((bytes) => ({ bytes, at: map.place(bytes) }))
  const inputs: SourceTrackInput[] = []

  if (videoSampleEntry(track.initBytes)) {
    inputs.push({ kind: 'video', initBytes: track.initBytes, segments })
  }
  if (audioSampleEntry(track.initBytes)) {
    inputs.push({ kind: 'audio', initBytes: track.initBytes, segments })
  }

  return inputs
}

interface Span {
  start: number
  end: number
}

/** Continuous decode-time runs of one track, in seconds. */
function runsOf(track: SourceTrack): Span[] {
  const runs: Span[] = []

  for (const sample of track.samples) {
    const start = sample.dts / track.timescale
    const end = (sample.dts + sample.duration) / track.timescale
    const last = runs[runs.length - 1]
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else runs.push({ start, end })
  }

  return runs
}

/**
 * Sound under the recorded picture, excluding audio fetched ahead across a picture hole.
 *
 * Save all is defined by the picture the viewer actually loaded. A player commonly buffers a
 * longer audio segment across a seek, and treating those unseen seconds as material keeps a
 * visible pause in the output. Retain packets that overlap a picture run plus the decoder warm-up
 * at the head; the ordinary gap planner then joins both tracks by the same amount.
 */
function soundUnderPicture(source: ClipSource): ClipSource {
  if (source.video.kind !== 'video' || !source.audio) return source

  const picture = runsOf(source.video)
  if (picture.length <= 1) return source
  const indexes = new Set<number>()

  for (const [index, sample] of source.audio.samples.entries()) {
    const start = sample.dts / source.audio.timescale
    const end = (sample.dts + sample.duration) / source.audio.timescale
    if (picture.some((run) => end > run.start && start < run.end)) indexes.add(index)
  }

  const first = Math.min(...indexes)
  if (Number.isFinite(first)) {
    for (let index = Math.max(0, first - AUDIO_WARMUP_PACKETS); index < first; index++) {
      indexes.add(index)
    }
  }

  return {
    video: source.video,
    audio: {
      ...source.audio,
      samples: source.audio.samples.filter((_sample, index) => indexes.has(index)),
    },
  }
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

  return assembleMp4(planPreview(soundUnderPicture(source)), (at) => map.bytesOf(at))
}
