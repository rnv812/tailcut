import type { Located } from '../../shared/types'

/**
 * Reading an MPEG audio elementary stream — an mp3 file — as a list of frames.
 *
 * The third container of the survey, and the barest of the three. An mp4 states every sample of
 * every track in the tables of its movie box; a Matroska states each frame in the block header
 * immediately in front of it; this states nothing anywhere. There is no header over the file, no
 * table, no index and no declared length: a file is a run of frames laid end to end, and every
 * one of them is described by the four bytes at its front and by nothing else. Reading it means
 * walking it.
 *
 * It is here because of one shape of page (§5.6): a picture in a `<video src>` with no sound of
 * its own and the sound in a separate `<audio src>` beside it, which on the site the survey found
 * it on is an mp3. Nothing else in the program reads a bare elementary stream, and nothing else
 * needs to — a file with a container around it comes in through the mp4 or the Matroska road.
 *
 * ## What is not read
 *
 * The free bitrate, where the header states no length and a frame is measured by finding the next
 * one. It exists in the specification and not in the wild, and guessing lengths by searching for
 * a sync word is exactly the kind of reading that produces a file with a frame of somebody else's
 * bytes in it. Such a stream is refused.
 */

/** MPEG-1, MPEG-2 (the low-sampling-frequency extension), and the unofficial MPEG-2.5. */
export type MpegVersion = 1 | 2 | 25

export interface MpegHeader {
  version: MpegVersion
  layer: 1 | 2 | 3
  /** Coded bits per second, as the index in the header names them. */
  bitrate: number
  sampleRate: number
  /** One for single-channel mode, two for every other: joint stereo is stereo. */
  channels: number
  /** Length of the whole frame in bytes, this header counted in. */
  length: number
  /** Decoded samples the frame carries. */
  samples: number
}

/** Bits per second by bitrate index, one table per version and layer. */
const BITRATES: Record<string, readonly number[]> = {
  // MPEG-1
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  // MPEG-2 and MPEG-2.5 share theirs, and Layers II and III share one between them.
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}

const SAMPLE_RATES: Record<MpegVersion, readonly number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  25: [11025, 12000, 8000],
}

/** The two version bits, in the order the field numbers them: 01 is reserved and has no meaning. */
const VERSIONS: Array<MpegVersion | null> = [25, null, 2, 1]

/** The two layer bits, likewise: 00 is reserved. */
const LAYERS: Array<1 | 2 | 3 | null> = [null, 3, 2, 1]

/**
 * How many decoded samples a frame of this version and layer carries.
 *
 * Layer III of MPEG-2 and MPEG-2.5 halves it — that is what the low-sampling-frequency extension
 * does — and the halving is the one number here a reader is likely to get wrong quietly: taken as
 * 1152 throughout, a 22.05 kHz file measures out at twice its length and its sound plays under a
 * picture at half speed.
 */
function samplesOf(version: MpegVersion, layer: 1 | 2 | 3): number {
  if (layer === 1) return 384
  if (layer === 2) return 1152
  return version === 1 ? 1152 : 576
}

/**
 * The length of a frame in bytes, out of what its header states.
 *
 * A Layer I frame is counted in slots of four bytes; the other two in single bytes. The padding
 * bit adds one slot, and it is not decoration: at 44.1 kHz no whole number of bytes holds exactly
 * one frame's worth of bits, so the encoder pads roughly every other frame and a reader that
 * ignored the bit would drift a byte at a time until it lost the chain.
 */
function lengthOf(
  version: MpegVersion,
  layer: 1 | 2 | 3,
  bitrate: number,
  sampleRate: number,
  padding: number,
): number {
  if (layer === 1) return (Math.floor((12 * bitrate) / sampleRate) + padding) * 4

  const perFrame = layer === 3 && version !== 1 ? 72 : 144
  return Math.floor((perFrame * bitrate) / sampleRate) + padding
}

/**
 * The frame header standing at `at`, or null when what stands there is not one.
 *
 * Eleven bits of sync and then every field packed against the next. Everything the specification
 * marks reserved or forbidden is refused rather than guessed at: a reserved value in a header is
 * a header this is not looking at, and the whole safety of walking a stream with no index in it
 * rests on saying so instead of carrying on.
 */
export function mpegHeaderAt(bytes: Uint8Array, at: number): MpegHeader | null {
  if (at < 0 || at + 4 > bytes.byteLength) return null

  const one = bytes[at]!
  const two = bytes[at + 1]!
  // Eleven bits and not ten: 0xFFE0 is the sync word, and 0xFFC0 — ten bits — is a JPEG marker.
  if (one !== 0xff || (two & 0xe0) !== 0xe0) return null

  const version = VERSIONS[(two >> 3) & 0b11]
  const layer = LAYERS[(two >> 1) & 0b11]
  if (!version || !layer) return null

  const three = bytes[at + 2]!
  const bitrateIndex = (three >> 4) & 0b1111
  const rateIndex = (three >> 2) & 0b11
  if (rateIndex === 0b11) return null
  // Index 0 is the free bitrate, whose frames state no length; index 15 is forbidden outright.
  if (bitrateIndex === 0 || bitrateIndex === 0b1111) return null

  const table = BITRATES[`${version === 1 ? 1 : 2}-${layer === 1 ? 1 : version === 1 ? layer : 2}`]
  const bitrate = (table?.[bitrateIndex] ?? 0) * 1000
  const sampleRate = SAMPLE_RATES[version][rateIndex] ?? 0
  if (!bitrate || !sampleRate) return null

  const padding = (three >> 1) & 1
  const length = lengthOf(version, layer, bitrate, sampleRate, padding)
  if (length <= 4) return null

  return {
    version,
    layer,
    bitrate,
    sampleRate,
    // Mode 11 is single channel; the other three — stereo, joint stereo, dual mono — are two.
    channels: ((bytes[at + 3]! >> 6) & 0b11) === 0b11 ? 1 : 2,
    length,
    samples: samplesOf(version, layer),
  }
}

/**
 * How many bytes of ID3v2 tag stand in front of the first frame; zero when none do.
 *
 * Every encoder writes one and ffmpeg writes 45 bytes of it. The size is stated seven bits to a
 * byte — "syncsafe", so that no byte of it can be mistaken for a sync word — and read as an
 * ordinary big-endian number a tag of 128 bytes measures out at 256, which puts the walk into the
 * middle of the second frame and ends it there.
 */
export function id3Length(bytes: Uint8Array): number {
  if (bytes.byteLength < 10) return 0
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0

  const size =
    ((bytes[6]! & 0x7f) << 21) |
    ((bytes[7]! & 0x7f) << 14) |
    ((bytes[8]! & 0x7f) << 7) |
    (bytes[9]! & 0x7f)

  // Bit 4 of the flags says a footer of ten more bytes closes the tag behind its frames.
  const footer = bytes[5]! & 0x10 ? 10 : 0
  return 10 + size + footer
}

/** Bytes of side information between the header and the payload, by version and channel count. */
function sideInfoBytes(version: MpegVersion, channels: number): number {
  if (version === 1) return channels === 1 ? 17 : 32
  return channels === 1 ? 9 : 17
}

/** 'Xing' and 'Info' — the tag of a header frame, at the offset the side information ends at. */
const XING = [
  [0x58, 0x69, 0x6e, 0x67],
  [0x49, 0x6e, 0x66, 0x6f],
]

/** 'VBRI' — the older Fraunhofer tag, which stands at a fixed offset instead. */
const VBRI = [0x56, 0x42, 0x52, 0x49]

const tagAt = (bytes: Uint8Array, at: number, tags: number[][]): boolean =>
  tags.some((tag) => tag.every((byte, i) => bytes[at + i] === byte))

/**
 * Samples every MP3 decoder throws away before the first one it puts out.
 *
 * A property of the format and not of any file: the synthesis filter bank of Layer III runs 529
 * samples behind its input, and every decoder there is comes out of the first frame that much
 * late. An encoder states its own delay on top of this, and the two are trimmed together.
 */
export const DECODER_DELAY_SAMPLES = 529

/** What the header frame at the front of a stream says, when there is one. */
export interface HeaderFrame {
  /**
   * Samples of silence at the head of the material, which a player throws away.
   *
   * The encoder's own delay as the LAME extension states it, plus the decoder delay above. It is
   * the counterpart of the priming an AAC track hides in its edit list and of the pre-skip of an
   * Opus one, and it is the same size: 1105 samples, 25.1 ms, measured on this repository's
   * fixture against ffmpeg's own decode of the same file.
   *
   * Zero when the frame states no delay. A stream with no LAME extension is played untrimmed, and
   * hiding a head that the browser does not hide would put our sound 12 ms the other way.
   */
  skipSamples: number
}

/**
 * The frame at `at` read as the encoder's header frame, or null when it is ordinary sound.
 *
 * An encoder writes the length of the file and a seek table into the payload of a frame at the
 * very front, and that frame decodes to silence. It is a frame in every formal sense — the walk
 * steps over it by its stated length like any other — and it is not material: counted in, it puts
 * 26 ms of nothing at the head of every clip taken from the track and moves the sound that far
 * away from the picture it was cut against.
 *
 * The tag sits behind the side information, whose length depends on the version and the channel
 * count, and behind the two bytes of checksum where the frame carries one. The older Fraunhofer
 * tag stands at a fixed offset instead. Both places are looked at, because getting it wrong in
 * either direction is silent: a tag missed is silence at the head, and an ordinary frame mistaken
 * for one is a frame of sound dropped.
 */
export function headerFrameAt(
  bytes: Uint8Array,
  at: number,
  header: MpegHeader,
): HeaderFrame | null {
  const crc = 4 + ((bytes[at + 1]! & 1) === 0 ? 2 : 0)
  const xing = at + crc + sideInfoBytes(header.version, header.channels)

  if (tagAt(bytes, xing, XING)) return { skipSamples: lameDelayAt(bytes, xing) }
  // VBRI states no encoder delay at all; what is left is the delay of the format itself.
  if (tagAt(bytes, at + 4 + 32, [VBRI])) return { skipSamples: DECODER_DELAY_SAMPLES }

  return null
}

/**
 * The delay the LAME extension of a Xing frame states, with the decoder's own added to it.
 *
 * The extension stands behind whichever of the four optional Xing fields the flags word says are
 * present, and the delay is twelve bits at a fixed offset inside it. Measured on the fixture:
 * 576 samples of encoder delay, which with the 529 of the format is the 1105 the file plays
 * behind its own zero.
 *
 * Zero when there is no extension there to read — a Xing frame with no LAME tag behind it, or a
 * buffer that ends inside one.
 */
function lameDelayAt(bytes: Uint8Array, xing: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (xing + 8 > bytes.byteLength) return 0

  const flags = view.getUint32(xing + 4)
  let at = xing + 8
  if (flags & 0x01) at += 4 // frames
  if (flags & 0x02) at += 4 // bytes
  if (flags & 0x04) at += 100 // the seek table
  if (flags & 0x08) at += 4 // quality

  // Nine bytes of encoder name, then twelve fields of the extension, then the delay: three bytes
  // holding two twelve-bit numbers, the delay in front and the padding behind it.
  const delayAt = at + 21
  if (delayAt + 3 > bytes.byteLength) return 0

  const delay = (bytes[delayAt]! << 4) | (bytes[delayAt + 1]! >> 4)
  // A number no encoder writes: the field is not a LAME extension but whatever else lay there.
  if (delay <= 0 || delay > 3000) return 0

  return delay + DECODER_DELAY_SAMPLES
}

/** One coded frame of the stream, addressed where it lies in the file. */
export interface MpegFrame {
  source: Located
  /** Decoded samples it carries, in the sampling rate of the stream. */
  samples: number
}

export interface MpegWalk {
  frames: MpegFrame[]
  /**
   * Samples of the first frames that are not sound; see `HeaderFrame.skipSamples`.
   *
   * Zero where the stream carries no header frame to state it. It is hidden by an edit list and
   * not thrown away, which is what the ISO BMFF convention is for: the samples are decoded and
   * the presentation begins behind them.
   */
  skipSamples: number
  /**
   * Where the walk stopped, counted from the first byte of the file.
   *
   * The head of the next frame when the buffer ran out in the middle of one, and where the sound
   * ends when it ran out of frames. Either way it is where a reader with more of the file in hand
   * has to begin, and it is the whole of what a windowed walk carries from one window to the next.
   */
  at: number
  sampleRate: number
  channels: number
  version: MpegVersion
}

/**
 * Walks the frames of a buffer, from `from` inside it, addressing them from `base`.
 *
 * `base` is where the buffer's first byte lies in the file: a window read part way in still has
 * to address its frames where they actually are, because a save fetches them by those addresses.
 *
 * The walk ends at the first thing that is not a frame of the same stream — an ID3v1 tag at the
 * tail, a truncated window, a header stating another sampling rate. It does not search for the
 * next sync word: the chain is what makes an index of a container with no index trustworthy, and
 * a reader that resynchronised would happily walk into the payload of a frame and describe the
 * bytes it found there as sound.
 */
export function walkMpegFrames(
  bytes: Uint8Array,
  from: number,
  base: number,
  /**
   * `head: false` — this buffer continues a stream whose front was walked already, so the frame
   * it begins with is ordinary sound and not the encoder's header frame.
   */
  options: { head?: boolean } = {},
): MpegWalk {
  const frames: MpegFrame[] = []
  let at = from
  let sampleRate = 0
  let channels = 0
  let version: MpegVersion = 1
  let skipSamples = 0
  let first = true

  for (;;) {
    const header = mpegHeaderAt(bytes, at)
    if (!header) break
    // Half a frame in the window is not a frame: an index over it would address bytes that the
    // next window holds and this one has not seen.
    if (at + header.length > bytes.byteLength) break

    // The first frame settles what the stream is; a frame that disagrees is where it ends. One
    // mp4 track states one sampling rate and one channel count, and a stream that changes either
    // half way cannot be described by one — nor is it a thing any encoder in the wild writes.
    if (!sampleRate) {
      sampleRate = header.sampleRate
      channels = header.channels
      version = header.version
    } else if (header.sampleRate !== sampleRate || header.channels !== channels) {
      break
    }

    // Only the very first frame of the stream can be the encoder's, and only there is it looked
    // for: four letters found in the payload of an ordinary frame further in would take a frame
    // of sound out of the middle of the track.
    const head = first && options.head !== false ? headerFrameAt(bytes, at, header) : null
    first = false

    if (head) skipSamples = head.skipSamples
    else frames.push({ source: { at: base + at, length: header.length }, samples: header.samples })

    at += header.length
  }

  return { frames, at: base + at, sampleRate, channels, version, skipSamples }
}
