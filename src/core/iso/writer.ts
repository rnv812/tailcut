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
