import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  AUDIO_WARMUP_PACKETS,
  locateSamples,
  planClip,
  planPreview,
  seamsOf,
  type ClipSource,
  type PlannedTrack,
  type SourceSample,
  type SourceTrack,
} from '../../src/core/export/plan'
import { editOffset, samplesInSegment, trackDefaults } from '../../src/core/iso/samples'
import { audioSampleEntry, sampleEntryBytes, videoSampleEntry } from '../../src/core/iso/entry'
import { parseInit } from '../../src/core/iso/init'
import { presentationTicks } from '../../src/core/iso/progressive'
import type { Located, TrackKind } from '../../src/shared/types'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/**
 * The bytes a clip is cut out of, laid out the way a snapshot lays them out: every segment of
 * every track in one buffer, and every sample addressed by where it landed in it.
 */
class Bank {
  private readonly parts: Uint8Array[] = []
  private cursor = 0

  add(bytes: Uint8Array): Located {
    const at = this.cursor
    this.cursor += bytes.byteLength
    this.parts.push(bytes)
    return { at, length: bytes.byteLength }
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.cursor)
    let at = 0
    for (const part of this.parts) {
      out.set(part, at)
      at += part.byteLength
    }
    return out
  }
}

function trackOf(bank: Bank, initPath: string, segmentPaths: string[], kind: TrackKind): SourceTrack {
  const init = read(initPath)
  const defaults = trackDefaults(init)
  const declared = parseInit(init)!.tracks.find((t) => t.kind === kind)!
  const entry = kind === 'video' ? videoSampleEntry(init) : audioSampleEntry(init)
  const samples = []

  for (const path of segmentPaths) {
    const segment = read(path)
    const at = bank.add(segment)
    for (const track of samplesInSegment(segment, defaults)) {
      samples.push(...locateSamples(track.samples, at))
    }
  }

  return {
    kind,
    timescale: declared.timescale,
    sampleEntry: sampleEntryBytes(init, declared.trackId)!,
    width: entry?.codedWidth ?? 0,
    height: entry?.codedHeight ?? 0,
    editOffset: editOffset(init, declared.trackId),
    samples,
  }
}

const videoPath = (n: number): string => `tests/fixtures/h264/chunk-stream0-0000${n}.m4s`
const audioPath = (n: number): string => `tests/fixtures/h264/chunk-stream1-0000${n}.m4s`
const VIDEO_INIT = 'tests/fixtures/h264/init-stream0.m4s'
const AUDIO_INIT = 'tests/fixtures/h264/init-stream1.m4s'

function sourceOf(videoSegments: number[], audioSegments: number[]): ClipSource {
  const bank = new Bank()
  return {
    video: trackOf(bank, VIDEO_INIT, videoSegments.map(videoPath), 'video'),
    audio: trackOf(bank, AUDIO_INIT, audioSegments.map(audioPath), 'audio'),
  }
}

/**
 * Material stated in ticks instead of read out of a fixture: runs of samples of one length, with
 * whatever lies between two runs left as a hole. Nothing in it is reordered — every sample is a
 * sync sample composed at its own decode time — so a test built on this measures arithmetic and
 * not the shape of one recording. The fixtures answer everything they can; the numbers that only
 * appear on other timescales, and the runs a packager only writes at the end of a recording, have
 * nowhere else to come from.
 */
function madeTrack(
  kind: TrackKind,
  timescale: number,
  duration: number,
  runs: Array<{ at: number; count: number }>,
): SourceTrack {
  const samples: SourceSample[] = []
  let at = 0

  for (const run of runs) {
    for (let i = 0; i < run.count; i++) {
      const dts = run.at + i * duration
      samples.push({ dts, pts: dts, duration, sync: true, source: { at, length: 64 } })
      at += 64
    }
  }

  const shape = kind === 'video' ? { width: 320, height: 240 } : { width: 0, height: 0 }
  return { kind, timescale, sampleEntry: new Uint8Array(0), ...shape, editOffset: 0, samples }
}

/** The longest stretch of a track with no material in it, in seconds. */
function widestHole(track: SourceTrack): number {
  let widest = 0
  for (const [i, sample] of track.samples.entries()) {
    const previous = track.samples[i - 1]
    if (previous) {
      widest = Math.max(widest, (sample.dts - previous.dts - previous.duration) / track.timescale)
    }
  }
  return widest
}

/**
 * How far each track moved across the seam, in seconds: where the first sample behind the hole
 * sat in the recording, less where the plan puts it. One number per track, and the whole scheme
 * stands on the two being equal.
 */
function pullsAcrossSeam(source: ClipSource, tracks: PlannedTrack[]): number[] {
  return tracks.map((track) => {
    const samples = track.kind === 'video' ? source.video.samples : source.audio!.samples
    let decode = 0
    for (const [i, planned] of track.samples.entries()) {
      const sample = samples[i]!
      const previous = samples[i - 1]
      if (previous && sample.dts > previous.dts + previous.duration) {
        return (sample.dts - decode) / track.timescale
      }
      decode += planned.duration
    }
    return NaN
  })
}

/** Everything the fixture has. */
const whole = sourceOf([1, 2, 3], [1, 2, 3, 4])
/** The same with the second segment of each track thrown away: a hole in the middle. */
const holed = sourceOf([1, 3], [1, 3, 4])
/**
 * Two segments of sound thrown away against one of picture: the same seam with the larger hole on
 * the other track. Which of the two is the larger is a property of the recording — segments are
 * lost per track — and it is not the picture's in any material the fixtures hold.
 */
const wider = sourceOf([1, 3], [1, 4])
/**
 * One hole in the picture with two holes of the sound inside it, of different length: the sound
 * dropped out twice while the picture was away once. `seamsOf` pulls the pair by the wider of the
 * two — that is what the `Math.max` in it is for — so at the narrower hole the seam wants to
 * close more than there is to close. No arrangement of whole segments makes this shape — a lost
 * segment of sound is two seconds long, and two of those do not fit inside one two-second hole of
 * the picture — so the packets are dropped out of the index by hand instead.
 */
const uneven: ClipSource = (() => {
  const source = sourceOf([1, 3], [1, 2, 3, 4])
  const scale = source.audio!.timescale
  // Inside the picture's hole, which runs from 2 s to 4 s: 0.30 s of packets gone, then 0.79 s.
  const lost = (dts: number): boolean => {
    const at = dts / scale
    return (at >= 2.2 && at < 2.5) || (at >= 3 && at < 3.8)
  }
  const samples = source.audio!.samples.filter((sample) => !lost(sample.dts))
  return { video: source.video, audio: { ...source.audio!, samples } }
})()

/**
 * A recording joined mid-group: the first five frames are not in the index, so the earliest
 * sample references a group the material does not hold and the first sync sample lies nineteen
 * behind it. A capture hooked into a running stream lands here — an LL-HLS or LL-DASH part is
 * under no obligation to begin on an IDR — and no arrangement of whole segments produces it.
 */
const midGroup: SourceTrack = (() => {
  const video = trackOf(new Bank(), VIDEO_INIT, [1, 2].map(videoPath), 'video')
  return { ...video, samples: video.samples.slice(5) }
})()

const trackByKind = (tracks: PlannedTrack[], kind: TrackKind): PlannedTrack =>
  tracks.find((t) => t.kind === kind)!

describe('locateSamples', () => {
  it('addresses samples inside the byte source their segment sits in', () => {
    const segment = read(videoPath(1))
    const [track] = samplesInSegment(segment, trackDefaults(read(VIDEO_INIT)))
    const located = locateSamples(track!.samples, { at: 5000, length: segment.byteLength })

    expect(located).toHaveLength(48)
    expect(located[0]!.source).toEqual({ at: 5760, length: 5082 })
    expect(located[0]!.pts).toBe(1024)
    expect(located[1]!.source).toEqual({ at: 10842, length: 2417 })
  })
})

describe('seamsOf', () => {
  it('finds nothing in material with no holes', () => {
    expect(seamsOf(whole)).toEqual([])
  })

  it('pairs the hole in the picture with the hole in the sound and pulls to the smaller', () => {
    const seams = seamsOf(holed)
    expect(seams).toHaveLength(1)
    const [seam] = seams
    // Two seconds of picture are missing; the sound stops a little earlier and comes back a
    // little earlier, because a packet is not a frame.
    expect(seam!.from).toBeCloseTo(2, 6)
    expect(seam!.to).toBeCloseTo(4, 6)
    // 88064 ticks of 44100 — the sound's own hole, and the smaller of the two.
    expect(seam!.pull).toBeCloseTo(1.996916, 6)
    expect(seam!.pull).toBeLessThan(seam!.to - seam!.from)
  })

  it('pulls to the smaller hole when the smaller one is the picture', () => {
    // The mirror of the case above, and the one no fixture produces on its own: four seconds of
    // sound are missing where two seconds of picture are. Both tracks still move by the two.
    // Pulling by the larger would start the sound behind the seam before the sound in front of
    // it had finished, which a decode timeline cannot say — and the error is per seam, so a
    // recording the user skipped through twice comes apart twice as far.
    const seams = seamsOf(wider)
    expect(seams).toHaveLength(1)
    const [seam] = seams

    expect(seam!.from).toBeCloseTo(2, 6)
    expect(seam!.to).toBeCloseTo(4, 6)
    expect(seam!.pull).toBeCloseTo(seam!.to - seam!.from, 9)
    // The sound's own hole is twice that, and it is not what the seam pulls by.
    expect(widestHole(wider.audio!)).toBeGreaterThan(seam!.pull + 1)
  })

  it('finds a hole that lies between the first two samples', () => {
    // The mirror of the case below, and the shape a stream chunked one frame to a fragment
    // arrives in: an opening fragment of exactly one sample, and the dropout right behind it. A
    // loop that starts one index in never compares that sample with the one after it, reports no
    // seam at all, and the two seconds stay in the clip as a freeze on the very first frame.
    const video = madeTrack('video', 12_288, 512, [
      { at: 0, count: 1 },
      { at: 24_576, count: 24 },
    ])

    expect(seamsOf({ video })).toEqual([{ from: 512 / 12_288, to: 2, pull: 2 - 512 / 12_288 }])
  })

  it('finds a hole that lies between the last two samples', () => {
    // A closing run of exactly one sample — the tail a packager leaves at the end of a recording,
    // or a single frame that arrived after a long stall. A loop stopping one index short of the
    // end reports no seam here at all, and the two seconds stay in the clip.
    const video = madeTrack('video', 12_288, 512, [
      { at: 0, count: 24 },
      { at: 36_864, count: 1 },
    ])

    expect(seamsOf({ video })).toEqual([{ from: 1, to: 3, pull: 2 }])
  })

  it('leaves a hole in the sound that merely touches the picture out of the seam', () => {
    // Two holes that meet at an instant are two holes: there is no moment at which both tracks
    // are missing, so there is nothing to pull. Counted as overlapping, the seam would take its
    // pull from a hole lying wholly outside it and the tracks would part by that much.
    const video = madeTrack('video', 12_288, 512, [
      { at: 0, count: 24 },
      { at: 36_864, count: 24 },
    ])
    // Packets of 20 ms at 48000, the shape Opus arrives in: the run before the seam ends exactly
    // where the picture's hole begins, and the run after it begins exactly where that hole ends.
    const audio = madeTrack('audio', 48_000, 960, [
      { at: 0, count: 25 },
      { at: 48_000, count: 100 },
      { at: 192_000, count: 50 },
    ])

    expect(widestHole(audio)).toBeCloseTo(1, 9)
    expect(seamsOf({ video, audio })).toEqual([{ from: 1, to: 3, pull: 0 }])
  })

  it('pulls nothing where only one of the two tracks has a hole', () => {
    // The sound is whole across the stretch the picture is missing: there is material to play, so
    // the timeline has to keep it and the picture freezes instead.
    const oneSided = { video: holed.video, audio: whole.audio }
    expect(seamsOf(oneSided)[0]!.pull).toBe(0)
  })

  it('collapses a hole entirely when there is no sound at all', () => {
    const silent: ClipSource = { video: holed.video }
    const [seam] = seamsOf(silent)
    expect(seam!.pull).toBeCloseTo(seam!.to - seam!.from, 9)
  })
})

describe('planPreview', () => {
  it('reproduces the edit the source itself carries', () => {
    const plan = planPreview(whole)
    const video = trackByKind(plan.tracks, 'video')
    const audio = trackByKind(plan.tracks, 'audio')

    expect(video.samples).toHaveLength(144)
    expect(audio.samples).toHaveLength(260)
    // The head hidden is exactly the media_time the fixture states: nothing has been added to it
    // and nothing recomputed.
    expect(video.skipTicks).toBe(1024)
    expect(audio.skipTicks).toBe(1024)
    // Nothing is cut, so what is left is the whole of the material on both tracks.
    expect(presentationTicks(video)).toBe(73728)
    expect(presentationTicks(audio)).toBe(264600)
    expect(plan.duration).toBeCloseTo(6, 9)
    expect(plan.bytes).toBe(228616 + 49545)
  })

  it('keeps the composition offsets of the source', () => {
    const video = trackByKind(planPreview(whole).tracks, 'video')
    expect(video.samples.slice(0, 5).map((s) => s.cts)).toEqual([1024, 2560, 1024, 0, 512])
    expect(video.samples[0]!.sync).toBe(true)
  })

  it('hides nothing at the head of a sound that starts after the picture', () => {
    // The preview asks for the picture's own span, and the sound of a recording whose first
    // second of packets never arrived begins a second behind it. The entry point of the sound
    // then lies in front of the packet it enters at, and there is nothing at its head to hide.
    // A skip below zero is not harmless the way a skip of zero is: no edit list is written
    // either way, so sync is unhurt, but `presentationTicks` subtracts it — and subtracting a
    // negative inflates the tkhd, the mvhd and `plan.duration` past the material that is there.
    const samples = whole.audio!.samples.filter((sample) => sample.dts >= whole.audio!.timescale)
    const late: ClipSource = { video: whole.video, audio: { ...whole.audio!, samples } }
    const plan = planPreview(late)
    const audio = trackByKind(plan.tracks, 'audio')

    expect(late.audio!.samples[0]!.dts).toBe(45056) // a second in, to the nearest packet
    expect(audio.samples).toHaveLength(216)
    expect(audio.skipTicks).toBe(0)
    expect(presentationTicks(audio)).toBe(220568)
    // Five seconds of packets cannot state six seconds of presentation, whatever the picture
    // beside them runs for.
    expect(presentationTicks(audio) / audio.timescale).toBeLessThanOrEqual(plan.duration)
  })
})

describe('planClip', () => {
  it('enters at the key frame before the requested one and hides the difference', () => {
    // Frame 30 of the fixture: the sixth frame after the key frame at 24.
    const plan = planClip(whole, { in: 30 / 24, out: 6, sound: true })
    const video = trackByKind(plan.tracks, 'video')

    // From the key frame at decode index 24 to the end: 120 samples, of which the first six are
    // decoded and not shown.
    expect(video.samples).toHaveLength(120)
    expect(video.samples[0]!.sync).toBe(true)
    // 16384 (the pts of frame 30) − 12288 (the dts of the key frame at 24).
    expect(video.skipTicks).toBe(4096)
    // The out point is the end of the material, so what is left is everything behind the skip.
    expect(presentationTicks(video)).toBe(58368)
    expect(plan.duration).toBeCloseTo(4.75, 6)
  })

  it('enters at the first key frame there is when the material starts mid-group', () => {
    // No sync sample at or before the entry point: the recording begins in the middle of a group
    // of pictures. The earliest place a decoder can be started is the first key frame there is,
    // and everything in front of it has to stay out of the file — those frames reference a group
    // the recording does not hold, and a player draws them as garbage rather than refusing them.
    expect(midGroup.samples[0]!.sync).toBe(false)
    const syncs = midGroup.samples.filter((sample) => sample.sync)
    expect(syncs).toHaveLength(3)

    const plan = planClip({ video: midGroup }, { in: 0, out: 3, sound: false })
    const video = trackByKind(plan.tracks, 'video')

    // The first key frame, and not the last one either: entering at the final key frame of the
    // recording would throw away all but the tail of what was asked for.
    expect(video.samples[0]!.sync).toBe(true)
    expect(video.samples[0]!.source).toEqual(syncs[0]!.source)
    expect(video.samples).toHaveLength(48)
    // The entry point lies before the first decodable frame, so there is nothing left to hide.
    expect(video.skipTicks).toBe(0)
    expect(presentationTicks(video)).toBe(25600)
    expect(plan.duration).toBeCloseTo(25600 / 12288, 9)
  })

  it('gives the sound a running start and hides it too', () => {
    const audio = trackByKind(planClip(whole, { in: 30 / 24, out: 6, sound: true }).tracks, 'audio')

    // The packet holding the in point is the 54th; four before it are decoded so that the first
    // audible one is not the first the decoder ever saw. Opus needs 80 ms of them, AAC one.
    expect(AUDIO_WARMUP_PACKETS).toBe(4)
    expect(audio.samples).toHaveLength(210)
    // 56149 (1.25 s plus the priming) − 51200 (the dts of the packet four before).
    expect(audio.skipTicks).toBe(4949)
    expect(presentationTicks(audio)).toBe(209475)
  })

  it('puts both tracks at the same instant at the head', () => {
    // The invariant behind both entry points: whatever each track hides, what is left starts at
    // the instant that was asked for. The difference between the two is what a viewer hears as
    // lip-sync, and neither skipTicks alone says anything about it — the tracks count in
    // different ticks and enter from different samples.
    const request = { in: 30 / 24, out: 6, sound: true }
    const plan = planClip(whole, request)

    const entries = plan.tracks.map((track) => {
      const source = track.kind === 'video' ? whole.video : whole.audio!
      const head = source.samples.find((s) => s.source.at === track.samples[0]!.source.at)!
      return (head.dts + track.skipTicks - source.editOffset) / track.timescale
    })

    expect(entries).toHaveLength(2)
    expect(entries[0]).toBeCloseTo(request.in, 6)
    expect(entries[1]).toBeCloseTo(request.in, 6)
  })

  it('cuts the tail by leaving samples out, and carries one reordered frame past the out point', () => {
    const plan = planClip(whole, { in: 30 / 24, out: 100 / 24, sound: true })
    const video = trackByKind(plan.tracks, 'video')

    // Decode order, not presentation order: the run reaches the last sample shown before the out
    // point, and a frame that decodes before it but composes after it comes along. It cannot be
    // dropped — frames shown before the out point are predicted from it — and nothing in this
    // container hides it: `segment_duration` would, and it does not survive a remux. So the clip
    // ends one frame late on material with B-frames, and that number is written down here rather
    // than papered over. 70 frames were asked for; 71 are shown.
    expect(video.samples).toHaveLength(77)
    expect(presentationTicks(video)).toBe(36352) // 71 × 512, not 70 × 512
    expect(plan.duration).toBeCloseTo(71 / 24, 6)

    // The sound has no reordering, so it stops at the packet holding the out point: 131 packets
    // from the fifty-first, less the priming the edit list hides. Within one packet of the point
    // that was **asked for** — and deliberately not of `plan.duration`, which is a frame longer
    // than that for the reason written above. A packet is 23 ms, a frame is 42, so comparing the
    // sound against the picture's overshoot would fail by 5 ms and mean nothing.
    const audio = trackByKind(plan.tracks, 'audio')
    expect(audio.samples).toHaveLength(131)
    expect(presentationTicks(audio)).toBe(129195)
    expect(Math.abs(presentationTicks(audio) / 44100 - 70 / 24)).toBeLessThan(1024 / 44100)
  })

  it('closes a hole by lengthening the sample in front of it', () => {
    const plan = planClip(holed, { in: 0, out: 6, sound: true })
    const video = trackByKind(plan.tracks, 'video')
    const audio = trackByKind(plan.tracks, 'audio')

    expect(video.samples).toHaveLength(96)
    expect(audio.samples).toHaveLength(174)

    // Every picture sample keeps its own length except the one before the seam, which carries
    // the 3 ms by which its hole was longer than the sound's.
    const stretched = video.samples.filter((s) => s.duration !== 512)
    expect(stretched).toHaveLength(1)
    expect(stretched[0]!.duration).toBe(512 + 38)
    // The sound had the smaller hole, so nothing of it is left: its packets run back to back.
    expect(audio.samples.filter((s) => s.duration !== 1024 && s.duration !== 408)).toHaveLength(0)
  })

  it('moves both tracks by the same amount across the seam', () => {
    // The invariant the whole scheme stands on: an instant of the recording lands at one instant
    // of the clip, whichever track is asked. Everything else about a collapsed hole is cosmetic.
    const pulls = pullsAcrossSeam(holed, planClip(holed, { in: 0, out: 6, sound: true }).tracks)

    expect(pulls[0]).toBeCloseTo(1.9969, 4)
    expect(Math.abs(pulls[0]! - pulls[1]!)).toBeLessThan(0.001)
  })

  it('moves both tracks by the same amount when the sound is the one missing more', () => {
    // The same invariant on the material where the larger hole is the sound's. A track pulled by
    // its own hole moves the sound two seconds ahead of the picture at this seam, and it stays
    // ahead for the rest of the clip: there is nothing later on that brings the two back.
    const pulls = pullsAcrossSeam(wider, planClip(wider, { in: 0, out: 8, sound: true }).tracks)

    expect(pulls[0]).toBeCloseTo(2, 6)
    expect(Math.abs(pulls[0]! - pulls[1]!)).toBeLessThan(0.001)
  })

  it('pulls both tracks across a hole a single tick wide', () => {
    // The narrowest hole there is. One tick of the picture is 81 microseconds and nothing to look
    // at, but the sound around it lost 192 ticks of its own — 4.4 ms — and the pair is pulled by
    // the smaller of the two, which is the tick. Read as no hole at all, the tick stays in front
    // of the picture while the sound keeps the whole of its 192: the two part by 4 ms at this
    // seam and stay parted, because nothing later in the clip brings them back.
    const video = madeTrack('video', 12_288, 512, [
      { at: 0, count: 4 }, // ends at 2048
      { at: 2049, count: 4 }, // one tick behind it
    ])
    const audio = madeTrack('audio', 44_100, 1024, [
      { at: 0, count: 7 }, // ends at 7168, inside the picture's tick
      { at: 7360, count: 7 }, // 192 ticks behind it
    ])
    const source = { video, audio }

    const [seam] = seamsOf(source)
    expect(seam!.pull).toBeCloseTo(1 / 12_288, 12)

    const plan = planClip(source, { in: 0, out: 0.5, sound: true })
    // The picture's hole is the smaller one, so all of it goes: every frame states its own length.
    expect(trackByKind(plan.tracks, 'video').samples.filter((s) => s.duration !== 512)).toEqual([])
    // The sound moved by that same tick — 3.59 of its own, to the nearest one — and carries what
    // is left of its own hole on the packet in front of the seam.
    const audio_ = trackByKind(plan.tracks, 'audio')
    expect(audio_.samples.filter((s) => s.duration !== 1024).map((s) => s.duration)).toEqual([
      1024 + 192 - 4,
    ])
  })

  it('rounds the entry point to the nearest tick of the track', () => {
    // The one place in the program where seconds go back into ticks, and the one fixture family
    // cannot exercise it: 512 ticks of 12288 and 1024 of 44100 divide and multiply back exactly
    // for every sample the h264 material has, so rounding and truncating agree on all of it.
    // 29.97 does not: the fifteenth frame of 3003 ticks at 90000 stands at 0.5005 s, which
    // measures back as 45044.999999999993 in a double. Truncated, that is one tick before the
    // frame, `shownAt` answers the frame before it, and the clip starts a whole frame early —
    // the single promise of §8.2 this stage exists for, broken on a few frames in a hundred.
    const video = madeTrack('video', 90_000, 3003, [{ at: 0, count: 60 }])
    const plan = planClip(
      { video },
      { in: (15 * 3003) / 90_000, out: (60 * 3003) / 90_000, sound: false },
    )
    const track = plan.tracks[0]!

    // Frame fifteen and the forty-four behind it, entered on the frame itself: every sample here
    // is a sync sample, so there is no run-up to hide and nothing for the edit list to do.
    expect(track.samples).toHaveLength(45)
    expect(track.samples[0]!.source).toEqual(video.samples[15]!.source)
    expect(track.skipTicks).toBe(0)
  })

  it('rounds what is left of a collapsed hole to the nearest tick as well', () => {
    // The same rounding one layer down. The picture is missing 2048 of its ticks and the sound
    // 2048 of its own — 167 ms against 46, because the two count in different scales — so the
    // pair is pulled by the sound's 46 ms, and in ticks of the picture that is 570.65 of them.
    // Truncated, a tick of the hole stays behind on every seam of the clip.
    const video = madeTrack('video', 12_288, 512, [
      { at: 0, count: 24 },
      { at: 14_336, count: 24 },
    ])
    const audio = madeTrack('audio', 44_100, 1024, [
      { at: 0, count: 43 },
      { at: 46_080, count: 43 },
    ])
    const plan = planClip({ video, audio }, { in: 0, out: 4, sound: true })

    const stretched = trackByKind(plan.tracks, 'video').samples.filter((s) => s.duration !== 512)
    expect(stretched.map((s) => s.duration)).toEqual([512 + (2048 - 571)])
    // The sound had the smaller hole, so nothing of it is left over to carry at all.
    expect(trackByKind(plan.tracks, 'audio').samples.filter((s) => s.duration !== 1024)).toEqual([])
  })

  it('leaves a packet whole where its hole is narrower than the pull of the seam', () => {
    // The seam pulls by the wider of the two holes of the sound, so at the narrower one the pull
    // is longer than the hole. What is left over is not a shortening: taking it off the packet in
    // front gives a negative duration, which the writer states as a zero stts delta — the file
    // still opens, ffprobe still reads a plausible header, and the sound has silently lost
    // packets and runs short against a picture that did not move.
    const [seam] = seamsOf(uneven)
    expect(seam!.pull).toBeCloseTo(34816 / 44100, 9) // the wider of the two, 0.79 s

    const plan = planClip(uneven, { in: 0, out: 8, sound: true })
    const audio = trackByKind(plan.tracks, 'audio')
    const video = trackByKind(plan.tracks, 'video')

    expect(audio.samples).toHaveLength(213)
    expect(Math.min(...audio.samples.map((s) => s.duration))).toBeGreaterThan(0)
    // Every packet keeps exactly its own length: neither hole of the sound has anything left over
    // once the seam has been pulled, and neither loses any of itself to the other one.
    expect(audio.samples.reduce((total, s) => total + s.duration, 0)).toBe(217496)
    expect(presentationTicks(audio)).toBe(216472)
    // The picture is the track with the leftover here, and it carries it the usual way.
    expect(video.samples.filter((s) => s.duration !== 512).map((s) => s.duration)).toEqual([15387])
  })

  it('leaves a one-sided hole alone', () => {
    const oneSided: ClipSource = { video: holed.video, audio: whole.audio }
    const video = trackByKind(planClip(oneSided, { in: 0, out: 6, sound: true }).tracks, 'video')

    // The frame before the hole lasts the whole two seconds of it: the picture freezes while the
    // sound, which never stopped, plays on. 24576 ticks of hole on top of its own 512.
    const stretched = video.samples.filter((s) => s.duration !== 512)
    expect(stretched.map((s) => s.duration)).toEqual([512 + 24576])
  })

  it('keeps every tick of a one-sided hole, however narrow the hole is', () => {
    // Nothing pulls a hole the sound does not share, so the whole of it stays in front of the
    // picture whatever its width — and the narrow ones are the dangerous ones. A hole of a tick,
    // or of a few hundred, dropped instead of kept is up to 167 ms of picture gone at this
    // timescale, per seam and cumulative over the clip, and the file still opens and still plays:
    // only the stts deltas moved, so the picture runs ahead of a sound that never stopped.
    const video = madeTrack('video', 12_288, 512, [
      { at: 0, count: 4 }, // ends at 2048
      { at: 2049, count: 4 }, // a tick behind it, ending at 4097
      { at: 4397, count: 4 }, // 300 ticks behind that, ending at 6445
      { at: 8445, count: 4 }, // and 2000 behind that
    ])
    const audio = madeTrack('audio', 44_100, 1024, [{ at: 0, count: 40 }])
    const source = { video, audio }

    // Every one of the three is the picture's alone: the sound plays through all of them.
    expect(seamsOf(source).map((seam) => seam.pull)).toEqual([0, 0, 0])

    const plan = planClip(source, { in: 0, out: 1, sound: true })
    const stretched = trackByKind(plan.tracks, 'video').samples.filter((s) => s.duration !== 512)
    expect(stretched.map((s) => s.duration)).toEqual([512 + 1, 512 + 300, 512 + 2000])
    // The sound has no hole to carry anywhere.
    expect(trackByKind(plan.tracks, 'audio').samples.filter((s) => s.duration !== 1024)).toEqual([])
  })

  it('leaves a hole that only touches a seam out of the pull', () => {
    // A hole that meets a seam at an instant belongs to no seam: there was material on the other
    // track for every moment of it, so none of it is closed and all of it stays in front of the
    // sound. Answered with the seam's pull instead, the packet in front of such a hole comes out
    // 0.3 s short and everything behind it plays that much early against a picture that did not
    // move. Both edges have to be strict, so both are here: the sound resumes exactly where the
    // picture's hole opens, and stops again exactly where that hole closes.
    const video = madeTrack('video', 12_288, 512, [
      { at: 0, count: 24 }, // a second of picture, then a second of none
      { at: 24_576, count: 24 },
    ])
    const audio = madeTrack('audio', 44_100, 1024, [
      { at: 0, count: 20 }, // stops at 20480 and resumes at 44100 — exactly 1 s, the seam's edge
      { at: 44_100, count: 10 }, // ends at 54340: the hole that does lie inside the seam
      { at: 67_720, count: 20 }, // ends at 88200 — exactly 2 s, the seam's other edge
      { at: 132_300, count: 20 },
    ])
    const source = { video, audio }

    const [seam] = seamsOf(source)
    expect([seam!.from, seam!.to]).toEqual([1, 2])
    // Pulled by the one hole of the sound that lies inside it: 13380 ticks of 44100, 0.30 s.
    expect(seam!.pull).toBeCloseTo(13_380 / 44_100, 9)

    const plan = planClip(source, { in: 0, out: 4, sound: true })
    const packets = trackByKind(plan.tracks, 'audio').samples
    // The two touching holes keep every tick of themselves; the one inside the seam is closed
    // whole, so it leaves nothing on the packet in front of it.
    expect(packets.filter((s) => s.duration !== 1024).map((s) => s.duration)).toEqual([
      1024 + 23_620,
      1024 + 44_100,
    ])
    // The picture, whose hole the seam is measured across, carries what the pull did not take:
    // 12288 ticks of hole less the 3728 the sound's 13380 come to in the picture's scale.
    const frames = trackByKind(plan.tracks, 'video').samples
    expect(frames.filter((s) => s.duration !== 512).map((s) => s.duration)).toEqual([
      512 + 12_288 - 3728,
    ])
  })

  it('drops the sound when the clip asks for none', () => {
    const plan = planClip(whole, { in: 0, out: 2, sound: false })
    expect(plan.tracks.map((t) => t.kind)).toEqual(['video'])
    expect(plan.bytes).toBeLessThan(planClip(whole, { in: 0, out: 2, sound: true }).bytes)
  })

  it('clamps a request that runs past either end of the material', () => {
    const early = planClip(whole, { in: -5, out: 100, sound: true })
    expect(trackByKind(early.tracks, 'video').samples).toHaveLength(144)
    expect(trackByKind(early.tracks, 'video').skipTicks).toBe(1024)

    // An out point at or before the in point yields the one frame at the in point — a clip of one
    // frame. The editor never asks for this; writing an empty file would hide the mistake instead
    // of showing it.
    const inverted = planClip(whole, { in: 2, out: 1, sound: true })
    const video = trackByKind(inverted.tracks, 'video')
    expect(video.samples).toHaveLength(1)
    expect(video.skipTicks).toBe(1024)
    expect(inverted.duration).toBeCloseTo(1 / 24, 6)
  })

  it('gives an empty plan for material with no samples', () => {
    const empty: ClipSource = { video: { ...whole.video, samples: [] } }
    expect(planClip(empty, { in: 0, out: 1, sound: true })).toEqual({
      tracks: [],
      duration: 0,
      bytes: 0,
    })
    expect(planPreview(empty).tracks).toEqual([])

    // Sound beside a picture with no samples in it is not a clip either: a file with no picture
    // is not what the editor was asked for, so the export is refused rather than half written.
    const mute: ClipSource = { video: { ...whole.video, samples: [] }, audio: whole.audio }
    expect(planClip(mute, { in: 0, out: 1, sound: true }).tracks).toEqual([])
  })
})
