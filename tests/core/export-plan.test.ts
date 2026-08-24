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

/** Everything the fixture has. */
const whole = sourceOf([1, 2, 3], [1, 2, 3, 4])
/** The same with the second segment of each track thrown away: a hole in the middle. */
const holed = sourceOf([1, 3], [1, 3, 4])

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
    const plan = planClip(holed, { in: 0, out: 6, sound: true })
    const pulls = plan.tracks.map((track, index) => {
      const source = index === 0 ? holed.video.samples : holed.audio!.samples
      let decode = 0
      for (const [i, planned] of track.samples.entries()) {
        const sample = source[i]!
        const previous = source[i - 1]
        if (previous && sample.dts > previous.dts + previous.duration) {
          return (sample.dts - decode) / track.timescale
        }
        decode += planned.duration
      }
      return NaN
    })

    expect(pulls[0]).toBeCloseTo(1.9969, 4)
    expect(Math.abs(pulls[0]! - pulls[1]!)).toBeLessThan(0.001)
  })

  it('leaves a one-sided hole alone', () => {
    const oneSided: ClipSource = { video: holed.video, audio: whole.audio }
    const video = trackByKind(planClip(oneSided, { in: 0, out: 6, sound: true }).tracks, 'video')

    // The frame before the hole lasts the whole two seconds of it: the picture freezes while the
    // sound, which never stopped, plays on. 24576 ticks of hole on top of its own 512.
    const stretched = video.samples.filter((s) => s.duration !== 512)
    expect(stretched.map((s) => s.duration)).toEqual([512 + 24576])
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
  })
})
