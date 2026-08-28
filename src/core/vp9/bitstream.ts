import { levelFor, type Vp9Config } from './codec'

/**
 * What an mp4 has to be told about a VP9 track, read out of the stream itself.
 *
 * The module next door (src/core/vp9/codec.ts) weighs the two possible sources of a vpcC and
 * chooses the codec string, and the whole of its argument is timing: a track out of MediaSource
 * has to be described the moment its init segment lands, and the first coded frame comes after.
 * That argument does not reach this path, and the difference is the point of this file. An
 * ordinary file is whole and already on a server: by the time anything is described, every frame
 * of it has an address, and the first keyframe is one ranged read away. There is also no codec
 * string to fall back on — nobody opened a SourceBuffer, so nobody wrote one — so the bitstream
 * is not merely allowed here, it is the only source there is.
 *
 * And it is the better one. The uncompressed header of a keyframe is what the decoder itself
 * reads: the profile, the bit depth and the subsampling in it cannot be wrong about the stream,
 * because being wrong would mean the stream does not decode.
 *
 * ## The colour, and why two of the three fields are left unspecified
 *
 * The record wants three CICP codes — primaries, transfer characteristics, matrix coefficients.
 * A VP9 keyframe carries one field about colour, `color_space`, and for all its name it is a
 * matrix: a three-bit enum whose values are BT.601, BT.709, SMPTE-170, SMPTE-240, BT.2020 and
 * sRGB. So the matrix is read out of it and the other two are written as 2, which is the CICP
 * code for "the stream does not say". Inventing primaries to match the name of a matrix would be
 * a claim the file never made.
 *
 * What is not read is the Colour element a Matroska may state beside the frame size. It is a
 * third authority and it disagrees with nobody in anything measured; where it did disagree, the
 * cost is a wrong line of metadata and not a wrong picture, for the reason vp9/codec.ts sets out
 * — every VP9 decoder reads the shape of the stream out of the frames and not out of the box.
 */

/** The value the two-bit frame marker always has. */
const FRAME_MARKER = 2

/** `49 83 42` — the three bytes that stand between the frame type and the colour of a keyframe. */
const SYNC_CODE = 0x498342

/** color_space, as the three bits spell it: the one value with a branch of its own. */
const CS_SRGB = 7

/**
 * The matrix each colour space names, as ISO/IEC 23091-2 numbers them. Index by `color_space`.
 *
 * Six is the reserved value: a stream that states it has said nothing this reader can act on, so
 * it comes out as unspecified rather than as a number nobody defined.
 */
const MATRIX_OF_COLOUR_SPACE = [
  2, // CS_UNKNOWN — unspecified
  5, // CS_BT_601 — BT.470 System B/G, which is what BT.601 625-line is
  1, // CS_BT_709
  6, // CS_SMPTE_170
  7, // CS_SMPTE_240
  9, // CS_BT_2020 non-constant luminance
  2, // CS_RESERVED
  0, // CS_SRGB — identity: the samples are already RGB
]

/** CICP for "the stream does not say". */
const UNSPECIFIED = 2

/** vpcC chroma subsampling: 4:2:0 sited with the luma, 4:2:2, 4:4:4. */
const CHROMA_420_COLOCATED = 1
const CHROMA_422 = 2
const CHROMA_444 = 3

/** The configuration record, with the frame size the bitstream states beside it. */
export interface Vp9Keyframe extends Vp9Config {
  width: number
  height: number
}

/**
 * Reads the uncompressed header of a VP9 keyframe.
 *
 * Null for anything that is not one: an inter frame, a frame that only shows a picture already
 * decoded, a header whose sync code is not where it must be, a combination the format does not
 * define. A refusal and not a default — the caller has a track it cannot describe, and a track
 * described by invented numbers is worse than a track left out of the file with the loss written
 * down.
 */
export function vp9ConfigOfKeyframe(bytes: Uint8Array): Vp9Keyframe | null {
  const bits = new Bits(bytes)

  if (bits.read(2) !== FRAME_MARKER) return null

  const low = bits.read(1)
  const high = bits.read(1)
  if (low < 0 || high < 0) return null
  const profile = (high << 1) + low
  // Profile 3 is spelled with a reserved bit behind it, and the bit is zero.
  if (profile === 3 && bits.read(1) !== 0) return null

  // A frame that shows one of the reference pictures again carries no description of anything.
  if (bits.read(1) !== 0) return null
  // frame_type: zero is a keyframe. An inter frame states no size and no colour.
  if (bits.read(1) !== 0) return null

  bits.read(1) // show_frame
  bits.read(1) // error_resilient_mode

  if (bits.read(24) !== SYNC_CODE) return null

  // Ten or twelve bits, and which of the two is a bit of its own; the shallower profiles are
  // eight and have no bit to spend on saying so.
  let bitDepth = 8
  if (profile >= 2) {
    const wider = bits.read(1)
    if (wider < 0) return null
    bitDepth = wider === 1 ? 12 : 10
  }

  const colourSpace = bits.read(3)
  if (colourSpace < 0) return null

  let fullRange = false
  let subsamplingX = 1
  let subsamplingY = 1

  if (colourSpace === CS_SRGB) {
    // sRGB samples are not subsampled at all, and they are always full swing.
    fullRange = true
    subsamplingX = 0
    subsamplingY = 0
    // And only the profiles that have 4:4:4 may carry them.
    if (profile !== 1 && profile !== 3) return null
    if (bits.read(1) !== 0) return null
  } else {
    const range = bits.read(1)
    if (range < 0) return null
    fullRange = range === 1

    if (profile === 1 || profile === 3) {
      subsamplingX = bits.read(1)
      subsamplingY = bits.read(1)
      if (subsamplingX < 0 || subsamplingY < 0) return null
      if (bits.read(1) !== 0) return null
    }
  }

  const chromaSubsampling = chromaOf(subsamplingX, subsamplingY)
  if (chromaSubsampling === null) return null

  const width = bits.read(16)
  const height = bits.read(16)
  if (width < 0 || height < 0) return null

  return {
    profile,
    level: levelFor(width + 1, height + 1),
    bitDepth,
    chromaSubsampling,
    fullRange,
    // The bitstream states a matrix and nothing else about colour; see the module.
    colourPrimaries: UNSPECIFIED,
    transferCharacteristics: UNSPECIFIED,
    matrixCoefficients: MATRIX_OF_COLOUR_SPACE[colourSpace] ?? UNSPECIFIED,
    width: width + 1,
    height: height + 1,
  }
}

/** The vpcC code for a pair of subsampling flags, or null for a pair the format does not have. */
function chromaOf(x: number, y: number): number | null {
  if (x === 1 && y === 1) return CHROMA_420_COLOCATED
  if (x === 1 && y === 0) return CHROMA_422
  if (x === 0 && y === 0) return CHROMA_444
  // Subsampled down the columns and not across them is not a shape VP9 defines.
  return null
}

/**
 * A reader of the bits of the uncompressed header, most significant first.
 *
 * Reading past the end answers −1 rather than throwing or wrapping round to zero: the bytes come
 * from a foreign page, and a header cut short must read as "not a header" and not as a header
 * full of zeroes.
 */
class Bits {
  private at = 0

  constructor(private readonly data: Uint8Array) {}

  read(width: number): number {
    if (this.at + width > this.data.byteLength * 8) {
      this.at = this.data.byteLength * 8 + 1
      return -1
    }

    let value = 0
    for (let i = 0; i < width; i++) {
      const bit = (this.data[this.at >> 3]! >> (7 - (this.at & 7))) & 1
      value = value * 2 + bit
      this.at++
    }

    return value
  }
}
