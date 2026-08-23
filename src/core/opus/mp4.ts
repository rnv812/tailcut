import { boxOf, i16, u16, u32, u8, zeroes } from '../iso/writer'
import { OPUS_SAMPLE_RATE, type OpusHead } from './packets'

/**
 * How an Opus track is declared inside an ISO BMFF file.
 *
 * Opus was specified for Ogg and arrives on the web inside WebM, but an mp4 has a place for it
 * too: an 'Opus' sample entry holding a 'dOps' box, which is the OpusHead written out again with
 * the magic dropped and every field big-endian. Nothing of the sound changes — the packets that
 * came out of the Matroska blocks go into the mdat untouched, and this box is what tells a
 * decoder how to read them.
 */

/**
 * The sample entry an Opus track is declared by. The layout above dOps is the AudioSampleEntry
 * every sound codec shares, and its samplerate field is fixed at 48 kHz by the Opus mapping:
 * whatever the material was recorded at, the decoder puts out 48 kHz, and the rate the encoder
 * was fed survives only inside dOps.
 */
export function opusSampleEntry(head: OpusHead): Uint8Array {
  return boxOf(
    'Opus',
    zeroes(6),
    u16(1), // data_reference_index: the one entry of the dref, the file itself
    zeroes(8),
    u16(head.channels, 16, 0, 0), // channelcount, samplesize, pre_defined, reserved
    u32(OPUS_SAMPLE_RATE * 0x10000), // samplerate, as a 16.16 fixed-point number
    opusSpecificBox(head),
  )
}

/**
 * dOps — the OpusHead, byte for byte, in the order an mp4 reads its fields.
 *
 * Not a full box: the version is a field of its own here rather than the first byte of a
 * version-and-flags word, which is why this is built with boxOf and not fullBoxOf.
 */
function opusSpecificBox(head: OpusHead): Uint8Array {
  const parts = [
    u8(0, head.channels), // Version, OutputChannelCount
    u16(head.preSkip),
    u32(head.inputSampleRate),
    i16(head.outputGain),
    u8(head.mappingFamily),
  ]

  // Family zero is mono or stereo in the obvious order and states no table. Every other family
  // has to carry one, and a decoder that read the mapping of the wrong channel would put the
  // sound in the wrong speaker rather than fail.
  if (head.mappingFamily !== 0) {
    parts.push(u8(head.streamCount, head.coupledCount), u8(...head.channelMapping))
  }

  return boxOf('dOps', ...parts)
}
