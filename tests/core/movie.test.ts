import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MAX_SAMPLES, samplesInMovie } from '../../src/core/iso/movie'
import {
  editOffset,
  locateSamples,
  sampleRunOf,
  trackDefaults,
  type LocatedSample,
  type PlacedSegment,
} from '../../src/core/iso/samples'
import { parseInit } from '../../src/core/iso/init'
import { sampleEntryBytes } from '../../src/core/iso/entry'
import { buildProgressiveMp4, type OutSample } from '../../src/core/iso/progressive'
import { findBox, topLevelBoxes } from '../../src/core/iso/reader'
import { boxOf, fullBoxOf, u16, u32, u64, zeroes } from '../../src/core/iso/writer'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/** The complete file: ftyp, free, mdat, moov — one moov holding the whole sample table. */
const whole = read('tests/fixtures/plain/whole.mp4')

/**
 * The same recording, fragmented. Built by tools/make-fixtures.sh from the same
 * `source-muxed.mp4` with the same `-c copy`, so the coded frames of the two are the same bytes.
 */
const fragInit = read('tests/fixtures/muxed-edits/init-stream0.m4s')
const fragChunks = [1, 2, 3].map((n) =>
  read(`tests/fixtures/muxed-edits/chunk-stream0-0000${n}.m4s`),
)

const VIDEO_TRACK = 1
const AUDIO_TRACK = 2

/**
 * The fragmented file put back together, and where each of its segments landed.
 *
 * The sample index addresses bytes inside the source they were read out of, so the fragmented
 * side needs a source to address: the init and the three media segments laid end to end, which is
 * the very file ffmpeg wrote before make-fixtures.sh cut it up.
 */
function reassembled(): { bytes: Uint8Array; segments: PlacedSegment[] } {
  const total = fragInit.byteLength + fragChunks.reduce((sum, c) => sum + c.byteLength, 0)
  const bytes = new Uint8Array(total)
  const segments: PlacedSegment[] = []

  bytes.set(fragInit, 0)
  let at = fragInit.byteLength
  for (const chunk of fragChunks) {
    bytes.set(chunk, at)
    segments.push({ bytes: chunk, source: { at, length: chunk.byteLength } })
    at += chunk.byteLength
  }

  return { bytes, segments }
}

/** The fragmented path, exactly as the editor walks it. */
function throughFragments(trackId: number): { samples: LocatedSample[]; bytes: Uint8Array } {
  const { bytes, segments } = reassembled()
  const run = sampleRunOf({ segments, trackId, defaults: trackDefaults(fragInit) })
  return { samples: run.samples, bytes }
}

/** The new path: one movie box, six tables, offsets counted from the first byte of the file. */
function throughMovie(trackId: number, file = whole): LocatedSample[] {
  const track = samplesInMovie(file, file.byteLength).find((t) => t.trackId === trackId)
  if (!track) throw new Error(`no track ${trackId}`)
  return locateSamples(track.samples, { at: 0, length: file.byteLength })
}

const codedBytes = (source: Uint8Array, sample: LocatedSample): Uint8Array =>
  source.subarray(sample.source.at, sample.source.at + sample.source.length)

describe('samplesInMovie, against the fragmented reader', () => {
  /**
   * The acceptance test.
   *
   * One recording described twice — by a moof per fragment and by the tables of a movie box — and
   * indexed through both readers. Every field of the sample has to come out the same, and if two
   * of them disagree one of the two readers is wrong; this is how we find out which.
   *
   * The one field that cannot be equal is the address: the two files lay their material out
   * differently, and 898 bytes of key frame sit at offset 48 in the complete file and at 1444 in
   * the fragmented one. So the address is checked by following it — the coded bytes at the two
   * places are compared, which is a stronger claim than an equal number would have been.
   */
  for (const [name, trackId] of [
    ['picture', VIDEO_TRACK],
    ['sound', AUDIO_TRACK],
  ] as const) {
    it(`indexes the ${name} of a complete file into the samples its fragments index into`, () => {
      const fragmented = throughFragments(trackId)
      const complete = throughMovie(trackId)

      expect(complete).toHaveLength(fragmented.samples.length)

      for (const [i, mine] of complete.entries()) {
        const theirs = fragmented.samples[i]!
        expect({
          i,
          dts: mine.dts,
          pts: mine.pts,
          duration: mine.duration,
          size: mine.source.length,
          sync: mine.sync,
        }).toEqual({
          i,
          dts: theirs.dts,
          pts: theirs.pts,
          duration: theirs.duration,
          size: theirs.source.length,
          sync: theirs.sync,
        })

        expect(codedBytes(whole, mine)).toEqual(codedBytes(fragmented.bytes, theirs))
      }
    })
  }

  it('reads the same edit list and the same track description off either file', () => {
    // editOffset and parseInit were written against an init segment and are handed a whole file
    // here. Nothing in them is fragment-shaped, and this is the check that it stays so: a
    // complete file is an init segment with the sample tables filled in.
    expect(editOffset(whole, VIDEO_TRACK)).toBe(editOffset(fragInit, VIDEO_TRACK))
    expect(editOffset(whole, AUDIO_TRACK)).toBe(editOffset(fragInit, AUDIO_TRACK))
    expect([editOffset(whole, VIDEO_TRACK), editOffset(whole, AUDIO_TRACK)]).toEqual([2048, 1024])

    expect(parseInit(whole)!.tracks.map((t) => [t.trackId, t.kind, t.timescale, t.codec])).toEqual([
      [VIDEO_TRACK, 'video', 10240, 'avc1'],
      [AUDIO_TRACK, 'audio', 22050, 'mp4a'],
    ])
    expect(sampleEntryBytes(whole, VIDEO_TRACK)).toEqual(sampleEntryBytes(fragInit, VIDEO_TRACK))

    // The sound entry is the same description of the same track but for four bytes, and they are
    // ffmpeg's arithmetic rather than ours: the average bitrate, stated once inside the esds and
    // once in the btrt beside it. A complete file averages over the sample table it is writing —
    // 16 289 bits a second — and a fragmented one, which has no such table, writes what it
    // estimated: 16 416. Named here rather than masked away, so that a difference anywhere else
    // in the entry still fails this.
    const mine = sampleEntryBytes(whole, AUDIO_TRACK)!
    const theirs = sampleEntryBytes(fragInit, AUDIO_TRACK)!
    const differ = [...mine].flatMap((byte, i) => (byte === theirs[i] ? [] : [i]))

    expect(mine.byteLength).toBe(theirs.byteLength)
    expect(differ).toEqual([72, 73, 108, 109])
    expect([...mine.subarray(72, 74), ...mine.subarray(108, 110)]).toEqual([0x3f, 0xa1, 0x3f, 0xa1])
    expect([...theirs.subarray(72, 74), ...theirs.subarray(108, 110)]).toEqual([
      0x40, 0x20, 0x40, 0x20,
    ])
  })
})

describe('samplesInMovie, on the tables of the fixture', () => {
  /**
   * What ffmpeg actually wrote, stated in numbers so that a change of shape is loud.
   *
   * These are not arbitrary: the sound is the case the reader would fail on if it took the easy
   * road. Its chunks hold one, two or three packets apiece — twenty runs of stsc over 59 chunks —
   * and a reader that assumed one sample per chunk would place 59 of the 131 packets and lose the
   * rest, while a reader that assumed a constant run would place them all at the wrong offsets.
   */
  it('places every sample of a run-length chunk map', () => {
    const video = throughMovie(VIDEO_TRACK)
    const audio = throughMovie(AUDIO_TRACK)

    expect([video.length, audio.length]).toEqual([60, 131])

    // stsc says [first_chunk 1, 2 per chunk], [first_chunk 2, 1 per chunk]: chunk one holds two
    // frames end to end, and every chunk after it holds one.
    expect(video[0]!.source).toEqual({ at: 48, length: 898 })
    expect(video[1]!.source).toEqual({ at: 48 + 898, length: 15 })
    expect(video[2]!.source.at).toBe(1059)

    // The sound starts in the middle of the same interleave and its chunks vary in length.
    expect(audio[0]!.source).toEqual({ at: 961, length: 98 })
    expect(audio[1]!.source).toEqual({ at: 1072, length: 114 })
    expect(audio[2]!.source).toEqual({ at: 1072 + 114, length: 90 })
    expect(audio[3]!.source).toEqual({ at: 1072 + 114 + 90, length: 88 })
  })

  it('reads durations and composition offsets out of their run-length tables', () => {
    const video = throughMovie(VIDEO_TRACK)
    const audio = throughMovie(AUDIO_TRACK)

    // stts of the picture is one entry: sixty frames of 1024 ticks.
    expect(video.map((s) => s.duration)).toEqual(Array(60).fill(1024))
    expect(video.map((s) => s.dts).slice(0, 4)).toEqual([0, 1024, 2048, 3072])

    // ctts of the picture reorders it — pts − dts runs 2048, 5120, 2048, 0, 1024, 5120…
    expect(video.slice(0, 6).map((s) => s.pts - s.dts)).toEqual([2048, 5120, 2048, 0, 1024, 5120])

    // stts of the sound is two entries: 130 frames of 1024 and a last one of 204.
    expect(new Set(audio.slice(0, 130).map((s) => s.duration))).toEqual(new Set([1024]))
    expect(audio[130]!.duration).toBe(204)
    expect(audio.every((s) => s.pts === s.dts)).toBe(true)
  })

  it('takes the sync samples from the stss, and calls them all sync where there is none', () => {
    // Three key frames of sixty. Marked wrong, a seek lands mid-prediction and shows a smear.
    const video = throughMovie(VIDEO_TRACK)
    expect(video.flatMap((s, i) => (s.sync ? [i] : []))).toEqual([0, 20, 40])

    // The sound writes no stss at all, and that absence means every packet is a place to start.
    const stbl = ['moov', 'trak', 'mdia', 'minf', 'stbl']
    expect(findBox(whole, stbl)).not.toBeNull()
    expect(throughMovie(AUDIO_TRACK).every((s) => s.sync)).toBe(true)
  })

  it('answers the same whether it is handed the file or the movie box alone', () => {
    // What the ranged loader has in hand is the movie box and nothing else: a few kilobytes out
    // of a file it deliberately did not download. The offsets are counted from the first byte of
    // the file either way, because that is what a chunk offset means.
    const moov = topLevelBoxes(whole).find((b) => b.type === 'moov')!
    const alone = whole.subarray(moov.start, moov.start + moov.size)

    expect(samplesInMovie(alone)).toEqual(samplesInMovie(whole))
  })
})

describe('samplesInMovie, written and read back', () => {
  /**
   * The writer of clips and this reader, closing a loop.
   *
   * `buildProgressiveMp4` states the tables and this reads them, and neither was written against
   * the other's fixtures. Doing it twice — once with 32-bit chunk offsets and once with 64 — is
   * how the wide path is exercised without producing a file of four gigabytes.
   */
  function roundTrip(largeOffsets: boolean): { out: OutSample[]; file: Uint8Array } {
    const source = throughMovie(VIDEO_TRACK)
    const out: OutSample[] = source.map((sample) => ({
      bytes: codedBytes(whole, sample),
      duration: sample.duration,
      cts: sample.pts - sample.dts,
      sync: sample.sync,
    }))

    const file = buildProgressiveMp4(
      [
        {
          trackId: 1,
          kind: 'video',
          timescale: 10240,
          sampleEntry: sampleEntryBytes(whole, VIDEO_TRACK)!,
          width: 256,
          height: 144,
          samples: out,
          skipTicks: 0,
        },
      ],
      { largeOffsets },
    )

    return { out, file }
  }

  for (const large of [false, true]) {
    it(`recovers every sample from a file it wrote with ${large ? 'co64' : 'stco'}`, () => {
      const { out, file } = roundTrip(large)
      const back = samplesInMovie(file, file.byteLength)

      expect(back).toHaveLength(1)
      expect(back[0]!.samples).toHaveLength(out.length)

      let dts = 0
      for (const [i, sample] of back[0]!.samples.entries()) {
        const wrote = out[i]!
        expect({
          i,
          dts: sample.dts,
          cts: sample.pts - sample.dts,
          duration: sample.duration,
          size: sample.size,
          sync: sample.sync,
        }).toEqual({
          i,
          dts,
          cts: wrote.cts,
          duration: wrote.duration,
          size: wrote.bytes.byteLength,
          sync: wrote.sync,
        })
        expect(file.subarray(sample.at, sample.at + sample.size)).toEqual(wrote.bytes)
        dts += wrote.duration
      }
    })
  }

  it('reads a co64 as the wide numbers it is', () => {
    const { file } = roundTrip(true)
    expect(findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'co64'])).not.toBeNull()
    expect(findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco'])).toBeNull()
  })
})

/**
 * Movie boxes written here rather than by ffmpeg.
 *
 * Every fixture in this repository is ffmpeg's work, and ffmpeg writes one shape of sample table:
 * sizes listed one by one, offsets 32 bits wide, a moov that means what it says. The shapes the
 * format allows and this encoder never produces — a constant sample size, a compact size table,
 * a count that promises more than the box holds — arrive from other muxers and from pages nobody
 * vouches for. They are built here or they are never read at all.
 */
function movieWith(...stbl: Uint8Array[]): Uint8Array {
  const tkhd = fullBoxOf('tkhd', 0, 3, u32(0, 0, 7, 0, 0), zeroes(60))
  const hdlr = fullBoxOf('hdlr', 0, 0, u32(0), u32(0x76696465), zeroes(12), new Uint8Array([0]))
  const mdhd = fullBoxOf('mdhd', 0, 0, u32(0, 0, 1000, 0), u16(0x55c4, 0))

  return boxOf(
    'moov',
    boxOf(
      'trak',
      tkhd,
      boxOf('mdia', mdhd, hdlr, boxOf('minf', boxOf('stbl', ...stbl))),
    ),
  )
}

/** stsd with one entry of a made-up format: nothing here reads it, and it must be walked over. */
const anyStsd = fullBoxOf('stsd', 0, 0, u32(1), boxOf('tSt1', zeroes(78)))

describe('samplesInMovie, on tables no encoder here writes', () => {
  it('reads an stsz that states one size for every sample', () => {
    // sample_size other than zero means the table behind it is absent and every sample is that
    // long. Read as a listed table it would take the count for the first size.
    const movie = movieWith(
      anyStsd,
      fullBoxOf('stts', 0, 0, u32(1), u32(4, 100)),
      fullBoxOf('stsc', 0, 0, u32(1), u32(1, 2, 1)),
      fullBoxOf('stsz', 0, 0, u32(512, 4)),
      fullBoxOf('stco', 0, 0, u32(2), u32(1000, 5000)),
    )

    expect(samplesInMovie(movie)[0]!.samples).toEqual([
      { dts: 0, pts: 0, duration: 100, at: 1000, size: 512, sync: true },
      { dts: 100, pts: 100, duration: 100, at: 1512, size: 512, sync: true },
      { dts: 200, pts: 200, duration: 100, at: 5000, size: 512, sync: true },
      { dts: 300, pts: 300, duration: 100, at: 5512, size: 512, sync: true },
    ])
  })

  it('reads a compact size table in each of its field widths', () => {
    // stz2: three reserved bytes, then the width of a field in bits, then the count. 4-bit
    // entries are packed two to a byte, the first in the high half.
    const table = (fieldSize: number, entries: Uint8Array) =>
      movieWith(
        anyStsd,
        fullBoxOf('stts', 0, 0, u32(1), u32(4, 10)),
        fullBoxOf('stsc', 0, 0, u32(1), u32(1, 4, 1)),
        fullBoxOf('stz2', 0, 0, new Uint8Array([0, 0, 0, fieldSize]), u32(4), entries),
        fullBoxOf('stco', 0, 0, u32(1), u32(100)),
      )

    const sizesOf = (movie: Uint8Array) => samplesInMovie(movie)[0]!.samples.map((s) => s.size)

    expect(sizesOf(table(4, new Uint8Array([0x12, 0x34])))).toEqual([1, 2, 3, 4])
    expect(sizesOf(table(8, new Uint8Array([1, 2, 3, 250])))).toEqual([1, 2, 3, 250])
    expect(sizesOf(table(16, u16(1, 2, 3, 65000)))).toEqual([1, 2, 3, 65000])
  })

  it('reads a version 1 ctts, where a frame may be shown before it is decoded', () => {
    const movie = movieWith(
      anyStsd,
      fullBoxOf('stts', 0, 0, u32(1), u32(3, 10)),
      fullBoxOf('ctts', 1, 0, u32(2), u32(1), new Uint8Array([0xff, 0xff, 0xff, 0xf6]), u32(2, 5)),
      fullBoxOf('stsc', 0, 0, u32(1), u32(1, 3, 1)),
      fullBoxOf('stsz', 0, 0, u32(0, 3), u32(1, 1, 1)),
      fullBoxOf('stco', 0, 0, u32(1), u32(100)),
    )

    expect(samplesInMovie(movie)[0]!.samples.map((s) => s.pts - s.dts)).toEqual([-10, 5, 5])
  })

  it('reads the offsets of a co64 as sixty-four bits and not as two halves', () => {
    const movie = movieWith(
      anyStsd,
      fullBoxOf('stts', 0, 0, u32(1), u32(2, 10)),
      fullBoxOf('stsc', 0, 0, u32(1), u32(1, 1, 1)),
      fullBoxOf('stsz', 0, 0, u32(0, 2), u32(4, 4)),
      fullBoxOf('co64', 0, 0, u32(2), u64(0x1_0000_0000), u64(0x1_0000_1000)),
    )

    expect(samplesInMovie(movie)[0]!.samples.map((s) => s.at)).toEqual([
      0x1_0000_0000, 0x1_0000_1000,
    ])
  })

  it('walks a chunk map whose first run does not start at chunk one', () => {
    // A first_chunk of 2 leaves chunk one described by nothing. The specification forbids it; a
    // reader that answers by reading entry −1 of the array does not get to say so.
    const movie = movieWith(
      anyStsd,
      fullBoxOf('stts', 0, 0, u32(1), u32(2, 10)),
      fullBoxOf('stsc', 0, 0, u32(1), u32(2, 1, 1)),
      fullBoxOf('stsz', 0, 0, u32(0, 2), u32(4, 4)),
      fullBoxOf('stco', 0, 0, u32(2), u32(100, 200)),
    )

    expect(samplesInMovie(movie)[0]!.samples.map((s) => s.at)).toEqual([200])
  })
})

describe('samplesInMovie, on a movie that lies', () => {
  const lying = (...stbl: Uint8Array[]) => samplesInMovie(movieWith(anyStsd, ...stbl))[0]!.samples

  it('stops a table at the end of its own box, whatever the entry count promises', () => {
    // entry_count is four bytes of a foreign file. Four billion entries of a box that holds two
    // is a walk off the end of the buffer, or a hang, depending on where the reader breaks.
    expect(
      lying(
        fullBoxOf('stts', 0, 0, u32(0xffffffff), u32(2, 10)),
        fullBoxOf('stsc', 0, 0, u32(0xffffffff), u32(1, 2, 1)),
        fullBoxOf('stsz', 0, 0, u32(0, 0xffffffff), u32(4, 4)),
        fullBoxOf('stco', 0, 0, u32(0xffffffff), u32(100)),
      ),
    ).toEqual([
      { dts: 0, pts: 0, duration: 10, at: 100, size: 4, sync: true },
      { dts: 10, pts: 10, duration: 10, at: 104, size: 4, sync: true },
    ])
  })

  it('drops the samples a constant-size table places past the end of the source', () => {
    // With one size stated for all of them there is no table to bound the count, so the length of
    // the file is the bound: a sample whose bytes lie past the last byte of the source is not a
    // sample. Measured against samplesInSegment next door, which bounds a run by the length of
    // its segment for the same reason.
    const movie = movieWith(
      anyStsd,
      fullBoxOf('stts', 0, 0, u32(1), u32(4, 10)),
      fullBoxOf('stsc', 0, 0, u32(1), u32(1, 4, 1)),
      fullBoxOf('stsz', 0, 0, u32(100, 4)),
      fullBoxOf('stco', 0, 0, u32(1), u32(0)),
    )

    expect(samplesInMovie(movie, 250).map((t) => t.samples.length)).toEqual([2])
    expect(samplesInMovie(movie, 400).map((t) => t.samples.length)).toEqual([4])
  })

  it('holds a constant-size table to a ceiling when nothing else bounds it', () => {
    // sample_size other than zero means there is no table behind the count, so four bytes of a
    // foreign file are the only thing saying how many samples there are. Where the length of the
    // file is unknown — which is exactly the case the ranged loader is in, holding the movie box
    // and nothing else — the ceiling is what stands between a page and an allocation of
    // gigabytes. Enough of them are placed to prove the count was not simply believed.
    const movie = movieWith(
      anyStsd,
      fullBoxOf('stts', 0, 0, u32(1), u32(0xffffffff, 10)),
      fullBoxOf('stsc', 0, 0, u32(1), u32(1, 0xffffffff, 1)),
      fullBoxOf('stsz', 0, 0, u32(4, 0xffffffff)),
      fullBoxOf('stco', 0, 0, u32(1), u32(0)),
    )

    expect(samplesInMovie(movie)[0]!.samples).toHaveLength(MAX_SAMPLES)
    // With the length of the file in hand it is bounded far tighter, by what the bytes can hold.
    expect(samplesInMovie(movie, 41)[0]!.samples).toHaveLength(10)
  })

  it('gives a track with no samples where the tables are empty, and no track at all for junk', () => {
    // A fragmented file has a movie box too, and its tables are empty on purpose: the samples are
    // in the fragments. Read here it must come back as tracks holding nothing, which is the
    // honest answer and the signal to go and read the fragments.
    expect(samplesInMovie(fragInit)).toEqual([
      { trackId: VIDEO_TRACK, samples: [] },
      { trackId: AUDIO_TRACK, samples: [] },
    ])

    expect(samplesInMovie(fragChunks[0]!)).toEqual([])
    expect(samplesInMovie(new Uint8Array(0))).toEqual([])
    expect(samplesInMovie(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([])
  })

  it('drops the track with no sample table and keeps the one beside it', () => {
    // A trak whose mdia never arrived costs itself and no more. Its neighbour is a whole track
    // and a file half of which is readable is worth the half that is.
    const headless = boxOf('trak', fullBoxOf('tkhd', 0, 3, u32(0, 0, 9, 0, 0), zeroes(60)))
    const complete = movieWith(
      anyStsd,
      fullBoxOf('stts', 0, 0, u32(1), u32(1, 10)),
      fullBoxOf('stsc', 0, 0, u32(1), u32(1, 1, 1)),
      fullBoxOf('stsz', 0, 0, u32(0, 1), u32(4)),
      fullBoxOf('stco', 0, 0, u32(1), u32(100)),
    )
    const moov = topLevelBoxes(complete)[0]!
    const trak = complete.subarray(moov.start + moov.headerSize, moov.start + moov.size)

    expect(samplesInMovie(boxOf('moov', headless, trak))).toEqual([
      { trackId: 7, samples: [{ dts: 0, pts: 0, duration: 10, at: 100, size: 4, sync: true }] },
    ])
  })
})
