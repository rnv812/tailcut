import { parsers, type ContainerParser } from './container'
import type { StreamUnit } from '../shared/types'

export type { StreamUnit }

/**
 * The run of appends a page makes on one SourceBuffer, read back as segments.
 *
 * MSE gives a SourceBuffer a byte stream and not a list of segments. Most players hand over one
 * segment per call and the distinction never shows; YouTube hands over the download as it
 * arrives, sixteen kilobytes at a time, and then every boundary of the container falls in the
 * middle of a call. Read call by call, such a stream yields the few pieces that happen to begin
 * with a header — and of those, the ones whose data has not all arrived are kept in half. That is
 * a clip with holes in the picture and, where the sound came in WebM and its init was cut in two,
 * no sound at all.
 *
 * So the pieces are put back together here, before anything is read out of them. What comes out
 * is what the site's packager wrote: an init segment, then media segments, whole, byte for byte,
 * and in the order the page appended them.
 *
 * One stream per SourceBuffer, and the container is settled once — the first thing recognisable
 * in the bytes names it, and it holds for the life of the buffer. Bytes of a picture spell
 * anything given enough of them, and a stream that changed its mind about its own container
 * halfway through would be reading a frame as a header.
 */

/**
 * Largest tail held back while a segment finishes arriving.
 *
 * A cap and not a budget: segments of a few hundred kilobytes are the usual thing and a
 * high-bitrate one runs to a few megabytes, all of them far below this. What it stops is a page
 * whose stream this reader cannot follow — a header stating a length that never comes — from
 * growing the tail without end beside the material of every other session on the page. Reaching
 * it means the buffer has lost its place, and it goes looking for the next header.
 */
export const MAX_PENDING_BYTES = 32 * 1024 * 1024

/**
 * Bytes kept from a buffer with nothing recognisable in it: enough that a header straddling the
 * boundary between two appends is still whole at the front of the next one.
 */
const HEADER_MARGIN = 16

/** Smallest buffer worth allocating: a push is kilobytes, and growing by ones would churn. */
const MIN_CAPACITY = 64 * 1024

const EMPTY = new Uint8Array(0)

/** Which parser makes sense of these bytes first, and where in them its stream begins. */
function sniff(data: Uint8Array): { parser: ContainerParser; at: number } | null {
  let found: { parser: ContainerParser; at: number } | null = null

  for (const parser of parsers) {
    const at = parser.resync(data, 0)
    if (at < 0) continue
    // The earliest one wins: the head of the stream is what names it, and a later match is a
    // sequence of bytes inside material the other parser is already reading.
    if (!found || at < found.at) found = { parser, at }
  }

  return found
}

export class SegmentStream {
  /** The segment still arriving, at the front of the buffer; the rest of it is spare room. */
  private pending = EMPTY
  private pendingLength = 0
  private parser: ContainerParser | null = null

  /**
   * Takes what the page appended and gives back every segment that is now complete. An empty
   * answer is the ordinary case for a stream delivered in slices: the bytes went into the segment
   * being assembled and it is not finished yet.
   */
  push(bytes: Uint8Array): StreamUnit[] {
    // Nothing held back, so the buffer just handed over is the stream as it stands. A player that
    // appends a segment at a time never leaves anything behind and never pays for a copy here.
    const held = this.pendingLength > 0
    if (held) this.hold(bytes)
    let data = held ? this.pending.subarray(0, this.pendingLength) : bytes

    const units: StreamUnit[] = []

    while (data.byteLength > 0) {
      if (!this.parser) {
        const found = sniff(data)
        if (!found) {
          data = edge(data)
          break
        }
        this.parser = found.parser
        data = data.subarray(found.at)
      }

      const split = this.parser.split(data)
      for (const unit of split.units) {
        // A unit cut out of the held buffer is a view into bytes that are about to be slid
        // forward and written over; one cut out of the page's own buffer can travel as it is.
        units.push(held ? { kind: unit.kind, bytes: unit.bytes.slice() } : unit)
      }
      data = data.subarray(split.consumed)
      if (data.byteLength === 0) break

      // A header at the front is a segment still arriving: hold it and wait for the rest, unless
      // the wait has already grown past what a segment can weigh.
      if (this.parser.unitStartsAt(data, 0) && data.byteLength <= MAX_PENDING_BYTES) break

      // Anything else is a buffer that has lost its place: an abort() cut the last segment short,
      // or recording began while the page was already playing. There is no honest way to place
      // these bytes, and the next header is where reading can start again.
      const at = this.parser.resync(data, 1)
      if (at < 0) {
        data = edge(data)
        break
      }
      data = data.subarray(at)
    }

    this.keep(data)
    return units
  }

  /** How much is being held back — the segment that has not all arrived. */
  pendingBytes(): number {
    return this.pendingLength
  }

  /** Adds the appended bytes to the end of what is held. */
  private hold(bytes: Uint8Array): void {
    this.reserve(this.pendingLength + bytes.byteLength)
    this.pending.set(bytes, this.pendingLength)
    this.pendingLength += bytes.byteLength
  }

  /** Keeps `data` as the new tail. */
  private keep(data: Uint8Array): void {
    if (data.byteLength === 0) {
      // Nothing left over, and the room it was in goes back: a buffer grown to hold one large
      // segment must not stay allocated for the rest of the recording.
      this.pending = EMPTY
      this.pendingLength = 0
      return
    }

    if (data.buffer === this.pending.buffer) {
      // Already in this very buffer, further along it: slide it to the front.
      this.pending.copyWithin(0, data.byteOffset, data.byteOffset + data.byteLength)
    } else {
      this.reserve(data.byteLength)
      this.pending.set(data, 0)
    }

    this.pendingLength = data.byteLength
  }

  /**
   * Room for `needed` bytes. The buffer doubles rather than growing to fit: a segment arriving in
   * slices of sixteen kilobytes would otherwise be copied afresh on every slice, and a large one
   * would cost the square of its own size to assemble.
   */
  private reserve(needed: number): void {
    if (this.pending.byteLength >= needed) return

    const grown = new Uint8Array(
      Math.max(needed, this.pending.byteLength * 2, MIN_CAPACITY),
    )
    grown.set(this.pending.subarray(0, this.pendingLength))
    this.pending = grown
  }
}

/** The tail of a buffer nothing could be made of: only what a header might straddle. */
function edge(data: Uint8Array): Uint8Array {
  return data.subarray(Math.max(0, data.byteLength - HEADER_MARGIN))
}
