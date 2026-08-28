import type { SampleEntry } from '../iso/entry'
import { OPUS_SAMPLE_RATE } from '../opus/packets'

/**
 * What an AudioDecoder has to be told. Structurally an `AudioDecoderConfig`, built without
 * touching WebCodecs: the decision is arithmetic over boxes and belongs where it can be tested.
 */
export interface AudioDecoderSetup {
  codec: string
  description?: Uint8Array
  numberOfChannels: number
  sampleRate: number
}

interface Descriptor {
  tag: number
  body: Uint8Array
}

/** One MPEG-4 descriptor: a tag, a length in seven-bit groups, a body. */
function descriptorAt(bytes: Uint8Array, at: number): Descriptor | null {
  if (at >= bytes.length) return null

  const tag = bytes[at]!
  let size = 0
  let cursor = at + 1

  for (let group = 0; group < 4; group++) {
    const byte = bytes[cursor]
    if (byte === undefined) return null
    cursor++
    size = (size << 7) | (byte & 0x7f)
    if (!(byte & 0x80)) break
  }

  const end = cursor + size
  if (end > bytes.length) return null
  return { tag, body: bytes.subarray(cursor, end) }
}

/**
 * The AudioSpecificConfig an esds carries, which is what an AAC decoder cannot work without.
 *
 * Measured: handed a rate and a channel count that do not match the material and no description,
 * Chromium decodes thousands of frames, reports no error, and puts out something whose envelope
 * correlates with the source at 0.037. The description overrides a wrong configuration outright,
 * so it is not an optimisation — it is the difference between sound and rubbish.
 */
export function audioSpecificConfig(esds: Uint8Array): Uint8Array | null {
  // esds is a full box: a version and three bytes of flags in front of the descriptor.
  const es = descriptorAt(esds.subarray(4), 0)
  if (!es || es.tag !== 0x03) return null

  const flags = es.body[2] ?? 0
  let at = 3
  if (flags & 0x80) at += 2 // depends on another stream: its ES_ID
  if (flags & 0x40) at += 1 + (es.body[at] ?? 0) // a URL: a length and that many bytes
  if (flags & 0x20) at += 2 // an OCR stream: its ES_ID

  const decoder = descriptorAt(es.body, at)
  if (!decoder || decoder.tag !== 0x04) return null

  // objectTypeIndication, streamType and buffer size, then two bitrates: thirteen bytes.
  const specific = descriptorAt(decoder.body, 13)
  return specific && specific.tag === 0x05 && specific.body.length ? specific.body : null
}

/** The audio object type, escape form included. */
function objectType(config: Uint8Array): number {
  const first = config[0] ?? 0
  const type = first >> 3
  if (type !== 31) return type
  return 32 + (((first & 0x07) << 3) | ((config[1] ?? 0) >> 5))
}

/**
 * The Opus identification header, built out of the dOps box beside the sample entry.
 *
 * The two hold the same fields and disagree on two points: the box states version 0 where the
 * header states 1, and the box is big-endian where the header — an Ogg header by origin — is
 * little-endian. Handing the box across as it stands leaves the pre-skip at some thousands of
 * samples and the sound starts in the wrong place.
 */
export function opusHeadOf(dOps: Uint8Array): Uint8Array | null {
  if (dOps.length < 11) return null

  const head = new Uint8Array(19 + (dOps.length - 11))
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]) // 'OpusHead'
  head[8] = 1
  head[9] = dOps[1]!
  head[10] = dOps[3]!
  head[11] = dOps[2]!
  head[12] = dOps[7]!
  head[13] = dOps[6]!
  head[14] = dOps[5]!
  head[15] = dOps[4]!
  head[16] = dOps[9]!
  head[17] = dOps[8]!
  head[18] = dOps[10]!
  // The channel mapping table is single bytes throughout: it crosses unchanged.
  if (dOps.length > 11) head.set(dOps.subarray(11), 19)

  return head
}

/** Null means this track cannot be decoded from what the container says, and is left alone. */
export function audioDecoderConfig(entry: SampleEntry): AudioDecoderSetup | null {
  if (!(entry.channels > 0)) return null

  if (entry.format === 'Opus') {
    const dOps = entry.children.get('dOps')
    const head = dOps ? opusHeadOf(dOps) : null
    if (!head) return null
    // Opus decodes to 48 kHz whatever the encoder was fed; the rate it saw lives on in the header.
    return {
      codec: 'opus',
      description: head,
      numberOfChannels: entry.channels,
      sampleRate: OPUS_SAMPLE_RATE,
    }
  }

  if (entry.format === 'mp4a') {
    const esds = entry.children.get('esds')
    const config = esds ? audioSpecificConfig(esds) : null
    if (!config || !(entry.sampleRate > 0)) return null
    return {
      codec: `mp4a.40.${objectType(config)}`,
      description: config,
      numberOfChannels: entry.channels,
      sampleRate: entry.sampleRate,
    }
  }

  return null
}
