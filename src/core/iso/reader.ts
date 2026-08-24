export interface Box {
  type: string
  /** смещение начала бокса в буфере */
  start: number
  /** полный размер бокса вместе с заголовком */
  size: number
  /** 8 для обычного заголовка, 16 для 64-битного */
  headerSize: number
}

/** Боксы-контейнеры, у которых сразу за заголовком идут дочерние боксы. */
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

    // size < headerSize — тело отрицательной длины; next > to — бокс не влезает
    // в разбираемый диапазон (тело родителя, а не конец буфера).
    // Первая проверка попутно гарантирует size >= headerSize >= 8, то есть
    // offset на каждой итерации строго растёт и цикл не может зациклиться.
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

/** Содержимое бокса без заголовка. */
export function boxBody(data: Uint8Array, box: Box): Uint8Array {
  return data.subarray(box.start + box.headerSize, box.start + box.size)
}
