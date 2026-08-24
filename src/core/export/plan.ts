import type { Located, TrackKind } from '../../shared/types'
import type { SampleRef } from '../iso/samples'
import { presentationTicks } from '../iso/progressive'

/**
 * How many packets of sound are decoded before the first one the clip lets through.
 *
 * A sound codec does not start clean: an AAC frame is windowed against the one before it, and
 * Opus states a pre-skip of 80 ms — four packets at the 20 ms every encoder in the wild uses.
 * They cost a few kilobytes and are hidden by the edit list, which is cheaper than a click at
 * the head of every clip.
 */
export const AUDIO_WARMUP_PACKETS = 4

/** One sample of the recording, with its bytes named rather than held. */
export interface SourceSample {
  dts: number
  pts: number
  duration: number
  sync: boolean
  source: Located
}

export interface SourceTrack {
  kind: TrackKind
  timescale: number
  /** The stsd entry of the init this track arrived in, byte for byte. */
  sampleEntry: Uint8Array
  width: number
  height: number
  /** The media_time of that init's first edit, in ticks of this track. */
  editOffset: number
  /** Every sample of the representation, in decode order, dts ascending. */
  samples: SourceSample[]
}

export interface ClipSource {
  video: SourceTrack
  audio?: SourceTrack
}

export interface ClipRequest {
  /**
   * The first instant to show, in seconds of the presentation timeline of the session — the same
   * seconds the frame table counts in, which is pts minus the edit offset over the timescale.
   */
  in: number
  /** The first instant not to show. */
  out: number
  sound: boolean
}

export interface PlannedSample {
  source: Located
  duration: number
  cts: number
  sync: boolean
}

export interface PlannedTrack {
  kind: TrackKind
  timescale: number
  sampleEntry: Uint8Array
  width: number
  height: number
  /** In decode order. The durations are the ones the file will state: holes already closed. */
  samples: PlannedSample[]
  /**
   * Ticks of presentation the edit list hides at the head. There is no counterpart for the tail:
   * the tail is gone because the samples are gone (§8.2).
   */
  skipTicks: number
}

export interface ExportPlan {
  tracks: PlannedTrack[]
  /** Seconds the clip runs once the head is hidden and the tail is gone. */
  duration: number
  /** Coded bytes of every sample. The boxes around them add a few kilobytes. */
  bytes: number
}

/** A hole in the recording, and how much of it the clip takes out. */
export interface Seam {
  /** Where the material stops, in seconds of the decode timeline of the session. */
  from: number
  /** Where it resumes. */
  to: number
  /**
   * How much of the hole is removed: the smaller of the two tracks' holes, or zero where only one
   * track has one. Pulling by the larger would start the material after the seam before the
   * material before it had finished, which a decode timeline cannot say.
   */
  pull: number
}

/** Samples of one segment, addressed inside the byte source that segment lies in. */
export function locateSamples(samples: SampleRef[], segment: Located): SourceSample[] {
  return samples.map((sample) => ({
    dts: sample.dts,
    pts: sample.pts,
    duration: sample.duration,
    sync: sample.sync,
    source: { at: segment.at + sample.at, length: sample.size },
  }))
}

export function seamsOf(source: ClipSource): Seam[] {
  const sound = source.audio ? holesOf(source.audio) : null

  return holesOf(source.video).map((hole) => {
    const length = hole.to - hole.from
    if (!sound) return { ...hole, pull: length }

    let widest = 0
    for (const other of sound) {
      if (other.to <= hole.from || other.from >= hole.to) continue
      widest = Math.max(widest, other.to - other.from)
    }

    return { ...hole, pull: Math.min(length, widest) }
  })
}

export function planClip(source: ClipSource, request: ClipRequest): ExportPlan {
  const seams = seamsOf(source)
  const tracks: PlannedTrack[] = []

  const video = planTrack(source.video, request, seams)
  if (video) tracks.push(video)

  if (request.sound && source.audio && video) {
    const audio = planTrack(source.audio, request, seams)
    if (audio) tracks.push(audio)
  }

  let bytes = 0
  for (const track of tracks) for (const sample of track.samples) bytes += sample.source.length

  // The picture states the length of the clip. It is the finer of the two scales, and the sound
  // is cut to it rather than the other way round.
  const lead = tracks[0]
  return {
    tracks,
    duration: lead ? presentationTicks(lead) / lead.timescale : 0,
    bytes,
  }
}

/** The whole representation, holes closed and nothing trimmed: what the player previews. */
export function planPreview(source: ClipSource): ExportPlan {
  const samples = source.video.samples
  const first = samples[0]
  if (!first) return { tracks: [], duration: 0, bytes: 0 }

  const scale = source.video.timescale
  const offset = source.video.editOffset
  let start = Infinity
  let end = 0
  for (const sample of samples) {
    if (sample.pts < start) start = sample.pts
    if (sample.pts + sample.duration > end) end = sample.pts + sample.duration
  }

  return planClip(source, {
    in: (start - offset) / scale,
    out: (end - offset) / scale,
    sound: source.audio !== undefined,
  })
}

interface Hole {
  from: number
  to: number
}

function holesOf(track: SourceTrack): Hole[] {
  const holes: Hole[] = []

  for (let i = 1; i < track.samples.length; i++) {
    const previous = track.samples[i - 1]!
    const next = track.samples[i]!
    const ends = previous.dts + previous.duration
    if (next.dts > ends) holes.push({ from: ends / track.timescale, to: next.dts / track.timescale })
  }

  return holes
}

function planTrack(track: SourceTrack, request: ClipRequest, seams: Seam[]): PlannedTrack | null {
  if (track.samples.length === 0) return null

  const scale = track.timescale
  // The request is stated on the presentation timeline; the samples are stated on the decode one.
  // Adding the edit offset moves from the first to the second, and it is the same addition for
  // both tracks — which is why the priming of the sound needs no term of its own anywhere below.
  const inTicks = Math.round(request.in * scale) + track.editOffset
  const outTicks = Math.round(request.out * scale) + track.editOffset

  const video = track.kind === 'video'
  const enters = video ? shownAt(track, inTicks) : inTicks
  const first = video ? firstFrame(track, enters) : firstPacket(track, inTicks)
  const last = lastSample(track, first, outTicks)

  const chosen = track.samples.slice(first, last + 1)
  const head = chosen[0]
  if (!head) return null

  const samples: PlannedSample[] = chosen.map((sample, i) => {
    const next = chosen[i + 1]
    let duration = sample.duration

    if (next) {
      const ends = sample.dts + sample.duration
      const hole = next.dts - ends
      if (hole > 0) {
        // What is left of the hole after both tracks have been pulled by the same amount. Zero
        // for the track that had the smaller one; for the other, the difference — and it stays in
        // the file as an extra tick or two on the sample in front of the seam.
        const pull = pullAcross(seams, ends / scale, next.dts / scale)
        duration += Math.max(0, hole - Math.round(pull * scale))
      }
    }

    return {
      source: sample.source,
      duration,
      cts: sample.pts - sample.dts,
      sync: sample.sync,
    }
  })

  return {
    kind: track.kind,
    timescale: scale,
    sampleEntry: track.sampleEntry,
    width: track.width,
    height: track.height,
    samples,
    skipTicks: Math.max(0, enters - head.dts),
  }
}

/** The composition time of the frame on the screen at that instant. */
function shownAt(track: SourceTrack, ticks: number): number {
  let best = Infinity
  let shown = Infinity

  for (const sample of track.samples) {
    if (sample.pts < shown) shown = sample.pts
    if (sample.pts <= ticks && (best === Infinity || sample.pts > best)) best = sample.pts
  }

  // A request before the first frame enters at the first frame: the clip cannot start earlier
  // than the material does, and an editor that clamped nowhere would ask it to.
  return best === Infinity ? shown : best
}

/**
 * Where decoding has to start for that frame to be decodable: the last sync sample not after it.
 *
 * Every sample from there on in decode order goes into the file, including the ones composed
 * before the entry point — they are references, they are cheap, and the edit list hides them.
 */
function firstFrame(track: SourceTrack, enters: number): number {
  let index = -1
  let fallback = -1

  for (const [i, sample] of track.samples.entries()) {
    if (!sample.sync) continue
    if (fallback < 0) fallback = i
    if (sample.pts <= enters) index = i
  }

  if (index >= 0) return index
  // Nothing decodable at or before the entry point: the recording starts mid-group. The first
  // sync sample there is is the earliest place a decoder can be started at all.
  return fallback >= 0 ? fallback : 0
}

/** The packet holding that instant, less the run-up the decoder needs to be warm. */
function firstPacket(track: SourceTrack, ticks: number): number {
  let holding = 0
  for (const [i, sample] of track.samples.entries()) {
    if (sample.dts <= ticks) holding = i
  }
  return Math.max(0, holding - AUDIO_WARMUP_PACKETS)
}

/**
 * The last sample in decode order any part of which is shown.
 *
 * Picture by composition time, sound by decode time, and never fewer than one sample: a clip of
 * zero length is a mistake somewhere upstream, and writing an empty file would hide it.
 *
 * Everything up to and including this sample goes into the file, and on reordered material that
 * takes in a frame or two whose composition lies past the out point. They stay: the frames shown
 * before the out point are predicted from them, and the only box that could hide them —
 * `segment_duration` — is not survivable. The clip therefore ends up to one frame late on such
 * material, which is stated in the plan and measured in the tests rather than worked around.
 */
function lastSample(track: SourceTrack, first: number, outTicks: number): number {
  let last = first

  for (let i = first; i < track.samples.length; i++) {
    const sample = track.samples[i]!
    const time = track.kind === 'video' ? sample.pts : sample.dts
    if (time < outTicks) last = i
  }

  return last
}

function pullAcross(seams: Seam[], from: number, to: number): number {
  for (const seam of seams) {
    if (seam.from < to && seam.to > from) return seam.pull
  }
  return 0
}
