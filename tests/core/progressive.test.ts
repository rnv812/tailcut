import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildProgressiveMp4,
  presentationTicks,
  type OutSample,
  type ProgressiveTrack,
} from '../../src/core/iso/progressive'
import { editOffset, samplesInSegment, trackDefaults } from '../../src/core/iso/samples'
import { sampleEntryBytes, videoSampleEntry } from '../../src/core/iso/entry'
import { parseInit } from '../../src/core/iso/init'
import { boxBody, childBoxes, findBox, topLevelBoxes } from '../../src/core/iso/reader'
import { concatBytes } from '../../src/core/iso/writer'
import { decodeWarnings, frameBySeeking, frameByPlaying, frameTimes, probeFile, writeTemp }
  from '../support/media'
import type { TrackKind } from '../../src/shared/types'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/** One track of a fixture, taken apart into the samples the writer takes in. */
function trackOf(
  initPath: string,
  segmentPaths: string[],
  kind: TrackKind,
  trackId: number,
): ProgressiveTrack {
  const init = read(initPath)
  const defaults = trackDefaults(init)
  const declared = parseInit(init)!.tracks.find((t) => t.kind === kind)!
  const entry = kind === 'video' ? videoSampleEntry(init) : null
  const samples: OutSample[] = []

  for (const path of segmentPaths) {
    const segment = read(path)
    for (const track of samplesInSegment(segment, defaults)) {
      for (const sample of track.samples) {
        samples.push({
          bytes: segment.subarray(sample.at, sample.at + sample.size),
          duration: sample.duration,
          cts: sample.pts - sample.dts,
          sync: sample.sync,
        })
      }
    }
  }

  return {
    trackId,
    kind,
    timescale: declared.timescale,
    sampleEntry: sampleEntryBytes(init, declared.trackId)!,
    width: entry?.codedWidth ?? 0,
    height: entry?.codedHeight ?? 0,
    samples,
    // Rebuilding the fixture into itself: the head it hid stays hidden.
    skipTicks: editOffset(init, declared.trackId),
  }
}

const videoSegments = [1, 2, 3].map((n) => `tests/fixtures/h264/chunk-stream0-0000${n}.m4s`)
const audioSegments = [1, 2, 3, 4].map((n) => `tests/fixtures/h264/chunk-stream1-0000${n}.m4s`)

const video = trackOf('tests/fixtures/h264/init-stream0.m4s', videoSegments, 'video', 1)
const audio = trackOf('tests/fixtures/h264/init-stream1.m4s', audioSegments, 'audio', 2)

/** The fixture as the capture would save it today: init and fragments end to end. */
const sourceVideo = writeTemp(
  'progressive-source-video.mp4',
  concatBytes([read('tests/fixtures/h264/init-stream0.m4s'), ...videoSegments.map(read)]),
)

const rebuilt = writeTemp('progressive-h264.mp4', buildProgressiveMp4([video, audio]))

const boxesOf = (file: Uint8Array, path: string[]): string[] => {
  const box = findBox(file, path)!
  return childBoxes(file, box).map((b) => b.type)
}

describe('buildProgressiveMp4', () => {
  it('writes a file of three boxes and no mvex', () => {
    const bytes = buildProgressiveMp4([video, audio])
    expect(topLevelBoxes(bytes).map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat'])

    const moov = findBox(bytes, ['moov'])!
    const kinds = childBoxes(bytes, moov).map((b) => b.type)
    expect(kinds.filter((t) => t === 'trak')).toHaveLength(2)
    // A progressive movie states its samples in the moov; an mvex would tell a player to expect
    // fragments and to disbelieve the tables it just read.
    expect(kinds).not.toContain('mvex')
  })

  it('gives back the frames of the fixture, at the times the fixture gives them', () => {
    const probe = probeFile(rebuilt)
    expect(probe.status, probe.stderr).toBe(0)
    expect(probe.stderr, 'ffprobe complains about reading the rebuilt file').toBe('')

    const streams = probe.probed!.streams
    expect(streams.map((s) => s.codec_name)).toEqual(['h264', 'aac'])
    expect(streams.map((s) => Number(s.nb_read_frames))).toEqual([144, 259])
    expect(streams.map((s) => Number(s.duration))).toEqual([6, 6])
    expect(streams.map((s) => Number(s.start_time))).toEqual([0, 0])
    expect(Number(probe.probed!.format.duration)).toBe(6)

    // Not the count but the times, one by one: a table that shifted the middle of the clip and
    // kept the length would pass every check above.
    expect(frameTimes(rebuilt, 'v')).toEqual(frameTimes(sourceVideo, 'v'))
  })

  it('decodes from end to end without a word from ffmpeg', () => {
    expect(decodeWarnings(rebuilt)).toBe('')
  })

  it('lands on the frame that belongs there when seeked into', () => {
    // Inside a group of pictures on purpose: a seek to a key frame comes out right whatever the
    // stss says. Marked all and a seek starts mid-prediction; marked none and it finds nothing.
    for (const at of [0.5, 1.3, 2.7, 4.1, 5.5]) {
      const seeked = frameBySeeking(rebuilt, at)
      const played = frameByPlaying(rebuilt, at)
      expect(seeked.byteLength, `nothing decodes at ${at}s`).toBeGreaterThan(0)
      expect(seeked.equals(played), `the frame at ${at}s differs seeked and played`).toBe(true)
    }
  })

  it('describes the samples in the tables a progressive file is read by', () => {
    const bytes = buildProgressiveMp4([video, audio])
    const moov = findBox(bytes, ['moov'])!
    const traks = childBoxes(bytes, moov).filter((b) => b.type === 'trak')

    const stblOf = (index: number): { types: string[]; box: ReturnType<typeof findBox> } => {
      const mdia = childBoxes(bytes, traks[index]!).find((b) => b.type === 'mdia')!
      const minf = childBoxes(bytes, mdia).find((b) => b.type === 'minf')!
      const stbl = childBoxes(bytes, minf).find((b) => b.type === 'stbl')!
      return { types: childBoxes(bytes, stbl).map((b) => b.type), box: stbl }
    }

    // The picture reorders its frames and does not start everywhere, so it needs both a ctts and
    // an stss; the sound needs neither, and writing an stss for it would be a lie of omission —
    // a list of the samples a player may start from that leaves most of them out.
    expect(stblOf(0).types).toEqual(['stsd', 'stts', 'ctts', 'stss', 'stsc', 'stsz', 'stco'])
    expect(stblOf(1).types).toEqual(['stsd', 'stts', 'stsc', 'stsz', 'stco'])

    const tableOf = (index: number, type: string): DataView => {
      const stbl = stblOf(index).box!
      const box = childBoxes(bytes, stbl).find((b) => b.type === type)!
      const body = boxBody(bytes, box)
      return new DataView(body.buffer, body.byteOffset, body.byteLength)
    }

    // stts as run lengths: 144 frames of 512 ticks is one entry, and the sound is two because
    // its last packet is short.
    const videoStts = tableOf(0, 'stts')
    expect(videoStts.getUint32(4)).toBe(1)
    expect([videoStts.getUint32(8), videoStts.getUint32(12)]).toEqual([144, 512])

    const audioStts = tableOf(1, 'stts')
    expect(audioStts.getUint32(4)).toBe(2)
    expect([audioStts.getUint32(8), audioStts.getUint32(12)]).toEqual([259, 1024])
    expect([audioStts.getUint32(16), audioStts.getUint32(20)]).toEqual([1, 408])

    // ctts version 1, so that a negative offset stays negative.
    const ctts = tableOf(0, 'ctts')
    expect(ctts.getUint8(0)).toBe(1)
    expect(ctts.getUint32(4)).toBe(131)
    expect([ctts.getUint32(8), ctts.getInt32(12)]).toEqual([1, 1024])
    expect([ctts.getUint32(16), ctts.getInt32(20)]).toEqual([1, 2560])

    // stss holds sample numbers, counted from one.
    const stss = tableOf(0, 'stss')
    expect(stss.getUint32(4)).toBe(6)
    expect([0, 1, 2, 3, 4, 5].map((i) => stss.getUint32(8 + i * 4))).toEqual([1, 25, 49, 73, 97, 121])

    // One chunk a track: every sample of the track lies in it, in order.
    const stsc = tableOf(0, 'stsc')
    expect(stsc.getUint32(4)).toBe(1)
    expect([stsc.getUint32(8), stsc.getUint32(12), stsc.getUint32(16)]).toEqual([1, 144, 1])

    const stsz = tableOf(0, 'stsz')
    expect(stsz.getUint32(4)).toBe(0) // sizes stated one by one, not one size for all
    expect(stsz.getUint32(8)).toBe(144)
    expect(stsz.getUint32(12)).toBe(video.samples[0]!.bytes.byteLength)
  })

  it('points the chunk offset at the bytes of the first sample', () => {
    const bytes = buildProgressiveMp4([video, audio])
    const stco = findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco'])!
    const body = boxBody(bytes, stco)
    // version and flags, then the entry count, then the one offset this writer states.
    const at = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(8)

    const first = video.samples[0]!.bytes
    expect([...bytes.subarray(at, at + first.byteLength)]).toEqual([...first])

    // And the mdat begins where the moov ends: a clip is written head first, so that a player
    // reading it over a network has the tables before the material.
    const mdat = topLevelBoxes(bytes).find((b) => b.type === 'mdat')!
    expect(at).toBe(mdat.start + mdat.headerSize)
  })

  it('states a negative composition offset as a negative number', () => {
    // Nothing in the fixtures composes a frame before it decodes, and material cut at an
    // arbitrary point will: the first sample of a clip can carry a pts below its dts. Version 0
    // of the box holds the field unsigned and would turn −512 into four billion, which no
    // decoder recovers from — so the version is checked here rather than waiting for the day.
    const reordered: ProgressiveTrack = {
      ...video,
      samples: [
        { ...video.samples[0]!, cts: -512 },
        { ...video.samples[1]!, cts: 0 },
      ],
    }
    const bytes = buildProgressiveMp4([reordered])
    const ctts = findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'ctts'])!
    const body = boxBody(bytes, ctts)
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)

    expect(view.getUint8(0)).toBe(1)
    expect(view.getUint32(4)).toBe(2)
    expect([view.getUint32(8), view.getInt32(12)]).toEqual([1, -512])
    expect([view.getUint32(16), view.getInt32(20)]).toEqual([1, 0])
  })

  it('writes the wide forms when asked, and they read the same', () => {
    const wide = writeTemp('progressive-h264-64.mp4', buildProgressiveMp4([video, audio], {
      largeOffsets: true,
    }))
    const bytes = read(wide)

    expect(boxesOf(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl'])).toContain('co64')
    expect(boxesOf(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl'])).not.toContain('stco')

    // A file that needs 64-bit offsets needs a 64-bit mdat header too, and both have to be right
    // at once or the offsets point four billion bytes into nothing.
    const mdat = topLevelBoxes(bytes).find((b) => b.type === 'mdat')!
    expect(mdat.headerSize).toBe(16)

    const probe = probeFile(wide)
    expect(probe.stderr).toBe('')
    expect(probe.probed!.streams.map((s) => Number(s.nb_read_frames))).toEqual([144, 259])
    expect(decodeWarnings(wide)).toBe('')
  })

  it('hides the head, and states exactly what is left behind it', () => {
    // The same material entered three frames later than the source itself entered it. The tail is
    // not touched here at all — an edit list that shortens the presentation is a trap: ffmpeg and
    // Chromium honour it, VLC plays on to the end of the material, and `-c copy` drops it. A clip
    // loses its tail by not carrying the samples, and this box only ever hides the head.
    const skipped = writeTemp(
      'progressive-skip.mp4',
      buildProgressiveMp4([{ ...video, skipTicks: 1024 + 3 * 512 }]),
    )
    const later = probeFile(skipped)
    expect(later.stderr).toBe('')
    expect(Number(later.probed!.streams[0]!.nb_read_frames)).toBe(141)
    expect(Number(later.probed!.streams[0]!.duration)).toBe(5.875)

    const bytes = read(skipped)
    const elst = findBox(bytes, ['moov', 'trak', 'edts', 'elst'])!
    const body = boxBody(bytes, elst)
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
    expect(view.getUint8(0)).toBe(1) // version 1: a 64-bit duration and a signed media_time
    expect(view.getUint32(4)).toBe(1) // one entry, always
    // What is left: 74752 ticks of presentation less the 2560 hidden, which is 72192 of 12288 —
    // 5.875 s — and 528750 of the movie's 90000. Stated in movie ticks and rounded down, never
    // up: a duration that claims more presentation than the file holds is a lie a player acts on.
    expect(Number(view.getBigUint64(8))).toBe(528750)
    expect(Number(view.getBigInt64(16))).toBe(1024 + 3 * 512)
    expect(view.getUint16(24)).toBe(1) // media_rate_integer: played at speed

    // Nothing hidden, no edit list at all: the box exists to state an offset, and there is none.
    const whole = buildProgressiveMp4([{ ...video, skipTicks: 0 }])
    expect(findBox(whole, ['moov', 'trak', 'edts'])).toBeNull()
  })

  it('writes a single track of vp9 and of av1', () => {
    const nine = trackOf(
      'tests/fixtures/vp9/init-stream0.m4s',
      [1, 2].map((n) => `tests/fixtures/vp9/chunk-stream0-0000${n}.m4s`),
      'video',
      1,
    )
    const nineFile = writeTemp('progressive-vp9.mp4', buildProgressiveMp4([nine]))
    const nineProbe = probeFile(nineFile)
    expect(nineProbe.stderr).toBe('')
    expect(Number(nineProbe.probed!.streams[0]!.nb_read_frames)).toBe(96)
    expect(Number(nineProbe.probed!.streams[0]!.duration)).toBe(4)
    // No B-frames in this material, so no ctts at all.
    expect(boxesOf(read(nineFile), ['moov', 'trak', 'mdia', 'minf', 'stbl'])).not.toContain('ctts')

    const one = trackOf(
      'tests/fixtures/av1/init-stream0.m4s',
      [1, 2, 3].map((n) => `tests/fixtures/av1/chunk-stream0-0000${n}.m4s`),
      'video',
      1,
    )
    const oneFile = writeTemp('progressive-av1.mp4', buildProgressiveMp4([one]))
    const oneProbe = probeFile(oneFile)
    expect(oneProbe.stderr).toBe('')
    expect(oneProbe.probed!.streams[0]!.codec_name).toBe('av1')
    expect(Number(oneProbe.probed!.streams[0]!.nb_read_frames)).toBe(60)
    expect(decodeWarnings(oneFile)).toBe('')
  })

  it('leaves out a track with no samples and writes nothing for no tracks at all', () => {
    const only = buildProgressiveMp4([video, { ...audio, samples: [] }])
    const moov = findBox(only, ['moov'])!
    expect(childBoxes(only, moov).filter((b) => b.type === 'trak')).toHaveLength(1)

    expect(buildProgressiveMp4([]).byteLength).toBe(0)
    expect(buildProgressiveMp4([{ ...video, samples: [] }]).byteLength).toBe(0)
  })

  it('measures what the edit list leaves of a track', () => {
    // The whole material, nothing hidden: the sum of the durations plus the composition delay of
    // the last frame — the presentation runs past the decode timeline by exactly that.
    expect(presentationTicks({ ...video, skipTicks: 0 })).toBe(74240 + 512)
    expect(presentationTicks(video)).toBe(74240 + 512 - 1024)
    expect(presentationTicks({ ...video, skipTicks: 1024 + 3 * 512 })).toBe(72192)
    // A skip past the end of the material leaves nothing, not a negative length.
    expect(presentationTicks({ ...video, skipTicks: 10 ** 9 })).toBe(0)
  })
})
