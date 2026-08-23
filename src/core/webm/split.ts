import { ID, childElements, topLevelElements } from './reader'
import type { Split, StreamUnit } from '../../shared/types'

/**
 * Cutting a WebM byte stream into the segments it is made of.
 *
 * The counterpart of the ISO BMFF splitter next door, over a grammar that nests differently: a
 * stream is an EBML header and a Segment, and everything else — Info, Tracks, the clusters —
 * lives inside that one Segment rather than beside it. An init segment therefore runs from the
 * first byte to the end of the Tracks, and every Cluster after it is a media segment.
 *
 * A Cluster is taken from its own first byte and not from wherever the last segment ended: Cues,
 * Tags and Void may stand between two clusters, and they are description of the recording rather
 * than material of it.
 */

/**
 * Ids a segment may start with: the top of the stream and the level-one elements that stand
 * between the clusters. Used to tell an element still arriving from a buffer that has lost its
 * place — bytes standing at anything else are in the middle of something.
 *
 * Void and CRC-32 are left out although they are perfectly legal here. They are one byte wide,
 * so a byte of a picture spells one of them once every hundred and twenty-eight: counting them
 * as a place a segment begins would keep a buffer that has lost its place waiting on noise. A
 * Void really standing at the head is walked over by the resynchronisation instead, which is
 * what would have happened to it anyway.
 */
const SEGMENT_HEADS = new Set<number>([
  ID.ebml, ID.segment, ID.seekHead, ID.info, ID.tracks, ID.cluster,
  ID.cues, ID.chapters, ID.tags, ID.attachments,
])

/** Ids distinctive enough to name the container on sight: four bytes that nothing else spells. */
const STREAM_HEADS = [ID.ebml, ID.cluster]

/** Whether the four bytes at `at` spell the id `wanted`. */
function idAt(data: Uint8Array, at: number, wanted: number): boolean {
  return (
    at + 4 <= data.byteLength &&
    data[at] === wanted >>> 24 &&
    data[at + 1]! === ((wanted >>> 16) & 0xff) &&
    data[at + 2]! === ((wanted >>> 8) & 0xff) &&
    data[at + 3]! === (wanted & 0xff)
  )
}

/**
 * Whether the head of a segment stands at `at`.
 *
 * Every id that matters here is four bytes wide, so fewer than four bytes in hand is an element
 * still arriving rather than a lost place, and counts as a head so the bytes behind it are kept.
 */
export function webmUnitStartsAt(data: Uint8Array, at: number): boolean {
  if (at >= data.byteLength) return false
  if (at + 4 > data.byteLength) return true

  for (const id of SEGMENT_HEADS) if (idAt(data, at, id)) return true
  return false
}

/** The next offset at or after `from` where a stream of this container starts; -1 when none. */
export function webmResync(data: Uint8Array, from: number): number {
  for (let at = Math.max(0, from); at + 4 <= data.byteLength; at++) {
    for (const id of STREAM_HEADS) if (idAt(data, at, id)) return at
  }
  return -1
}

export function splitWebm(data: Uint8Array): Split {
  const units: StreamUnit[] = []
  let consumed = 0

  // Everything of interest sits one level down when the stream came with its Segment wrapper, and
  // at the top when it did not — a buffer that starts partway through a stream holds clusters and
  // nothing around them.
  const top = topLevelElements(data)
  const segment = top.find((e) => e.id === ID.segment)
  const level = segment ? childElements(data, segment) : top

  for (const [index, element] of level.entries()) {
    // An element that stated no size of its own was ended by the reader at whatever came next,
    // and for the last element of the buffer that is the end of the bytes in hand rather than the
    // end of the element. Closing a segment on it would hand out a segment cut in half.
    if (element.unknownSize && index === level.length - 1) break

    const end = element.start + element.size

    if (element.id === ID.tracks) {
      // From the first byte, so the EBML header and the Segment that carry the timestamp scale
      // travel with the tracks they describe.
      units.push({ kind: 'init', bytes: data.subarray(consumed, end) })
    } else if (element.id === ID.cluster) {
      units.push({ kind: 'media', bytes: data.subarray(element.start, end) })
    } else continue

    consumed = end
  }

  return { units, consumed }
}
