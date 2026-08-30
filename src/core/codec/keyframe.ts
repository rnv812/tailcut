import { decoderConfigOf, sampleEntryFormat } from '../encode/decoder'

/** `null` means the coded bytes did not carry enough information to overrule the container. */
export type KeyframeClassifier = (bytes: Uint8Array) => boolean | null

/**
 * The random-access bit of a coded video sample, read from the coded sample itself.
 *
 * `sample_flags` may legally leave dependency unknown. Treating that zero as “key” produces an
 * `EncodedVideoChunk` which Chrome rejects after checking the bitstream. The bitstream is the
 * authority for the AVC and AV1 streams this fallback covers; an unreadable sample falls back to
 * the container instead of being invented as either kind.
 */
export function keyframeClassifier(sampleEntry: Uint8Array): KeyframeClassifier | null {
  const format = sampleEntryFormat(sampleEntry)
  const description = decoderConfigOf(sampleEntry)?.description
  const record =
    description instanceof Uint8Array
      ? description
      : description
        ? new Uint8Array(description as ArrayBuffer)
        : null

  if ((format === 'avc1' || format === 'avc3') && record && record.byteLength >= 5) {
    const lengthBytes = (record[4]! & 0x03) + 1
    return (bytes) => lengthPrefixedKey(bytes, lengthBytes, (head) => (head & 0x1f) === 5)
  }

  if ((format === 'hvc1' || format === 'hev1') && record && record.byteLength >= 22) {
    const lengthBytes = (record[21]! & 0x03) + 1
    return (bytes) =>
      lengthPrefixedKey(bytes, lengthBytes, (head) => {
        const nalType = (head >> 1) & 0x3f
        return nalType >= 16 && nalType <= 23
      })
  }

  if (format === 'av01') {
    let reducedHeader = record ? reducedStillPictureHeader(record.subarray(4)) : null
    return (bytes) => {
      const judged = av1Keyframe(bytes, reducedHeader)
      if (judged.reduced !== null) reducedHeader = judged.reduced
      return judged.key
    }
  }

  if (format === 'vp09') return vp9Keyframe

  return null
}

/** VP9 uncompressed header, whose fixed fields lead every coded frame. */
function vp9Keyframe(bytes: Uint8Array): boolean | null {
  const bits = new Av1Bits(bytes)
  if (bits.read(2) !== 2) return null

  const profileLow = bits.read(1)
  const profileHigh = bits.read(1)
  if (profileLow < 0 || profileHigh < 0) return null
  const profile = profileLow | (profileHigh << 1)
  if (profile === 3 && bits.read(1) !== 0) return null

  const showExisting = bits.read(1)
  if (showExisting < 0) return null
  if (showExisting === 1) return false

  const frameType = bits.read(1)
  return frameType < 0 ? null : frameType === 0
}

/** Walk AVC/HEVC length-prefixed NAL units and ask whether any is an intra random-access unit. */
function lengthPrefixedKey(
  bytes: Uint8Array,
  lengthBytes: number,
  key: (nalHead: number) => boolean,
): boolean | null {
  let at = 0
  let sawNal = false

  while (at + lengthBytes <= bytes.byteLength) {
    let size = 0
    for (let i = 0; i < lengthBytes; i++) size = size * 256 + bytes[at + i]!
    at += lengthBytes
    if (size === 0) continue
    if (at + size > bytes.byteLength) return null

    sawNal = true
    if (key(bytes[at]!)) return true
    at += size
  }

  return sawNal && at === bytes.byteLength ? false : null
}

interface Obu {
  type: number
  payload: Uint8Array
}

/** AV1 low-overhead OBU stream, used both by av1C configOBUs and by ISO samples. */
function obus(bytes: Uint8Array): Obu[] | null {
  const out: Obu[] = []
  let at = 0

  while (at < bytes.byteLength) {
    const header = bytes[at++]!
    if ((header & 0x81) !== 0) return null
    const type = (header >> 3) & 0x0f
    if (header & 0x04) {
      if (at >= bytes.byteLength) return null
      at += 1
    }

    let size: number
    if (header & 0x02) {
      const read = leb128(bytes, at)
      if (!read) return null
      size = read.value
      at = read.next
    } else {
      // Without an explicit size the OBU occupies the rest of this temporal unit.
      size = bytes.byteLength - at
    }
    if (size < 0 || at + size > bytes.byteLength) return null

    out.push({ type, payload: bytes.subarray(at, at + size) })
    at += size
  }

  return out
}

function leb128(bytes: Uint8Array, start: number): { value: number; next: number } | null {
  let value = 0
  let scale = 1

  for (let at = start; at < bytes.byteLength && at < start + 8; at++) {
    const byte = bytes[at]!
    value += (byte & 0x7f) * scale
    if (!Number.isSafeInteger(value)) return null
    if ((byte & 0x80) === 0) return { value, next: at + 1 }
    scale *= 128
  }

  return null
}

/** First five bits of sequence_header_obu: profile, still_picture, reduced_still_picture_header. */
function reducedStillPictureHeader(configObus: Uint8Array): boolean | null {
  const listed = obus(configObus)
  const sequence = listed?.find((obu) => obu.type === 1)
  if (!sequence) return null

  return reducedStillPictureHeaderOf(sequence.payload)
}

function reducedStillPictureHeaderOf(payload: Uint8Array): boolean | null {
  const bits = new Av1Bits(payload)
  if (bits.read(3) < 0 || bits.read(1) < 0) return null
  const reduced = bits.read(1)
  return reduced < 0 ? null : reduced === 1
}

function av1Keyframe(
  bytes: Uint8Array,
  knownReduced: boolean | null,
): { key: boolean | null; reduced: boolean | null } {
  const listed = obus(bytes)
  if (!listed) return { key: null, reduced: knownReduced }

  let reduced = knownReduced
  for (const obu of listed) {
    if (obu.type === 1) reduced = reducedStillPictureHeaderOf(obu.payload)
    if (obu.type !== 3 && obu.type !== 6) continue
    if (reduced === true) return { key: true, reduced }

    const bits = new Av1Bits(obu.payload)
    const showExisting = bits.read(1)
    if (showExisting < 0) return { key: null, reduced }
    if (showExisting === 1) return { key: false, reduced }

    const frameType = bits.read(2)
    return { key: frameType < 0 ? null : frameType === 0, reduced }
  }

  return { key: null, reduced }
}

/** AV1 fixed-width syntax fields are read most-significant bit first. */
class Av1Bits {
  private at = 0

  constructor(private readonly bytes: Uint8Array) {}

  read(count: number): number {
    if (this.at + count > this.bytes.byteLength * 8) return -1
    let value = 0
    for (let bit = 0; bit < count; bit++, this.at++) {
      value = (value << 1) | ((this.bytes[this.at >> 3]! >> (7 - (this.at & 7))) & 1)
    }
    return value
  }
}
