import type { SampleEntry } from '../iso/entry'
import { MPEG1_OBJECT_TYPE, MPEG2_OBJECT_TYPE } from '../mpeg/mp4'
import { OPUS_SAMPLE_RATE } from '../opus/packets'
import { VORBIS_OBJECT_TYPE } from '../vorbis/mp4'

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

/** What the DecoderConfigDescriptor of an esds says: which codec, and how to start it. */
interface DecoderConfig {
  /** objectTypeIndication: 0x40 is MPEG-4 audio, 0xDD is the Vorbis convention. */
  objectType: number
  /** The DecoderSpecificInfo behind it, or null where the descriptor carries none. */
  specific: Uint8Array | null
}

/**
 * The decoder configuration an esds carries: the object type, and the setup bytes under it.
 *
 * The object type matters as much as the setup does, and one file in the fixtures is the reason:
 * a Vorbis track inside an mp4 is declared as `mp4a` because Vorbis has no sample entry of its
 * own (src/core/vorbis/mp4.ts), so the four letters of the box say AAC and only this byte says
 * otherwise. Read no further than the letters, the decoder is told to expect AAC and then handed
 * Vorbis codebooks.
 */
function decoderConfigOf(esds: Uint8Array): DecoderConfig | null {
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

  return {
    objectType: decoder.body[0] ?? 0,
    specific: specific && specific.tag === 0x05 && specific.body.length ? specific.body : null,
  }
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
  return decoderConfigOf(esds)?.specific ?? null
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
    const declared = esds ? decoderConfigOf(esds) : null
    if (!declared || !(entry.sampleRate > 0)) return null

    // MPEG-1 or MPEG-2 audio — an mp3, which is how the soundtrack of a page that plays its sound
    // apart arrives (§5.6, src/core/mpeg/frames.ts). It is the one codec here with nothing to set
    // up: every field a decoder needs stands in the header of every frame, so the descriptor
    // carries no DecoderSpecificInfo, and the refusal below would throw the track away for the
    // absence of a thing it never has. Chromium names the codec `mp3` and decodes it.
    //
    // No consumer reaches this branch today, and it is here all the same because the question
    // this function answers is what an AudioDecoder has to be told about a sample entry, and
    // "nothing can be told about this one" is the wrong answer for an entry that describes itself
    // completely. The one caller is the waveform worker, and it is handed the sound of a
    // recording only where the sound sits in a track of its own (`materialOf`); a clip made of a
    // complete file states both kinds in one movie box and reaches it as a picture. Should that
    // change, this track draws its wave instead of the inspector saying it cannot be decoded.
    if (
      declared.objectType === MPEG1_OBJECT_TYPE ||
      declared.objectType === MPEG2_OBJECT_TYPE
    ) {
      return { codec: 'mp3', numberOfChannels: entry.channels, sampleRate: entry.sampleRate }
    }

    if (!declared.specific) return null

    // Vorbis under an mp4a, which is the only place an mp4 has for it. The description is the
    // three setup headers exactly as the Matroska carried them, which is the form Chromium asks
    // for: measured, `AudioDecoder.isConfigSupported` answers true for this pair and refuses the
    // same codec with no description at all.
    if (declared.objectType === VORBIS_OBJECT_TYPE) {
      return {
        codec: 'vorbis',
        description: declared.specific,
        numberOfChannels: entry.channels,
        sampleRate: entry.sampleRate,
      }
    }

    return {
      codec: `mp4a.40.${objectType(declared.specific)}`,
      description: declared.specific,
      numberOfChannels: entry.channels,
      sampleRate: entry.sampleRate,
    }
  }

  return null
}
