import { colourBox } from './colour'
import { boxOf, i16, u16, u32, zeroes } from '../iso/writer'

/** Seventy-two dots per inch, as the 16.16 fixed-point number every visual sample entry states. */
const RESOLUTION_72_DPI = 0x0048_0000
const COLOUR_DEPTH = 0x0018
const SAMPLE_ENTRY_TRAILER = -1
const COMPRESSOR_NAME = zeroes(32)

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
  colorSpace?: VideoColorSpaceInit,
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
    colourBox(colorSpace),
  )
}
