import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildProgressiveMp4,
  needsWideOffsets,
  presentationTicks,
  MOVIE_TIMESCALE,
  type OutSample,
  type ProgressiveTrack,
} from '../../src/core/iso/progressive'
import { editOffset, samplesInSegment, trackDefaults } from '../../src/core/iso/samples'
import { sampleEntryBytes, videoSampleEntry } from '../../src/core/iso/entry'
import { parseInit } from '../../src/core/iso/init'
import { boxBody, boxesIn, childBoxes, findBox, topLevelBoxes, type Box }
  from '../../src/core/iso/reader'
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

/**
 * The same sample entry with its pasp cut out, and its size put right.
 *
 * Every fixture in this repository carries a pasp copied from the packager that made it, and a
 * pasp is where ffmpeg reads the pixel aspect from when there is one — which hides whatever the
 * tkhd states. The entries this program writes itself have none: vp9SampleEntry
 * (src/core/vp9/mp4.ts) writes no such box, so on any WebM capture the shape of the picture rests
 * on the track header alone. This makes that entry out of one that has it.
 */
function withoutPasp(entry: Uint8Array): Uint8Array {
  // A video sample entry states 86 bytes of fixed fields before the boxes that describe the codec.
  const FIELDS = 86
  const kept = boxesIn(entry, FIELDS, entry.byteLength).filter((box) => box.type !== 'pasp')
  const out = concatBytes([
    entry.subarray(0, FIELDS),
    ...kept.map((box) => entry.subarray(box.start, box.start + box.size)),
  ])
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, out.byteLength)
  return out
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

/** Every coded byte of the two tracks: what an mdat holding them has to say it is long. */
const payloadBytes = [...video.samples, ...audio.samples].reduce(
  (total, sample) => total + sample.bytes.byteLength,
  0,
)

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

  it('brands the file, and leaves a number for a track added after the last one', () => {
    const bytes = buildProgressiveMp4([video, audio])
    const ftyp = boxBody(bytes, topLevelBoxes(bytes).find((b) => b.type === 'ftyp')!)
    const brand = (at: number): string => String.fromCharCode(...ftyp.subarray(at, at + 4))

    // A compatibility hint and no more: nothing this writer was measured against refuses a file
    // over a missing brand. Pinned anyway, because it is the file's own statement of what it is,
    // and a list that quietly loses an entry is the kind of change nothing else here would show.
    expect(brand(0)).toBe('isom')
    expect(new DataView(ftyp.buffer, ftyp.byteOffset, ftyp.byteLength).getUint32(4)).toBe(0x200)
    expect([8, 12, 16, 20].map(brand)).toEqual(['isom', 'iso2', 'avc1', 'mp41'])
    expect(ftyp.byteLength).toBe(24) // major, minor and four brands, with nothing behind them

    // next_track_ID is what a tool appending a track to this clip has to give it, so it is one
    // past the last id used. Writing the count instead hands it the id the sound already holds.
    const mvhd = boxBody(bytes, findBox(bytes, ['moov', 'mvhd'])!)
    const view = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength)
    expect(view.getUint32(mvhd.byteLength - 4)).toBe(3)
  })

  it('states in every track header the number of the track, its shape and its volume', () => {
    const bytes = buildProgressiveMp4([video, audio])
    const traks = childBoxes(bytes, findBox(bytes, ['moov'])!).filter((b) => b.type === 'trak')

    /** tkhd version 0, read from the first byte of its body: the fields the duration test
     *  skips over. */
    const header = (index: number): Record<string, number> => {
      const box = childBoxes(bytes, traks[index]!).find((b) => b.type === 'tkhd')!
      const body = boxBody(bytes, box)
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
      return {
        // version and flags, creation, modification, then the number of the track.
        trackId: view.getUint32(12),
        // reserved pair, layer, alternate_group, then volume as an 8.8 number.
        volume: view.getUint16(36),
        // the matrix, then the display size as two 16.16 numbers of pixels.
        width: view.getUint32(76),
        height: view.getUint32(80),
      }
    }

    // The display size is not decoration and it is not the coded size restated: with no pasp in
    // the sample entry ffmpeg reads the shape of the picture out of this box and nothing else —
    // see the test below, which builds that file. Measured on a writer that hands the two over
    // the other way round: ffprobe answers SAR 9:16 and DAR 3:4 for material that is square
    // pixelled and 4:3, and every player built on ffmpeg shows it squeezed.
    expect(header(0)).toEqual({
      trackId: 1,
      volume: 0,
      width: 320 * 0x10000,
      height: 240 * 0x10000,
    })

    // The sound is the mirror of it: no frame size, and full volume. ffmpeg and Chromium make
    // nothing of the volume field — measured, a zero there changes neither — and the readers that
    // do honour it, QuickTime among them, would open this clip and play it silent. The track_ID
    // has to be its own as well: two tracks numbered alike make the next_track_ID above a lie and
    // hand a remuxer two tracks it cannot tell apart. Measured on a writer that numbers both 1,
    // ffprobe still counts 144 and 259 frames and Chromium still plays the file to its end, so
    // this line is the only place either mistake is visible at all.
    expect(header(1)).toEqual({ trackId: 2, volume: 0x0100, width: 0, height: 0 })
  })

  it('heads each track with the media information box its kind calls for', () => {
    // Nothing else in this suite reads this box. ffmpeg and Chromium take the kind of a track
    // from its handler, so a sound track carrying a vmhd probes clean and decodes to the last
    // packet — measured, the whole suite stays green with every track written as a picture. It
    // is a malformed sound track all the same, and the readers that would refuse it are the same
    // ones the volume field above is written for, so it is pinned the same way.
    const bytes = buildProgressiveMp4([video, audio])
    const traks = childBoxes(bytes, findBox(bytes, ['moov'])!).filter((b) => b.type === 'trak')

    const minfOf = (index: number): Box => {
      const mdia = childBoxes(bytes, traks[index]!).find((b) => b.type === 'mdia')!
      return childBoxes(bytes, mdia).find((b) => b.type === 'minf')!
    }

    // First child of the minf, ahead of the data reference and the tables.
    expect(childBoxes(bytes, minfOf(0)).map((b) => b.type)).toEqual(['vmhd', 'dinf', 'stbl'])
    expect(childBoxes(bytes, minfOf(1)).map((b) => b.type)).toEqual(['smhd', 'dinf', 'stbl'])

    const bodyOf = (index: number): number[] =>
      [...boxBody(bytes, childBoxes(bytes, minfOf(index))[0]!)]

    // Version and flags, then the fields. A vmhd states flags of one — the specification fixes
    // them there, alone among the full boxes this writer emits — and behind them graphicsmode
    // copy and an opcolor of three zeroes.
    expect(bodyOf(0)).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])
    // A smhd is the plainer of the two: no flags, a centred balance, and its reserved pair.
    expect(bodyOf(1)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('carries the shape of the picture when the sample entry does not', () => {
    // The fixture's own entry states a pasp, which is what ffprobe answers out of above; strip it
    // and the tkhd is the only thing left saying how wide the picture is shown. This is the file
    // this program writes from a WebM capture, where the entry it builds carries no pasp at all.
    const stripped: ProgressiveTrack = { ...video, sampleEntry: withoutPasp(video.sampleEntry) }
    const file = writeTemp('progressive-no-pasp.mp4', buildProgressiveMp4([stripped]))

    const probe = probeFile(file)
    expect(probe.stderr).toBe('')
    const shape = probe.probed!.streams[0]!
    expect([shape.sample_aspect_ratio, shape.display_aspect_ratio]).toEqual(['1:1', '4:3'])
    expect(Number(shape.nb_read_frames)).toBe(144)
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

  it('states an mdat size that reaches the end of the file, in either header', () => {
    // A size that stops short is the quietest mistake this writer can make: ffmpeg and Chromium
    // find the samples by the absolute offsets in the stco and never consult it, and the box list
    // still reads ftyp, moov, mdat — the reader drops a trailing run it cannot parse rather than
    // complaining about it. A reader that clamps a sample to the extent of the box it lies in
    // loses the last frame of every clip, and nothing before this line would have said so.
    for (const largeOffsets of [false, true]) {
      const bytes = buildProgressiveMp4([video, audio], { largeOffsets })
      const mdat = topLevelBoxes(bytes).find((b) => b.type === 'mdat')!

      expect(mdat.headerSize).toBe(largeOffsets ? 16 : 8)
      // Header and payload both: the size a box states counts itself in.
      expect(mdat.size).toBe(mdat.headerSize + payloadBytes)
      expect(mdat.start + mdat.size).toBe(bytes.byteLength)
    }
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

  it('writes a ctts when the shift is in the composition and not in the first sample', () => {
    // ffmpeg's negative_cts_offsets — the layout a DASH or HLS packager emits — moves the whole
    // composition down until the first sample needs no offset at all: this fixture's
    // 1024K 2560 1024 0 512 … becomes 0K 1536 0 −1024 −512 …. A clip always begins at a sync
    // sample, so on such a source the sample this writer sees first carries a zero however hard
    // the frames behind it are reordered, and an answer read off that one sample writes no ctts
    // at all. Measured on a writer that reads it off that one sample: ffprobe still counts 144
    // frames over six seconds and says nothing, and the frames come out at 0, 0.125, 0.166667 …
    // — decode order, two of them on one tick, ffmpeg reporting a dts that goes backwards. Opens,
    // probes clean, plays garbage.
    const shifted: ProgressiveTrack = {
      ...video,
      samples: video.samples.map((sample) => ({ ...sample, cts: sample.cts - 1024 })),
      // What the fixture hides with an edit list, this layout hides in the composition itself.
      skipTicks: 0,
    }
    expect([shifted.samples[0]!.cts, shifted.samples[0]!.sync]).toEqual([0, true])

    const bytes = buildProgressiveMp4([shifted])
    expect(boxesOf(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl'])).toContain('ctts')

    const body = boxBody(bytes, findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'ctts'])!)
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
    expect(view.getUint8(0)).toBe(1)
    expect(view.getUint32(4)).toBe(131) // the runs of the fixture, every one of them moved down
    expect([view.getUint32(8), view.getInt32(12)]).toEqual([1, 0])
    expect([view.getUint32(16), view.getInt32(20)]).toEqual([1, 1536])
    expect([view.getUint32(24), view.getInt32(28)]).toEqual([1, 0])
    expect([view.getUint32(32), view.getInt32(36)]).toEqual([1, -1024])

    // The same material either way, so the same times to the frame: the shift and the edit list
    // the fixture carries instead of it leave every frame in the same place.
    const file = writeTemp('progressive-shifted.mp4', bytes)
    const probe = probeFile(file)
    expect(probe.stderr).toBe('')
    expect(Number(probe.probed!.streams[0]!.nb_read_frames)).toBe(144)
    expect(frameTimes(file, 'v')).toEqual(frameTimes(sourceVideo, 'v'))
    expect(decodeWarnings(file)).toBe('')
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

  it('counts what stands in front of the material when it picks the wide forms', () => {
    // A chunk offset is counted from the start of the file, so the ftyp and the moov in front of
    // the samples spend the same 32 bits the samples do: material that clears four gigabytes on
    // its own can still have its last chunk lie past what an stco can state. The file that would
    // show this is a four-gigabyte capture, so the question is put to the writer directly.
    const limit = 0xffffffff

    // Four gigabytes exactly, the eight-byte header counted in: the last byte is still
    // addressable, and the narrow forms hold.
    expect(needsWideOffsets(0, limit - 8)).toBe(false)
    expect(needsWideOffsets(0, limit - 7)).toBe(true)
    // The same material with tables in front of it does not fit any more.
    expect(needsWideOffsets(4096, limit - 8)).toBe(true)
  })

  it('weighs the moov it just measured, and not the ftyp on its own', () => {
    // And the writer has to hand it the moov, which is the whole reason the function was pulled
    // out of it. The window this decides in is as wide as the moov and sits just under four
    // gigabytes: a payload an stco can still address on its own stops being addressable once the
    // tables in front of it are counted, and every chunk offset past the first is then written
    // modulo 2^32 — measured on a writer that leaves the moov out of the weighing, the sound's
    // chunk of this very file comes back at byte 937.
    //
    // Putting the question at all needs a four-gigabyte file, so the picture states a length and
    // carries nothing: `set` copies as many bytes as the source array holds, which is none, and
    // the output is a lazily allocated buffer written no further than the moov.
    const stub = (byteLength: number): OutSample => ({
      bytes: Object.defineProperty(new Uint8Array(0), 'byteLength', { value: byteLength }),
      duration: 512,
      cts: 0,
      sync: true,
    })

    const tail = audio.samples[0]!
    const shape = (byteLength: number): ProgressiveTrack[] => [
      { ...video, samples: [stub(byteLength)], skipTicks: 0 },
      { ...audio, samples: [tail], skipTicks: 0 },
    ]

    // The ftyp is the same box whatever the file behind it holds, so its length is measured on a
    // file small enough to hold rather than written down here as a number.
    const small = buildProgressiveMp4(shape(1024))
    const ftypBytes = topLevelBoxes(small).find((b) => b.type === 'ftyp')!.size

    // The largest payload that still clears four gigabytes with the mdat header and the ftyp in
    // front of it, and no room left for the moov: this file needs the wide forms because of the
    // tables and for no other reason.
    const payload = 0xffffffff - 8 - ftypBytes
    const bytes = buildProgressiveMp4(shape(payload - tail.bytes.byteLength))

    const moov = findBox(bytes, ['moov'])!
    const traks = childBoxes(bytes, moov).filter((b) => b.type === 'trak')
    const stblOf = (trak: Box): Box => {
      const mdia = childBoxes(bytes, trak).find((b) => b.type === 'mdia')!
      const minf = childBoxes(bytes, mdia).find((b) => b.type === 'minf')!
      return childBoxes(bytes, minf).find((b) => b.type === 'stbl')!
    }

    // One sync sample of no composition offset apiece, so neither track carries a ctts or an
    // stss and the only question left in the table is how wide its chunk offset is stated.
    expect(traks.map((trak) => childBoxes(bytes, stblOf(trak)).map((b) => b.type))).toEqual([
      ['stsd', 'stts', 'stsc', 'stsz', 'co64'],
      ['stsd', 'stts', 'stsc', 'stsz', 'co64'],
    ])

    const co64 = childBoxes(bytes, stblOf(traks[1]!)).find((b) => b.type === 'co64')!
    const body = boxBody(bytes, co64)
    const at = new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(8)
    expect(at).toBeGreaterThan(0xffffffffn) // a place four bytes cannot point at
    expect(at).toBe(BigInt(bytes.byteLength - tail.bytes.byteLength))

    const mdat = topLevelBoxes(bytes).find((b) => b.type === 'mdat')!
    expect(mdat.headerSize).toBe(16)
    expect(bytes.byteLength).toBe(ftypBytes + moov.size + mdat.headerSize + payload)
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

  it('states the length of a real cut in every box that carries one', () => {
    // The fixture rebuilt into itself is the one clip where all these numbers agree by accident:
    // both its tracks come out at exactly 540000 ticks of the movie, and its picture hides the
    // same 1024 at the head that its presentation runs past the decode timeline at the tail,
    // which makes the decode sum and the presentation span one number. A cut does none of that:
    // its two tracks end 828 ms apart, and neither span is its sum. Fifty-one frames of picture
    // from the twenty-fifth on, and the first hundred and thirty packets of sound: 2.167 s of
    // the one against 2.995 s of the other.
    const cutVideo: ProgressiveTrack = {
      ...video,
      samples: video.samples.slice(24, 75),
      skipTicks: 1024,
    }
    const cutAudio: ProgressiveTrack = { ...audio, samples: audio.samples.slice(0, 130) }
    const file = writeTemp('progressive-cut.mp4', buildProgressiveMp4([cutVideo, cutAudio]))
    const bytes = read(file)

    const viewOf = (box: Box): DataView => {
      const body = boxBody(bytes, box)
      return new DataView(body.buffer, body.byteOffset, body.byteLength)
    }
    const child = (parent: Box, type: string): Box =>
      childBoxes(bytes, parent).find((b) => b.type === type)!

    // The movie lasts as long as its longest track. The shorter one would have this file state
    // 2.167 s of itself, and everything reading the mvhd would stop the sound 828 ms early.
    const moov = findBox(bytes, ['moov'])!
    const mvhd = viewOf(child(moov, 'mvhd'))
    expect(mvhd.getUint32(12)).toBe(MOVIE_TIMESCALE)
    expect(mvhd.getUint32(16)).toBe(269583)

    const lengths = childBoxes(bytes, moov)
      .filter((b) => b.type === 'trak')
      .map((trak) => {
        const mdhd = viewOf(child(child(trak, 'mdia'), 'mdhd'))
        const elst = viewOf(child(child(trak, 'edts'), 'elst'))
        return {
          // The tkhd duration, which the box states in ticks of the movie and after the edit
          // list has had its say. Nothing else in this suite reads it: ffprobe answers out of
          // the mvhd and the mdhd, so a tkhd of zero — or of track ticks — probes as a six
          // second file all the same.
          tkhd: viewOf(child(trak, 'tkhd')).getUint32(20),
          timescale: mdhd.getUint32(12),
          mdhd: mdhd.getUint32(16),
          segment: Number(elst.getBigUint64(8)),
          mediaTime: Number(elst.getBigInt64(16)),
        }
      })

    // The picture: 27648 ticks of presentation less the 1024 hidden is 26624 of the track's
    // 12288, which is 195000 of the movie's 90000. The mdhd is the other number — 26112, the sum
    // of the durations — because it states how much material there is to decode, and the last
    // frame is composed 512 ticks past the end of the decode timeline. Writing the span there
    // instead would let media_time + segment_duration reach past the material the mdhd declares.
    expect(lengths[0]!).toEqual({
      tkhd: 195000,
      timescale: 12288,
      mdhd: 26112,
      segment: 195000,
      mediaTime: 1024,
    })

    // The sound: 132096 ticks of 44100 are 269583.67 of the movie, and the number written is the
    // one below and never the one above — a duration claiming more presentation than the file
    // holds is a claim a player acts on. In ticks of the track it would read 132096, which is
    // three seconds of sound calling itself one and a half.
    expect(lengths[1]!).toEqual({
      tkhd: 269583,
      timescale: 44100,
      mdhd: 133120,
      segment: 269583,
      mediaTime: 1024,
    })

    // And the cut is that long to a reader as well. Fifty-one frames: the last one is inside the
    // clip, which it is not when the presentation is measured to the frame decoded last. The
    // sound comes back one packet short of the hundred and thirty written, because the edit list
    // hides its priming packet — which is what the priming is there for.
    const probe = probeFile(file)
    expect(probe.stderr).toBe('')
    expect(probe.probed!.streams.map((s) => Number(s.nb_read_frames))).toEqual([51, 129])
    expect(decodeWarnings(file)).toBe('')
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

  it('measures the spans against the tracks it writes, not the tracks it was given', () => {
    // Dropping the empty track renumbers everything counted per track, and the count has to
    // follow. Counting against the list handed in lines the two up only while the empty tracks
    // come last — the case above; put one in front and the sound is handed the picture's span,
    // which for a track with no samples is nothing at all. Measured on a writer that indexes the
    // list it was given: the mdhd still states 265624 ticks of material and every table still
    // describes the 260 packets, while the mvhd, the tkhd and the edit list all state a clip of
    // no length. ffprobe exits zero and says nothing — it reports the six second file as
    // 0.000000 and, told to count frames, decodes not one of them.
    const bytes = buildProgressiveMp4([{ ...video, samples: [] }, audio])

    const moov = findBox(bytes, ['moov'])!
    const traks = childBoxes(bytes, moov).filter((b) => b.type === 'trak')
    expect(traks).toHaveLength(1)

    const viewOf = (box: Box): DataView => {
      const body = boxBody(bytes, box)
      return new DataView(body.buffer, body.byteOffset, body.byteLength)
    }
    const child = (parent: Box, type: string): Box =>
      childBoxes(bytes, parent).find((b) => b.type === type)!

    const trak = traks[0]!
    const mdhd = viewOf(child(child(trak, 'mdia'), 'mdhd'))
    const elst = viewOf(child(child(trak, 'edts'), 'elst'))

    // 265624 ticks of the track's 44100 less the 1024 the source hides is six seconds exactly,
    // which is 540000 of the movie's 90000. The mdhd is the other number, the sum of the
    // durations, because it states how much material there is to decode rather than how much of
    // it is shown.
    expect(viewOf(child(moov, 'mvhd')).getUint32(16)).toBe(540000)
    expect(viewOf(child(trak, 'tkhd')).getUint32(20)).toBe(540000)
    expect([mdhd.getUint32(12), mdhd.getUint32(16)]).toEqual([44100, 265624])
    expect([Number(elst.getBigUint64(8)), Number(elst.getBigInt64(16))]).toEqual([540000, 1024])

    // And a reader agrees the clip has a length: the last count is the one the boxes above cannot
    // make on their own, because a segment_duration of zero costs ffmpeg every packet in the file.
    const file = writeTemp('progressive-empty-first.mp4', bytes)
    const probe = probeFile(file)
    expect(probe.stderr).toBe('')
    expect(Number(probe.probed!.format.duration)).toBe(6)
    expect(Number(probe.probed!.streams[0]!.nb_read_frames)).toBe(259)
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

  it('measures to the frame that finishes last, not to the frame decoded last', () => {
    // Two samples say the whole of it: the one decoded second is shown first, so the presentation
    // ends where the first one ends and not where the last one does.
    const pair = [
      { duration: 512, cts: 1024 },
      { duration: 512, cts: 0 },
    ]
    expect(presentationTicks({ samples: pair, skipTicks: 0 })).toBe(1536)

    // And it is the ordinary case, not a corner: on this fixture 93 of the 144 places a cut can
    // end have a last decoded sample that finishes before the running maximum. Fifty-one frames
    // out of the middle — the cts of the last of them run 2048, 512, 512, 1024, 2048, 512, and
    // the B-frame decoded last is shown before the P-frame ahead of it. Its finish is 26624 and
    // the largest is 27648: a whole frame apart, and the frame at stake is the out point itself.
    const cut = { samples: video.samples.slice(24, 75), skipTicks: 1024 }
    expect(presentationTicks(cut)).toBe(27648 - 1024)
  })
})
