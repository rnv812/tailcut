import type { Located, TrackKind } from '../../shared/types'
import type { LocatedSample } from '../iso/samples'
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

/**
 * One sample of the recording, with its bytes named rather than held.
 *
 * The vocabulary of a clip for what `sampleRunOf` hands back, and the same type rather than a
 * second declaration of it: a shape restated is a shape that drifts.
 */
export type SourceSample = LocatedSample

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
  /**
   * How many samples the index dropped because the recording held their decode time twice.
   *
   * A re-watch overlaps itself and the map keeps both copies (`core/timeline/map.ts`), so this is
   * an ordinary number and not an alarm. It is carried rather than counted and forgotten because
   * whoever assembles a clip is the one who can say it out loud — the interface has nowhere to
   * put it yet, and a fact dropped at the index cannot be recovered further down.
   */
  dropped: number
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
   * the tail is gone because those samples are omitted from the output.
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

interface Span {
  start: number
  end: number
}

/** Continuous presentation-time runs of one track, in seconds. */
function runsOf(track: SourceTrack): Span[] {
  const spans = track.samples
    .map((sample) => ({
      start: (sample.pts - track.editOffset) / track.timescale,
      end: (sample.pts + sample.duration - track.editOffset) / track.timescale,
    }))
    .sort((a, b) => a.start - b.start)
  const runs: Span[] = []

  for (const span of spans) {
    const last = runs[runs.length - 1]
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else runs.push({ ...span })
  }

  return runs
}

/**
 * Sound under the recorded picture, excluding packets fetched ahead through a picture hole.
 *
 * The picture is what the viewer watched. Adaptive players commonly buffer longer audio pieces
 * across a seek or a live-video discontinuity; keeping those packets makes the old picture freeze
 * while unheard prefetched sound plays. Retain packets overlapping picture runs, plus decoder
 * warm-up at the head, so preview, selected export and Save all join the same material.
 */
export function soundUnderPicture(source: ClipSource): ClipSource {
  if (source.video.kind !== 'video' || !source.audio) return source

  const picture = runsOf(source.video)
  if (picture.length <= 1) return source
  const indexes = new Set<number>()

  for (const [index, sample] of source.audio.samples.entries()) {
    const start = (sample.pts - source.audio.editOffset) / source.audio.timescale
    const end = (sample.pts + sample.duration - source.audio.editOffset) / source.audio.timescale
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
  const repaired = decodableVideo(source.video)
  const videoSource = repaired.track
  const decodable =
    videoSource === source.video
      ? source
      : {
          ...source,
          video: videoSource,
          ...(source.audio
            ? { audio: soundAfterDecodablePicture(source.audio, repaired.discarded) }
            : {}),
        }
  const seams = seamsOf(decodable)
  const tracks: PlannedTrack[] = []

  const video = planTrack(decodable.video, request, seams)
  if (video) tracks.push(video)

  if (request.sound && decodable.audio && video) {
    const audio = planTrack(decodable.audio, request, seams)
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

/**
 * Drop the undecodable head of every retained run of picture.
 *
 * A gap loses the decoder state along with the missing bytes. Samples after it may still be in
 * the index before the next sync sample, but their references are not, so handing one to a fresh
 * decoder is invalid. The skipped stretch becomes part of the hole seen by the seam planner.
 */
interface DecodableTrack {
  track: SourceTrack
  /** Presentation stretches present in the recording but unusable without the missing reference. */
  discarded: Hole[]
}

function decodableVideo(track: SourceTrack): DecodableTrack {
  if (track.kind !== 'video') return { track, discarded: [] }

  const samples: SourceSample[] = []
  const dropped: SourceSample[] = []
  let previousEnd: number | null = null
  // `firstFrame` already chooses the first usable entry for the head of a clip. This pass only
  // repairs later runs, where `planTrack` would otherwise keep walking across the gap.
  let waitingForSync = false

  for (const sample of track.samples) {
    if (previousEnd !== null && sample.dts > previousEnd) waitingForSync = true
    if (!waitingForSync || sample.sync) {
      samples.push(sample)
      waitingForSync = false
    } else {
      dropped.push(sample)
    }
    previousEnd = sample.dts + sample.duration
  }

  return {
    track: samples.length === track.samples.length ? track : { ...track, samples },
    discarded: presentationHoles(track, dropped),
  }
}

/** Presentation stretches occupied by samples that cannot be decoded, merged in time order. */
function presentationHoles(track: SourceTrack, samples: readonly SourceSample[]): Hole[] {
  const spans = samples
    .map((sample) => ({
      from: (sample.pts - track.editOffset) / track.timescale,
      to: (sample.pts + sample.duration - track.editOffset) / track.timescale,
    }))
    .sort((a, b) => a.from - b.from)
  const merged: Hole[] = []

  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to)
    else merged.push({ ...span })
  }

  return merged
}

/**
 * Drop sound that belongs to picture frames discarded at the start of a resumed GOP.
 *
 * A seek can leave the first picture fragment after a gap starting with delta frames. They cannot
 * be decoded without the group that the gap removed, so `decodableVideo` waits for the next sync
 * frame. Keeping sound from that unusable stretch would play it under the frozen pre-gap picture
 * and put it ahead. Whole packets are removed; the seam planner then closes the widened hole in
 * both tracks by the same amount.
 */
function soundAfterDecodablePicture(audio: SourceTrack, discarded: readonly Hole[]): SourceTrack {
  if (discarded.length === 0) return audio

  const samples = audio.samples.filter((sample) => {
    const start = (sample.pts - audio.editOffset) / audio.timescale
    const end = (sample.pts + sample.duration - audio.editOffset) / audio.timescale
    return !discarded.some((span) => end > span.from && start < span.to)
  })

  return samples.length === audio.samples.length ? audio : { ...audio, samples }
}

/**
 * The stretch of presentation a track covers, in the seconds a clip is asked for.
 *
 * The same clock the browser counts `currentTime` and `buffered` in: an edit list moves the
 * material to the presentation timeline by subtracting its media_time, and so does this. An empty
 * span — no samples — comes back as zero to zero.
 */
export function presentationSpan(track: SourceTrack): { start: number; end: number } {
  let start = Infinity
  let end = 0

  for (const sample of track.samples) {
    if (sample.pts < start) start = sample.pts
    if (sample.pts + sample.duration > end) end = sample.pts + sample.duration
  }

  if (start === Infinity) return { start: 0, end: 0 }
  return {
    start: (start - track.editOffset) / track.timescale,
    end: (end - track.editOffset) / track.timescale,
  }
}

/** The whole representation, holes closed and nothing trimmed: what the player previews. */
export function planPreview(source: ClipSource): ExportPlan {
  if (source.video.samples.length === 0) return { tracks: [], duration: 0, bytes: 0 }

  const watched = soundUnderPicture(source)
  const span = presentationSpan(watched.video)
  return planClip(watched, {
    in: span.start,
    out: span.end,
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
    if (next.dts > ends) {
      holes.push({
        from: (ends - track.editOffset) / track.timescale,
        to: (next.dts - track.editOffset) / track.timescale,
      })
    }
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
        const pull = pullAcross(
          seams,
          (ends - track.editOffset) / scale,
          (next.dts - track.editOffset) / scale,
        )
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

/**
 * How much of the timeline is taken out inside one hole of one track, in seconds.
 *
 * Every seam that opens inside the hole, added up, and not the first of them. A seam is measured
 * across a hole of the picture, so a hole of the picture holds exactly one — the seams are those
 * holes. A hole of the sound is under no such rule: the sound can be away for one unbroken
 * stretch while the picture comes and goes twice inside it, and then the clip takes a piece out
 * at each seam and the sound has to give up all of them. Answered with the first, the sound keeps
 * what the picture has already lost and plays that much late for the rest of the clip.
 *
 * Touching is not overlapping, at either edge: a hole that ends exactly where a seam begins
 * shares no instant with it and gives up nothing, which is why both comparisons are strict.
 */
function pullAcross(seams: Seam[], from: number, to: number): number {
  let pull = 0
  for (const seam of seams) {
    if (seam.from < to && seam.to > from) pull += seam.pull
  }
  return pull
}
