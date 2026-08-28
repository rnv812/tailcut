import { boxOf, concatBytes, u16, u32, u8, zeroes } from '../iso/writer'
import { descriptorOf } from '../vorbis/mp4'
import type { MpegVersion } from './frames'

/**
 * How an MPEG-1 or MPEG-2 audio track is declared inside an ISO BMFF file.
 *
 * The same shape the Vorbis writer beside this uses and for the same reason: the codec has no
 * sample entry of its own in an mp4, so it is declared as an ordinary MPEG-4 elementary stream
 * whose object type says which codec it actually is. Unlike Vorbis, this one is not a convention
 * — 14496-1 registers 0x6B for MPEG-1 audio and 0x69 for the low-sampling-frequency extension of
 * MPEG-2, and Chromium names them in as many words: `mp4a.6B` and `mp4a.69` are codecs it plays.
 *
 * What it does not carry is any decoder-specific information, and that is not an omission. An AAC
 * stream cannot be started without its AudioSpecificConfig — the rate and the channel count live
 * only there — while every field an MP3 decoder needs stands in the four-byte header of every
 * frame it is handed. The descriptor is written without one, which is what ffmpeg and every other
 * muxer writes for this codec.
 */

/** MPEG-1 audio, all three layers. */
export const MPEG1_OBJECT_TYPE = 0x6b

/**
 * MPEG-2 audio, the low-sampling-frequency extension.
 *
 * MPEG-2.5 is given the same byte. It is not in the registry at all — it is Fraunhofer's own
 * extension down to 8 kHz and no object type was ever assigned to it — and 0x69 is what says the
 * most true thing available: half-rate MPEG audio. A decoder reads the version out of the frame
 * header anyway, which is the only place either of these streams ever states it.
 */
export const MPEG2_OBJECT_TYPE = 0x69

/** streamType(6) reserved(1) upStream(1) for an audio stream: 0x05 << 2 | 0x01. */
const AUDIO_STREAM_TYPE = 0x15

/** Sixteen bits a sample, which is what an AudioSampleEntry writes whatever the codec does. */
const SAMPLE_SIZE = 16

const ES_DESCRIPTOR = 0x03
const DECODER_CONFIG = 0x04
const SL_CONFIG = 0x06

export interface MpegTrack {
  version: MpegVersion
  channels: number
  sampleRate: number
}

/**
 * The sample entry an MPEG audio track is declared by.
 *
 * The rate written here is the material's own and the mp4 track is timed in the same rate, so
 * every time in the track is a whole number of samples and nothing is ever rounded.
 */
export function mpegSampleEntry(track: MpegTrack): Uint8Array {
  return boxOf(
    'mp4a',
    zeroes(6),
    u16(1), // data_reference_index: the one entry of the dref, the file itself
    zeroes(8),
    u16(track.channels, SAMPLE_SIZE, 0, 0), // channelcount, samplesize, pre_defined, reserved
    u32(track.sampleRate * 0x10000), // samplerate, as a 16.16 fixed-point number
    elementaryStreamDescription(track.version),
  )
}

/**
 * esds — the descriptor tree the stream is described by, and the object type inside it.
 *
 * Two descriptors deep instead of the three a codec with setup bytes needs: there is no
 * DecoderSpecificInfo, so the DecoderConfigDescriptor ends where its fixed fields do. The buffer
 * size and the two bitrates are written as zero — "not stated" — because a variable-rate file
 * states none of them anywhere and a number invented here would be a claim about somebody else's
 * stream.
 */
function elementaryStreamDescription(version: MpegVersion): Uint8Array {
  const config = descriptorOf(
    DECODER_CONFIG,
    concatBytes([
      u8(version === 1 ? MPEG1_OBJECT_TYPE : MPEG2_OBJECT_TYPE, AUDIO_STREAM_TYPE),
      u8(0, 0, 0), // bufferSizeDB
      u32(0, 0), // maxBitrate, avgBitrate
    ]),
  )

  const stream = descriptorOf(
    ES_DESCRIPTOR,
    concatBytes([u16(1), u8(0), config, descriptorOf(SL_CONFIG, u8(0x02))]),
  )

  return boxOf('esds', u32(0), stream)
}
