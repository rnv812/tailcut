export interface Box {
  type: string
  /** Offset of the box start within the buffer. */
  start: number
  /** Full box size, including its header. */
  size: number
  /** 8 for a regular header, 16 for a 64-bit header. */
  headerSize: number
}

/** Container boxes whose child boxes begin immediately after the header. */
const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'dinf',
])

/**
 * The boxes lying end to end in a range of the buffer.
 *
 * Exported because two of the places that need it are not containers in the sense the reader
 * knows: an stsd states a version and an entry count in front of its children, and a sample entry
 * a whole run of fields. Neither can be added to CONTAINERS — childBoxes would read those fields
 * as a box header — so the caller states where the children start and reads them out itself.
 */
export function boxesIn(data: Uint8Array, from: number, to: number): Box[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const boxes: Box[] = []
  let offset = from

  while (offset + 8 <= to) {
    let size = view.getUint32(offset)
    let headerSize = 8
    const type = String.fromCharCode(
      data[offset + 4]!, data[offset + 5]!, data[offset + 6]!, data[offset + 7]!,
    )

    if (size === 1) {
      if (offset + 16 > to) break
      const large = view.getBigUint64(offset + 8)
      size = Number(large)
      headerSize = 16
    } else if (size === 0) {
      size = to - offset
    }

    // size < headerSize means a negative-length body; next > to means the box does not fit in
    // the range being parsed, which is the parent body rather than necessarily the buffer end.
    // The first check also guarantees size >= headerSize >= 8, so offset strictly increases on
    // every iteration and the loop cannot stall.
    const next = offset + size
    if (size < headerSize || next > to) break

    boxes.push({ type, start: offset, size, headerSize })
    offset = next
  }

  return boxes
}

export function topLevelBoxes(data: Uint8Array): Box[] {
  return boxesIn(data, 0, data.byteLength)
}

export function childBoxes(data: Uint8Array, parent: Box): Box[] {
  if (!CONTAINERS.has(parent.type)) return []
  return boxesIn(data, parent.start + parent.headerSize, parent.start + parent.size)
}

export function findBox(data: Uint8Array, path: string[]): Box | null {
  let level = topLevelBoxes(data)
  let found: Box | null = null

  for (const want of path) {
    found = level.find((b) => b.type === want) ?? null
    if (!found) return null
    level = childBoxes(data, found)
  }

  return found
}

/** Box contents without the header. */
export function boxBody(data: Uint8Array, box: Box): Uint8Array {
  return data.subarray(box.start + box.headerSize, box.start + box.size)
}
