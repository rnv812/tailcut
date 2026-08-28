import type { RangeReader } from '../iso/locate'
import { concatBytes } from '../iso/writer'
import {
  ID,
  childElements,
  elementBody,
  readString,
  readVint,
  segmentLevel,
  topLevelElements,
} from './reader'

/**
 * Finding the head of a whole Matroska without downloading the file.
 *
 * The counterpart of src/core/iso/locate.ts, and the same job: an ordinary `<video src>` is
 * delivered whole, the description of what it holds is a few kilobytes at the front of it, and
 * everything else is material we are going to all this trouble not to fetch. So the front is
 * read, the elements are stepped over by the lengths they state, and the walk stops at the first
 * Cluster — the first byte of material there is.
 *
 * What comes back is not the counterpart of a movie box, and the difference is the whole reason
 * the second half of this reading (src/core/webm/whole.ts) exists at all. An mp4 states every
 * sample of every track in six tables inside the `moov`: fetch those few kilobytes and the file
 * is indexed without a byte of `mdat` behind them. A Matroska states a frame in the block header
 * lying immediately in front of that frame, and nowhere else. Its Cues are an index of keyframes
 * to seek by and not a table of samples: they say where a cluster begins, never how many frames
 * are in it, how long each lasts or what any of them weighs. So the head yields the Tracks, the
 * timestamp scale and nothing more, and the frames have to be walked.
 *
 * Measured against tests/fixtures/plain: one request of eight kilobytes for both fixtures, the
 * VP9 one whose Tracks is 174 bytes and the VP8 one whose Tracks is 3.4 kB of Vorbis setup
 * headers. Neither costs a second.
 */

/** `1A 45 DF A3` — the EBML header id, and the four bytes every Matroska begins with. */
export const MATROSKA_MAGIC = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])

/**
 * How much of the front of a file the first read asks for.
 *
 * The same eight kilobytes the mp4 walk probes with, and for a different reason. There it is
 * deliberately small because the movie box may be anywhere and the bytes behind the probe are
 * material; here everything wanted lies in one run at the front, and eight kilobytes is what it
 * takes to hold the widest of it we have measured — a Vorbis track's setup headers are three and
 * a half kilobytes on their own.
 *
 * The same number as the mp4 walk's on purpose, and not by coincidence: the loader reads the
 * front of a file once and lends it to whichever of the two walks the first four bytes call for
 * (src/bridge/loader.ts). A wider probe here would ask the host for bytes it has already paid for.
 */
export const PROBE_BYTES = 8192

/**
 * How many reads the walk may make before giving up.
 *
 * The head is one window on every file measured. The ceiling is for the other kind: bytes that
 * open like a Matroska and then step forward two at a time.
 */
const MAX_REQUESTS = 12

/**
 * Largest head this reader will agree to hold in memory.
 *
 * The head is fetched whole, so its stated length is an allocation this code is agreeing to. A
 * megabyte is far past any real one — the widest measured is four kilobytes — and what would
 * push a file past it is an Attachments element written in front of the material, which is cover
 * art rather than anything a save needs.
 */
const MAX_HEAD_BYTES = 1024 * 1024

/** The document types this reader will take. Anything else is EBML that is not video. */
const DOC_TYPES = new Set(['webm', 'matroska'])

/** `18 53 80 67` — the Segment id, four bytes wide, with the size written behind it. */
const SEGMENT_ID_BYTES = 4

export interface FoundSegment {
  /**
   * Everything the walk read, from the first byte of the file: the head, and whatever of the
   * material the last window happened to reach past it.
   *
   * Handed on so that the walk over the clusters (src/core/webm/whole.ts) starts from bytes
   * already paid for instead of asking for them again. A probe is eight kilobytes and a head is
   * four, so half a probe would otherwise be fetched twice over on every file.
   */
  front: Uint8Array
  /**
   * The front of the file down to the first cluster, whole: the EBML header, the Segment header
   * and every element the segment states in front of its material.
   *
   * Handed out as bytes rather than as a parsed thing because that is what the readers above take
   * — `parseInit` reads exactly this shape, and it is the same call the captured path makes on an
   * init segment out of MSE.
   */
  head: Uint8Array
  /**
   * Where the segment's body begins, counted from the first byte of the file. A Cue position and
   * a SeekHead position are both counted from here rather than from the start of the file.
   */
  bodyAt: number
  /** Where the first cluster begins: the first byte of material. */
  clustersAt: number
  /** The first byte past the segment — where the material can not run beyond. */
  segmentEnd: number
  /** Length of the whole file where the answers stated one, and zero where they did not. */
  total: number
  /** How many ranged reads it took. */
  requests: number
}

export interface LocateSegmentOptions {
  /** How much to ask for in one speculative read; PROBE_BYTES unless a test says otherwise. */
  window?: number
  maxRequests?: number
  /** Ceiling on the head, in bytes. */
  headLimit?: number
}

/**
 * Reads the front of a Matroska: everything in front of its first cluster.
 *
 * Null for anything this program will not go on to read — bytes that are not EBML at all, a
 * DocType that is not Matroska, a segment with no Tracks in front of its material, a head past
 * the ceiling, a file whose end nothing states. Each of those is a file the save cannot be made
 * from, and answering with half of one would only move the refusal further down.
 */
export async function locateSegment(
  read: RangeReader,
  options: LocateSegmentOptions = {},
): Promise<FoundSegment | null> {
  const window = Math.max(64, options.window ?? PROBE_BYTES)
  const maxRequests = options.maxRequests ?? MAX_REQUESTS
  const headLimit = options.headLimit ?? MAX_HEAD_BYTES

  let requests = 0
  let total = 0
  /** The front of the file as far as it has been read: always from byte zero, always contiguous. */
  let held: Uint8Array = new Uint8Array(0)

  /** Reads on until `want` bytes of the front are in hand, or until there are no more to have. */
  const reach = async (want: number): Promise<boolean> => {
    while (held.byteLength < want) {
      if (requests >= maxRequests || held.byteLength >= headLimit) return false
      requests += 1

      const answer = await read(held.byteLength, Math.max(window, want - held.byteLength))
      if (total === 0 && answer.total > 0) total = answer.total
      if (answer.bytes.byteLength === 0) return false

      held = held.byteLength === 0 ? answer.bytes : concatBytes([held, answer.bytes])
    }

    return true
  }

  if (!(await reach(Math.min(window, headLimit)))) return null
  if (!beginsLikeMatroska(held)) return null

  const ebml = topLevelElements(held).find((element) => element.id === ID.ebml)
  // An EBML header that does not fit the first window is not a header this reader has ever seen:
  // the widest measured is 36 bytes.
  if (!ebml || ebml.start !== 0) return null

  const docType = childElements(held, ebml).find((element) => element.id === ID.docType)
  if (!docType || !DOC_TYPES.has(readString(elementBody(held, docType)))) return null

  const segment = await segmentHeaderAt(ebml.start + ebml.size, reach, () => held, total)
  if (!segment) return null

  const clustersAt = await firstClusterAt(segment, reach, () => held, headLimit)
  if (clustersAt === null) return null

  if (!(await reach(clustersAt))) return null

  const head = held.subarray(0, clustersAt)
  // Tracks in front of the material, or nothing to read the material as. Every muxer writes them
  // there because a player needs them before the first frame; a file that hides them behind its
  // clusters is refused rather than chased through the SeekHead, and no file measured is one.
  //
  // Read out of the head with the same call the captured path uses on an init segment: a Segment
  // whose stated length outruns the buffer is cut back to what is there, which is exactly what
  // the head is.
  if (!segmentLevel(head).some((element) => element.id === ID.tracks)) return null

  return {
    front: held,
    head,
    bodyAt: segment.bodyAt,
    clustersAt,
    segmentEnd: segment.end,
    total,
    requests,
  }
}

/** Whether the first four bytes are the EBML header id — the one cheap answer to "is this one". */
export function beginsLikeMatroska(bytes: Uint8Array): boolean {
  if (bytes.byteLength < MATROSKA_MAGIC.byteLength) return false
  for (let i = 0; i < MATROSKA_MAGIC.byteLength; i++) {
    if (bytes[i] !== MATROSKA_MAGIC[i]) return false
  }
  return true
}

/** The Segment element's header: where its body starts and where the whole of it ends. */
interface SegmentHeader {
  element: { id: number; start: number; size: number; headerSize: number; unknownSize: boolean }
  bodyAt: number
  end: number
}

/**
 * The Segment behind the EBML header, with its length settled.
 *
 * A segment written to a pipe states its length as the reserved "unknown", because the muxer
 * could not seek back to fill it in. The only other thing that can say where such a segment ends
 * is the stated length of the file — and where neither says, the walk has no bound at all and
 * the file is refused.
 */
async function segmentHeaderAt(
  at: number,
  reach: (want: number) => Promise<boolean>,
  heldNow: () => Uint8Array,
  total: number,
): Promise<SegmentHeader | null> {
  // Twelve bytes is the widest an id and a size can be together.
  if (!(await reach(at + 12))) return null

  const held = heldNow()
  const element = topLevelElements(held).find((candidate) => candidate.start === at)
  if (!element || element.id !== ID.segment) return null

  const bodyAt = at + element.headerSize
  // topLevelElements cuts a Segment that outruns the buffer back to what is held — the exemption
  // that lets a live stream be read a piece at a time — so its size here says nothing about where
  // the segment really ends. The stated size is read again from the bytes for that, from behind
  // the four bytes a Segment's id is written in.
  const stated = readVint(held, at + SEGMENT_ID_BYTES, at + element.headerSize)
  if (!stated) return null

  if (stated.allOnes) return total > 0 ? { element, bodyAt, end: total } : null
  return { element, bodyAt, end: bodyAt + stated.value }
}

/**
 * Where the material starts: the offset of the first Cluster among the segment's children.
 *
 * Walked by the stated sizes and never into a body — a SeekHead, an Info, a Tracks and a Tags is
 * the ordinary run, and each of them says how long it is. Null when the walk cannot go on: an
 * element that states no length of its own, a segment with no cluster in it at all, or a head
 * that has grown past what this reader will hold.
 */
async function firstClusterAt(
  segment: SegmentHeader,
  reach: (want: number) => Promise<boolean>,
  heldNow: () => Uint8Array,
  headLimit: number,
): Promise<number | null> {
  let at = segment.bodyAt

  while (at < segment.end) {
    if (at >= headLimit) return null
    if (!(await reach(Math.min(at + 12, segment.end)))) return null

    const held = heldNow()
    const id = readVint(held, at, held.byteLength, 4)
    if (!id) return null

    const size = readVint(held, at + id.length, held.byteLength)
    if (!size) return null

    // Read again with the marker bits kept: an id is its bytes, and 0x1F43B675 is what a Cluster
    // is called. readVint strips the width marker, which is right for a length and wrong for a name.
    let name = 0
    for (let i = 0; i < id.length; i++) name = name * 256 + held[at + i]!

    if (name === ID.cluster) return at

    // An element of unknown size in front of the material has no end this walk can step to. The
    // one element that is allowed to be written that way is the Segment itself.
    if (size.allOnes) return null

    const next = at + id.length + size.length + size.value
    // Two bytes at the least per header, so the walk always moves; a size that steps backwards or
    // past the segment is a file this reader cannot follow.
    if (next <= at || next > segment.end) return null
    at = next
  }

  return null
}
