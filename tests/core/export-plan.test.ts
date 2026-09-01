import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  AUDIO_WARMUP_PACKETS,
  planClip,
  planPreview,
  seamsOf,
  soundUnderPicture,
  type ClipSource,
  type PlannedTrack,
  type SourceSample,
  type SourceTrack,
} from '../../src/core/export/plan'
import { editOffset, sampleRunOf, trackDefaults } from '../../src/core/iso/samples'
import { audioSampleEntry, sampleEntryBytes, videoSampleEntry } from '../../src/core/iso/entry'
import { parseInit } from '../../src/core/iso/init'
import { presentationTicks } from '../../src/core/iso/progressive'
import { parseInit as parseWebmInit } from '../../src/core/webm/init'
import { webmToIso } from '../../src/core/webm/to-iso'
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

/**
 * A track indexed the way `sourceTrackOf` indexes one — through `sampleRunOf`, the single walk
 * from segments to samples — and assembled by hand only so that a test can hand the plan a
 * fixture and a bank of its own.
 */
function trackFrom(
  bank: Bank,
  init: Uint8Array,
  segments: Uint8Array[],
  kind: TrackKind,
): SourceTrack {
  const declared = parseInit(init)!.tracks.find((t) => t.kind === kind)!
  const entry = kind === 'video' ? videoSampleEntry(init) : audioSampleEntry(init)
  const run = sampleRunOf({
    segments: segments.map((bytes) => ({ bytes, source: bank.add(bytes) })),
    trackId: declared.trackId,
    kind,
    defaults: trackDefaults(init),
    loneTrack: true,
  })

  return {
    kind,
    timescale: declared.timescale,
    sampleEntry: sampleEntryBytes(init, declared.trackId)!,
    width: entry?.codedWidth ?? 0,
    height: entry?.codedHeight ?? 0,
    editOffset: editOffset(init, declared.trackId),
    samples: run.samples,
    dropped: run.dropped,
  }
}

const trackOf = (
  bank: Bank,
  initPath: string,
  segmentPaths: string[],
  kind: TrackKind,
): SourceTrack => trackFrom(bank, read(initPath), segmentPaths.map(read), kind)

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
  // Stated sample by sample rather than walked out of a container, so there was never a repeat
  // for `sampleRunOf` to drop: these runs are arithmetic, and every decode time in them is
  // written once by the test that asked for it.
  return {
    kind,
    timescale,
    sampleEntry: new Uint8Array(0),
    ...shape,
    editOffset: 0,
    samples,
    dropped: 0,
  }
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
      const sample = samples.find((candidate) => candidate.source.at === planned.source.at)!
      const previousPlanned = track.samples[i - 1]
      const previous = previousPlanned
        ? samples.find((candidate) => candidate.source.at === previousPlanned.source.at)
        : undefined
      if (previous && sample.dts > previous.dts + previous.duration) {
        return (sample.dts - decode) / track.timescale
      }
      decode += planned.duration
    }
    return NaN
  })
}

/**
 * Where every planned sample is composed in the file being written, in ticks counted from the
 * head of it: the decode time it lands at, which is the sum of the durations in front of it, plus
 * its own composition offset. The frame the clip opens on is the earliest of these at or after
 * `skipTicks`; everything composed before that is run-up the edit list hides.
 */
function composedFrames(track: PlannedTrack): Array<{ at: number; source: Located }> {
  let decode = 0
  return track.samples.map((sample) => {
    const at = decode + sample.cts
    decode += sample.duration
    return { at, source: sample.source }
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

/**
 * Three retained runs whose latter two begin inside a group of pictures. The samples before each
 * sync frame survived capture, but their references lie in the missing stretch in front of the
 * run, so neither can be the first chunk handed to a fresh decoder.
 */
const gapsIntoGroups: SourceTrack = (() => {
  const video = madeTrack('video', 1000, 100, [
    { at: 0, count: 3 },
    { at: 1000, count: 5 },
    { at: 2000, count: 4 },
  ])
  const syncTimes = new Set([0, 1200, 2100])
  return {
    ...video,
    samples: video.samples.map((sample) => ({ ...sample, sync: syncTimes.has(sample.dts) })),
  }
})()

/** The type the page opened its SourceBuffer with; a VP9 track cannot be converted without it. */
const VP9_TYPE = 'video/webm; codecs="vp09.00.10.08"'

/**
 * The picture of the WebM fixture, converted to ISO exactly as the capture converts it: sixty
 * frames of VP9 at ten a second, timed in ticks of 1000, the first of them at 14 ms.
 *
 * Every frame of it therefore begins on a boundary that is off the whole tenth of a second —
 * 0.014, 0.114, … 4.014 — and those are the boundaries a double cannot state exactly. No fixture
 * packaged as mp4 has one: 512 ticks of 12288 and 1024 of 44100 divide and multiply back to the
 * tick, which is why the rounding at both ends of a request is measured on this material.
 */
const webmPicture: SourceTrack = (() => {
  const init = parseWebmInit(read('tests/fixtures/webm/init-stream0.webm'))!
  const converter = webmToIso(init, VP9_TYPE)!
  const segments = [1, 2, 3].map(
    (n) => converter.segment(read(`tests/fixtures/webm/chunk-stream0-0000${n}.webm`))!.bytes,
  )
  return trackFrom(new Bank(), converter.initBytes, segments, 'video')
})()

const trackByKind = (tracks: PlannedTrack[], kind: TrackKind): PlannedTrack =>
  tracks.find((t) => t.kind === kind)!

describe('seamsOf', () => {
  it('finds nothing in material with no holes', () => {
    expect(seamsOf(whole)).toEqual([])
  })

  it('pairs the hole in the picture with the hole in the sound and pulls to the smaller', () => {
    const seams = seamsOf(holed)
    expect(seams).toHaveLength(1)
    const [seam] = seams
    // Two seconds of picture are missing. The boundaries are on the presentation clock, after
    // the source edit has hidden the reordered lead-in.
    expect(seam!.from).toBeCloseTo(2 - holed.video.editOffset / holed.video.timescale, 6)
    expect(seam!.to).toBeCloseTo(4 - holed.video.editOffset / holed.video.timescale, 6)
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

    expect(seam!.from).toBeCloseTo(2 - wider.video.editOffset / wider.video.timescale, 6)
    expect(seam!.to).toBeCloseTo(4 - wider.video.editOffset / wider.video.timescale, 6)
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

  it('pairs holes on the presentation clock when the tracks have different edits', () => {
    const video = {
      ...madeTrack('video', 1000, 100, [
        { at: 1000, count: 3 },
        { at: 2000, count: 3 },
      ]),
      editOffset: 1000,
    }
    const audio = madeTrack('audio', 1000, 100, [
      { at: 0, count: 3 },
      { at: 1000, count: 3 },
    ])

    expect(seamsOf({ video, audio })).toEqual([{ from: 0.3, to: 1, pull: 0.7 }])
  })

  it('collapses a hole entirely when there is no sound at all', () => {
    const silent: ClipSource = { video: holed.video }
    const [seam] = seamsOf(silent)
    expect(seam!.pull).toBeCloseTo(seam!.to - seam!.from, 9)
  })
})

describe('planPreview', () => {
  it('leaves an existing sound gap intact when it already matches the picture gap', () => {
    const watched = soundUnderPicture(holed)

    expect(watched.audio!.samples.map((sample) => sample.source.at)).toEqual(
      holed.audio!.samples.map((sample) => sample.source.at),
    )
  })

  it('matches prefetched sound to picture runs on the presentation clock', () => {
    const video = {
      ...madeTrack('video', 1000, 100, [
        { at: 200, count: 3 },
        { at: 1200, count: 3 },
      ]),
      editOffset: 200,
    }
    const audio = madeTrack('audio', 1000, 100, [{ at: 0, count: 13 }])
    const watched = soundUnderPicture({ video, audio }).audio!

    expect(watched.samples.map((sample) => sample.dts)).toEqual([0, 100, 200, 1000, 1100, 1200])
  })

  it('removes sound retained through part of a longer picture gap', () => {
    const video = madeTrack('video', 1000, 100, [
      { at: 0, count: 3 },
      { at: 1000, count: 3 },
    ])
    const audio = madeTrack('audio', 1000, 100, [
      { at: 0, count: 5 },
      { at: 800, count: 5 },
    ])
    const watched = soundUnderPicture({ video, audio }).audio!

    expect(watched.samples.map((sample) => sample.dts)).toEqual([0, 100, 200, 1000, 1100, 1200])
  })

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

  it('keeps silence at the head of sound that starts after the picture', () => {
    // The preview asks for the picture's own span, and the sound of a recording whose first
    // second of packets never arrived begins a second behind it. The entry point of the sound
    // then lies in front of the packet it enters at, and there is nothing at its head to hide.
    // There is no sound to hide, but there is a real second of silence to preserve before it.
    const samples = whole.audio!.samples.filter((sample) => sample.dts >= whole.audio!.timescale)
    const late: ClipSource = { video: whole.video, audio: { ...whole.audio!, samples } }
    const plan = planPreview(late)
    const audio = trackByKind(plan.tracks, 'audio')

    expect(late.audio!.samples[0]!.dts).toBe(45056) // a second in, to the nearest packet
    expect(audio.samples).toHaveLength(216)
    expect(audio.skipTicks).toBe(0)
    expect(audio.delayTicks).toBe(44_032)
    expect(presentationTicks(audio)).toBe(264600)
    expect(presentationTicks(audio) / audio.timescale).toBeCloseTo(plan.duration, 9)
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

  it('enters at the key frame the requested frame is composed after, not the one it decodes after', () => {
    // The two clocks part company at every key frame of this material. The fixture carries
    // B-frames, so each sync sample is composed 1024 ticks — two frames of 512 — after it is
    // decoded, and the last frames of a group are the ones that show it: frame 22 of the
    // presentation is composed at 12288, which is to the tick the **decode** time of the key
    // frame at index 24, while the frame itself decodes at index 21, three samples in front of
    // that key frame.
    //
    // Entered by decode time, the run therefore starts at the key frame at 24 and the frame that
    // was asked for is not in the file at all: the clip opens two frames late, on the key frame
    // itself, and every measure of the plan agrees with itself while saying so — `skipTicks`
    // comes out zero and the head lands exactly where the request pointed. Entered by
    // composition time, the run starts at the key frame in front of the group the frame belongs
    // to and the edit list hides the whole of it. The gap between the two clocks is the reorder
    // delay, and it is the width of the mistake: two frames here, more on a deeper pyramid.
    const key = whole.video.samples[24]!
    const asked = whole.video.samples[21]!
    expect(key.sync).toBe(true)
    expect(key.pts - key.dts).toBe(1024)
    expect(asked.pts).toBe(key.dts) // 12288 on one clock, 12288 on the other, two frames apart
    expect(asked.sync).toBe(false)

    const plan = planClip(whole, { in: 22 / 24, out: 6, sound: false })
    const video = trackByKind(plan.tracks, 'video')

    // The whole recording, from the key frame that opens it: everything in decode order in front
    // of frame 22 is a reference for it or for the frames behind it, and it is cheap to keep.
    expect(video.samples).toHaveLength(144)
    expect(video.samples[0]!.source).toEqual(whole.video.samples[0]!.source)
    // Twenty-four frames of run-up hidden — 12288 − 0 — and not the nothing an entry at 24 hides.
    expect(video.skipTicks).toBe(12288)

    // And the frame the clip opens on is the frame that was asked for, which is the promise of
    // Exact entry is the reason the export head may be re-encoded. Entered at key frame 24, the earliest composition
    // in the file lies 1024 ticks past a skip of zero, and this is the frame two later.
    const shown = composedFrames(video)
      .filter((frame) => frame.at >= video.skipTicks)
      .sort((a, b) => a.at - b.at)[0]!
    expect(shown.at).toBe(video.skipTicks)
    expect(shown.source).toEqual(asked.source)
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

  it('resumes every retained run at a sync sample after a decode-time gap', () => {
    const firstDelta = gapsIntoGroups.samples.find((sample) => sample.dts === 1000)!
    const secondDelta = gapsIntoGroups.samples.find((sample) => sample.dts === 2000)!
    const firstEntry = gapsIntoGroups.samples.find((sample) => sample.dts === 1200)!
    const secondEntry = gapsIntoGroups.samples.find((sample) => sample.dts === 2100)!
    expect([firstDelta.sync, secondDelta.sync]).toEqual([false, false])
    expect([firstEntry.sync, secondEntry.sync]).toEqual([true, true])

    const video = trackByKind(
      planClip({ video: gapsIntoGroups }, { in: 0, out: 3, sound: false }).tracks,
      'video',
    )
    const sources = video.samples.map((sample) => sample.source)

    expect(sources).not.toContainEqual(firstDelta.source)
    expect(sources).not.toContainEqual(secondDelta.source)
    expect(sources).toContainEqual(firstEntry.source)
    expect(sources).toContainEqual(secondEntry.source)
  })

  it('drops sound that resumes before the picture can decode after a gap', () => {
    // The second picture run begins at 1.0 s, but its first decodable frame is the sync sample at
    // 1.2 s. Sound resumes at 1.0 s as well. Keeping those first two packets lets them play under
    // the frozen frame before the gap and leaves the sound visibly ahead until the keyframe.
    const audio = madeTrack('audio', 1000, 100, [
      { at: 0, count: 3 },
      { at: 1000, count: 20 },
    ])
    const source = { video: gapsIntoGroups, audio }
    const plan = planClip(source, { in: 0, out: 3, sound: true })
    const sound = trackByKind(plan.tracks, 'audio')
    const retained = new Set(sound.samples.map((sample) => sample.source.at))

    expect(retained.has(audio.samples.find((sample) => sample.dts === 1000)!.source.at)).toBe(false)
    expect(retained.has(audio.samples.find((sample) => sample.dts === 1100)!.source.at)).toBe(false)
    expect(retained.has(audio.samples.find((sample) => sample.dts === 1200)!.source.at)).toBe(true)
    expect(retained.has(audio.samples.find((sample) => sample.dts === 2000)!.source.at)).toBe(false)
    expect(retained.has(audio.samples.find((sample) => sample.dts === 2100)!.source.at)).toBe(true)

    const pulls = pullsAcrossSeam(source, plan.tracks)
    expect(Math.abs(pulls[0]! - pulls[1]!)).toBeLessThan(0.001)
  })

  it('matches discarded picture and sound on their presentation clocks', () => {
    const video = { ...gapsIntoGroups, editOffset: 200 }
    const audio = madeTrack('audio', 1000, 100, [{ at: 0, count: 30 }])
    const plan = planClip({ video, audio }, { in: -0.2, out: 2.2, sound: true })
    const retained = new Set(
      trackByKind(plan.tracks, 'audio').samples.map((sample) => sample.source.at),
    )

    // Raw video 1.0…1.2 is presentation 0.8…1.0 because its edit begins 200 ms in. Audio has no
    // edit, so the packets at 0.8 and 0.9 are the ones belonging to those unusable delta frames.
    expect(retained.has(audio.samples.find((sample) => sample.dts === 800)!.source.at)).toBe(false)
    expect(retained.has(audio.samples.find((sample) => sample.dts === 900)!.source.at)).toBe(false)
    expect(retained.has(audio.samples.find((sample) => sample.dts === 1000)!.source.at)).toBe(true)
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

  it('does not take sound warm-up from the run before a recording gap', () => {
    const sourceAudio = holed.audio!
    const resumed = sourceAudio.samples.find((sample, index, samples) => {
      const previous = samples[index - 1]
      return previous !== undefined && sample.dts > previous.dts + previous.duration
    })!
    const audio = trackByKind(
      planClip(holed, { in: 4, out: 5.5, sound: true }).tracks,
      'audio',
    )

    // The requested instant is less than four packets into the resumed run. Walking four packets
    // back without respecting the discontinuity takes one from the old run, then asks the edit
    // list to hide the two-second hole. That skip is longer than the planned sound itself, so the
    // exported clip has no audible presentation even though the editor preview does.
    expect(audio.samples[0]!.source).toEqual(resumed.source)
    expect(audio.skipTicks).toBeLessThan(
      audio.samples.reduce((ticks, sample) => ticks + sample.duration, 0),
    )
    expect(presentationTicks(audio)).toBeGreaterThan(0)
  })

  it('keeps a resumed sound run late when it begins after the resumed picture', () => {
    const video = madeTrack('video', 1000, 100, [
      { at: 0, count: 4 },
      { at: 1000, count: 4 },
    ])
    const sourceAudio = madeTrack('audio', 1000, 100, [
      { at: 0, count: 4 },
      { at: 1100, count: 4 },
    ])
    const audio = trackByKind(
      planClip({ video, audio: sourceAudio }, { in: 1, out: 1.4, sound: true }).tracks,
      'audio',
    )

    // At the clip head the picture has resumed, while the first packet of the new sound run is
    // still 100 ms away. The packet before the recording gap is not decoder warm-up for that run,
    // and moving the future packet to movie time zero would put the sound 100 ms early. The plan
    // therefore names the future run and carries its silent lead for the edit list to state.
    expect(audio.samples[0]!.source).toEqual(sourceAudio.samples[4]!.source)
    expect(audio).toMatchObject({ delayTicks: 100 })
    expect(presentationTicks(audio)).toBe(400)
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
    // the frame-accurate entry promise, otherwise broken on a few frames in a hundred.
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

    // The same rounding from the side truncating never reaches. 0.50049 s measures back as
    // 45044.1 — a tick short of that same frame — so the frame on the screen at that instant is
    // the one before it, frame fourteen, and that is where a clip asked for that instant starts.
    // Rounded up instead of to the nearest tick it is 45045 on the nose, frame fifteen opens the
    // clip, and the 33 ms of frame fourteen the user was looking at when the handle was placed
    // are gone from the file with nothing to say they ever were there.
    const early = planClip({ video }, { in: 0.50049, out: (60 * 3003) / 90_000, sound: false })
    const from14 = early.tracks[0]!
    expect(from14.samples).toHaveLength(46)
    expect(from14.samples[0]!.source).toEqual(video.samples[14]!.source)
    expect(from14.skipTicks).toBe(0)
  })

  it('rounds the out point to the nearest tick as well, and not up to the next one', () => {
    // The other end of the same rule, on the material that can state it. The WebM fixture times
    // its picture in milliseconds and starts it at 14, so the forty-first frame begins at 4.014 s
    // exactly — and 4.014 × 1000 comes back out of a double as 4014.0000000000005, a hair above
    // the tick that frame begins on. Rounded up, the hair takes the frame in: the clip runs
    // 4.100 s and shows a frame past the instant the editor asked it to stop at. Rounded to the
    // nearest tick it is the 4.000 s that was asked for, which is what the in point above does at
    // its own end — and the plan has exactly one rule for turning a second into a tick.
    const scale = webmPicture.timescale
    const boundary = webmPicture.samples[40]!
    expect([scale, webmPicture.editOffset]).toEqual([1000, 0])
    expect(webmPicture.samples).toHaveLength(60)
    expect(boundary.pts / scale).toBe(4.014)
    expect(4.014 * scale).toBeGreaterThan(boundary.pts)

    const plan = planClip({ video: webmPicture }, { in: 0, out: 4.014, sound: false })
    const track = plan.tracks[0]!

    // Forty frames, the last of them the one before the boundary: the frame that begins at the
    // out point is the first frame not shown, and it stays out of the file.
    expect(track.samples).toHaveLength(40)
    expect(track.samples[39]!.source).toEqual(webmPicture.samples[39]!.source)
    expect(track.skipTicks).toBe(0)
    expect(plan.duration).toBeCloseTo(4, 9)

    // And the same rule from below, which is the half a truncated tick gets wrong: 4.0146 s
    // lands six tenths of a tick inside that same frame, part of the frame is therefore shown,
    // and the whole of it goes into the file — the last sample any part of which is shown.
    // Truncated to 4014 the frame is dropped instead, and a request six tenths of a millisecond
    // longer than the one above comes out a tenth of a second shorter.
    const inside = planClip({ video: webmPicture }, { in: 0, out: 4.0146, sound: false })
    expect(inside.tracks[0]!.samples).toHaveLength(41)
    expect(inside.tracks[0]!.samples[40]!.source).toEqual(boundary.source)
    expect(inside.duration).toBeCloseTo(4.1, 9)
  })

  it('enters on the frame that is on the screen at the in point, not on the one after it', () => {
    // An in point off the frame grid, which is where a dragged handle lands: 2.02 s sits inside
    // the frame that begins at 2.0000, and the next one begins at 2.0417. The frame on the screen
    // at that instant is the first of the two, and the clip has to open on it to remain frame-accurate.
    // clip starts at the instant that was asked for, and entering at the frame after it starts
    // the clip 42 ms late instead. Nothing in the file would say so: the edit list dutifully
    // hides the extra frame, the plan agrees with itself, and the material is simply not there.
    const onScreen = whole.video.samples[48]!
    const next = whole.video.samples[51]!
    const seconds = (sample: SourceSample): number =>
      (sample.pts - whole.video.editOffset) / whole.video.timescale
    expect(seconds(onScreen)).toBeCloseTo(2, 9)
    expect(seconds(next)).toBeCloseTo(2 + 1 / 24, 9)

    const plan = planClip(whole, { in: 2.02, out: 3, sound: false })
    const video = trackByKind(plan.tracks, 'video')

    // 25600 − 24576: the frame at two seconds is composed a key frame's reorder delay after the
    // sample the run starts at, and that delay is the whole of what the edit list hides here.
    expect(video.skipTicks).toBe(1024)
    const shown = composedFrames(video)
      .filter((frame) => frame.at >= video.skipTicks)
      .sort((a, b) => a.at - b.at)[0]!
    expect(shown.at).toBe(video.skipTicks)
    expect(shown.source).toEqual(onScreen.source)

    // A second of clip out of the 0.98 that was asked for: an in point inside a frame rounds the
    // head outwards, never inwards. Entered at the frame after it the clip comes out 0.958 —
    // a frame short of the request instead of a frame over it.
    expect(plan.duration).toBeCloseTo(1, 9)
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

  it('joins a picture hole even when sound was buffered through it', () => {
    const video = madeTrack('video', 1000, 100, [
      { at: 0, count: 3 },
      { at: 1000, count: 3 },
    ])
    const audio = madeTrack('audio', 1000, 100, [{ at: 0, count: 13 }])
    const plan = planPreview({ video, audio })
    const picture = trackByKind(plan.tracks, 'video')
    const sound = trackByKind(plan.tracks, 'audio')

    // Audio fetched ahead through a picture gap is not watched material. Keeping it makes the
    // preview freeze on the last frame of every live segment while that sound plays. Both tracks
    // therefore lose the same 0.7 s and the resumed picture follows the previous frame directly.
    expect(picture.samples.map((sample) => sample.duration)).toEqual([100, 100, 100, 100, 100, 100])
    expect(sound.samples.map((sample) => sample.source.at)).toEqual([
      audio.samples[0]!.source.at,
      audio.samples[1]!.source.at,
      audio.samples[2]!.source.at,
      audio.samples[10]!.source.at,
      audio.samples[11]!.source.at,
      audio.samples[12]!.source.at,
    ])
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

  it('pulls a gap that lies under two seams by the whole of both', () => {
    // The picture drops out twice with a stretch of picture between the two; the sound is away
    // for one unbroken stretch covering both. Every seam is measured across a hole of the
    // picture, so there are two of them here and one hole of the sound under them, and what the
    // clip takes out of the timeline is the pair — a second at each seam.
    //
    // Answered with the first seam alone, the packet in front of the sound's hole keeps a second
    // that the picture no longer has, and everything behind it plays a whole second late against
    // a picture that moved by two. Nothing about the file looks wrong: the durations are all
    // positive, the frames are all there, and ffprobe reads it without a word.
    const video = madeTrack('video', 12_288, 512, [
      { at: 0, count: 24 }, // a second of picture, then a second of none
      { at: 24_576, count: 24 }, // a second back, from 2 s to 3 s
      { at: 49_152, count: 24 }, // and away again until 4 s
    ])
    const audio = madeTrack('audio', 44_100, 1024, [
      { at: 0, count: 38 }, // stops at 0.88 s, before the first seam opens
      { at: 180_224, count: 40 }, // and comes back at 4.09 s, after the second one closes
    ])
    const source = { video, audio }

    // One hole of the sound lying under both seams, and each of them pulls by its own second.
    expect(seamsOf(source).map((seam) => [seam.from, seam.to, seam.pull])).toEqual([
      [1, 2, 1],
      [3, 4, 1],
    ])

    const plan = planClip(source, { in: 0, out: 5, sound: true })
    const frames = trackByKind(plan.tracks, 'video')
    const packets = trackByKind(plan.tracks, 'audio')

    // The picture's two holes are closed whole: nothing of either is left on the frame in front.
    expect(frames.samples.every((sample) => sample.duration === 512)).toBe(true)
    // The sound's hole is 141312 ticks wide and two seconds of it go: 88200 ticks off, and the
    // 53112 that are left ride on the packet in front of it.
    expect(packets.samples.filter((s) => s.duration !== 1024).map((s) => s.duration)).toEqual([
      1024 + 53_112,
    ])

    // What the whole scheme stands on: the two tracks come out of the gap having lost the same
    // stretch of real time, so the sound behind it sits on the picture it was recorded with.
    const lands = (track: PlannedTrack, index: number): number =>
      track.samples.slice(0, index).reduce((total, s) => total + s.duration, 0) / track.timescale
    const recorded = (track: SourceTrack, index: number): number =>
      track.samples[index]!.dts / track.timescale

    expect(recorded(video, 48) - lands(frames, 48)).toBeCloseTo(2, 9)
    expect(recorded(audio, 38) - lands(packets, 38)).toBeCloseTo(2, 9)
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
