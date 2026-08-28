import { codecsOf, levelFor, type Vp9Config as VpConfig } from '../vp9/codec'
import { vpCodecSampleEntry } from '../vp9/mp4'

/**
 * How a VP8 track is described in an mp4, and where the description comes from.
 *
 * VP8 is the codec the plain web still hands over: an imageboard's file is VP8 with Vorbis to
 * this day, and it was the last thing standing between "any video on any page" and a refusal.
 * The mp4 has a place for it — the VP Codec ISO Media File Format Binding gives it the fourcc
 * 'vp08' and the same vpcC record it gives VP9 — and this is the only mapping there is.
 *
 * That it works was measured and not assumed. Chromium plays a file written this way to its end
 * and hands back real pixels: fifty distinct colours out of a frame drawn from the element into
 * a canvas, 3.8 kB of picture through the decoder. ffmpeg 4.4 reads it as VP8 and decodes it
 * without a word — although its *muxer* refuses to write one, saying "codec not currently
 * supported in container", which is a statement about ffmpeg and not about the format. The
 * static type check says no too: `canPlayType('video/mp4; codecs="vp08.00.10.08"')` answers with
 * an empty string. Neither of those stands on the path a saved file takes — a file is opened by
 * the demuxer — which is why the question had to be settled by playing one.
 *
 * ## Where the fields come from
 *
 * The vpcC record was written for VP9 and asks for things VP8 does not have. The neighbouring
 * module (src/core/vp9/codec.ts) argues at length that the codec string is the only source that
 * arrives in time, because a track out of MSE has to be described before its first frame lands.
 * None of that holds here, and the difference is worth stating: this path reads a *file*, whole
 * and already on a server, so the first keyframe is one ranged read away and the bitstream — the
 * authority, the thing the decoder itself reads — is available before anything is described.
 *
 * So the profile is read out of the frame tag. Everything else about a VP8 stream is fixed by
 * the format: eight bits a component, 4:2:0, and one colour space with one bit to name it.
 */

/** The three bytes that open the uncompressed part of every VP8 keyframe. */
const START_CODE = [0x9d, 0x01, 0x2a]

/** Frame tag, start code and the two dimensions: the whole of the uncompressed keyframe header. */
const KEYFRAME_HEADER_BYTES = 10

/** VP8 codes eight bits a component and cannot say otherwise. */
const BIT_DEPTH = 8

/** 4:2:0 with the chroma sited with the luma — the one subsampling VP8 has. */
const CHROMA_420_COLOCATED = 1

/** CICP for "the stream does not say"; see the colour note in vp8ConfigOfKeyframe. */
const UNSPECIFIED = 2

/** The frame size the bitstream states is 14 bits wide; the two above it are a scaling hint. */
const SIZE_MASK = 0x3fff

/**
 * The configuration record of a VP8 track, with the frame size the bitstream states beside it.
 *
 * The record type is the VP9 one because the box is: one VPCodecConfigurationRecord serves both
 * codecs, and it is named here for the codec it was written for rather than duplicated under a
 * second name.
 */
export interface Vp8Keyframe extends VpConfig {
  /** Frame width the keyframe declares. The container declares it too, and they agree. */
  width: number
  height: number
}

/**
 * What an mp4 has to be told about a VP8 track, read out of one keyframe of it.
 *
 * Null for bytes that are not a VP8 keyframe: an inter frame, which carries neither the start
 * code nor the size, and anything too short to hold the header. A refusal and not a default —
 * a description invented here would be a claim about somebody else's stream, and the track is
 * better left undescribed than described wrongly.
 */
export function vp8ConfigOfKeyframe(bytes: Uint8Array): Vp8Keyframe | null {
  if (bytes.byteLength < KEYFRAME_HEADER_BYTES) return null

  // The frame tag is three bytes read as one little-endian number: the keyframe bit, the version,
  // the show_frame bit and the length of the first partition.
  const tag = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16)
  // Zero is a keyframe and one is an inter frame — the bit is set the way round that makes an
  // all-zero tag mean "the frame everything else is predicted from".
  if ((tag & 1) !== 0) return null

  const profile = (tag >> 1) & 0x07
  // The format defines four; the three bits can spell eight, and the four above are not VP8.
  if (profile > 3) return null

  for (let i = 0; i < START_CODE.length; i++) {
    if (bytes[3 + i] !== START_CODE[i]) return null
  }

  const width = (bytes[6]! | (bytes[7]! << 8)) & SIZE_MASK
  const height = (bytes[8]! | (bytes[9]! << 8)) & SIZE_MASK
  if (!(width > 0 && height > 0)) return null

  return {
    profile,
    // The record has one level field and one table behind it, and that table is VP9's: VP8
    // defines no levels at all. What is written is the level a VP9 picture of this size would
    // need — the same number the VP9 path writes for the same frame — and no decoder of either
    // codec reads it.
    level: levelFor(width, height),
    bitDepth: BIT_DEPTH,
    chromaSubsampling: CHROMA_420_COLOCATED,
    // The colour of a VP8 stream is one bit, it has one legal value, and it lives inside the
    // arithmetic-coded partition rather than in the header above. A bit that cannot differ from
    // file to file distinguishes nothing, so the three CICP fields are left at "the stream does
    // not say" instead of being decoded for it.
    fullRange: false,
    colourPrimaries: UNSPECIFIED,
    transferCharacteristics: UNSPECIFIED,
    matrixCoefficients: UNSPECIFIED,
    width,
    height,
  }
}

/**
 * The sample entry a VP8 track is declared by: a 'vp08' VisualSampleEntry with the vpcC inside it.
 *
 * The frame size is the container's, as it is for VP9, so that the entry and the track header
 * cannot disagree — the bitstream's own size is read above only to prove the frame is a keyframe
 * and to price the level.
 */
export function vp8SampleEntry(config: VpConfig, width: number, height: number): Uint8Array {
  return vpCodecSampleEntry('vp08', config, width, height)
}

/**
 * The same record for a track that has not arrived yet — the shape of every VP8 stream there is.
 *
 * The ingest boundary describes a track the moment its init segment lands, before a single coded
 * frame has been appended (src/core/webm/to-iso.ts), so the keyframe above is not available
 * there. For VP9 that is the end of the matter and the codec string has to answer instead, at
 * length, because a VP9 stream may be eight or twelve bits, 4:2:0 or 4:4:4, and a decoder built
 * for the wrong one is built wrongly.
 *
 * VP8 has no such variety. Eight bits, 4:2:0, one colour space: every field of the record but one
 * is fixed by the format, and the one that is not — the version, which selects the loop filter —
 * is read by a decoder out of the frame tag of every frame and never out of this box. So nothing
 * is guessed at here. The version is taken from the codec string where the page wrote the long
 * form `vp08.PP.LL.DD`, and where it wrote plain `vp8`, as pages do, the field states the
 * commonest of the four and costs a line of metadata if it is wrong.
 */
export function vp8Config(mime: string | undefined, width: number, height: number): VpConfig {
  return {
    profile: profileOfCodecString(mime),
    level: levelFor(width, height),
    bitDepth: BIT_DEPTH,
    chromaSubsampling: CHROMA_420_COLOCATED,
    fullRange: false,
    colourPrimaries: UNSPECIFIED,
    transferCharacteristics: UNSPECIFIED,
    matrixCoefficients: UNSPECIFIED,
  }
}

/** The version a `vp08.PP.LL.DD` names; zero for a string that names none, which is most of them. */
function profileOfCodecString(mime: string | undefined): number {
  for (const codec of codecsOf(mime ?? '')) {
    const fields = codec.split('.')
    if (fields[0] !== 'vp08') continue

    const profile = Number(fields[1])
    if (/^\d{2}$/.test(fields[1] ?? '') && profile <= 3) return profile
  }

  return 0
}
