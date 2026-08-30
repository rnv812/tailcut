import type { RangeReader } from '../iso/locate'
import type { Located } from '../../shared/types'
import { ID, childElements, elementBody, readUint, readVint, type Element } from './reader'
import type { FoundSegment } from './locate'

/**
 * Walking the material of a whole Matroska by ranges, and writing down where every frame lies.
 *
 * This is the half of reading a complete file that an mp4 does not need. There, the six tables of
 * a `moov` describe every sample of every track, and locating that box is the whole job: a few
 * kilobytes fetched, and the file is indexed without a byte of material touched. A Matroska has
 * no such table. The only description of a frame is the block header immediately in front of it,
 * and the Cues are an index of keyframes to seek by — where a cluster begins, and not a word
 * about how many frames are in it, how long they last or what they weigh.
 *
 * So the clusters are walked, and walking them means fetching them. That is the honest cost of
 * the container and it is stated here rather than hidden: opening an ordinary mp4 costs two reads
 * of a few kilobytes, and opening an ordinary Matroska costs one pass over its material. What the
 * walk does not do is keep any of it — what stays is an address per frame, some dozens of bytes a
 * second of material against the material itself — and what it does not read at all is everything
 * that is not a cluster: the Cues, the Tags, the Attachments at the tail are stepped over by the
 * sizes they state and never fetched.
 *
 * The reads are windowed, so the memory is one window whatever the file is; and they are bounded,
 * so a page cannot hand this a file that would be a download rather than an index (see
 * MAX_INDEX_BYTES).
 */

/** One coded frame of the file, addressed where it actually lies. */
export interface WebmFrame {
  /** TrackNumber the block addressed — the same numbering parseInit reports as trackId. */
  trackNumber: number
  /** Presentation time in ticks of the segment's TimestampScale. */
  timestamp: number
  /** Length in the same ticks where the container states one, zero where it does not. */
  duration: number
  /** The frame can be decoded on its own. */
  keyframe: boolean
  /** Where the coded bytes lie, counted from the first byte of the file. */
  source: Located
}

/**
 * How much of the file one read asks for.
 *
 * A megabyte, because the walk reads the material end to end and the only thing the window
 * decides is how many requests that takes: the twenty-second fixtures are one request apiece, and
 * a ten-megabyte file is ten. Narrower windows cost requests for nothing; wider ones hold more of
 * somebody else's file in memory than the walk has any use for, since nothing of it is kept.
 */
export const INDEX_WINDOW_BYTES = 1024 * 1024

/**
 * How much material this reader will read to index one file.
 *
 * The line where the price of an index becomes a download. Fetching the
 * video out of scope, and a Matroska has to be read to be indexed — so the two meet, and the
 * meeting point is stated as a number rather than discovered by a user on a metered connection.
 * Sixty-four megabytes covers what the web actually serves as a plain Matroska: imageboards cap
 * an upload at four to six, and the files measured in the survey were under one. Past it the file
 * is refused, and the popup says the file could not be read rather than reading it anyway.
 */
export const MAX_INDEX_BYTES = 64 * 1024 * 1024

/**
 * Largest block this reader will fetch whole.
 *
 * An unlaced block is never fetched whole — its header is eleven bytes and the frame behind it is
 * addressed rather than read. A laced one has to be, because the sizes of the frames it holds are
 * written at the front of its payload and each of them needs an address of its own. Lacing is for
 * small packets of sound; a laced block of megabytes is not a thing any muxer writes, and this is
 * the ceiling that says so.
 */
const MAX_LACED_BLOCK_BYTES = 1024 * 1024

/** The widest an element's id and size can be together: four bytes and eight. */
const MAX_HEADER_BYTES = 12

/** Track number, a signed offset from the cluster's timestamp, and one byte of flags. */
const BLOCK_HEADER_MAX_BYTES = 11

/** The keyframe bit of a SimpleBlock's flags. */
const FLAG_KEYFRAME = 0x80

/** The two bits of the flags byte that say how the payload is split. */
const LACING_NONE = 0

export interface IndexOptions {
  /** How much to ask for in one read; INDEX_WINDOW_BYTES unless a test says otherwise. */
  window?: number
  /** Ceiling on the material read to build the index, in bytes. */
  limit?: number
}

/**
 * Every frame of the file, in the order the blocks lie in it.
 *
 * Null when the file cannot be indexed at all: material past the ceiling, a cluster with no
 * timestamp to place its blocks against, bytes that stop making sense as elements, a segment
 * with no material in it. A half-built index is never handed back — an offer made over one would
 * promise a stretch of the file that is not described.
 */
export async function indexClusters(
  read: RangeReader,
  found: FoundSegment,
  options: IndexOptions = {},
): Promise<WebmFrame[] | null> {
  const window = Math.max(64, options.window ?? INDEX_WINDOW_BYTES)
  const limit = options.limit ?? MAX_INDEX_BYTES

  const end = found.total > 0 ? Math.min(found.segmentEnd, found.total) : found.segmentEnd
  if (!(end > found.clustersAt)) return null
  // Weighed before anything is fetched, and it is the segment that says how much there is. A file
  // this reader is going to refuse costs no request at all rather than being discovered halfway
  // through a walk over it — and this is the one place the ceiling is enforced, which is why the
  // window below carries none.
  if (end - found.clustersAt > limit) return null

  // Seeded with what the head walk already read: its last probe usually reaches past the first
  // cluster, and those bytes are paid for whether or not they are used again.
  const source = new Window(read, window, found.front)
  const frames: WebmFrame[] = []

  /** The cluster the walk is inside of: where it ends, and the time its blocks are offset from. */
  let clusterEnd = 0
  let clusterTime = 0
  /** The cluster stated no length of its own: it ends where its children stop being its children. */
  let clusterOpen = false

  let at = found.clustersAt

  while (at < end) {
    if (clusterEnd > 0 && at >= clusterEnd) {
      clusterEnd = 0
      clusterOpen = false
    }

    const header = await source.headerAt(at, end)
    if (!header) return null

    if (header.id === ID.cluster) {
      clusterTime = 0
      clusterOpen = header.unknownSize
      clusterEnd = header.unknownSize ? 0 : Math.min(at + header.size, end)
      at += header.headerSize
      continue
    }

    const inside = clusterEnd > 0 || clusterOpen

    if (inside && header.id === ID.timestamp) {
      const body = await source.bytesAt(at + header.headerSize, header.size - header.headerSize)
      if (!body) return null
      clusterTime = readUint(body)
    } else if (inside && header.id === ID.simpleBlock) {
      const block = await blockFramesAt(source, at, header, clusterTime, null)
      if (!block) return null
      // Pushed one at a time rather than spread in: a file holds as many frames as it holds, and
      // a spread of a hundred thousand of them is an argument list no engine accepts.
      for (const frame of block) frames.push(frame)
    } else if (inside && header.id === ID.blockGroup) {
      const group = await groupFramesAt(source, at, header, clusterTime)
      if (!group) return null
      for (const frame of group) frames.push(frame)
    } else if (clusterOpen && !CLUSTER_CHILDREN.has(header.id)) {
      // An element that cannot belong to a cluster ends one whose length was never written. The
      // walk does not step over it here: it is read again at the level above, which is where it
      // belongs.
      clusterOpen = false
      continue
    }

    const next = at + header.size
    // Every header is two bytes at the least, so a step is never nothing; a size that reaches
    // backwards or past the segment is a file this walk cannot follow.
    if (next <= at || next > end) return null
    at = next
  }

  return frames.length > 0 ? frames : null
}

/**
 * The ids a Cluster may hold. Only consulted to end a cluster that stated no length of its own,
 * which is what a muxer writing to a pipe produces.
 *
 * CRC-32 and Void are in it because they are allowed at every depth: taken for the start of the
 * next element they would end a cluster in the middle of its blocks.
 */
const CLUSTER_CHILDREN = new Set<number>([
  ID.timestamp,
  ID.simpleBlock,
  ID.blockGroup,
  ID.crc32,
  ID.void,
  /** Position and PrevSize: a cluster's own place in the segment, which this walk already knows. */
  0xa7,
  0xab,
])

/** An element header read out of the file: what it is, how wide the header is, how long it runs. */
interface Header {
  id: number
  /** Bytes of id and size taken together. */
  headerSize: number
  /** Full length of the element, its header included. */
  size: number
  unknownSize: boolean
}

/**
 * A sliding window over the file, and the tally of what it has cost.
 *
 * Reads are always forward: the walk never goes back, so a window is thrown away as soon as the
 * next one is fetched and the memory is one window whatever the file is.
 *
 * It carries no ceiling of its own, and does not need one: every read is clamped to the end of
 * the material, and how much material there is was weighed against the ceiling before the first
 * of them was made. A second check inside here would be a branch nothing could ever take.
 */
class Window {
  private held: Uint8Array
  private heldAt = 0

  constructor(
    private readonly read: RangeReader,
    private readonly window: number,
    front: Uint8Array = new Uint8Array(0),
  ) {
    this.held = front
  }

  /** Whether `want` bytes at `at` are already in hand. */
  private has(at: number, want: number): boolean {
    return at >= this.heldAt && at + want <= this.heldAt + this.held.byteLength
  }

  /**
   * Whatever it takes to hold `want` bytes at `at`, never reaching past `end`.
   *
   * False when the read was refused, came back short, or would push the walk past what it is
   * allowed to read.
   */
  private async reach(at: number, want: number, end: number): Promise<boolean> {
    if (this.has(at, want)) return true

    const length = Math.max(want, Math.min(this.window, end - at))
    if (length <= 0) return false

    const answer = await this.read(at, length)
    this.held = answer.bytes
    this.heldAt = at

    return this.has(at, want)
  }

  /** The element header at `at`, or null when there is not a readable one there. */
  async headerAt(at: number, end: number): Promise<Header | null> {
    const want = Math.min(MAX_HEADER_BYTES, end - at)
    if (want < 2 || !(await this.reach(at, want, end))) return null

    const from = at - this.heldAt
    const to = from + want

    const id = readVint(this.held, from, to, 4)
    if (!id) return null

    const size = readVint(this.held, from + id.length, to)
    if (!size) return null

    // The id is its bytes, marker and all: 0x1F43B675 is what a Cluster is called, and readVint
    // strips the width marker — right for a length, wrong for a name.
    let name = 0
    for (let i = 0; i < id.length; i++) name = name * 256 + this.held[from + i]!

    const headerSize = id.length + size.length
    if (size.allOnes) return { id: name, headerSize, size: headerSize, unknownSize: true }

    return { id: name, headerSize, size: headerSize + size.value, unknownSize: false }
  }

  /** `length` bytes at `at`, or null when they could not all be had. */
  async bytesAt(at: number, length: number): Promise<Uint8Array | null> {
    if (length < 0) return null
    if (length === 0) return new Uint8Array(0)
    if (!(await this.reach(at, length, at + length))) return null

    const from = at - this.heldAt
    return this.held.subarray(from, from + length)
  }
}

/**
 * The frames of one block, addressed in the file.
 *
 * Only the head of a block is fetched: a track number, two bytes of offset and one of flags. The
 * coded frame behind it is named and not read — which is the whole reason a clip can be planned
 * over a file nobody has downloaded.
 *
 * A laced block is the exception. It carries several frames under one timestamp with their sizes
 * written at the front of the payload, and each of those frames needs an address of its own, so
 * the block is fetched whole and split. No muxer measured laces anything — 3256 blocks across
 * three files, not one of them laced — and it is read anyway because mkvmerge does it for sound.
 */
async function blockFramesAt(
  source: Window,
  at: number,
  header: Header,
  clusterTime: number,
  group: { duration: number; keyframe: boolean } | null,
): Promise<WebmFrame[] | null> {
  const bodyAt = at + header.headerSize
  const bodyLength = header.size - header.headerSize
  if (bodyLength <= 0) return null

  const head = await source.bytesAt(bodyAt, Math.min(BLOCK_HEADER_MAX_BYTES, bodyLength))
  if (!head) return null

  const track = readVint(head, 0)
  if (!track || track.length + 3 > head.byteLength) return null

  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const timestamp = clusterTime + view.getInt16(track.length)
  const flags = head[track.length + 2]!
  const lacing = (flags >> 1) & 0x03

  // A SimpleBlock states for itself whether it is a keyframe. A Block inside a BlockGroup carries
  // no such bit: what makes it one is that the group names no frame it was predicted from.
  const keyframe = group ? group.keyframe : (flags & FLAG_KEYFRAME) !== 0
  const duration = group ? group.duration : 0

  const payloadAt = bodyAt + track.length + 3
  const payloadLength = bodyLength - track.length - 3
  if (payloadLength < 0) return null

  if (lacing === LACING_NONE) {
    return [
      {
        trackNumber: track.value,
        timestamp,
        duration,
        keyframe,
        source: { at: payloadAt, length: payloadLength },
      },
    ]
  }

  if (payloadLength > MAX_LACED_BLOCK_BYTES) return null
  const payload = await source.bytesAt(payloadAt, payloadLength)
  if (!payload) return null

  const sizes = lacedSizes(payload, lacing)
  if (!sizes) return null

  const frames: WebmFrame[] = []
  // A stated duration is shared out over the frames the block holds, exactly as the in-memory
  // reader shares it (src/core/webm/fragment.ts); with none stated there is nothing to share.
  const each = duration > 0 ? duration / sizes.frames.length : 0

  let offset = sizes.from
  for (let i = 0; i < sizes.frames.length; i++) {
    const length = sizes.frames[i]!
    if (offset + length > payloadLength) return null

    frames.push({
      trackNumber: track.value,
      timestamp: timestamp + each * i,
      duration: each,
      keyframe,
      source: { at: payloadAt + offset, length },
    })
    offset += length
  }

  return frames
}

/**
 * The frames of a BlockGroup: a Block, and beside it the two things a SimpleBlock cannot say —
 * how long the frame lasts, and whether it was predicted from another.
 *
 * ffmpeg writes exactly one of these per file, for the last picture frame, so that the length of
 * that frame is stated rather than guessed at. The group is small and is fetched whole.
 */
async function groupFramesAt(
  source: Window,
  at: number,
  header: Header,
  clusterTime: number,
): Promise<WebmFrame[] | null> {
  if (header.size > MAX_LACED_BLOCK_BYTES) return null

  const bytes = await source.bytesAt(at, header.size)
  if (!bytes) return null

  const group: Element = {
    id: ID.blockGroup,
    start: 0,
    size: header.size,
    headerSize: header.headerSize,
    unknownSize: false,
  }

  const children = childElements(bytes, group)
  const block = children.find((child) => child.id === ID.block)
  if (!block) return null

  const stated = children.find((child) => child.id === ID.blockDuration)
  const duration = stated ? readUint(elementBody(bytes, stated)) : 0
  const keyframe = !children.some((child) => child.id === ID.referenceBlock)

  return blockFramesAt(
    source,
    at + block.start,
    { id: ID.block, headerSize: block.headerSize, size: block.size, unknownSize: false },
    clusterTime,
    { duration, keyframe },
  )
}

/**
 * The frame sizes a laced payload states, and where the frames themselves begin.
 *
 * The three encodings the format allows, read exactly as the in-memory reader reads them — a
 * count, then a table in one of three shapes, and the last frame takes whatever is left over.
 * Null for a table that does not add up: a block whose frame boundaries are unreadable is dropped
 * whole rather than handed on as one oversized frame with several packets inside it.
 */
function lacedSizes(payload: Uint8Array, lacing: number): { from: number; frames: number[] } | null {
  if (payload.byteLength < 1) return null

  const count = payload[0]! + 1
  let at = 1
  const frames: number[] = []

  if (lacing === 2) {
    const total = payload.byteLength - at
    if (total % count !== 0) return null
    for (let i = 0; i < count; i++) frames.push(total / count)
    return { from: at, frames }
  }

  if (lacing === 1) {
    for (let i = 0; i < count - 1; i++) {
      let size = 0
      for (;;) {
        if (at >= payload.byteLength) return null
        const byte = payload[at]!
        at++
        size += byte
        if (byte !== 0xff) break
      }
      frames.push(size)
    }
  } else {
    const first = readVint(payload, at)
    if (!first) return null
    at += first.length
    frames.push(first.value)

    let previous = first.value
    for (let i = 1; i < count - 1; i++) {
      const delta = readVint(payload, at)
      if (!delta) return null
      at += delta.length
      previous += delta.value - (2 ** (7 * delta.length - 1) - 1)
      if (previous < 0) return null
      frames.push(previous)
    }
  }

  let used = 0
  for (const size of frames) used += size
  const rest = payload.byteLength - at - used
  if (rest < 0) return null
  frames.push(rest)

  return { from: at, frames }
}
