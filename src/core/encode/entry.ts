import { boxOf, i16, u16, u32, u8, zeroes } from '../iso/writer'

/** Seventy-two dots per inch, as the 16.16 fixed-point number every visual sample entry states. */
const RESOLUTION_72_DPI = 0x0048_0000
const COLOUR_DEPTH = 0x0018
const SAMPLE_ENTRY_TRAILER = -1
const COMPRESSOR_NAME = zeroes(32)

/**
 * The colour box every clip this program encodes carries: BT.709, limited range.
 *
 * Written because the encoder does not. Chrome's hardware encoders take the RGB of a canvas,
 * convert it by BT.709 limited, and signal nothing at all — a probe of the result says
 * `color_space=unknown`. ffmpeg then guesses by frame size and picks BT.601 for anything smaller
 * than HD, which is how a correctly encoded clip comes back visibly wrong: measured at 21.9 dB
 * against the 27.5 the same file reads at once the box is there.
 *
 * Written on every rung, software included. Which encoder served the clip is not something the
 * reader of the file can know, so it must not be something the file's correctness depends on.
 */
export const COLOUR_BT709_LIMITED = boxOf(
  'colr',
  u32(0x6e636c78), // 'nclx'
  u16(1, 1, 1), // primaries, transfer, matrix: BT.709 throughout
  u8(0), // full_range_flag: limited, which is what the encoder actually wrote
)

/**
 * The stsd entry for a track this program encoded itself.
 *
 * `description` is what `EncodedVideoChunkMetadata.decoderConfig` handed over on the first chunk:
 * an avcC for `avc1` (asked for with `avc: { format: 'avc' }`), an hvcC for `hvc1`. It goes in
 * byte for byte — it is the codec's own account of itself and nothing here is entitled to an
 * opinion about it.
 */
export function codedSampleEntry(
  format: 'avc1' | 'hvc1',
  description: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  if (!description.byteLength) {
    // A track whose configuration never arrived is a track no decoder will open. Better a refusal
    // here, where the job fails with a name, than a file that looks written and plays as nothing.
    throw new Error('The encoder produced no decoder configuration.')
  }

  return boxOf(
    format,
    zeroes(6),
    u16(1), // data_reference_index
    u16(0, 0),
    u32(0, 0, 0),
    u16(width, height),
    u32(RESOLUTION_72_DPI, RESOLUTION_72_DPI),
    u32(0),
    u16(1), // frame_count
    COMPRESSOR_NAME,
    u16(COLOUR_DEPTH),
    i16(SAMPLE_ENTRY_TRAILER),
    boxOf(format === 'avc1' ? 'avcC' : 'hvcC', description),
    COLOUR_BT709_LIMITED,
  )
}
