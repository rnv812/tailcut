import { colourBox, colourCodes } from './colour'
import { boxOf, concatBytes, i16, u16, u32, zeroes } from '../iso/writer'
import { vp9Config } from '../vp9/codec'
import { vpCodecSampleEntry } from '../vp9/mp4'

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

/**
 * The stsd entry for a VP9 track this program encoded: a `vp09` entry with its `vpcC`.
 *
 * VP9 hands over no `description` — every frame carries its own header, and Chrome's
 * `decoderConfig` for it is a codec string, a size and a colour space and nothing else — so
 * there is no record to copy in byte for byte as `codedSampleEntry` does. The record is written
 * here instead, out of the two things the encoder does say: the codec string, which spells
 * profile, level and bit depth field for field as the vpcC states them (the same parsing the
 * recorder's VP9 tracks go through, src/core/vp9/codec.ts), and the colour space, which fills the
 * three colour fields and the range. Colour the encoder did not report goes down as unspecified
 * rather than as the BT.709 a short codec string defaults to: it is a fact nobody stated.
 *
 * A `colr` follows the vpcC whenever the H.264 path would write one, so that a reader who looks
 * there — this program's own `decoderConfigOf` does — finds the same answer as in the record.
 */
export function encodedVp9SampleEntry(
  codec: string,
  width: number,
  height: number,
  colorSpace?: VideoColorSpaceInit,
): Uint8Array {
  const parsed = vp9Config(`video/mp4; codecs="${codec}"`, width, height)
  if (!parsed || !codec.startsWith('vp09.')) {
    throw new Error(`The encoder named its stream ${codec}, which this program cannot describe as VP9.`)
  }

  const colour = colourCodes(colorSpace)
  const entry = vpCodecSampleEntry(
    'vp09',
    {
      // The subsampling as the string states it; a short string such as `vp09.00.40.08` means
      // 4:2:0 sited on the luma, which is what ffmpeg also writes for 4:2:0 with no siting.
      ...parsed,
      fullRange: colour.fullRange,
      colourPrimaries: colour.primaries,
      transferCharacteristics: colour.transfer,
      matrixCoefficients: colour.matrix,
    },
    width,
    height,
  )

  const colr = colourBox(colorSpace)
  if (!colr.byteLength) return entry
  // One more child after the vpcC, so the entry's own size grows by exactly that box.
  const whole = concatBytes([entry, colr])
  new DataView(whole.buffer).setUint32(0, whole.byteLength)
  return whole
}
