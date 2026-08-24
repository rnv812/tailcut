import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseInit } from '../../src/core/iso/init'
import {
  audioSampleEntry,
  sampleEntryBytes,
  sampleEntryOf,
  videoSampleEntry,
} from '../../src/core/iso/entry'
import { isoEncrypted } from '../../src/core/iso/encryption'
import { parseFragment, trafDuration } from '../../src/core/iso/fragment'
import { boxesIn, childBoxes, findBox, topLevelBoxes } from '../../src/core/iso/reader'
import {
  editOffset,
  sampleRunOf,
  samplesInSegment,
  trackDefaults,
} from '../../src/core/iso/samples'
import { muxFragmentedMp4 } from '../../src/core/mux'
import { assembleMp4 } from '../../src/core/export/assemble'
import { planClip, planPreview } from '../../src/core/export/plan'
import { ByteMap, clipSourceOf, sourceTrackOf } from '../../src/core/export/source'
import { framesOf } from '../../src/core/timeline/frames'
import { decodeWarnings, probeFile, writeTemp } from '../support/media'

/**
 * The set that holds more than one of everything a reader walks.
 *
 * Four rounds of mutation testing over `src/core/iso` and `src/core/export` kept turning up the
 * same defect wearing different clothes: a reader handed a container with several of something
 * takes the first and answers as though it were the one it was asked about. Round three found a
 * track chosen by position and committed `tests/fixtures/muxed` to close it; that set states no
 * edit list, so round four found the same confusion twice over in `editOffset`. Each fix was a
 * fixture that could catch that one question and no other.
 *
 * `tests/fixtures/multi` is the material for the whole family, and this is where it is spent.
 * Everything ffmpeg can state, ffmpeg stated; the rest `tools/make-multi-fixture.mjs` wrote around
 * the encoder's own coded frames — see the comment over the `multi` section of
 * `tools/make-fixtures.sh`. What the set holds that nothing else in the repository does:
 *
 * - two traks, each with its own timescale (30000 for the picture, 22050 for the sound), its own
 *   edit list (6000 ticks of B-frame reordering delay against 1024 of AAC priming — neither a
 *   rounding of the other, neither zero) and its own trex, and no two of the trex fields alike;
 * - a moof carrying a traf per track, and the two turning over: the picture stands first in
 *   fragments 1 and 3, the sound in fragment 2, so "the traf of the track asked about" and "the
 *   traf that happens to be first" are not the same box;
 * - several truns per traf — three for the picture, two for the sound, no two of the same length —
 *   with their bytes interleaved in the mdat, so that consecutive runs of one traf are never
 *   adjacent and a reader carrying on from the end of the previous run lands in the other track;
 * - a tfhd stating no optional field at all beside one stating every one of them, the sample
 *   description index included: the first can be measured only out of the trex of the movie, and
 *   the second makes a reader step over a field no other fixture here writes;
 * - two entries in every stsd, so that "the first entry and only the first" is put to the question
 *   rather than assumed.
 */
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

const INIT = read('multi/init-stream0.m4s')
const SEGMENTS = [1, 2, 3].map((n) => read(`multi/chunk-stream0-0000${n}.m4s`))

/** A second stream, to put the muxed buffer somewhere other than first in a file. */
const H264_SEGMENTS = [1, 2, 3].map((n) => read(`h264/chunk-stream0-0000${n}.m4s`))

const VIDEO_TRACK = 1
const AUDIO_TRACK = 2
const VIDEO_TIMESCALE = 30000
const AUDIO_TIMESCALE = 22050

/** Segments laid end to end in an address space of their own, the way Save all lays them. */
function placed() {
  const map = new ByteMap()
  const segments = SEGMENTS.map((bytes) => ({ bytes, at: map.place(bytes) }))
  return { map, segments }
}

describe('the fixture itself', () => {
  it('is the file ffmpeg wrote, boxes apart: init and segments decode frame for frame', () => {
    // Everything below reads a container written by hand, and a handmade container is worth
    // nothing as evidence unless a decoder agrees it describes the material. The segments are
    // laid end to end into the file they were cut from and put through ffprobe frame by frame.
    const whole = new Uint8Array(
      [INIT, ...SEGMENTS].reduce((total, part) => total + part.byteLength, 0),
    )
    let at = 0
    for (const part of [INIT, ...SEGMENTS]) {
      whole.set(part, at)
      at += part.byteLength
    }

    const file = writeTemp('multi-whole.mp4', whole)
    const probed = probeFile(file)

    expect(probed.status).toBe(0)
    expect(probed.stderr).toBe('')

    const [video, audio] = probed.probed!.streams
    expect(video!.codec_name).toBe('h264')
    expect(video!.nb_read_frames).toBe('60')
    expect(audio!.codec_name).toBe('aac')
    expect(audio!.nb_read_frames).toBe('131')

    // Not merely readable: read without a word of complaint. A container that addresses its
    // samples an offset out still decodes, and says so only here.
    expect(decodeWarnings(file)).toBe('')
  })
})

describe('an init that declares two tracks', () => {
  it('gives each track its own timescale and its own trex default', () => {
    expect(parseInit(INIT)).toEqual({
      tracks: [
        {
          trackId: VIDEO_TRACK,
          kind: 'video',
          timescale: VIDEO_TIMESCALE,
          codec: 'avc1',
          width: 256,
          height: 144,
          defaultSampleDuration: 3000,
        },
        {
          trackId: AUDIO_TRACK,
          kind: 'audio',
          timescale: AUDIO_TIMESCALE,
          codec: 'mp4a',
          width: 0,
          height: 0,
          defaultSampleDuration: 1024,
        },
      ],
    })
  })

  it('reads every trex of the mvex, and each of the three fields of it', () => {
    // A frame of the picture lasts 3000 ticks and a packet of the sound 1024, and the two are not
    // the same number by accident: the picture's timescale is forced to 30000 in the generator so
    // that it cannot be. Every other fixture here counts both at 1024 — an AAC frame is 1024
    // samples whatever the rate, and ffmpeg gives a 10 fps picture a timescale of 10240.
    expect([...trackDefaults(INIT)]).toEqual([
      [VIDEO_TRACK, { duration: 3000, size: 898, flags: 0x01010000 }],
      [AUDIO_TRACK, { duration: 1024, size: 98, flags: 0x02000000 }],
    ])
  })

  it('gives each track the media_time of its own edit list', () => {
    expect(editOffset(INIT, VIDEO_TRACK)).toBe(6000)
    expect(editOffset(INIT, AUDIO_TRACK)).toBe(1024)
  })

  it('has nothing to say about a track the movie does not carry', () => {
    expect(editOffset(INIT, 3)).toBe(0)
    expect(sampleEntryOf(INIT, 3)).toBeNull()
  })
})

describe('a sample description that holds two entries', () => {
  /** The entries of one track's stsd, as boxes: version, flags and the count stand in front. */
  function entriesOf(trackId: number) {
    const moov = topLevelBoxes(INIT).find((box) => box.type === 'moov')!
    const trak = childBoxes(INIT, moov)
      .filter((box) => box.type === 'trak')
      .find((box) => {
        const tkhd = childBoxes(INIT, box).find((child) => child.type === 'tkhd')!
        const view = new DataView(INIT.buffer, INIT.byteOffset, INIT.byteLength)
        const body = tkhd.start + tkhd.headerSize
        return (INIT[body] === 1 ? view.getUint32(body + 20) : view.getUint32(body + 12)) === trackId
      })!
    const mdia = childBoxes(INIT, trak).find((box) => box.type === 'mdia')!
    const minf = childBoxes(INIT, mdia).find((box) => box.type === 'minf')!
    const stbl = childBoxes(INIT, minf).find((box) => box.type === 'stbl')!
    const stsd = childBoxes(INIT, stbl).find((box) => box.type === 'stsd')!
    return boxesIn(INIT, stsd.start + stsd.headerSize + 8, stsd.start + stsd.size)
  }

  it('holds two of them, and the second says something else than the first', () => {
    // Without this the rest of the block proves nothing: two identical entries would let a reader
    // that took the last one come out right.
    const video = entriesOf(VIDEO_TRACK)
    const audio = entriesOf(AUDIO_TRACK)
    expect(video).toHaveLength(2)
    expect(audio).toHaveLength(2)

    const at = (entry: { start: number }) =>
      new DataView(INIT.buffer, INIT.byteOffset + entry.start, 40)
    expect([at(video[0]!).getUint16(32), at(video[0]!).getUint16(34)]).toEqual([256, 144])
    expect([at(video[1]!).getUint16(32), at(video[1]!).getUint16(34)]).toEqual([128, 72])
    expect([at(audio[0]!).getUint16(24), at(audio[0]!).getUint32(32) >>> 16]).toEqual([2, 22050])
    expect([at(audio[1]!).getUint16(24), at(audio[1]!).getUint32(32) >>> 16]).toEqual([6, 48000])
  })

  it('is read for its first entry and no other', () => {
    const video = videoSampleEntry(INIT)!
    expect(video.trackId).toBe(VIDEO_TRACK)
    expect([video.codedWidth, video.codedHeight]).toEqual([256, 144])
    expect([...video.children.keys()]).toEqual(['avcC', 'pasp', 'btrt'])

    const audio = audioSampleEntry(INIT)!
    expect(audio.trackId).toBe(AUDIO_TRACK)
    expect([audio.channels, audio.sampleRate]).toEqual([2, 22050])
    expect([...audio.children.keys()]).toEqual(['esds', 'btrt'])
  })

  it('hands the writer one entry and not the pair of them', () => {
    // What goes into the stsd of a saved clip, which states an entry count of one. Both entries
    // copied across would be a box whose count and contents disagree.
    const video = entriesOf(VIDEO_TRACK)
    expect(sampleEntryBytes(INIT, VIDEO_TRACK)!.byteLength).toBe(video[0]!.size)
    expect(sampleEntryBytes(INIT, AUDIO_TRACK)!.byteLength).toBe(entriesOf(AUDIO_TRACK)[0]!.size)
  })

  it('answers about the track it was asked for and not about the first one there is', () => {
    expect(sampleEntryOf(INIT, VIDEO_TRACK)!.format).toBe('avc1')
    expect(sampleEntryOf(INIT, AUDIO_TRACK)!.format).toBe('mp4a')
  })

  it('is searched to the end for the mark of encryption', () => {
    expect(isoEncrypted(INIT)).toBe(false)

    // The same init with the second entry of the picture renamed `encv` — four bytes, and every
    // length in the file still true. A reader that looked at the first entry alone would call
    // this stream clear and start recording a protected page.
    const protectedInit = new Uint8Array(INIT)
    const stsd = findBox(protectedInit, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!
    const entries = boxesIn(
      protectedInit,
      stsd.start + stsd.headerSize + 8,
      stsd.start + stsd.size,
    )
    protectedInit.set(new TextEncoder().encode('encv'), entries[1]!.start + 4)

    expect(isoEncrypted(protectedInit)).toBe(true)
  })
})

describe('a moof that carries two track fragments', () => {
  const defaults = trackDefaults(INIT)

  it('reads both trafs, in the order the moof states them', () => {
    // The order turns over between fragments. Every other muxed fixture here writes the picture
    // first in every moof, which makes "the traf of track 1" and "the first traf" one box.
    expect(SEGMENTS.map((bytes) => samplesInSegment(bytes, defaults).map((t) => t.trackId))).toEqual(
      [
        [VIDEO_TRACK, AUDIO_TRACK],
        [AUDIO_TRACK, VIDEO_TRACK],
        [VIDEO_TRACK, AUDIO_TRACK],
      ],
    )
  })

  it('measures the fragment it read by the trex belonging to that fragment', () => {
    // parseFragment answers about one traf — the first the moof states — and the point here is
    // which track it then borrows a sample duration from. Fragment 2 leads with the sound: read
    // against the picture's trex its 43 packets would measure 129000 ticks instead of 44032, and
    // a two-second chunk would land on the map as five and a half.
    expect(SEGMENTS.map((bytes) => parseFragment(bytes, parseInit(INIT)!.tracks))).toEqual([
      { trackId: VIDEO_TRACK, baseMediaDecodeTime: 0, duration: 60000 },
      { trackId: AUDIO_TRACK, baseMediaDecodeTime: 40960, duration: 44032 },
      { trackId: VIDEO_TRACK, baseMediaDecodeTime: 120000, duration: 60000 },
    ])
  })

  it('leaves a fragment that states nothing unmeasured when the movie is not to hand', () => {
    // The other half of the same claim: the number does not come out of the fragment, so a caller
    // that cannot supply the movie's default gets zero rather than an invented length.
    const moof = topLevelBoxes(SEGMENTS[0]!).find((box) => box.type === 'moof')!
    const [silent, stated] = childBoxes(SEGMENTS[0]!, moof).filter((box) => box.type === 'traf')

    expect(trafDuration(SEGMENTS[0]!, silent!)).toBe(0)
    expect(trafDuration(SEGMENTS[0]!, silent!, 3000)).toBe(60000)
    // The one behind it states its own default and ignores whatever the movie says.
    expect(trafDuration(SEGMENTS[0]!, stated!)).toBe(40960)
    expect(trafDuration(SEGMENTS[0]!, stated!, 3000)).toBe(40960)
  })
})

describe('a fragment header that states none of its optional fields', () => {
  const defaults = trackDefaults(INIT)

  it('takes the length of its samples from the trex of the movie', () => {
    const [video] = samplesInSegment(SEGMENTS[0]!, defaults)
    expect(video!.trackId).toBe(VIDEO_TRACK)
    expect(new Set(video!.samples.map((sample) => sample.duration))).toEqual(new Set([3000]))
    expect(video!.samples[19]!.dts).toBe(57000)
  })

  it('takes which of its samples may be seeked to from there as well', () => {
    // The trex says non-sync and the trun overrides it for its first sample alone. Read with the
    // flags at zero — the value of a field never read — every frame of the picture would offer a
    // player a place to seek to, and nineteen in twenty of them would smear.
    const [video] = samplesInSegment(SEGMENTS[0]!, defaults)
    expect(video!.samples.filter((sample) => sample.sync)).toHaveLength(1)
    expect(video!.samples[0]!.sync).toBe(true)
  })

  it('is not a privilege of the picture: the sound falls through the same way', () => {
    // Fragment 2 leads with the sound, and it is the sound that states nothing there. Measured
    // against the picture's trex its packets would be three times too long.
    const [audio] = samplesInSegment(SEGMENTS[1]!, defaults)
    expect(audio!.trackId).toBe(AUDIO_TRACK)
    expect(new Set(audio!.samples.map((sample) => sample.duration))).toEqual(new Set([1024]))
    expect(audio!.samples).toHaveLength(43)
  })

  it('is read past its stated fields where it states them', () => {
    // The traf behind it states the sample description index, which no other fixture here writes.
    // A reader that failed to step over those four bytes would take the duration out of the size
    // field and measure every packet of the sound at 98 ticks instead of 1024.
    const tracks = samplesInSegment(SEGMENTS[0]!, new Map())
    const audio = tracks.find((track) => track.trackId === AUDIO_TRACK)!
    expect(new Set(audio.samples.map((sample) => sample.duration))).toEqual(new Set([1024]))
    expect(audio.samples.every((sample) => sample.sync)).toBe(true)
  })
})

describe('a traf that carries several runs', () => {
  const defaults = trackDefaults(INIT)

  it('walks every one of them', () => {
    // Three runs of the picture and two of the sound, and no two of them the same length: a
    // reader that took the count of the first run for all of them would come out at 24 and 42.
    const [video, audio] = samplesInSegment(SEGMENTS[0]!, defaults)
    expect(video!.samples).toHaveLength(20)
    expect(audio!.samples).toHaveLength(40)
  })

  it('addresses each run from the moof and never from the end of the run before it', () => {
    // The runs of a traf are interleaved with the other track's in the mdat, so the run behind
    // one does not begin where it left off. Reading on from there hands the picture the sound's
    // bytes — the boxes stay consistent and the decoder gets noise.
    const [video] = samplesInSegment(SEGMENTS[0]!, defaults)
    const samples = video!.samples

    expect(samples[0]!.at).toBe(560)
    expect(samples[8]!.at).toBe(3574)
    expect(samples[15]!.at).toBe(5499)

    // What the seam looks like: the previous run ends well short of where the next one starts.
    expect(samples[7]!.at + samples[7]!.size).toBeLessThan(samples[8]!.at)
    expect(samples[14]!.at + samples[14]!.size).toBeLessThan(samples[15]!.at)
  })

  it('keeps the decode timeline running across the seam between runs', () => {
    // Times carry on where the bytes do not: the runs of a traf are one sequence of samples, and
    // the tfdt is stated once for the traf and not once per run.
    const [video] = samplesInSegment(SEGMENTS[0]!, defaults)
    expect(video!.samples.map((sample) => sample.dts)).toEqual(
      Array.from({ length: 20 }, (_unused, i) => i * 3000),
    )
  })

  it('carries the first sample flags of the run that states them and of no other', () => {
    // Only the first run of the picture states first_sample_flags — its first sample is the key
    // frame. The runs behind it must not: a run whose leading sample were marked a sync sample
    // would offer a seek into the middle of a group of pictures.
    const [video] = samplesInSegment(SEGMENTS[0]!, defaults)
    expect(video!.samples.map((sample) => sample.sync).indexOf(true)).toBe(0)
    expect(video!.samples[8]!.sync).toBe(false)
    expect(video!.samples[15]!.sync).toBe(false)
  })

  it('adds the runs of a traf up into one length', () => {
    const moof = topLevelBoxes(SEGMENTS[2]!).find((box) => box.type === 'moof')!
    const [, audio] = childBoxes(SEGMENTS[2]!, moof).filter((box) => box.type === 'traf')
    // The last fragment of the sound states a duration per sample and its runs hold 25 and 23 of
    // them: 48332 ticks in all, and 25164 if only the first run were counted.
    expect(trafDuration(SEGMENTS[2]!, audio!)).toBe(48332)
  })
})

describe('a recording read out of one muxed buffer', () => {
  it('indexes each track by the trak its sample entry belongs to', () => {
    const { segments } = placed()

    const video = sourceTrackOf({ kind: 'video', initBytes: INIT, segments })!
    expect(video.timescale).toBe(VIDEO_TIMESCALE)
    expect(video.editOffset).toBe(6000)
    expect(video.samples).toHaveLength(60)
    expect(video.dropped).toBe(0)
    expect([video.width, video.height]).toEqual([256, 144])

    const audio = sourceTrackOf({ kind: 'audio', initBytes: INIT, segments })!
    expect(audio.timescale).toBe(AUDIO_TIMESCALE)
    expect(audio.editOffset).toBe(1024)
    expect(audio.samples).toHaveLength(131)
    expect(audio.dropped).toBe(0)
  })

  it('takes the traf of the track it was asked about, not the only traf there is', () => {
    // sourceTrackOf allows a segment carrying one track to number its traf anything (loneTrack).
    // With two trafs in the moof that allowance must not fire: matched loosely, the picture would
    // be handed whichever traf came first and fragment 2 would give it the sound's packets.
    const { segments } = placed()
    const video = sourceTrackOf({ kind: 'video', initBytes: INIT, segments })!
    expect(video.samples.map((sample) => sample.dts)).toEqual(
      Array.from({ length: 60 }, (_unused, i) => i * 3000),
    )
  })

  it('builds a frame table on the presentation timeline of its own track', () => {
    const { segments } = placed()
    const frames = framesOf({
      init: INIT,
      trackId: VIDEO_TRACK,
      timescale: VIDEO_TIMESCALE,
      segments: segments.map((segment) => ({ bytes: segment.bytes, source: segment.at })),
    })

    expect(frames).toHaveLength(60)
    // (pts − 6000) / 30000: the first frame shown sits at zero, and 6000 borrowed from the sound
    // instead would put it 0.166 s out.
    expect(frames[0]!.pts).toBeCloseTo(0, 9)
    expect(frames[59]!.pts).toBeCloseTo(5.9, 9)
    expect(frames.filter((frame) => frame.sync)).toHaveLength(3)
  })

  it('pairs the two into one source and previews the whole of it', () => {
    const { segments } = placed()
    const source = clipSourceOf([
      { kind: 'video', initBytes: INIT, segments },
      { kind: 'audio', initBytes: INIT, segments },
    ])!

    expect(source.video.kind).toBe('video')
    expect(source.audio!.kind).toBe('audio')

    const preview = planPreview(source)
    expect(preview.duration).toBeCloseTo(6, 9)
    expect(preview.tracks.map((track) => track.timescale)).toEqual([
      VIDEO_TIMESCALE,
      AUDIO_TIMESCALE,
    ])
  })

  it('cuts a clip out of it that a decoder reads back at the length asked for', () => {
    const { map, segments } = placed()
    const source = clipSourceOf([
      { kind: 'video', initBytes: INIT, segments },
      { kind: 'audio', initBytes: INIT, segments },
    ])!

    // One second in to three seconds out, over material with a key frame every two seconds: the
    // clip starts a whole group early and the edit list hides the run-up.
    const plan = planClip(source, { in: 1, out: 3, sound: true })
    expect(plan.duration).toBeCloseTo(2.3, 9)

    const file = writeTemp('multi-clip.mp4', assembleMp4(plan, (at) => map.bytesOf(at)))
    const probed = probeFile(file)

    expect(probed.status).toBe(0)
    expect(probed.stderr).toBe('')
    expect(decodeWarnings(file)).toBe('')

    const [video, audio] = probed.probed!.streams
    // Twenty-two frames shown of the thirty-two written: the ten in front of the entry point are
    // references the edit list hides.
    expect(video!.nb_read_frames).toBe('22')
    expect(Number(video!.duration)).toBeCloseTo(2.3, 3)
    expect(audio!.codec_name).toBe('aac')
  })

  it('muxes back into a fragmented file a decoder reads whole', () => {
    // The muxer walks the same lists from the other side: two traks to renumber, two trex boxes to
    // carry over, two trafs a fragment to place and several runs inside each to leave alone.
    const file = writeTemp(
      'multi-mux.mp4',
      muxFragmentedMp4([{ initBytes: INIT, segments: SEGMENTS }]),
    )
    const probed = probeFile(file)

    expect(probed.status).toBe(0)
    expect(probed.stderr).toBe('')
    expect(decodeWarnings(file)).toBe('')

    const [video, audio] = probed.probed!.streams
    expect(video!.nb_read_frames).toBe('60')
    expect(audio!.nb_read_frames).toBe('131')

    // How long the file says it is, which is where two of the muxer's walks show up and nowhere
    // else. The length is the furthest any traf of any fragment reaches: the sound of the last
    // fragment runs 46 ms past the picture, so a span measured off the first traf alone states
    // 6.000 instead. And the sound of fragment 2 states no sample duration of its own — measured
    // against the picture's trex instead of its own, its 43 packets stretch to 5.85 s and the file
    // declares itself 7.7 s long. Neither shows in a frame count, and ffprobe reads both without
    // a word.
    expect(Number(video!.duration)).toBeCloseTo(6.046, 3)
    expect(Number(audio!.duration)).toBeCloseTo(6.046, 3)
  })

  it('moves every traf of a fragment back to the origin, not the leading one alone', () => {
    // A recording joined halfway: the first fragment kept starts at 1.86 s, and the whole file is
    // pulled back by that much — each track in its own ticks, all by the same stretch of real
    // time, so the offset the two had against each other survives. Fragment 2 leads with the
    // sound, so the picture is the traf standing second and is exactly the one a walk that stopped
    // at the first would leave where it was: 1.86 s late against its own sound, in a file that
    // still plays.
    const file = writeTemp(
      'multi-mux-tail.mp4',
      muxFragmentedMp4([{ initBytes: INIT, segments: SEGMENTS.slice(1) }]),
    )
    const probed = probeFile(file)

    expect(probed.status).toBe(0)
    expect(decodeWarnings(file)).toBe('')

    const [video, audio] = probed.probed!.streams
    expect(video!.nb_read_frames).toBe('40')
    expect(audio!.nb_read_frames).toBe('91')
    // 60000 ticks of 30000 less the origin, then the edit list of the trak takes off its 6000.
    expect(Number(video!.start_time)).toBeCloseTo(0.1424, 4)
    expect(Number(audio!.start_time)).toBeCloseTo(-0.0464, 4)
  })

  it('renumbers every traf of a fragment when the file already holds a track', () => {
    // The muxed buffer arriving behind another stream is the case where the numbers actually move:
    // its two traks become 2 and 3, and every traf of every fragment has to follow. A traf left
    // at its old number would hand its samples to the track that number now belongs to.
    const file = writeTemp(
      'multi-mux-behind.mp4',
      muxFragmentedMp4([
        { initBytes: read('h264/init-stream0.m4s'), segments: H264_SEGMENTS },
        { initBytes: INIT, segments: SEGMENTS },
      ]),
    )
    const probed = probeFile(file)

    expect(probed.status).toBe(0)
    expect(decodeWarnings(file)).toBe('')
    expect(probed.probed!.streams.map((stream) => stream.nb_read_frames)).toEqual([
      '144',
      '60',
      '131',
    ])
  })
})

describe('a run of segments read as one', () => {
  it('carries every decode time once and keeps the run in order', () => {
    const { segments } = placed()
    const run = sampleRunOf({
      segments: segments.map((segment) => ({ bytes: segment.bytes, source: segment.at })),
      trackId: AUDIO_TRACK,
      defaults: trackDefaults(INIT),
    })

    expect(run.samples).toHaveLength(131)
    expect(run.dropped).toBe(0)
    expect(run.samples[0]!.dts).toBe(0)
    for (let i = 1; i < run.samples.length; i++) {
      expect(run.samples[i]!.dts).toBeGreaterThan(run.samples[i - 1]!.dts)
    }
  })
})
