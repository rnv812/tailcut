/**
 * EBML — the element grammar WebM and Matroska are written in.
 *
 * Shaped after the ISO BMFF reader next door on purpose: a flat list of elements at one level,
 * a descent into the containers, a lookup by path, a body without its header. The two containers
 * are read the same way from the outside, and the code above them does not have to learn a second
 * idiom to reach the second half of what a page delivers.
 *
 * Where the two grammars differ is the header. A box states four bytes of size and four of type;
 * an EBML element states a variable-length id and a variable-length size, and the size may be
 * written as "unknown" — the element then runs until something appears that cannot belong to it.
 *
 * The bytes come from a foreign page, so nothing here throws and nothing here loops: every header
 * is at least two bytes wide, so each turn of a scan moves strictly forward, and an element whose
 * body does not fit the range being read ends the scan instead of extending it.
 */

/** One EBML element found in a buffer. The counterpart of Box in the ISO BMFF reader. */
export interface Element {
  /** Element id with its length marker bits, exactly as the bytes spell it: Segment is 0x18538067. */
  id: number
  /** Offset of the first byte of the id within the buffer. */
  start: number
  /** Full size of the element, its header included. */
  size: number
  /** Bytes of id and size taken together: 2 at the least, 12 at the most. */
  headerSize: number
  /** The size was the reserved "unknown" value; `size` is where the scan decided the element ends. */
  unknownSize: boolean
}

/**
 * The ids this reader knows by name. Everything else is still walked over — an unknown element is
 * skipped by its own stated size — but only the ones listed here take part in descending into
 * containers and in ending an element of unknown size.
 */
export const ID = {
  ebml: 0x1a45dfa3,
  docType: 0x4282,

  segment: 0x18538067,

  seekHead: 0x114d9b74,
  seek: 0x4dbb,

  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  duration: 0x4489,

  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackUid: 0x73c5,
  trackType: 0x83,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  codecDelay: 0x56aa,
  seekPreRoll: 0x56bb,
  defaultDuration: 0x23e383,

  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,

  audio: 0xe1,
  samplingFrequency: 0xb5,
  channels: 0x9f,
  bitDepth: 0x6264,

  contentEncodings: 0x6d80,
  contentEncoding: 0x6240,

  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
  referenceBlock: 0xfb,

  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTrackPositions: 0xb7,

  chapters: 0x1043a770,
  tags: 0x1254c367,
  tag: 0x7373,
  targets: 0x63c0,
  simpleTag: 0x67c8,
  attachments: 0x1941a469,

  void: 0xec,
  crc32: 0xbf,
} as const

/** Master elements: the ones whose body is a run of further elements rather than a value. */
const MASTERS = new Set<number>([
  ID.ebml, ID.segment, ID.seekHead, ID.seek, ID.info, ID.tracks, ID.trackEntry,
  ID.video, ID.audio, ID.contentEncodings, ID.contentEncoding,
  ID.cluster, ID.blockGroup, ID.cues, ID.cuePoint, ID.cueTrackPositions,
  ID.chapters, ID.tags, ID.tag, ID.targets, ID.simpleTag, ID.attachments,
])

/**
 * Nesting depth of the ids that have a fixed place in the tree. Only used to end an element whose
 * size was written as unknown: such an element runs until an element appears that sits at its own
 * depth or above it — the next Cluster ends the previous one, Tracks ends a Cluster, another
 * Segment ends a Segment.
 *
 * Void and CRC-32 are missing from the table deliberately: they are allowed at every depth, so
 * they must never be taken for the start of the next element.
 */
const LEVELS = new Map<number, number>([
  [ID.ebml, 0], [ID.segment, 0],

  [ID.seekHead, 1], [ID.info, 1], [ID.tracks, 1], [ID.cluster, 1],
  [ID.cues, 1], [ID.chapters, 1], [ID.tags, 1], [ID.attachments, 1],

  [ID.timestamp, 2], [ID.simpleBlock, 2], [ID.blockGroup, 2],
  [ID.trackEntry, 2], [ID.cuePoint, 2], [ID.tag, 2], [ID.seek, 2],

  [ID.block, 3], [ID.blockDuration, 3], [ID.referenceBlock, 3],
])

/** A variable-length integer as it lies in the bytes. */
export interface Vint {
  /** The value the data bits spell, marker bit stripped. */
  value: number
  /** Bytes the number occupies, 1 to 8. */
  length: number
  /** Every data bit is set — for a size that is the reserved "unknown length". */
  allOnes: boolean
}

/**
 * Reads a variable-length integer at `at`. Returns null when there is no readable number there:
 * a leading zero byte (the length marker would run past eight bytes), a length above `maxLength`,
 * or a number that reaches past `end`.
 *
 * Values are accumulated by multiplication rather than by shifting: an eight-byte size does not
 * fit in the 32 bits a bitwise operator works in, and a shifted read would silently wrap.
 */
export function readVint(
  data: Uint8Array,
  at: number,
  end: number = data.byteLength,
  maxLength = 8,
): Vint | null {
  if (at < 0 || at >= end) return null

  const first = data[at]!

  // The width is written as the position of the first set bit. A byte with no bit set at all is a
  // width beyond the eight bytes EBML allows, and the mask running off the end is what says so —
  // the loop is bounded by the mask itself rather than by a guard that could be dropped.
  let length = 1
  let mask = 0x80
  while (mask !== 0 && (first & mask) === 0) {
    mask >>= 1
    length++
  }

  if (mask === 0 || length > maxLength || at + length > end) return null

  let value = first & (mask - 1)
  let allOnes = value === mask - 1

  for (let i = 1; i < length; i++) {
    const byte = data[at + i]!
    value = value * 256 + byte
    if (byte !== 0xff) allOnes = false
  }

  return { value, length, allOnes }
}

/** Reads an element id at `at`: the raw bytes, marker bits kept, so 0x1a45dfa3 stays itself. */
function readId(data: Uint8Array, at: number, end: number): { id: number; length: number } | null {
  if (at < 0 || at >= end) return null

  const first = data[at]!

  // Bounded by the mask, exactly as in readVint above: a zero byte runs it off the end and the
  // id is refused rather than read.
  let length = 1
  let mask = 0x80
  while (mask !== 0 && (first & mask) === 0) {
    mask >>= 1
    length++
  }

  // An id is four bytes at the most, which is narrower than the eight a size may take.
  if (mask === 0 || length > 4 || at + length > end) return null

  let id = 0
  for (let i = 0; i < length; i++) id = id * 256 + data[at + i]!

  return { id, length }
}

/**
 * Where an element of unknown size ends: at the first element from `from` onwards that sits at
 * the depth of `parentId` or above it, and at `to` when no such element turns up.
 *
 * An id the level table does not know is walked over as a child. An element of unknown size met
 * on the way is stepped into rather than over — its own end is decided by this very scan, so its
 * children continue the same walk.
 */
function unknownSizeEnd(data: Uint8Array, from: number, to: number, parentId: number): number {
  const parentLevel = LEVELS.get(parentId)
  // An id with no place in the table says nothing about what may follow it: the only honest end
  // is the end of the range.
  if (parentLevel === undefined) return to

  let offset = from

  while (offset < to) {
    const id = readId(data, offset, to)
    if (!id) return to

    const size = readVint(data, offset + id.length, to)
    if (!size) return to

    const level = LEVELS.get(id.id)
    if (level !== undefined && level <= parentLevel) return offset

    // Step into a nested unknown size instead of over it, and keep scanning from its first child.
    if (size.allOnes) {
      offset += id.length + size.length
      continue
    }

    const next = offset + id.length + size.length + size.value
    if (next > to) return to
    offset = next
  }

  return to
}

function readElementAt(data: Uint8Array, at: number, to: number): Element | null {
  const id = readId(data, at, to)
  if (!id) return null

  const size = readVint(data, at + id.length, to)
  if (!size) return null

  const headerSize = id.length + size.length

  if (size.allOnes) {
    const end = unknownSizeEnd(data, at + headerSize, to, id.id)
    return { id: id.id, start: at, size: end - at, headerSize, unknownSize: true }
  }

  if (size.value > to - at - headerSize) {
    // The body has to lie inside the range being read, whole. Reading half an element would hand
    // out a truncated body as if it were complete.
    //
    // One element is exempt, and it is the one a live stream is delivered inside of: the Segment
    // wraps the whole recording and states its length before any of it has been written. A page
    // is handed that stream a piece at a time, so the Segment always outruns the bytes in hand,
    // and refusing it would hide the Tracks that have already arrived within it. It is cut back
    // to what is here; every child is still measured against its own stated length, so nothing
    // truncated is handed out as whole.
    if (id.id !== ID.segment) return null
    return { id: id.id, start: at, size: to - at, headerSize, unknownSize: false }
  }

  return { id: id.id, start: at, size: headerSize + size.value, headerSize, unknownSize: false }
}

function readElementsIn(data: Uint8Array, from: number, to: number): Element[] {
  const elements: Element[] = []
  let offset = from

  while (offset < to) {
    const element = readElementAt(data, offset, to)
    if (!element) break

    elements.push(element)
    // headerSize is two bytes at the least and size is never below it, so the offset always grows
    // and the walk always ends.
    offset = element.start + element.size
  }

  return elements
}

export function topLevelElements(data: Uint8Array): Element[] {
  return readElementsIn(data, 0, data.byteLength)
}

export function childElements(data: Uint8Array, parent: Element): Element[] {
  if (!MASTERS.has(parent.id)) return []
  return readElementsIn(data, parent.start + parent.headerSize, parent.start + parent.size)
}

/** Follows a path of ids from the top level down, returning the leaf. */
export function findElement(data: Uint8Array, path: number[]): Element | null {
  let level = topLevelElements(data)
  let found: Element | null = null

  for (const want of path) {
    found = level.find((e) => e.id === want) ?? null
    if (!found) return null
    level = childElements(data, found)
  }

  return found
}

/** The element's body, its header cut off. A view into the same buffer, not a copy. */
export function elementBody(data: Uint8Array, element: Element): Uint8Array {
  return data.subarray(element.start + element.headerSize, element.start + element.size)
}

/** Children of `parent` carrying the given id, in the order they lie in the buffer. */
export function childrenWithId(data: Uint8Array, parent: Element, id: number): Element[] {
  return childElements(data, parent).filter((e) => e.id === id)
}

/** The first child of `parent` carrying the given id. */
export function childWithId(data: Uint8Array, parent: Element, id: number): Element | undefined {
  return childElements(data, parent).find((e) => e.id === id)
}

/**
 * An unsigned integer, big-endian, as EBML writes them: any width from zero to eight bytes, an
 * empty body meaning zero. A body wider than eight bytes is not an integer at all and reads as
 * zero rather than as a wrapped-around number.
 */
export function readUint(body: Uint8Array): number {
  if (body.byteLength > 8) return 0

  let value = 0
  for (const byte of body) value = value * 256 + byte
  return value
}

/** A signed integer, big-endian, two's complement over the width the body happens to have. */
export function readInt(body: Uint8Array): number {
  if (body.byteLength === 0 || body.byteLength > 8) return 0

  let value = readUint(body)
  const limit = 2 ** (8 * body.byteLength - 1)
  if (value >= limit) value -= limit * 2
  return value
}

/**
 * A float, which EBML writes as four bytes or as eight. An empty body is zero, as it is for the
 * integers; any other width is not a float and reads as zero, so a broken SamplingFrequency ends
 * up at a value the caller can reject rather than at NaN spreading through the arithmetic above.
 */
export function readFloat(body: Uint8Array): number {
  if (body.byteLength === 0) return 0
  if (body.byteLength !== 4 && body.byteLength !== 8) return 0

  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  return body.byteLength === 4 ? view.getFloat32(0) : view.getFloat64(0)
}

/**
 * A string. Matroska pads a fixed-width string with zero bytes, so the value ends at the first of
 * them. The bytes are taken one to one as code points: the ids this reader cares about — CodecID,
 * DocType — are ASCII by specification.
 */
export function readString(body: Uint8Array): string {
  let end = body.byteLength
  for (let i = 0; i < body.byteLength; i++) {
    if (body[i] === 0) {
      end = i
      break
    }
  }

  let text = ''
  for (let i = 0; i < end; i++) text += String.fromCharCode(body[i]!)
  return text
}
