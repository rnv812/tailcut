import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { planFrames } from '../../src/core/encode/plan'
import { decoderConfigOf } from '../../src/core/encode/decoder'
import { normalizeCrop, type Crop } from '../../src/core/encode/crop'
import {
  planClip,
  type ClipRequest,
  type ClipSource,
  type PlannedTrack,
  type SourceTrack,
} from '../../src/core/export/plan'
import { sampleEntryBytes, videoSampleEntry } from '../../src/core/iso/entry'
import { parseInit } from '../../src/core/iso/init'
import { editOffset, sampleRunOf, trackDefaults } from '../../src/core/iso/samples'
import { boxOf, u32, zeroes } from '../../src/core/iso/writer'
import type { Located, TrackKind } from '../../src/shared/types'

/**
 * What the frame path decides about a clip, against what the copy path decides about the same one.
 *
 * Almost nothing here is asserted as a number on its own. The whole of the second half of this
 * contract is one equality — what the encoder throws off the head is what the copy path would have
 * hidden with an edit list — and an equality is tested by computing both sides, so `planClip`
 * runs beside `planFrames` in nearly every case below.
 */

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/**
 * Where a sample's bytes would lie in a snapshot.
 *
 * A plan addresses samples by offset and length and never reads them, so this hands out the
 * addresses and keeps nothing: what matters is that two tracks of one recording are laid out in
 * one space, the way the snapshot lays them out.
 */
class Bank {
  private cursor = 0

  add(bytes: Uint8Array): Located {
    const at = this.cursor
    this.cursor += bytes.byteLength
    return { at, length: bytes.byteLength }
  }
}

/** A track indexed the way `sourceTrackOf` indexes one, out of a fixture and a bank of its own. */
function trackFrom(
  bank: Bank,
  init: Uint8Array,
  segments: Uint8Array[],
  kind: TrackKind,
): SourceTrack {
  const declared = parseInit(init)!.tracks.find((track) => track.kind === kind)!
  const entry = kind === 'video' ? videoSampleEntry(init) : null
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

/**
 * Six seconds of H.264 with sound: 320×240 at 24 frames a second, a sync sample every second,
 * and every frame after the first composed out of decode order. The reordering is the reason
 * this fixture is the one nearly everything below is measured on — a plan that reasoned about
 * decode order instead of presentation would be right on any material that has none.
 */
function h264(video: number[], audio: number[]): ClipSource {
  const bank = new Bank()
  return {
    video: trackFrom(
      bank,
      read('tests/fixtures/h264/init-stream0.m4s'),
      video.map((n) => read(`tests/fixtures/h264/chunk-stream0-0000${n}.m4s`)),
      'video',
    ),
    audio: trackFrom(
      bank,
      read('tests/fixtures/h264/init-stream1.m4s'),
      audio.map((n) => read(`tests/fixtures/h264/chunk-stream1-0000${n}.m4s`)),
      'audio',
    ),
  }
}

/** Four seconds of VP9, no sound and nothing reordered: the material a clip can open at zero on. */
function vp9(): ClipSource {
  const bank = new Bank()
  return {
    video: trackFrom(
      bank,
      read('tests/fixtures/vp9/init-stream0.m4s'),
      [1, 2].map((n) => read(`tests/fixtures/vp9/chunk-stream0-0000${n}.m4s`)),
      'video',
    ),
  }
}

/** Everything the fixture has. */
const whole = h264([1, 2, 3], [1, 2, 3, 4])
/** The same with the second segment of each track thrown away: a two-second hole in the middle. */
const holed = h264([1, 3], [1, 3, 4])
const nine = vp9()

const FRAMERATE = 30

/** One frame of the H.264 fixture, in ticks of its 12288: twenty-four frames a second. */
const FRAME_TICKS = 512

const videoOf = (plan: { tracks: PlannedTrack[] }): PlannedTrack =>
  plan.tracks.find((track) => track.kind === 'video')!

const audioOf = (plan: { tracks: PlannedTrack[] }): PlannedTrack | undefined =>
  plan.tracks.find((track) => track.kind === 'audio')

/**
 * The composition time of the frame on the screen at that instant, in ticks of the track.
 *
 * The definition the invariant is stated in, computed here from the samples themselves so that
 * the two sides of the equality do not come from the same arithmetic.
 */
function shownAt(track: SourceTrack, request: ClipRequest): number {
  const ticks = Math.round(request.in * track.timescale) + track.editOffset
  let best = -Infinity
  for (const sample of track.samples) {
    if (sample.pts <= ticks && sample.pts > best) best = sample.pts
  }
  return best
}

/** The source samples the copy path chose, matched back by where their bytes lie. */
function chosenSamples(source: SourceTrack, planned: PlannedTrack): SourceTrack['samples'] {
  return planned.samples.map(
    (sample) => source.samples.find((one) => one.source.at === sample.source.at)!,
  )
}

const sum = (numbers: number[]): number => numbers.reduce((total, one) => total + one, 0)

describe('planFrames: the head the copy path would have hidden', () => {
  it('throws off exactly the ticks the edit list of the copy would have hidden', () => {
    const request: ClipRequest = { in: 1.5, out: 3, sound: true }
    const copy = videoOf(planClip(whole, request))
    const plan = planFrames(whole, request, null, FRAMERATE)!

    // The premise: this clip does open in the middle of a group, so there is a head to hide.
    // On material where the entry point is a sync sample both numbers are zero and the equality
    // holds for nothing.
    expect(copy.skipTicks, 'the fixture gave this clip no head to hide').toBeGreaterThan(0)
    expect(plan).not.toBeNull()

    expect(plan.headTicks).toBe(copy.skipTicks)
    expect(plan.timescale).toBe(whole.video.timescale)

    // The other half of the convention, and not a consequence of the first: the frame the clip
    // opens on is composed exactly `headTicks` in, so subtracting them puts it at zero.
    const first = plan.frames.find((frame) => frame.keep)!
    expect(first.pts).toBe(plan.headTicks)
    expect(first.pts - plan.headTicks).toBe(0)
  })

  it('hides nothing where the clip opens on a sync sample, and both numbers are zero', () => {
    const request: ClipRequest = { in: 1, out: 3, sound: false }
    // The premise: the instant asked for is where a sync sample is composed. Read off the
    // material rather than assumed — a fixture whose keyframes moved would make this case a
    // second copy of the one above.
    const opening = nine.video.samples.find(
      (sample) => sample.pts === Math.round(request.in * nine.video.timescale),
    )
    expect(opening, 'no sample is composed at the instant the clip opens').toBeDefined()
    expect(opening!.sync, 'the clip does not open on a sync sample').toBe(true)

    const copy = videoOf(planClip(nine, request))
    const plan = planFrames(nine, request, null, FRAMERATE)!

    expect(copy.skipTicks).toBe(0)
    expect(plan.headTicks).toBe(0)
    // Nothing is a reference here: every frame decoded is a frame encoded.
    expect(plan.kept).toBe(plan.frames.length)
    expect(plan.frames[0]!.pts).toBe(0)
  })

  it('drops the composition offset of a clip that opens before the material does', () => {
    const request: ClipRequest = { in: -1, out: 1, sound: true }
    const copy = videoOf(planClip(whole, request))
    const plan = planFrames(whole, request, null, FRAMERATE)!

    // Nothing is thrown away — the clip begins where the recording begins — and yet the head is
    // not zero: the first frame of reordered material is composed a group after it is decoded,
    // and that offset is the whole of what the copy path's edit list hides here.
    expect(plan.kept).toBe(plan.frames.length)
    expect(copy.skipTicks).toBeGreaterThan(0)
    expect(plan.headTicks).toBe(copy.skipTicks)
    expect(plan.frames.find((frame) => frame.keep)!.pts).toBe(plan.headTicks)
  })
})

describe('planFrames: what is decoded and what is encoded', () => {
  it('decodes every sample the copy path would have written, head and all', () => {
    const request: ClipRequest = { in: 1.5, out: 3, sound: true }
    const copy = videoOf(planClip(whole, request))
    const plan = planFrames(whole, request, null, FRAMERATE)!

    expect(plan.frames).toHaveLength(copy.samples.length)
    // The same bytes in the same order: the frame path reads the material the copy path planned,
    // not a selection of its own.
    expect(plan.frames.map((frame) => frame.source)).toEqual(
      copy.samples.map((sample) => sample.source),
    )
    expect(plan.frames.map((frame) => frame.sync)).toEqual(
      copy.samples.map((sample) => sample.sync),
    )
    // The premise of the next test, stated here: there is a head, and it is decoded.
    expect(plan.kept).toBeLessThan(plan.frames.length)
    expect(plan.duration).toBe(planClip(whole, request).duration)
  })

  it('encodes the frames composed at or after the entry point, and only those', () => {
    const request: ClipRequest = { in: 1.5, out: 3, sound: true }
    const copy = videoOf(planClip(whole, request))
    const plan = planFrames(whole, request, null, FRAMERATE)!

    const enters = shownAt(whole.video, request)
    expect(enters, 'no frame is on the screen at the instant the clip opens').toBeGreaterThan(
      -Infinity,
    )

    const shown = chosenSamples(whole.video, copy).filter((sample) => sample.pts >= enters)
    expect(shown.length).toBeGreaterThan(0)
    expect(plan.kept).toBe(shown.length)
    expect(plan.frames.filter((frame) => frame.keep)).toHaveLength(plan.kept)
    // By presentation and not by place in the queue: on this material the two orders differ, so
    // a plan that counted the frames it had already seen would keep a different set of the same
    // size and encode the wrong ones.
    expect(plan.frames.map((frame) => frame.keep)).not.toEqual(
      plan.frames.map((_, index) => index >= plan.frames.length - plan.kept),
    )
    expect(plan.frames.filter((frame) => frame.keep).map((frame) => frame.source)).toEqual(
      shown.map((sample) => sample.source),
    )
  })

  it('keeps the durations the copy path settled on, so a hole it closed stays closed', () => {
    const request: ClipRequest = { in: 0, out: 6, sound: true }
    const copy = videoOf(planClip(holed, request))
    const plan = planFrames(holed, request, null, FRAMERATE)!

    // The premise: this material really does have a seam in it, and the copy path really did
    // close it. The frame in front of the hole runs a frame and a little — the tick or two the
    // sound could not give up — where the recording has it standing for two whole seconds.
    const seam = copy.samples.findIndex(
      (sample, index) => index + 1 < copy.samples.length && sample.duration !== FRAME_TICKS,
    )
    expect(seam, 'the holed fixture has no seam in it').toBeGreaterThan(0)
    const source = chosenSamples(holed.video, copy)
    const gap = source[seam + 1]!.pts - source[seam]!.pts
    expect(gap, 'the recording has no hole at the seam').toBeGreaterThan(20_000)
    expect(copy.samples[seam]!.duration).toBeLessThan(2 * FRAME_TICKS)

    expect(plan.frames.map((frame) => frame.duration)).toEqual(
      copy.samples.map((sample) => sample.duration),
    )
    // Counted afresh from the presentation times, the frame in front of the seam would be two
    // seconds long and the hole would be back in the file.
    expect(plan.frames[seam]!.duration).not.toBe(gap)
    expect(sum(plan.frames.filter((frame) => frame.keep).map((frame) => frame.duration))).toBe(
      sum(copy.samples.map((sample) => sample.duration)),
    )
  })
})

describe('planFrames: the sound is not touched', () => {
  it('hands on the track the copy path planned, packet for packet', () => {
    const request: ClipRequest = { in: 1.5, out: 3, sound: true }
    const copy = audioOf(planClip(whole, request))!
    const plan = planFrames(whole, request, null, FRAMERATE)!

    // The premise: the sound of this clip has a head of its own, hidden by its own edit list.
    // Re-timed anywhere in the frame path, this is the number that would move.
    expect(copy.skipTicks).toBeGreaterThan(0)
    expect(copy.samples.length).toBeGreaterThan(0)

    expect(plan.audio).toEqual(copy)
    expect(plan.audio!.skipTicks).toBe(copy.skipTicks)
    // Not shifted by the head of the picture, which is stated in a different timescale and would
    // be silently plausible: the two numbers have nothing to do with each other.
    expect(plan.audio!.skipTicks).not.toBe(plan.headTicks)
  })

  it('plans no sound for a clip asked for without it', () => {
    const request: ClipRequest = { in: 1.5, out: 3, sound: false }
    // The premise: this material has a sound track, so a null below is a decision and not a fact
    // about the fixture.
    expect(whole.audio).toBeDefined()
    const heard = planFrames(whole, { ...request, sound: true }, null, FRAMERATE)!
    expect(heard.audio).not.toBeNull()

    const silent = planFrames(whole, request, null, FRAMERATE)!
    expect(silent.audio).toBeNull()
    // The flag is about the sound and about nothing else: the same frames are decoded, the same
    // ones are encoded, and the same head comes off them.
    expect(silent.frames).toEqual(heard.frames)
    expect(silent.headTicks).toBe(heard.headTicks)
    expect(silent.duration).toBe(heard.duration)
  })
})

describe('planFrames: the picture that is asked for', () => {
  it('asks for the whole representation where there is no crop', () => {
    const request: ClipRequest = { in: 1.5, out: 3, sound: true }
    // The premise: the representation is this size, and the size comes off the track.
    expect(whole.video.width).toBe(320)
    expect(whole.video.height).toBe(240)

    const plan = planFrames(whole, request, null, FRAMERATE)!
    expect(plan.crop).toBeNull()
    expect(plan.geometry).toEqual({ width: 320, height: 240, framerate: FRAMERATE })
    // The frame rate is the one asked for and not one read off the material.
    expect(planFrames(whole, request, null, 25)!.geometry.framerate).toBe(25)
  })

  it('asks for the rectangle where there is one, and states its size nowhere twice over', () => {
    const request: ClipRequest = { in: 1.5, out: 3, sound: true }
    const crop: Crop = { x: 12, y: 10, width: 160, height: 120 }
    const plan = planFrames(whole, request, crop, FRAMERATE)!

    expect(plan.crop).toEqual(crop)
    expect(plan.geometry).toEqual({ width: 160, height: 120, framerate: FRAMERATE })
    // The three numbers are one rectangle: they cannot be made to disagree.
    expect(plan.geometry.width).toBe(plan.crop!.width)
    expect(plan.geometry.height).toBe(plan.crop!.height)
  })

  it('puts a rectangle right against the size the samples are coded in', () => {
    const request: ClipRequest = { in: 1.5, out: 3, sound: true }
    // Odd in three of its four numbers and hanging over the right edge of a 320-wide picture.
    const raw: Crop = { x: 301, y: 7, width: 101, height: 61 }
    const plan = planFrames(whole, request, raw, FRAMERATE)!

    expect(plan.crop).toEqual(normalizeCrop(raw, { width: 320, height: 240 }))
    // Pushed in rather than trimmed, and every number even: 220 is as far right as a rectangle
    // of 100 goes in a picture of 320, and 61 is under the smallest side worth cutting, so it
    // comes back as the minimum itself.
    expect(plan.crop).toEqual({ x: 220, y: 6, width: 100, height: 64 })
    expect(plan.geometry).toEqual({ width: 100, height: 64, framerate: FRAMERATE })
  })
})

describe('planFrames: what the decoder is told', () => {
  it('carries the configuration and the four letters of the track it is planning', () => {
    const request: ClipRequest = { in: 1.5, out: 3, sound: true }
    const plan = planFrames(whole, request, null, FRAMERATE)!

    expect(plan.decoder).toEqual(decoderConfigOf(whole.video.sampleEntry))
    expect(plan.decoder.codec).toBe('avc1.4d400d')
    expect(plan.decoder.description).toBeDefined()
    expect(plan.sourceFormat).toBe('avc1')

    // A second codec, so that neither of the two is a constant that happens to be right.
    const other = planFrames(nine, { in: 1, out: 3, sound: false }, null, FRAMERATE)!
    expect(other.decoder).toEqual(decoderConfigOf(nine.video.sampleEntry))
    expect(other.decoder.codec).toBe('vp09.00.20.08')
    expect(other.sourceFormat).toBe('vp09')
  })
})

describe('planFrames: material with no frame path at all', () => {
  it('answers with none for a clip that has no picture, or a picture nobody here can describe', () => {
    const request: ClipRequest = { in: 1.5, out: 3, sound: true }
    // The premise: the same request on the same material does have a frame path.
    expect(planFrames(whole, request, null, FRAMERATE)).not.toBeNull()

    const silent: ClipSource = { video: { ...whole.video, samples: [] }, audio: whole.audio }
    expect(planFrames(silent, request, null, FRAMERATE)).toBeNull()

    // A well-formed sample entry describing itself with nothing this program reads. Answered
    // with a plan, it would configure a decoder out of a guess.
    const unknown = boxOf('avc1', zeroes(24), u32(0x0140_00f0), zeroes(50), boxOf('pasp', u32(1, 1)))
    const undescribed: ClipSource = {
      video: { ...whole.video, sampleEntry: unknown },
      audio: whole.audio,
    }
    expect(decoderConfigOf(unknown)).toBeNull()
    expect(planFrames(undescribed, request, null, FRAMERATE)).toBeNull()
  })

  it('refuses picture whose retained bytes contain no decoder entry point', () => {
    const request: ClipRequest = { in: 0, out: 3, sound: true }
    const midGroup: ClipSource = {
      video: {
        ...whole.video,
        samples: whole.video.samples.map((sample) => ({ ...sample, sync: false })),
      },
      audio: whole.audio,
    }

    expect(midGroup.video.samples).not.toHaveLength(0)
    expect(midGroup.video.samples.some((sample) => sample.sync)).toBe(false)
    expect(planFrames(midGroup, request, null, FRAMERATE)).toBeNull()
  })
})

describe('planFrames: the entry point in the scale the transport counts in', () => {
  /**
   * A picture track at a chosen timescale, reordered the way a recorder writes one.
   *
   * Four frames a group; the frame decoded first is composed two frames later, which is where
   * the head is. Built rather than read from a fixture because the whole of this describe is
   * about what the arithmetic does at timescales the fixtures do not have — and the sample entry
   * is still the fixture's, because a plan without a decoder configuration is no plan at all.
   */
  function reordered(timescale: number, frameTicks: number, groups: number): ClipSource {
    const samples: SourceTrack['samples'] = []

    for (let group = 0; group < groups; group++) {
      const base = 4 * group * frameTicks
      // Decode order across, composition down: the sync sample of a group is composed two frames
      // after it is decoded, and the two frames before it are decoded after it.
      for (const [at, shown] of [2, 5, 3, 4].entries()) {
        samples.push({
          dts: base + at * frameTicks,
          pts: base + shown * frameTicks,
          duration: frameTicks,
          sync: at === 0,
          source: { at: 4096 + samples.length * 32, length: 32 },
        })
      }
    }

    return { video: { ...whole.video, timescale, editOffset: 0, samples, dropped: 0 } }
  }

  /** What `decodedFrames` will ask a decoded frame: its timestamp, in whole microseconds. */
  const stamp = (ticks: number, timescale: number): number =>
    Math.round((ticks * 1_000_000) / timescale)

  /**
   * Three scales, each with a clip that opens in the middle of a group.
   *
   * The first two are the ones a recording is written in, chosen so that the head does not land
   * on a whole microsecond — at 30000 and 90000 the conversion has a remainder of two thirds, and
   * a truncation instead of a rounding would be a microsecond out. The third is the cruel one:
   * a tick and a microsecond are the same thing there, so nothing can hide behind a scale factor.
   */
  const scales = [
    { timescale: 30_000, frameTicks: 2_000, exact: false },
    { timescale: 90_000, frameTicks: 1_500, exact: false },
    { timescale: 1_000_000, frameTicks: 40_000, exact: true },
  ]

  it('states the head in microseconds as well as in ticks, and nothing where there is no head', () => {
    for (const { timescale, frameTicks, exact } of scales) {
      const source = reordered(timescale, frameTicks, 3)
      const request: ClipRequest = { in: (8 * frameTicks) / timescale, out: 100, sound: false }
      const copy = videoOf(planClip(source, request))
      const plan = planFrames(source, request, null, FRAMERATE)!

      // The premise: this clip has a head at all, and it is the one the copy path would hide.
      expect(copy.skipTicks, `no head at ${timescale}`).toBe(4 * frameTicks)
      expect(plan.headTicks).toBe(copy.skipTicks)

      expect(plan.headUs).toBe(stamp(copy.skipTicks, timescale))
      // And it is a rounding and not a truncation, which is only a claim about something where
      // the division has a remainder worth a microsecond.
      expect(plan.headUs !== Math.trunc((copy.skipTicks * 1_000_000) / timescale)).toBe(!exact)
    }

    // Nothing to hide, nothing to convert. The vp9 fixture opens on a sync sample.
    const opened = planFrames(nine, { in: 1, out: 3, sound: false }, null, FRAMERATE)!
    expect(opened.headTicks).toBe(0)
    expect(opened.headUs).toBe(0)
  })

  it('keeps exactly the frames the stream will let through, at every scale', () => {
    for (const { timescale, frameTicks } of scales) {
      const source = reordered(timescale, frameTicks, 3)
      const request: ClipRequest = { in: (8 * frameTicks) / timescale, out: 100, sound: false }
      const plan = planFrames(source, request, null, FRAMERATE)!

      // What `decodedFrames` will do with each frame, worked out the way it works it out: off the
      // timestamp the decoder hands back, which is microseconds and can be nothing else.
      const lets = plan.frames.filter((frame) => stamp(frame.pts, timescale) >= plan.headUs)
      const kept = plan.frames.filter((frame) => frame.keep)

      // The premises: some frames are dropped and some are not, so the two sets below are two
      // sets and not two names for all of them.
      expect(kept.length, `nothing kept at ${timescale}`).toBe(6)
      expect(plan.frames.length - kept.length, `nothing dropped at ${timescale}`).toBe(2)
      expect(plan.kept).toBe(kept.length)

      expect(lets).toEqual(kept)

      // The frame the clip opens on sits exactly on the boundary, in both scales at once: this is
      // the one an off-by-one would take out. It is the earliest composed of the kept and not the
      // first of them — this material is reordered, and on reordered material those differ.
      const entry = kept.reduce((low, frame) => (frame.pts < low.pts ? frame : low))
      expect(entry).not.toBe(kept[0])
      expect(entry.pts).toBe(plan.headTicks)
      expect(stamp(entry.pts, timescale)).toBe(plan.headUs)
    }
  })

  it('answers by the microsecond where the two scales part company', () => {
    // A timescale nobody has seen, and the material is as absurd as the number: two million ticks
    // a second with a frame every tick. It is here because it is the only place the two ways of
    // asking the same question give different answers — anywhere below two million ticks a second
    // two adjacent frames are a whole microsecond apart and no rounding can bring them together.
    const timescale = 2_000_000
    const source = reordered(timescale, 1, 3)
    const request: ClipRequest = { in: 8 / timescale, out: 100, sound: false }
    const plan = planFrames(source, request, null, FRAMERATE)!

    expect(plan.headTicks).toBe(4)
    expect(plan.headUs).toBe(2)

    // The frame composed one tick before the entry point. In ticks it is behind the head; in the
    // microseconds the decoder counts it is level with it, and the decoder is what hands the
    // frames back.
    const edge = plan.frames.find((frame) => frame.pts === 3)!
    expect(edge, 'the material has no frame on the seam between the two scales').toBeDefined()
    expect(edge.pts).toBeLessThan(plan.headTicks)
    expect(stamp(edge.pts, timescale)).toBe(plan.headUs)

    // Kept, because it is the frame the stream will hand out. Said in ticks instead, the plan
    // would count one frame fewer than the stream produces — and the extra one would not even be
    // refused: its timestamp is the entry frame's own, so the guard in `encodeToTrack` knows the
    // number. It would be written as a sample with no duration left over for it, and the progress
    // would run past its own total.
    expect(edge.keep).toBe(true)
    expect(plan.frames.filter((frame) => stamp(frame.pts, timescale) >= plan.headUs)).toEqual(
      plan.frames.filter((frame) => frame.keep),
    )
    expect(plan.frames.filter((frame) => frame.pts >= plan.headTicks).length).toBe(plan.kept - 1)
  })
})
