import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { assembleMp4 } from '../../src/core/export/assemble'
import {
  planClip,
  planPreview,
  soundUnderPicture,
  type ClipSource,
  type SourceTrack,
} from '../../src/core/export/plan'
import { editOffset, sampleRunOf, trackDefaults } from '../../src/core/iso/samples'
import { audioSampleEntry, sampleEntryBytes, videoSampleEntry } from '../../src/core/iso/entry'
import { parseInit } from '../../src/core/iso/init'
import { boxBody, childBoxes, findBox, topLevelBoxes } from '../../src/core/iso/reader'
import { decodeWarnings, frameAt, frameTimes, probeFile, writeTemp } from '../support/media'
import type { Located, TrackKind } from '../../src/shared/types'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/** The snapshot, in miniature: one buffer of segments, and ranges into it. */
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
 * from segments to samples — and assembled by hand only so that a test can pick the fixture
 * segments and the bank they land in.
 */
function trackOf(bank: Bank, initPath: string, segmentPaths: string[], kind: TrackKind): SourceTrack {
  const init = read(initPath)
  const declared = parseInit(init)!.tracks.find((t) => t.kind === kind)!
  const entry = kind === 'video' ? videoSampleEntry(init) : audioSampleEntry(init)
  const run = sampleRunOf({
    segments: segmentPaths.map((path) => {
      const bytes = read(path)
      return { bytes, source: bank.add(bytes) }
    }),
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

interface Material {
  source: ClipSource
  bytesOf: (at: Located) => Uint8Array
}

function materialOf(videoSegments: number[], audioSegments: number[]): Material {
  const bank = new Bank()
  const source: ClipSource = {
    video: trackOf(
      bank,
      'tests/fixtures/h264/init-stream0.m4s',
      videoSegments.map((n) => `tests/fixtures/h264/chunk-stream0-0000${n}.m4s`),
      'video',
    ),
    audio: trackOf(
      bank,
      'tests/fixtures/h264/init-stream1.m4s',
      audioSegments.map((n) => `tests/fixtures/h264/chunk-stream1-0000${n}.m4s`),
      'audio',
    ),
  }
  const bytes = bank.bytes()
  return { source, bytesOf: (at) => bytes.subarray(at.at, at.at + at.length) }
}

/** A picture on its own, from any fixture family: used for material with no reordering in it. */
function pictureOnly(initPath: string, segmentPaths: string[]): Material {
  const bank = new Bank()
  const source: ClipSource = { video: trackOf(bank, initPath, segmentPaths, 'video') }
  const bytes = bank.bytes()
  return { source, bytesOf: (at) => bytes.subarray(at.at, at.at + at.length) }
}

const whole = materialOf([1, 2, 3], [1, 2, 3, 4])
const holed = materialOf([1, 3], [1, 3, 4])

/** The recording itself, written out whole: the frames every cut is compared against. */
const reference = writeTemp(
  'export-reference.mp4',
  assembleMp4(planPreview(whole.source), whole.bytesOf),
)

const clip = (name: string, material: Material, request: Parameters<typeof planClip>[1]): string =>
  writeTemp(name, assembleMp4(planClip(material.source, request), material.bytesOf))

describe('assembleMp4', () => {
  it('writes the whole recording back as one progressive file', () => {
    const probe = probeFile(reference)
    expect(probe.stderr, 'ffprobe complains about the reference file').toBe('')
    expect(probe.probed!.streams.map((s) => Number(s.nb_read_frames))).toEqual([144, 259])
    expect(decodeWarnings(reference)).toBe('')

    // Two source tracks whose init segments both call themselves track 1: the writer has to
    // renumber them or the second trak overwrites the first in every player.
    const bytes = read(reference)
    const moov = findBox(bytes, ['moov'])!
    expect(topLevelBoxes(bytes).map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat'])
    expect(moov.size).toBeGreaterThan(0)
  })

  it('numbers the tracks apart and states the shape of the picture the right way up', () => {
    // Read out of the boxes and not out of ffprobe, because ffprobe answers neither question
    // from them: it takes the frame size out of the SPS and counts streams, so a file that
    // declares 240×320 for a 320×240 picture and calls both its tracks 1 probes clean and plays
    // wrong. Measured: with the two sizes handed over the other way round every player that lays
    // out from the tkhd shows the clip squeezed, and ffprobe reports nothing at all.
    const bytes = read(reference)
    const traks = childBoxes(bytes, findBox(bytes, ['moov'])!).filter((b) => b.type === 'trak')

    /** tkhd version 0: the number of the track, and the display size as two 16.16 numbers. */
    const header = (index: number): Record<string, number> => {
      const box = childBoxes(bytes, traks[index]!).find((b) => b.type === 'tkhd')!
      const body = boxBody(bytes, box)
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
      return {
        trackId: view.getUint32(12),
        width: view.getUint32(76) / 0x10000,
        height: view.getUint32(80) / 0x10000,
      }
    }

    expect(traks).toHaveLength(2)
    // Both source inits call their track 1, so the numbers here are this stage's own: distinct,
    // and none of them zero, which the specification forbids outright.
    expect(header(0)).toEqual({ trackId: 1, width: 320, height: 240 })
    expect(header(1)).toEqual({ trackId: 2, width: 0, height: 0 })
  })

  it('starts on the frame that was asked for', () => {
    // Experiment one of three. Frame 30 is six frames inside a group of pictures, so the file
    // has to carry the key frame at 24 and five frames nobody sees.
    const file = clip('export-in.mp4', whole, { in: 30 / 24, out: 6, sound: true })
    const probe = probeFile(file)

    expect(probe.stderr).toBe('')
    expect(Number(probe.probed!.streams[0]!.nb_read_frames)).toBe(144 - 30)
    expect(Number(probe.probed!.streams[0]!.duration)).toBe(4.75)
    // The sound is cut to the same length, to the microsecond: both edit lists state the same
    // span, and the span is what a player trims to.
    expect(Number(probe.probed!.streams[1]!.duration)).toBe(4.75)
    expect(decodeWarnings(file)).toBe('')

    // Pixels, not counts: the first frame of the clip is frame 30 of the recording and neither
    // of its neighbours.
    expect(frameAt(file, 0).equals(frameAt(reference, 30))).toBe(true)
    expect(frameAt(file, 0).equals(frameAt(reference, 29))).toBe(false)
    expect(frameAt(file, 0).equals(frameAt(reference, 31))).toBe(false)
    expect(frameAt(file, 113).equals(frameAt(reference, 143))).toBe(true)
  })

  it('ends one frame past the one asked for, and that frame is the reordered tail', () => {
    // Experiment two, and the one the known limitation of this stage is measured by. Out at frame
    // 100 means frame 99 is the last one asked for. The file carries frame 100 as well: it decodes
    // before frame 99 and composes after it, frames shown earlier are predicted from it, and the
    // only box that could hide it is `segment_duration`, which does not survive `-c copy`.
    const file = clip('export-out.mp4', whole, { in: 30 / 24, out: 100 / 24, sound: true })
    const probe = probeFile(file)

    expect(probe.stderr).toBe('')
    expect(Number(probe.probed!.streams[0]!.nb_read_frames)).toBe(71)
    // Five digits and not six: ffprobe prints six decimals, so the last one is its rounding
    // and not ours.
    expect(Number(probe.probed!.streams[0]!.duration)).toBeCloseTo(71 / 24, 5)
    // The sound stops at the packet holding the out point, which is within one packet of the
    // picture and no closer — a packet is 23 ms and a frame is 42.
    const sound = Number(probe.probed!.streams[1]!.duration)
    expect(Math.abs(sound - 70 / 24)).toBeLessThan(1024 / 44100)

    expect(frameAt(file, 0).equals(frameAt(reference, 30))).toBe(true)
    expect(frameAt(file, 69).equals(frameAt(reference, 99))).toBe(true)
    // Named out loud rather than left to be discovered: the one extra frame is frame 100 of the
    // recording, and there is not a second one.
    expect(frameAt(file, 70).equals(frameAt(reference, 100))).toBe(true)
    expect(frameAt(file, 71).byteLength, 'a second frame beyond the out point').toBe(0)
    expect(decodeWarnings(file)).toBe('')
  })

  it('ends exactly on the frame asked for where nothing is reordered', () => {
    // The same request against material with no B-frames: every cts is zero, decode order is
    // presentation order, and there is no tail to carry. Tail trimming is exact
    // today, and it is here so the limitation above reads as a property of reordering and not as
    // a property of the cut.
    const vp9 = pictureOnly(
      'tests/fixtures/vp9/init-stream0.m4s',
      [1, 2].map((n) => `tests/fixtures/vp9/chunk-stream0-0000${n}.m4s`),
    )
    // Two seconds out of four, and two seconds is a whole number of ticks on any timescale — so
    // the count here is the cut and not a rounding.
    const file = writeTemp(
      'export-out-vp9.mp4',
      assembleMp4(planClip(vp9.source, { in: 0, out: 2, sound: false }), vp9.bytesOf),
    )
    const probe = probeFile(file)

    expect(probe.stderr).toBe('')
    expect(Number(probe.probed!.streams[0]!.nb_read_frames)).toBe(48)
    expect(Number(probe.probed!.streams[0]!.duration)).toBe(2)
    expect(decodeWarnings(file)).toBe('')
  })

  it('joins two runs of material with the picture and the sound still together', () => {
    // Experiment three. The middle segment of both tracks is missing, and the holes are not the
    // same length: two seconds of picture against 1.9969 of sound.
    const file = clip('export-gap.mp4', holed, { in: 0, out: 6, sound: true })
    const probe = probeFile(file)

    expect(probe.stderr).toBe('')
    expect(decodeWarnings(file)).toBe('')
    expect(Number(probe.probed!.streams[0]!.nb_read_frames)).toBe(96)

    // The two streams end within a hundredth of a frame of each other. Anything the collapse got
    // wrong shows up here, because the error is per seam and this file has one.
    const picture = Number(probe.probed!.streams[0]!.duration)
    const sound = Number(probe.probed!.streams[1]!.duration)
    expect(Math.abs(picture - sound)).toBeLessThan(1 / 24 / 100)

    // The hole is gone from the picture: the longest step between two frames is one frame plus
    // the 3 ms the sound's hole was shorter by, not the two seconds that were cut out.
    const times = frameTimes(file, 'v')
    const steps = times.slice(1).map((time, i) => time - times[i]!)
    expect(Math.max(...steps)).toBeLessThan(2 / 24)
    expect(steps.filter((step) => step > 1 / 24 + 0.001)).toHaveLength(1)

    // The sound has no step at all: it had the smaller hole, so its packets run back to back.
    const sounds = frameTimes(file, 'a')
    const soundSteps = sounds.slice(1).map((time, i) => time - sounds[i]!)
    expect(Math.max(...soundSteps)).toBeLessThan(1024 / 44100 + 0.0005)

    // And the material either side of the seam is the material it should be: frame 47 of the
    // recording, then frame 96, with nothing invented in between.
    expect(frameAt(file, 47).equals(frameAt(reference, 47))).toBe(true)
    expect(frameAt(file, 48).equals(frameAt(reference, 96))).toBe(true)
  })

  it('starts resumed sound after the picture when its first packet is late', () => {
    const picture = holed.source.video
    const sourceAudio = holed.source.audio!
    const pictureResume = picture.samples.find((sample, index, samples) => {
      const previous = samples[index - 1]
      return previous !== undefined && sample.dts > previous.dts + previous.duration
    })!
    const pictureResumeSeconds =
      (pictureResume.pts - picture.editOffset) / picture.timescale
    const soundResumeIndex = sourceAudio.samples.findIndex((sample, index, samples) => {
      const previous = samples[index - 1]
      return previous !== undefined && sample.dts > previous.dts + previous.duration
    })
    const lateAudio: SourceTrack = {
      ...sourceAudio,
      samples: sourceAudio.samples.filter((sample, index) => {
        if (index < soundResumeIndex) return true
        return (sample.pts - sourceAudio.editOffset) / sourceAudio.timescale > pictureResumeSeconds
      }),
    }
    const firstResumedSound = lateAudio.samples[soundResumeIndex]!
    const soundResumeSeconds =
      (firstResumedSound.pts - lateAudio.editOffset) / lateAudio.timescale
    const delay = soundResumeSeconds - pictureResumeSeconds
    const source = soundUnderPicture({ video: picture, audio: lateAudio })
    const file = writeTemp(
      'export-late-resumed-sound.mp4',
      assembleMp4(
        planClip(source, { in: pictureResumeSeconds, out: 5.5, sound: true }),
        holed.bytesOf,
      ),
    )
    const streams = probeFile(file).probed!.streams
    const video = streams.find((stream) => stream.codec_type === 'video')!
    const audio = streams.find((stream) => stream.codec_type === 'audio')!

    // This fixture's first retained AAC packet begins 17 ms after the resumed video frame. An
    // empty edit keeps that interval silent. Without it the planner reaches back across the gap,
    // writes a media-time skip longer than the new run, and ffmpeg exposes no audible frames.
    expect(delay).toBeCloseTo(0.017052, 6)
    expect(Number(video.start_time)).toBe(0)
    expect(Number(audio.start_time)).toBeCloseTo(delay, 5)
    expect(Number(audio.nb_read_frames)).toBeGreaterThan(0)
  })

  it('keeps sound aligned when a selected clip starts well after a repaired picture gap', () => {
    const prefetched = materialOf([1, 3], [1, 2, 3, 4])
    const picture = prefetched.source.video
    const resumed = picture.samples.find((sample, index, samples) => {
      const previous = samples[index - 1]
      return previous !== undefined && sample.dts > previous.dts + previous.duration
    })!
    const resume = (resumed.pts - picture.editOffset) / picture.timescale
    const file = writeTemp(
      'export-selected-after-gap.mp4',
      assembleMp4(
        planClip(soundUnderPicture(prefetched.source), {
          in: resume + 0.5,
          out: resume + 1.5,
          sound: true,
        }),
        prefetched.bytesOf,
      ),
    )
    const streams = probeFile(file).probed!.streams
    const video = streams.find((stream) => stream.codec_type === 'video')!
    const audio = streams.find((stream) => stream.codec_type === 'audio')!

    expect(Math.abs(Number(video.start_time) - Number(audio.start_time))).toBeLessThan(1 / 1000)
    expect(Math.abs(Number(video.duration) - Number(audio.duration))).toBeLessThan(1 / 24)
    expect(decodeWarnings(file)).toBe('')
  })

  it('writes a clip with no sound in it', () => {
    const file = clip('export-silent.mp4', whole, { in: 1, out: 3, sound: false })
    const probe = probeFile(file)
    expect(probe.stderr).toBe('')
    expect(probe.probed!.streams.map((s) => s.codec_type)).toEqual(['video'])
    expect(decodeWarnings(file)).toBe('')
  })

  it('writes nothing for a plan with no tracks', () => {
    const empty = { tracks: [], duration: 0, bytes: 0 }
    expect(assembleMp4(empty, whole.bytesOf).byteLength).toBe(0)
  })
})
