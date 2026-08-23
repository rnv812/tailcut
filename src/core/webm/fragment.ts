import {
  ID,
  childElements,
  childWithId,
  elementBody,
  readUint,
  readVint,
  topLevelElements,
  type Element,
} from './reader'
import type { FragmentInfo } from '../../shared/types'

/**
 * The media segments of a WebM stream: clusters, and inside them the frames.
 *
 * A DASH media segment holds nothing but Clusters, and that is what MSE is handed. A cluster
 * states its own timestamp once and every block inside it carries a signed offset from it, so an
 * absolute time exists only after the two are put together — which is what this module does, and
 * the reason a caller never sees a raw block.
 *
 * parseFragment answers in the shape the ISO BMFF side answers in, so the registry can lay a WebM
 * segment on the same map. parseClusters is the fuller reading underneath it, for a muxer that
 * has to write these frames somewhere else.
 */

/** Frame layout inside a block: the two bits of the flags byte that say how the payload is split. */
const LACING_NONE = 0
const LACING_XIPH = 1
const LACING_FIXED = 2
const LACING_EBML = 3

/** The keyframe bit of a SimpleBlock's flags. A Block inside a BlockGroup has no such bit. */
const FLAG_KEYFRAME = 0x80

/** One coded frame, placed on the timeline of its own track. */
export interface Frame {
  /** TrackNumber the block addressed — the same numbering parseInit reports as trackId. */
  trackNumber: number
  /** Absolute presentation time in ticks of the segment's TimestampScale. */
  timestamp: number
  /** Length in the same ticks when the container states one, zero when it does not. */
  duration: number
  /** The frame can be decoded on its own. */
  keyframe: boolean
  /** The coded bytes. A view into the segment, not a copy. */
  data: Uint8Array
}

/** One cluster of a media segment, with its frames already placed in absolute time. */
export interface Cluster {
  /** The cluster's own timestamp, in ticks of the segment's TimestampScale. */
  timestamp: number
  frames: Frame[]
}

/** The block header the two block kinds share, payload split off. */
interface BlockHeader {
  trackNumber: number
  timestamp: number
  flags: number
  payload: Uint8Array
}

/**
 * Reads the fixed part of a block: a variable-length track number, a signed 16-bit offset from
 * the cluster's timestamp, and one byte of flags. Null when those bytes are not all there.
 */
function readBlockHeader(body: Uint8Array, clusterTimestamp: number): BlockHeader | null {
  const track = readVint(body, 0)
  if (!track) return null

  const at = track.length
  if (at + 3 > body.byteLength) return null

  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)

  return {
    trackNumber: track.value,
    // The offset is signed: a frame may be presented before the cluster it is stored in.
    timestamp: clusterTimestamp + view.getInt16(at),
    flags: body[at + 2]!,
    payload: body.subarray(at + 3),
  }
}

/**
 * Splits the payload of a block into the frames it holds.
 *
 * Without lacing there is exactly one frame and the payload is it. With lacing the payload opens
 * with a count and a table of sizes in one of three encodings, and the last frame always takes
 * whatever is left over. A table that does not add up returns null: a block whose frame
 * boundaries are unreadable is dropped whole rather than handed on as one oversized frame with
 * several packets inside it.
 */
function splitFrames(payload: Uint8Array, lacing: number): Uint8Array[] | null {
  if (lacing === LACING_NONE) return [payload]
  if (payload.byteLength < 1) return null

  const count = payload[0]! + 1
  let at = 1
  const sizes: number[] = []

  if (lacing === LACING_FIXED) {
    const total = payload.byteLength - at
    if (total % count !== 0) return null
    for (let i = 0; i < count; i++) sizes.push(total / count)
  } else if (lacing === LACING_XIPH) {
    // Each size but the last is a run of 0xff bytes closed by a byte below 0xff, all added up.
    // The walk is bounded by the payload: a run that reaches its end without closing is broken.
    for (let i = 0; i < count - 1; i++) {
      let size = 0
      for (;;) {
        if (at >= payload.byteLength) return null
        const byte = payload[at]!
        at++
        size += byte
        if (byte !== 0xff) break
      }
      sizes.push(size)
    }
  } else if (lacing === LACING_EBML) {
    // EBML lacing: the first size outright, the rest as signed differences from the one before.
    const first = readVint(payload, at)
    if (!first) return null
    at += first.length
    sizes.push(first.value)

    let previous = first.value
    for (let i = 1; i < count - 1; i++) {
      const delta = readVint(payload, at)
      if (!delta) return null
      at += delta.length
      // A lacing difference is stored biased, so that the unsigned number can carry a negative one.
      previous += delta.value - (2 ** (7 * delta.length - 1) - 1)
      if (previous < 0) return null
      sizes.push(previous)
    }
  } else {
    // The two lacing bits spell four values, and the fourth returned at the top. Unreachable, and
    // written out rather than folded into the branch above so that it stays unreachable.
    return null
  }

  if (lacing !== LACING_FIXED) {
    let used = 0
    for (const size of sizes) used += size
    const rest = payload.byteLength - at - used
    if (rest < 0) return null
    sizes.push(rest)
  }

  const frames: Uint8Array[] = []
  for (const size of sizes) {
    if (size < 0 || at + size > payload.byteLength) return null
    frames.push(payload.subarray(at, at + size))
    at += size
  }

  return frames
}

/**
 * Frames of one block.
 *
 * A laced block holds several frames under a single timestamp. When the container states a
 * duration for the block, that duration is what the frames share: each takes an equal part of it
 * and starts where the one before it ended. When it states none, the frames all report the
 * block's own timestamp and no duration — the container gave nothing to spread.
 */
function framesOfBlock(
  header: BlockHeader,
  keyframe: boolean,
  blockDuration: number,
): Frame[] {
  const payloads = splitFrames(header.payload, (header.flags >> 1) & 0x03)
  if (!payloads) return []

  const each = blockDuration > 0 ? blockDuration / payloads.length : 0

  return payloads.map((data, index) => ({
    trackNumber: header.trackNumber,
    timestamp: header.timestamp + each * index,
    duration: each,
    keyframe,
    data,
  }))
}

function framesOfSimpleBlock(data: Uint8Array, element: Element, clusterTimestamp: number): Frame[] {
  const header = readBlockHeader(elementBody(data, element), clusterTimestamp)
  if (!header) return []

  // A SimpleBlock states for itself whether it is a keyframe, and never states a duration.
  return framesOfBlock(header, (header.flags & FLAG_KEYFRAME) !== 0, 0)
}

function framesOfBlockGroup(data: Uint8Array, element: Element, clusterTimestamp: number): Frame[] {
  const block = childWithId(data, element, ID.block)
  if (!block) return []

  const header = readBlockHeader(elementBody(data, block), clusterTimestamp)
  if (!header) return []

  const durationElement = childWithId(data, element, ID.blockDuration)
  const duration = durationElement ? readUint(elementBody(data, durationElement)) : 0

  // A Block carries no keyframe bit. What makes it a keyframe is that the group names no frame it
  // was predicted from.
  const keyframe = childWithId(data, element, ID.referenceBlock) === undefined

  return framesOfBlock(header, keyframe, duration)
}

/**
 * Clusters of a media segment, in the order they lie in the buffer.
 *
 * Both shapes a segment arrives in are read: bare clusters, which is what a DASH media segment
 * is, and clusters wrapped in a Segment, which is what a whole file looks like.
 *
 * A cluster with no Timestamp of its own is skipped. Its blocks carry offsets and nothing to
 * offset them from, and placing them at zero would drop the whole cluster onto the start of the
 * recording.
 */
export function parseClusters(data: Uint8Array): Cluster[] {
  const clusters: Cluster[] = []

  for (const element of clusterElements(data)) {
    const timestampElement = childWithId(data, element, ID.timestamp)
    if (!timestampElement) continue

    const timestamp = readUint(elementBody(data, timestampElement))
    const frames: Frame[] = []

    // Pushed one at a time rather than spread in: a cluster may hold any number of blocks, and a
    // spread of a hundred thousand of them is an argument list no engine accepts.
    for (const child of childElements(data, element)) {
      if (child.id === ID.simpleBlock) {
        for (const frame of framesOfSimpleBlock(data, child, timestamp)) frames.push(frame)
      } else if (child.id === ID.blockGroup) {
        for (const frame of framesOfBlockGroup(data, child, timestamp)) frames.push(frame)
      }
    }

    clusters.push({ timestamp, frames })
  }

  return clusters
}

function clusterElements(data: Uint8Array): Element[] {
  const top = topLevelElements(data)
  const found = top.filter((e) => e.id === ID.cluster)

  for (const segment of top.filter((e) => e.id === ID.segment)) {
    for (const child of childElements(data, segment)) {
      if (child.id === ID.cluster) found.push(child)
    }
  }

  return found.sort((a, b) => a.start - b.start)
}

/**
 * Where a media segment starts on the timeline of its track and how long it lasts, in ticks of
 * the segment's TimestampScale — the same pair the ISO BMFF reader draws out of tfdt and trun.
 *
 * The track is the one the first frame belongs to. A segment carrying more than one track has the
 * rest silently passed over, exactly as the mp4 side passes over every traf but the first.
 *
 * The extent is measured over presentation times, which is why it is the smallest and the largest
 * rather than the first and the last: with B-frames the blocks are stored out of order and the
 * last one written is not the last one shown.
 *
 * The tail of the fragment — how long its final frame lasts — is the one number Matroska usually
 * does not carry. A BlockGroup may state a BlockDuration and then that is used; a SimpleBlock
 * never does, and the step between the last two frames stands in for it. For the constant frame
 * rate of an Opus or a video track that step is exact. A fragment holding a single frame with no
 * stated duration has nothing to fall back on and comes out with a length of zero — understated,
 * like a truncated trun on the mp4 side, and for the same reason: an invented length would put
 * the next fragment in the wrong place instead of leaving a gap that shows.
 */
export function parseFragment(data: Uint8Array): FragmentInfo | null {
  const frames: Frame[] = []
  for (const cluster of parseClusters(data)) {
    for (const frame of cluster.frames) frames.push(frame)
  }

  const first = frames[0]
  if (!first) return null

  const own = frames.filter((f) => f.trackNumber === first.trackNumber)
  const times = own.map((f) => f.timestamp).sort((a, b) => a - b)

  const start = times[0]!
  const last = times[times.length - 1]!

  // The longest duration stated for a frame shown last, walked rather than spread through
  // Math.max: the number of frames is whatever the segment says it is.
  let stated = 0
  for (const frame of own) {
    if (frame.timestamp === last && frame.duration > stated) stated = frame.duration
  }

  const step = times.length > 1 ? last - times[times.length - 2]! : 0
  const tail = stated > 0 ? stated : step

  return {
    trackId: first.trackNumber,
    baseMediaDecodeTime: start,
    duration: last + tail - start,
  }
}
