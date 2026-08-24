import { ascii, boxOf, fullBoxOf, u16, u32, u8, zeroes } from './writer'
import type { TrackKind } from '../../shared/types'

/**
 * The boxes a movie is described by, whichever of the two writers is writing it.
 *
 * A fragmented file and a progressive one differ in what they say about samples and agree about
 * everything else: the same mvhd, the same tkhd, the same handler and the same data reference. The
 * two writers used to hold a copy each; they hold one between them now, so that a fix to the
 * matrix or the language code cannot land in one file and miss the other.
 *
 * Nothing here decides the timescale. A fragmented file counts the movie in milliseconds because
 * that is what every packager writes; a clip counts it finer, so that an edit list can end on a
 * frame boundary. Both state their own and pass it in.
 */

/** The unity matrix: the picture is shown as it was coded, with no rotation and no scaling. */
export const UNITY_MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000)

/** Full volume, as an 8.8 fixed-point number. */
const FULL_VOLUME = 0x0100

/** track_enabled | track_in_movie: the track plays, and it is part of the presentation. */
const TRACK_FLAGS = 0x000003

/** 'und' as an mdhd packs a language: three five-bit letters, each offset from 0x60. */
const UNDETERMINED_LANGUAGE = 0x55c4

/** self-contained: the media lives in this very file, so the dref entry names nothing. */
const DREF_SELF_CONTAINED = 0x000001

export function fileType(major: string, minorVersion: number, brands: string[]): Uint8Array {
  return boxOf('ftyp', ascii(major), u32(minorVersion), ...brands.map((brand) => ascii(brand)))
}

export function movieHeader(timescale: number, duration: number, nextTrackId: number): Uint8Array {
  return fullBoxOf(
    'mvhd',
    0,
    0,
    u32(0, 0, timescale, duration), // creation, modification, timescale, duration
    u32(0x00010000), // rate: normal speed
    u16(FULL_VOLUME),
    zeroes(10),
    UNITY_MATRIX,
    zeroes(24), // pre_defined
    u32(nextTrackId),
  )
}

/**
 * The track header. Volume belongs to a sound track and the frame size to a picture one, and each
 * writes zero where the other writes a number: that is how a reader that looks no further than
 * this box can still tell what it is holding.
 *
 * The duration is counted in ticks of the movie, not of the track, and it is the length after the
 * edit list has had its say — which for a clip is the length of the clip.
 */
export function trackHeader(
  trackId: number,
  kind: TrackKind,
  width: number,
  height: number,
  duration: number,
): Uint8Array {
  const video = kind === 'video'

  return fullBoxOf(
    'tkhd',
    0,
    TRACK_FLAGS,
    u32(0, 0, trackId, 0, duration), // creation, modification, track_ID, reserved, duration
    zeroes(8),
    u16(0, 0, video ? 0 : FULL_VOLUME, 0), // layer, alternate_group, volume, reserved
    UNITY_MATRIX,
    // A 16.16 fixed-point number of pixels: the field exists to allow a display size other than
    // the coded one, and a track shown as it was coded states the coded size twice.
    u32(width * 0x10000, height * 0x10000),
  )
}

/** The media header: ticks of the track and how many of them the material lasts. */
export function mediaHeader(timescale: number, duration: number): Uint8Array {
  return fullBoxOf(
    'mdhd',
    0,
    0,
    u32(0, 0, timescale, duration), // creation, modification, timescale, duration
    u16(UNDETERMINED_LANGUAGE, 0), // language, pre_defined
  )
}

export function handler(kind: TrackKind): Uint8Array {
  const [type, name] = kind === 'video' ? ['vide', 'VideoHandler'] : ['soun', 'SoundHandler']
  return fullBoxOf('hdlr', 0, 0, u32(0), ascii(type!), zeroes(12), ascii(name!), u8(0))
}

/**
 * The one box inside a minf that differs by kind. The flags of a vmhd are fixed at one by the
 * specification, unlike every other full box in this file.
 */
export function mediaInformationHeader(kind: TrackKind): Uint8Array {
  return kind === 'video'
    ? fullBoxOf('vmhd', 0, 1, u16(0, 0, 0, 0)) // graphicsmode: copy, opcolor of three zeroes
    : fullBoxOf('smhd', 0, 0, u16(0, 0)) // balance, reserved
}

export function dataInformation(): Uint8Array {
  return boxOf('dinf', fullBoxOf('dref', 0, 0, u32(1), fullBoxOf('url ', 0, DREF_SELF_CONTAINED)))
}
