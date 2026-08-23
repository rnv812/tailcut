/**
 * The Opus bitstream, as far as a container has to understand it.
 *
 * Two things are needed here and nothing else. How long a packet lasts, because Matroska writes
 * its timestamps in milliseconds and an mp4 track counts in samples: the millisecond is a rounded
 * number and the packet itself is not, so the length of the last packet of a fragment — the one
 * with no following timestamp to measure against — has to come out of the packet. And what the
 * OpusHead says, because an mp4 declares the same fields in a box of its own and they have to be
 * carried across rather than guessed.
 *
 * The bytes come from a foreign page. Nothing here throws: what cannot be read comes back as zero
 * or as null, and the caller decides what a packet of unknown length is worth.
 */

/** Opus always decodes to 48 kHz, whatever rate the encoder was fed. */
export const OPUS_SAMPLE_RATE = 48_000

/** The longest a packet may last: 120 ms, and at 48 kHz that is this many samples. */
const MAX_PACKET_SAMPLES = 5760

/**
 * Samples one frame lasts, per the configuration number in the top five bits of the TOC byte.
 *
 * The table is the configuration space of the codec laid out flat: twelve SILK configurations of
 * 10, 20, 40 and 60 ms over three bandwidths, four hybrid ones of 10 and 20 ms over two, and
 * sixteen CELT ones of 2.5, 5, 10 and 20 ms over four.
 */
const FRAME_SAMPLES: readonly number[] = [
  480, 960, 1920, 2880, // SILK, narrowband
  480, 960, 1920, 2880, // SILK, mediumband
  480, 960, 1920, 2880, // SILK, wideband
  480, 960, // hybrid, super-wideband
  480, 960, // hybrid, fullband
  120, 240, 480, 960, // CELT, narrowband
  120, 240, 480, 960, // CELT, mediumband
  120, 240, 480, 960, // CELT, wideband
  120, 240, 480, 960, // CELT, fullband
]

/** The two low bits of the TOC byte: how many frames the packet holds and how they are counted. */
const CODE_ONE_FRAME = 0
const CODE_TWO_EQUAL = 1
const CODE_TWO_DIFFERENT = 2
const CODE_ARBITRARY = 3

/**
 * How many samples at 48 kHz one Opus packet decodes to, and zero when the bytes are not a packet
 * whose length can be read: an empty payload, a frame count of zero, or a count that would carry
 * the packet past the 120 ms the codec allows.
 *
 * Zero rather than a guess. A length invented for a packet the reader does not understand would
 * move every sample after it on the timeline, and a stated zero is a length the caller can see.
 */
export function packetSamples(packet: Uint8Array): number {
  const toc = packet[0]
  if (toc === undefined) return 0

  const frameSamples = FRAME_SAMPLES[toc >> 3]!
  const code = toc & 0x03

  let frames = 0
  if (code === CODE_ONE_FRAME) frames = 1
  else if (code === CODE_TWO_EQUAL || code === CODE_TWO_DIFFERENT) frames = 2
  else if (code === CODE_ARBITRARY) {
    // The frame count sits in the low six bits of the byte after the TOC. A packet that promises
    // frames and then ends before saying how many is not a packet.
    const count = packet[1]
    if (count === undefined) return 0
    frames = count & 0x3f
  }

  const samples = frames * frameSamples
  if (samples <= 0 || samples > MAX_PACKET_SAMPLES) return 0
  return samples
}

/** The identification header of an Opus stream — the CodecPrivate of a Matroska A_OPUS track. */
export interface OpusHead {
  /** Channels the decoder puts out. */
  channels: number
  /** Samples at 48 kHz the decoder is to throw away at the start of the stream. */
  preSkip: number
  /** Rate of the material before it was encoded. Informational: Opus decodes to 48 kHz. */
  inputSampleRate: number
  /** Gain to apply on output, as a signed 8.8 fixed-point number of decibels. */
  outputGain: number
  /** 0 mono or stereo, 1 Vorbis channel order, 255 discrete. */
  mappingFamily: number
  /** Streams the packets carry. One for family 0, where the mapping table is left out. */
  streamCount: number
  /** How many of those streams are coupled pairs. */
  coupledCount: number
  /** Which decoded channel feeds each output channel; empty for family 0. */
  channelMapping: number[]
}

/** "OpusHead" — the eight bytes the header opens with. */
const MAGIC = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]

/** Magic, version, channels, pre-skip, input rate, output gain, mapping family. */
const HEAD_SIZE = 19

/**
 * Reads an OpusHead, or null when the bytes are not one.
 *
 * The fields are little-endian — the one place in this codebase where they are, because the
 * header belongs to the Ogg world Opus was specified in and travels into Matroska unchanged.
 * The mp4 box built out of it writes the same numbers big-endian.
 *
 * A major version above zero means a header this reader does not know the shape of; refused,
 * because a channel count read out of the wrong offset is worse than no track at all.
 */
export function parseOpusHead(bytes: Uint8Array): OpusHead | null {
  if (bytes.byteLength < HEAD_SIZE) return null
  for (const [i, byte] of MAGIC.entries()) if (bytes[i] !== byte) return null

  // The upper four bits are the major version; the lower four are a minor one, and a minor
  // version only ever adds fields past the ones read here.
  if ((bytes[8]! & 0xf0) !== 0x00) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const channels = bytes[9]!
  if (channels < 1) return null

  const head: OpusHead = {
    channels,
    preSkip: view.getUint16(10, true),
    inputSampleRate: view.getUint32(12, true),
    outputGain: view.getInt16(16, true),
    mappingFamily: bytes[18]!,
    streamCount: 1,
    coupledCount: channels === 2 ? 1 : 0,
    channelMapping: [],
  }

  if (head.mappingFamily === 0) {
    // Family zero is mono or stereo and nothing else, and it carries no mapping table: a header
    // that claims more channels under it is describing a layout it has not written down.
    return channels <= 2 ? head : null
  }

  // Every other family states the table outright: stream count, coupled count, and one byte per
  // output channel saying which decoded channel it comes from.
  if (bytes.byteLength < HEAD_SIZE + 2 + channels) return null

  head.streamCount = bytes[19]!
  head.coupledCount = bytes[20]!
  if (head.streamCount < 1 || head.coupledCount > head.streamCount) return null

  head.channelMapping = [...bytes.subarray(21, 21 + channels)]
  return head
}
