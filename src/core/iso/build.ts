import { ascii, boxOf, concatBytes, fullBoxOf, u16, u32, u64, u8, zeroes } from './writer'

/**
 * Writing a fragmented mp4 for a track that did not arrive in one.
 *
 * The reader next door takes an init segment apart; this puts one together. It is needed because
 * a page may deliver a track in WebM while the file being saved is an mp4: the coded frames cross
 * over untouched, but the description around them — what the track is, how its time is counted,
 * where each sample begins — has to be written from scratch in the other container's idiom.
 *
 * What comes out is what a media source is handed and what the muxer expects: an ftyp and a moov
 * with an mvex, so the movie carries no sample tables of its own and every fragment states its
 * own; then a moof and an mdat per media segment.
 *
 * The layout is the one every packager writes, and deliberately so. Sample data is addressed from
 * the start of its own moof (default-base-is-moof), which is the only addressing that survives a
 * fragment being moved somewhere else in a file — and moving fragments is exactly what the muxer
 * does with them afterwards.
 */

/** Ticks per second of the movie timeline. Milliseconds, as every mp4 in the wild counts. */
const MOVIE_TIMESCALE = 1000

/** The unity matrix: the picture is shown as it was coded, with no rotation and no scaling. */
const UNITY_MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000)

/** Full volume, as an 8.8 fixed-point number. */
const FULL_VOLUME = 0x0100

/** track_enabled | track_in_movie: the track plays, and it is part of the presentation. */
const TRACK_FLAGS = 0x000003

/** 'und' as an mdhd packs a language: three five-bit letters, each offset from 0x60. */
const UNDETERMINED_LANGUAGE = 0x55c4

/** self-contained: the media lives in this very file, so the dref entry names nothing. */
const DREF_SELF_CONTAINED = 0x000001

/**
 * Sample flags for a frame that every other frame is independent of: sample_depends_on = 2, and
 * sample_is_non_sync_sample left at zero. Every Opus packet is such a frame, so the value is
 * stated once in the trex and no fragment repeats it per sample.
 */
const SYNC_SAMPLE_FLAGS = 0x02000000

/** base-data-offset is the first byte of the enclosing moof. */
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000

const TRUN_DATA_OFFSET = 0x000001
const TRUN_SAMPLE_DURATION = 0x000100
const TRUN_SAMPLE_SIZE = 0x000200

/** Size and type: an mdat holding a media segment never needs the 64-bit form. */
const MDAT_HEADER_SIZE = 8

/** One sound track to declare. The codec shows up only as the sample entry it is described by. */
export interface AudioTrackSpec {
  /** track_ID inside the file. Any number above zero; the muxer renumbers them as it builds. */
  trackId: number
  /** Ticks per second the samples of this track are timed in. */
  timescale: number
  /** The sample entry the stsd holds: an 'Opus' with its dOps, an 'mp4a' with its esds. */
  sampleEntry: Uint8Array
}

/** One coded frame on its way into a fragment. */
export interface Sample {
  /** How long it lasts, in ticks of the track. */
  duration: number
  /** The coded bytes. Copied into the mdat as they are; a view into the source is fine. */
  bytes: Uint8Array
}

/**
 * The init segment of a sound track: ftyp and moov, with the mvex that makes the movie a
 * fragmented one. No sample tables — a fragmented movie states nothing about its samples, and
 * the four empty ones are there because the specification asks for them, not because they carry
 * anything.
 */
export function buildAudioInit(spec: AudioTrackSpec): Uint8Array {
  const trak = boxOf(
    'trak',
    trackHeader(spec.trackId),
    boxOf(
      'mdia',
      mediaHeader(spec.timescale),
      handler('soun', 'SoundHandler'),
      boxOf(
        'minf',
        fullBoxOf('smhd', 0, 0, u16(0, 0)), // balance, reserved
        dataInformation(),
        sampleTable(spec.sampleEntry),
      ),
    ),
  )

  const moov = boxOf(
    'moov',
    movieHeader(spec.trackId + 1),
    trak,
    boxOf('mvex', fullBoxOf('trex', 0, 0, u32(spec.trackId, 1, 0, 0, SYNC_SAMPLE_FLAGS))),
  )

  return concatBytes([fileType(), moov])
}

/**
 * One media segment: a moof describing the samples and an mdat holding them.
 *
 * The decode time is stated in a 64-bit tfdt whatever its value. A narrow one would hold a
 * fourteen-hour recording at 48 kHz and no more, and the width costs four bytes a fragment.
 *
 * The sequence number is the fragment's place in the file. It is written because the box has the
 * field and a player reads it; the muxer renumbers every fragment along the file it assembles, so
 * what stands here matters only to a segment read on its own.
 */
export function buildFragment(
  trackId: number,
  baseMediaDecodeTime: number,
  samples: Sample[],
  sequence = 1,
): Uint8Array {
  const mfhd = fullBoxOf('mfhd', 0, 0, u32(sequence))
  const tfhd = fullBoxOf('tfhd', 0, TFHD_DEFAULT_BASE_IS_MOOF, u32(trackId))
  const tfdt = fullBoxOf('tfdt', 1, 0, u64(baseMediaDecodeTime))

  // The trun states where the samples begin, counted from the start of the moof — so the number
  // cannot be written until the moof is as long as it is going to be. Built once to be measured
  // and once for keeps: the field is of fixed width, so the second moof comes out to exactly the
  // length the first one measured.
  const measured = boxOf('moof', mfhd, boxOf('traf', tfhd, tfdt, trackRun(samples, 0)))
  const dataOffset = measured.byteLength + MDAT_HEADER_SIZE
  const moof = boxOf('moof', mfhd, boxOf('traf', tfhd, tfdt, trackRun(samples, dataOffset)))

  return concatBytes([moof, mediaData(samples)])
}

function fileType(): Uint8Array {
  return boxOf('ftyp', ascii('iso5'), u32(0x200), ascii('iso5'), ascii('iso6'), ascii('mp41'))
}

function movieHeader(nextTrackId: number): Uint8Array {
  return fullBoxOf(
    'mvhd',
    0,
    0,
    u32(0, 0, MOVIE_TIMESCALE, 0), // creation, modification, timescale, duration
    u32(0x00010000), // rate: normal speed
    u16(FULL_VOLUME),
    zeroes(10),
    UNITY_MATRIX,
    zeroes(24), // pre_defined
    u32(nextTrackId),
  )
}

function trackHeader(trackId: number): Uint8Array {
  return fullBoxOf(
    'tkhd',
    0,
    TRACK_FLAGS,
    u32(0, 0, trackId, 0, 0), // creation, modification, track_ID, reserved, duration
    zeroes(8),
    u16(0, 0, FULL_VOLUME, 0), // layer, alternate_group, volume, reserved
    UNITY_MATRIX,
    u32(0, 0), // width and height: a sound track has neither
  )
}

function mediaHeader(timescale: number): Uint8Array {
  return fullBoxOf(
    'mdhd',
    0,
    0,
    u32(0, 0, timescale, 0), // creation, modification, timescale, duration
    u16(UNDETERMINED_LANGUAGE, 0), // language, pre_defined
  )
}

function handler(type: string, name: string): Uint8Array {
  return fullBoxOf('hdlr', 0, 0, u32(0), ascii(type), zeroes(12), ascii(name), u8(0))
}

function dataInformation(): Uint8Array {
  return boxOf(
    'dinf',
    fullBoxOf('dref', 0, 0, u32(1), fullBoxOf('url ', 0, DREF_SELF_CONTAINED)),
  )
}

function sampleTable(sampleEntry: Uint8Array): Uint8Array {
  return boxOf(
    'stbl',
    fullBoxOf('stsd', 0, 0, u32(1), sampleEntry),
    fullBoxOf('stts', 0, 0, u32(0)),
    fullBoxOf('stsc', 0, 0, u32(0)),
    fullBoxOf('stsz', 0, 0, u32(0, 0)), // sample_size, sample_count
    fullBoxOf('stco', 0, 0, u32(0)),
  )
}

function trackRun(samples: Sample[], dataOffset: number): Uint8Array {
  const entries = new Uint8Array(samples.length * 8)
  const view = new DataView(entries.buffer)

  for (const [i, sample] of samples.entries()) {
    // A duration is never negative and never fractional in a file: the caller works in whole
    // ticks, and this is the last place a rounding error could reach the bytes.
    view.setUint32(i * 8, Math.max(0, Math.round(sample.duration)))
    view.setUint32(i * 8 + 4, sample.bytes.byteLength)
  }

  return fullBoxOf(
    'trun',
    0,
    TRUN_DATA_OFFSET | TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE,
    u32(samples.length, dataOffset),
    entries,
  )
}

/**
 * The mdat, written straight into its own buffer rather than through concatBytes: a segment holds
 * hundreds of frames, and gathering them into an array of copies first would hold the segment in
 * memory twice over.
 */
function mediaData(samples: Sample[]): Uint8Array {
  let size = MDAT_HEADER_SIZE
  for (const sample of samples) size += sample.bytes.byteLength

  const out = new Uint8Array(size)
  new DataView(out.buffer).setUint32(0, size)
  out.set(ascii('mdat'), 4)

  let at = MDAT_HEADER_SIZE
  for (const sample of samples) {
    out.set(sample.bytes, at)
    at += sample.bytes.byteLength
  }

  return out
}
