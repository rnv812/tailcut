import { boxOf, fullBoxOf, i16, u16, u32, u8, zeroes } from '../iso/writer'
import type { Vp9Config } from './codec'

/**
 * How a VP9 track is declared inside an ISO BMFF file.
 *
 * VP9 was specified for WebM and arrives on the web inside it, but an mp4 has a place for it too:
 * a 'vp09' visual sample entry holding a 'vpcC' box, as the VP Codec ISO Media File Format
 * Binding lays it out. Nothing of the picture changes — the frames that came out of the Matroska
 * blocks go into the mdat untouched — and this box is what tells a decoder how to read them.
 *
 * The counterpart of opusSampleEntry next door, and it exists for the same reason: the coded
 * frames cross containers unaltered and only the description around them has to be written afresh.
 */

/** Seventy-two dots per inch, as the 16.16 fixed-point number every visual sample entry states. */
const RESOLUTION_72_DPI = 0x0048_0000

/** Twenty-four bits a pixel: the value a sample entry writes for colour with no alpha. */
const COLOUR_DEPTH = 0x0018

/** pre_defined at the end of a VisualSampleEntry, which the specification fixes at -1. */
const SAMPLE_ENTRY_TRAILER = -1

/** A compressorname is a 32-byte Pascal string; an empty one is 32 zeroes. */
const COMPRESSOR_NAME = zeroes(32)

/**
 * The sample entry a VP9 track is declared by: the VisualSampleEntry every picture codec shares,
 * with the vpcC that makes it VP9 in particular.
 *
 * The frame size is written twice over in a finished file — here and in the track header — and
 * both come from the same PixelWidth and PixelHeight the WebM init declared, so the two cannot
 * disagree.
 */
export function vp9SampleEntry(config: Vp9Config, width: number, height: number): Uint8Array {
  return boxOf(
    'vp09',
    zeroes(6),
    u16(1), // data_reference_index: the one entry of the dref, the file itself
    u16(0, 0), // pre_defined, reserved
    u32(0, 0, 0), // pre_defined[3]
    u16(width, height),
    u32(RESOLUTION_72_DPI, RESOLUTION_72_DPI),
    u32(0), // reserved
    u16(1), // frame_count: one coded frame per sample
    COMPRESSOR_NAME,
    u16(COLOUR_DEPTH),
    i16(SAMPLE_ENTRY_TRAILER),
    vpCodecConfigurationBox(config),
  )
}

/**
 * vpcC — profile, level, and how the samples are coloured.
 *
 * Version 1 of the record, which is the only one an mp4 carries: version 0 was defined against a
 * draft that numbered the colour fields differently, and nothing writes it any more.
 *
 * The last field is the length of the codec initialisation data that would follow. VP9 has none —
 * every frame carries its own header — so the box ends on two zero bytes, and that zero is a
 * statement rather than padding.
 */
function vpCodecConfigurationBox(config: Vp9Config): Uint8Array {
  return fullBoxOf(
    'vpcC',
    1,
    0,
    u8(
      config.profile,
      config.level,
      // bitDepth(4) chromaSubsampling(3) videoFullRangeFlag(1), packed into the one byte.
      (config.bitDepth << 4) | (config.chromaSubsampling << 1) | (config.fullRange ? 1 : 0),
      config.colourPrimaries,
      config.transferCharacteristics,
      config.matrixCoefficients,
    ),
    u16(0), // codecIntializationDataSize
  )
}
