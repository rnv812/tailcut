import { boxOf, concatBytes, u16, u32, u8, zeroes } from '../iso/writer'

/**
 * How a Vorbis track is declared inside an ISO BMFF file.
 *
 * Vorbis was specified for Ogg and arrives on the web inside WebM — an imageboard's file is VP8
 * and Vorbis to this day — and unlike Opus it has no box of its own in an mp4. There is no
 * 'vorb' sample entry and no registered object type for it: what exists instead is a convention,
 * old and widely implemented, of declaring it as an ordinary MPEG-4 audio stream whose object
 * type is 0xDD and whose decoder-specific information is the three Vorbis setup headers as the
 * container already carries them.
 *
 * That convention is what this writes, and it was measured rather than trusted. ffmpeg reads the
 * result as Vorbis and decodes it without a word; Chromium plays it and hands back real samples —
 * six seconds of 44.1 kHz mono, peak 0.13, out of `decodeAudioData`. What says the opposite is the
 * static type check: `canPlayType('audio/mp4; codecs="vorbis"')` answers with an empty string and
 * `MediaSource.isTypeSupported` with false, because the codec is not on the allow-list either of
 * them consults. Neither of those is on the path a saved file takes — a file is opened by the
 * demuxer, and the demuxer takes it — which is why the question had to be settled by playing a
 * file rather than by asking.
 *
 * What is not claimed: that every player does this. It is a convention and not a standard, and
 * the two we can run — ffmpeg 4.4 and Chromium — are the two it is known to hold for.
 */

/**
 * The object type that means Vorbis: 0xDD, out of the range the specification leaves to private
 * use. GPAC chose it, ffmpeg reads it, and there is nothing else to choose.
 */
export const VORBIS_OBJECT_TYPE = 0xdd

/** streamType(6) reserved(1) upStream(1) for an audio stream: 0x05 << 2 | 0x01. */
const AUDIO_STREAM_TYPE = 0x15

/** Sixteen bits a sample, which is what an AudioSampleEntry writes whatever the codec does. */
const SAMPLE_SIZE = 16

/** Tags of the descriptors an esds is made of. */
const ES_DESCRIPTOR = 0x03
const DECODER_CONFIG = 0x04
const DECODER_SPECIFIC_INFO = 0x05
const SL_CONFIG = 0x06

export interface VorbisTrack {
  channels: number
  /** The rate the material was encoded at; a Vorbis decoder puts out that rate and no other. */
  sampleRate: number
  /** CodecPrivate of the Matroska track: identification, comment and codebooks, xiph-laced. */
  setup: Uint8Array
}

/**
 * One descriptor of the MPEG-4 grammar: a tag, a length, and the body.
 *
 * The length is written seven bits to a byte with the high bit set on every byte but the last, so
 * a body under 128 bytes costs one and a Vorbis setup blob of three kilobytes costs three. Not a
 * corner case here but the ordinary one: written as a single byte, a length of 3341 would state
 * 13 and cut the codebooks off.
 */
export function descriptorOf(tag: number, body: Uint8Array): Uint8Array {
  const length: number[] = []
  let left = body.byteLength

  do {
    length.unshift(left & 0x7f)
    left >>= 7
  } while (left > 0)

  for (let i = 0; i < length.length - 1; i++) length[i]! |= 0x80

  return concatBytes([u8(tag), Uint8Array.from(length), body])
}

/**
 * The sample entry a Vorbis track is declared by: the AudioSampleEntry every sound codec shares,
 * with an esds behind it naming the object type and carrying the setup headers.
 *
 * The rate is the material's own, unlike Opus: a Vorbis decoder puts out what it was fed, and the
 * mp4 track is timed in the same rate.
 */
export function vorbisSampleEntry(track: VorbisTrack): Uint8Array {
  return boxOf(
    'mp4a',
    zeroes(6),
    u16(1), // data_reference_index: the one entry of the dref, the file itself
    zeroes(8),
    u16(track.channels, SAMPLE_SIZE, 0, 0), // channelcount, samplesize, pre_defined, reserved
    u32(track.sampleRate * 0x10000), // samplerate, as a 16.16 fixed-point number
    elementaryStreamDescription(track.setup),
  )
}

/**
 * esds — the descriptor tree an MPEG-4 stream is described by, with the Vorbis headers at the
 * bottom of it.
 *
 * Three descriptors deep and every one of them required: the ES around the whole, the decoder
 * configuration naming the object type, and the decoder-specific information holding the setup.
 * The buffer size and the two bitrates are written as zero — "not stated" — because nothing in
 * the container says what they are and a number invented here would be a claim about somebody
 * else's stream.
 */
function elementaryStreamDescription(setup: Uint8Array): Uint8Array {
  const specific = descriptorOf(DECODER_SPECIFIC_INFO, setup)

  const config = descriptorOf(
    DECODER_CONFIG,
    concatBytes([
      u8(VORBIS_OBJECT_TYPE, AUDIO_STREAM_TYPE),
      u8(0, 0, 0), // bufferSizeDB
      u32(0, 0), // maxBitrate, avgBitrate
      specific,
    ]),
  )

  // ES_ID of one and no flags: the stream has no dependency, no URL and no OCR to name.
  const stream = descriptorOf(
    ES_DESCRIPTOR,
    concatBytes([u16(1), u8(0), config, descriptorOf(SL_CONFIG, u8(0x02))]),
  )

  // A full box written by hand rather than through fullBoxOf: the version and flags of an esds
  // are one four-byte word of zeroes, and what follows is a descriptor tree and not fields.
  return boxOf('esds', u32(0), stream)
}
