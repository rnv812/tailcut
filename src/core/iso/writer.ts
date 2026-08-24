/** Lays buffers end to end into one. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let size = 0
  for (const part of parts) size += part.byteLength

  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }

  return out
}

/**
 * A box: four bytes of size, four of type, then the parts in the order they are given.
 *
 * The size counts the header in — that is how the reader steps from one box to the next, and a
 * size stated without it turns every box after this one into bytes read out of the middle of its
 * neighbour.
 */
export function boxOf(type: string, ...parts: Uint8Array[]): Uint8Array {
  let size = 8
  for (const part of parts) size += part.byteLength

  const header = new Uint8Array(8)
  new DataView(header.buffer).setUint32(0, size)
  for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i)

  return concatBytes([header, ...parts])
}

/**
 * Big-endian integers of a fixed width — the only kind an ISO BMFF box is written out of.
 *
 * Several values at once because that is how the fields of a box come: an mvhd states four
 * consecutive 32-bit numbers, and writing them one call each would bury the shape of the box
 * under the calls.
 */
export function u8(...values: number[]): Uint8Array {
  return Uint8Array.from(values, (value) => value & 0xff)
}

export function u16(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2)
  const view = new DataView(out.buffer)
  for (const [i, value] of values.entries()) view.setUint16(i * 2, value & 0xffff)
  return out
}

export function i16(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2)
  const view = new DataView(out.buffer)
  for (const [i, value] of values.entries()) view.setInt16(i * 2, value)
  return out
}

export function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const view = new DataView(out.buffer)
  for (const [i, value] of values.entries()) view.setUint32(i * 4, value)
  return out
}

/** A 64-bit field: the decode times of a long recording outgrow four bytes. */
export function u64(value: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.max(0, Math.trunc(value))))
  return out
}

/**
 * A signed 64-bit field: the media_time of an edit list, which is a positive offset into the
 * material or −1 for an edit that shows nothing at all. u64 above clamps a negative value to
 * zero, which is right for a decode time and wrong for this.
 */
export function i64(value: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, BigInt(Math.trunc(value)))
  return out
}

/** A run of zero bytes: the reserved fields boxes are full of. */
export function zeroes(count: number): Uint8Array {
  return new Uint8Array(count)
}

/** Four-letter codes and box names — ASCII by specification, one byte a character. */
export function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff)
}

/**
 * A full box: an ordinary box whose body opens with one byte of version and three of flags.
 * Written as one 32-bit field, which is how every reader of them takes it apart again.
 */
export function fullBoxOf(
  type: string,
  version: number,
  flags: number,
  ...parts: Uint8Array[]
): Uint8Array {
  return boxOf(type, u32(((version & 0xff) << 24) | (flags & 0x00ffffff)), ...parts)
}
