import { boxBody, boxesIn } from '../iso/reader'

/**
 * How the decoder is configured for material this program recorded, out of the bytes that
 * describe it.
 *
 * The recording carries its own account of itself — an `avcC`, an `hvcC`, a `vpcC`, an `av1C`
 * inside the sample entry — and a decoder wants two things out of it: the codec string, which is
 * a summary of the profile and level, and the `description`, which is the record itself. Both
 * come from here and from nowhere else, so the two cannot come to describe different streams.
 *
 * Null for an entry with no configuration this program knows. It should be unreachable — every
 * picture codec the recorder admits is in the table below — and it is an answer rather than a
 * throw because it is asked while a panel is being drawn.
 */
export function decoderConfigOf(sampleEntry: Uint8Array): VideoDecoderConfig | null {
  const entry = boxesIn(sampleEntry, 0, sampleEntry.byteLength)[0]
  if (!entry) return null

  const view = new DataView(sampleEntry.buffer, sampleEntry.byteOffset + entry.start, entry.size)
  const children = new Map<string, Uint8Array>()
  // 86 bytes of VisualSampleEntry fields stand in front of the children; the same number
  // src/core/iso/entry.ts counts, and for the same reason: it is the sum of the fields
  // ISO/IEC 14496-12 lists.
  for (const child of boxesIn(sampleEntry, entry.start + 86, entry.start + entry.size)) {
    if (!children.has(child.type)) children.set(child.type, boxBody(sampleEntry, child))
  }

  const size = { codedWidth: view.getUint16(32), codedHeight: view.getUint16(34) }

  const avcC = children.get('avcC')
  if (avcC && avcC.byteLength >= 4) {
    // `avc1` and `avc3` differ in where the parameter sets live and not in how they are read, so
    // the four letters of the entry are the four letters of the string.
    return { codec: `${entry.type}.${hex(avcC[1]!)}${hex(avcC[2]!)}${hex(avcC[3]!)}`, description: avcC, ...size }
  }

  const hvcC = children.get('hvcC')
  if (hvcC && hvcC.byteLength >= 13) {
    return { codec: `${entry.type}.${hevcString(hvcC)}`, description: hvcC, ...size }
  }

  const vpcC = children.get('vpcC')
  if (vpcC && vpcC.byteLength >= 7) {
    // A vpcC is a full box: version and flags come first, and the record starts at byte four.
    // VP9 takes no description at all — Chrome refuses a configuration carrying an empty one —
    // and VP8 has no parameters to state, so it is the bare word the specification gives it.
    if (entry.type === 'vp08') return { codec: 'vp8', ...size }
    return { codec: `vp09.${pad(vpcC[4]!)}.${pad(vpcC[5]!)}.${pad(vpcC[6]! >> 4)}`, ...size }
  }

  const av1C = children.get('av1C')
  if (av1C && av1C.byteLength >= 3) {
    const profile = (av1C[1]! >> 5) & 0x07
    const level = av1C[1]! & 0x1f
    const tier = (av1C[2]! >> 7) & 1 ? 'H' : 'M'
    // high_bitdepth and twelve_bit together, as the string spells the depth.
    const twelve = (av1C[2]! >> 5) & 1
    const high = (av1C[2]! >> 6) & 1
    const depth = twelve ? 12 : high ? 10 : 8
    return { codec: `av01.${profile}.${pad(level)}${tier}.${pad(depth)}`, description: av1C, ...size }
  }

  return null
}

/** The sample-entry code, such as `avc1`, `vp09`, or `av01`, used for codec warnings. */
export function sampleEntryFormat(sampleEntry: Uint8Array): string {
  return boxesIn(sampleEntry, 0, sampleEntry.byteLength)[0]?.type ?? ''
}

const hex = (byte: number): string => byte.toString(16).padStart(2, '0')
const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * The `A.B.C.D` of an `hvc1` string, out of an HEVCDecoderConfigurationRecord.
 *
 * Four fields with four different spellings, and every one of them is in RFC 6381 rather than
 * invented here: the profile space as a letter, the compatibility flags in hexadecimal with the
 * bit order **reversed**, the tier as `L` or `H` in front of the level, and the six constraint
 * bytes with the trailing zeroes left off. A string that gets any of them wrong is a string some
 * player will read and refuse.
 */
function hevcString(record: Uint8Array): string {
  const space = (record[1]! >> 6) & 0x03
  const tier = (record[1]! >> 5) & 0x01
  const profile = record[1]! & 0x1f

  let flags = 0
  for (let at = 2; at <= 5; at++) flags = (flags << 8) | record[at]!
  let reversed = 0
  for (let bit = 0; bit < 32; bit++) reversed = (reversed << 1) | ((flags >>> bit) & 1)

  const constraints: string[] = []
  for (let at = 6; at <= 11; at++) constraints.push(hex(record[at]!))
  while (constraints.length && constraints[constraints.length - 1] === '00') constraints.pop()

  return [
    `${['', 'A', 'B', 'C'][space]}${profile}`,
    (reversed >>> 0).toString(16),
    `${tier ? 'H' : 'L'}${record[12]!}`,
    ...constraints,
  ].join('.')
}
