import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { assembleEncoded, type EncodedVideo } from '../../src/core/encode/assemble'
import { codedSampleEntry } from '../../src/core/encode/entry'
import { assembleMp4 } from '../../src/core/export/assemble'
import {
  planClip,
  planPreview,
  type ClipSource,
  type SourceTrack,
} from '../../src/core/export/plan'
import { audioSampleEntry, sampleEntryBytes, videoSampleEntry } from '../../src/core/iso/entry'
import { parseInit } from '../../src/core/iso/init'
import { samplesInMovie } from '../../src/core/iso/movie'
import type { OutSample } from '../../src/core/iso/progressive'
import { boxBody, childBoxes, findBox, type Box } from '../../src/core/iso/reader'
import { editOffset, sampleRunOf, trackDefaults } from '../../src/core/iso/samples'
import { decodeWarnings, frameAt, probeFile, writeTemp } from '../support/media'
import type { Located, TrackKind } from '../../src/shared/types'

/**
 * A file made of a picture nobody else described and a sound nobody touched.
 *
 * The coded frames here were not encoded by this program — there is no encoder in a unit test —
 * but they are the same kind of thing one hands back: AVC access units with their lengths in
 * front, configured by an avcC held out of band. So the fixture's own frames go in under a sample
 * entry this program wrote, and the file is then decoded. That is the point of the last case:
 * every other assertion in this file is about numbers in boxes, and numbers in boxes have been
 * right in files that played as nothing.
 */

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

const H264_VIDEO_INIT = 'tests/fixtures/h264/init-stream0.m4s'
const H264_AUDIO_INIT = 'tests/fixtures/h264/init-stream1.m4s'

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

/** A track indexed the way `sourceTrackOf` indexes one, through the single walk `sampleRunOf`. */
function trackOf(
  bank: Bank,
  initPath: string,
  segmentPaths: string[],
  kind: TrackKind,
): SourceTrack {
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

const bank = new Bank()
const source: ClipSource = {
  video: trackOf(
    bank,
    H264_VIDEO_INIT,
    [1, 2, 3].map((n) => `tests/fixtures/h264/chunk-stream0-0000${n}.m4s`),
    'video',
  ),
  audio: trackOf(
    bank,
    H264_AUDIO_INIT,
    [1, 2, 3, 4].map((n) => `tests/fixtures/h264/chunk-stream1-0000${n}.m4s`),
    'audio',
  ),
}
const material = bank.bytes()
const bytesOf = (at: Located): Uint8Array => material.subarray(at.at, at.at + at.length)

const whole = planClip(source, { in: 0, out: 6, sound: true })
const plannedVideo = whole.tracks.find((track) => track.kind === 'video')!
const plannedAudio = whole.tracks.find((track) => track.kind === 'audio')!

/** The recording's own configuration, standing in for the one an encoder hands back. */
const avcC = videoSampleEntry(read(H264_VIDEO_INIT))!.children.get('avcC')!

/** Every frame of the recording, as the bytes and times a chunk of an encoder would carry. */
const codedFrames: OutSample[] = plannedVideo.samples.map((sample) => ({
  bytes: bytesOf(sample.source),
  duration: sample.duration,
  cts: sample.cts,
  sync: sample.sync,
}))

const picture: EncodedVideo = {
  sampleEntry: codedSampleEntry('avc1', avcC, plannedVideo.width, plannedVideo.height),
  width: plannedVideo.width,
  height: plannedVideo.height,
  timescale: plannedVideo.timescale,
  samples: codedFrames,
}

const sound = { track: plannedAudio, bytesOf }

/** The recording written the other way — by the copy path — so frames can be compared to it. */
const reference = writeTemp(
  'encode-reference.mp4',
  assembleMp4(planPreview(source), bytesOf),
)

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** The duration field of an mvhd or an mdhd, both of which this writer writes in version 0. */
const headerDuration = (file: Uint8Array, path: string[]): number =>
  viewOf(boxBody(file, findBox(file, path)!)).getUint32(16)

const traksOf = (file: Uint8Array) =>
  childBoxes(file, findBox(file, ['moov'])!).filter((box) => box.type === 'trak')

/** The ticks per second one track counts in, out of its own media header. */
function mediaTimescaleOf(file: Uint8Array, trak: Box): number {
  const mdia = childBoxes(file, trak).find((child) => child.type === 'mdia')!
  const mdhd = childBoxes(file, mdia).find((child) => child.type === 'mdhd')!
  return viewOf(boxBody(file, mdhd)).getUint32(12)
}

/** A track header, version 0: the number of the track and the size it is laid out at. */
function trackHeaderOf(file: Uint8Array, trak: Box): Record<string, number> {
  const box = childBoxes(file, trak).find((child) => child.type === 'tkhd')!
  const view = viewOf(boxBody(file, box))
  return {
    trackId: view.getUint32(12),
    width: view.getUint32(76) / 0x10000,
    height: view.getUint32(80) / 0x10000,
  }
}

describe('assembleEncoded', () => {
  it('writes back every frame it was handed, with its own time and its own bytes', () => {
    // The premise, stated so that nothing below can pass by being empty or flat: this is the
    // whole recording, its frames are reordered, and not every one of them is a sync sample.
    expect(codedFrames).toHaveLength(144)
    expect(codedFrames.some((frame) => frame.cts !== 0)).toBe(true)
    expect(codedFrames.some((frame) => !frame.sync)).toBe(true)

    const file = assembleEncoded(picture, null)
    const tracks = samplesInMovie(file, file.byteLength)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.samples).toHaveLength(codedFrames.length)

    // The size a player lays the picture out at, which is stated in the track header and nowhere
    // the sample entry can be read from. Handed over the other way round it probes clean and
    // plays squeezed — measured on the copy path, and the same trap here.
    expect(trackHeaderOf(file, traksOf(file)[0]!)).toEqual({ trackId: 1, width: 320, height: 240 })

    let dts = 0
    for (const [i, back] of tracks[0]!.samples.entries()) {
      const wrote = codedFrames[i]!
      expect({
        i,
        dts: back.dts,
        cts: back.pts - back.dts,
        duration: back.duration,
        sync: back.sync,
      }).toEqual({ i, dts, cts: wrote.cts, duration: wrote.duration, sync: wrote.sync })
      expect(file.subarray(back.at, back.at + back.size)).toEqual(wrote.bytes)
      dts += wrote.duration
    }
  })

  it('puts the copied sound beside the picture, and hides the head of one of them only', () => {
    // The premise of the whole case: the sound really is hiding something. With nothing to hide
    // the writer writes no edit list at all, and an assertion about which track carries one
    // would pass for the wrong reason.
    expect(plannedAudio.skipTicks).toBeGreaterThan(0)

    const file = assembleEncoded(picture, sound)
    const tracks = samplesInMovie(file, file.byteLength)
    expect(tracks.map((track) => track.trackId)).toEqual([1, 2])
    expect(tracks[1]!.samples).toHaveLength(plannedAudio.samples.length)

    // Byte for byte, tick for tick: the packets in the file are the packets of the recording,
    // not a re-encoding of them and not a re-timing of them. Every one of them stands on its
    // own, and the file has to say so — an stss listing only some would offer a player seeks it
    // should never refuse.
    expect(plannedAudio.samples.every((sample) => sample.sync)).toBe(true)
    for (const [i, back] of tracks[1]!.samples.entries()) {
      const planned = plannedAudio.samples[i]!
      expect(file.subarray(back.at, back.at + back.size)).toEqual(bytesOf(planned.source))
      expect({ duration: back.duration, cts: back.pts - back.dts, sync: back.sync }).toEqual({
        duration: planned.duration,
        cts: planned.cts,
        sync: planned.sync,
      })
    }

    // The picture's head was not hidden, it was never encoded — so it has no edit list at all,
    // and the sound keeps the one the copy path would have written for it.
    const traks = traksOf(file)
    expect(traks).toHaveLength(2)
    expect(childBoxes(file, traks[0]!).map((box) => box.type)).not.toContain('edts')

    // Each track counts in its own ticks, and these two do not agree: a sound written at the
    // picture's timescale would run three and a half times too fast and the edit hiding its
    // head would hide the wrong amount, while every number checked above stayed right.
    expect(plannedAudio.timescale).not.toBe(plannedVideo.timescale)
    expect(mediaTimescaleOf(file, traks[0]!)).toBe(plannedVideo.timescale)
    expect(mediaTimescaleOf(file, traks[1]!)).toBe(plannedAudio.timescale)

    const edts = childBoxes(file, traks[1]!).find((box) => box.type === 'edts')
    expect(edts, 'the sound lost its edit list').toBeDefined()
    const elst = childBoxes(file, edts!).find((box) => box.type === 'elst')!
    const body = boxBody(file, elst)
    // Version 1: entry_count, then segment_duration and media_time in eight bytes each.
    expect(body[0]).toBe(1)
    expect(viewOf(body).getUint32(4)).toBe(1)
    expect(Number(viewOf(body).getBigInt64(16))).toBe(plannedAudio.skipTicks)
  })

  it('keeps the silent lead of copied sound beside an encoded picture', () => {
    const delayTicks = 2_205
    const file = writeTemp(
      'encode-delayed-sound.mp4',
      assembleEncoded(picture, {
        track: { ...plannedAudio, delayTicks },
        bytesOf,
      }),
    )
    const audio = probeFile(file).probed!.streams.find(
      (stream) => stream.codec_type === 'audio',
    )!

    expect(Number(audio.start_time)).toBeCloseTo(delayTicks / plannedAudio.timescale, 6)
    expect(Number(audio.nb_read_frames)).toBeGreaterThan(0)
  })

  it('states a composition offset that precedes decode, which is the shape an encoder returns', () => {
    // Not hypothetical, and not the copy path's problem. The chunks come back in decode order
    // carrying the source's own presentation times, and `samplesOf` takes the dropped head off
    // every one of them: on this very fixture the fourth frame decoded presents at 1536 ticks
    // against a head of 1024, which is 512, while its decode time by then is 1536. That is
    // −1024, and an unsigned table would state it as 4294966272.
    const bytes = (n: number): Uint8Array => Uint8Array.from([n, n + 1, n + 2, n + 3])
    const reordered: OutSample[] = [
      { bytes: bytes(10), duration: 512, cts: 0, sync: true },
      { bytes: bytes(20), duration: 512, cts: 1536, sync: false },
      { bytes: bytes(30), duration: 512, cts: 0, sync: false },
      { bytes: bytes(40), duration: 512, cts: -1024, sync: false },
    ]
    expect(Math.min(...reordered.map((sample) => sample.cts))).toBeLessThan(0)

    const file = assembleEncoded({ ...picture, samples: reordered }, null)
    const ctts = findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'ctts'])
    expect(ctts, 'no composition table at all').not.toBeNull()
    expect(boxBody(file, ctts!)[0], 'a ctts of version 0 cannot say it').toBe(1)

    const back = samplesInMovie(file, file.byteLength)[0]!.samples
    expect(back.map((sample) => sample.pts - sample.dts)).toEqual([0, 1536, 0, -1024])
  })

  it('states the length of the picture in its own ticks, and the presentation reordering adds', () => {
    const file = assembleEncoded(picture, null)

    // The media header counts in ticks of the track — the encoded picture's own timescale, not
    // the movie's ninety thousand and not the sound's forty-four one hundred.
    const total = codedFrames.reduce((sum, frame) => sum + frame.duration, 0)
    expect(viewOf(boxBody(file, findBox(file, ['moov', 'trak', 'mdia', 'mdhd'])!)).getUint32(12))
      .toBe(plannedVideo.timescale)
    expect(headerDuration(file, ['moov', 'trak', 'mdia', 'mdhd'])).toBe(total)
    expect(total).toBe(73728)

    // The movie header counts the presentation, which on reordered material runs past the decode
    // timeline by the reordering delay: the last frame is composed after the last one is decoded.
    // Measured on this fixture: 74752 ticks against 73728, which is two frames of 512.
    let dts = 0
    let end = 0
    for (const frame of codedFrames) {
      end = Math.max(end, dts + frame.cts + frame.duration)
      dts += frame.duration
    }
    expect(end).toBe(total + 1024)
    expect(headerDuration(file, ['moov', 'mvhd'])).toBe(
      Math.floor((end * 90000) / plannedVideo.timescale),
    )

    // And where nothing is reordered the two are the same number, which is the ordinary case:
    // ten frames of 40 ticks at a thousand a second is 400 of the track's and 36000 of the
    // movie's.
    const flat = Array.from({ length: 10 }, (): OutSample => ({
      bytes: Uint8Array.from([1, 2, 3]),
      duration: 40,
      cts: 0,
      sync: true,
    }))
    const even = assembleEncoded({ ...picture, timescale: 1000, samples: flat }, null)
    expect(headerDuration(even, ['moov', 'trak', 'mdia', 'mdhd'])).toBe(400)
    expect(headerDuration(even, ['moov', 'mvhd'])).toBe(36000)
  })

  it('writes a file a decoder opens, showing the frames it was given and no others', () => {
    const file = writeTemp('encode-assembled.mp4', assembleEncoded(picture, sound))

    // The sample entry in the file is the one this program wrote, read back by the same reader
    // that reads foreign ones: the record is there, and so is the colour box the encoder omits.
    const entry = videoSampleEntry(read(file))!
    expect(entry.format).toBe('avc1')
    expect(entry.codedWidth).toBe(320)
    expect(entry.codedHeight).toBe(240)
    expect(entry.children.get('avcC')).toEqual(avcC)
    expect(entry.children.has('colr')).toBe(true)

    const probe = probeFile(file)
    expect(probe.stderr, 'ffprobe complains about the assembled file').toBe('')
    expect(probe.probed!.streams.map((stream) => stream.codec_name)).toEqual(['h264', 'aac'])
    expect(Number(probe.probed!.streams[0]!.nb_read_frames)).toBe(144)
    // Six seconds of picture and six of sound, which is the recording: a track written at the
    // wrong timescale states a length nothing else in the file contradicts.
    expect(probe.probed!.streams.map((stream) => Number(stream.duration))).toEqual([6, 6])
    expect(decodeWarnings(file)).toBe('')

    // Pixels, and against the same material written the other way. A file that merely opens
    // proves the boxes; this proves the picture — frame for frame, and the neighbours ruled out
    // so that an off-by-one cannot pass. In yuv420p, which is what the codec decoded: rgb24
    // would be the picture with somebody's colour matrix already applied, and the two files do
    // not state the same one, which is the next assertion rather than a nuisance here.
    const coded = (of: string, index: number): Buffer => frameAt(of, index, 'yuv420p')
    expect(coded(file, 0).byteLength).toBeGreaterThan(0)
    expect(coded(file, 0).equals(coded(reference, 0))).toBe(true)
    expect(coded(file, 71).equals(coded(reference, 71))).toBe(true)
    expect(coded(file, 71).equals(coded(reference, 70))).toBe(false)
    expect(coded(file, 143).equals(coded(reference, 143))).toBe(true)
    expect(coded(file, 144).byteLength, 'a frame past the end of the recording').toBe(0)
  })

  it('says which colour it is in, where the file it was copied from says nothing', () => {
    const file = writeTemp('encode-coloured.mp4', assembleEncoded(picture, null))

    // The defect the colour box exists for, measured on these two files rather than argued.
    // Same coded frames in both; the copy path carries the recorder's own sample entry, which
    // has no colr in it, so the reader has nothing to report — it prints the word `unknown` in
    // its flat forms and omits the field outright in JSON — and falls back to a guess by frame
    // size, which is BT.601 at 320×240.
    expect(videoSampleEntry(read(reference))!.children.has('colr')).toBe(false)
    const copied = probeFile(reference).probed!.streams[0]!
    expect([copied.color_space, copied.color_primaries, copied.color_transfer]).toEqual([
      undefined,
      undefined,
      undefined,
    ])

    const written = probeFile(file).probed!.streams[0]!
    expect({
      space: written.color_space,
      primaries: written.color_primaries,
      transfer: written.color_transfer,
    }).toEqual({ space: 'bt709', primaries: 'bt709', transfer: 'bt709' })

    // And it is not a label nobody acts on: the same frame comes out of the two files with the
    // same luma and different colour, because one reader was told the matrix and the other
    // guessed it.
    expect(frameAt(file, 0, 'yuv420p').equals(frameAt(reference, 0, 'yuv420p'))).toBe(true)
    expect(frameAt(file, 0).equals(frameAt(reference, 0))).toBe(false)
  })
})
