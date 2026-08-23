import { topLevelBoxes } from './reader'
import type { Split, StreamUnit } from '../../shared/types'

/**
 * Cutting an ISO BMFF byte stream into the segments it is made of.
 *
 * A stream is one ftyp and moov, then a run of media fragments; the reader next door already
 * walks the boxes and stops at the first one whose body has not all arrived, so the work here is
 * only to say where a segment ends. Two boxes close one: a moov closes an init segment, and an
 * mdat closes a media one. Everything that stands in front of them — styp, sidx, emsg, the moof
 * itself — belongs to the segment they close and travels with it.
 */

/**
 * Top-level box types this reader expects to find a segment starting with, as the four bytes of
 * a type field spell them. Used to tell a header still filling up from a buffer that has lost its
 * place: bytes standing at anything else are not the start of a segment, whatever they are.
 *
 * Held as numbers rather than strings because resynchronisation walks a buffer byte by byte, and
 * a string cut out at every offset along a few megabytes is a few million strings.
 *
 * mdat is deliberately absent. It closes a segment and never opens one, so an mdat at the head of
 * the buffer means the moof that addressed it has been lost — and the samples in it can no longer
 * be placed.
 */
const SEGMENT_HEADS = new Set(
  ['ftyp', 'styp', 'moov', 'moof', 'sidx', 'ssix', 'emsg', 'prft', 'free', 'skip'].map(
    (type) => packed(type),
  ),
)

/** Four characters as the unsigned number their bytes spell. */
function packed(type: string): number {
  return (
    type.charCodeAt(0) * 0x1000000 +
    (type.charCodeAt(1) << 16) +
    (type.charCodeAt(2) << 8) +
    type.charCodeAt(3)
  )
}

/** The four bytes at `at` as one unsigned number. */
function wordAt(data: Uint8Array, at: number): number {
  return data[at]! * 0x1000000 + (data[at + 1]! << 16) + (data[at + 2]! << 8) + data[at + 3]!
}

/**
 * Whether a box header stands at `at`: a type this reader knows and a size that could be one.
 *
 * Zero is "to the end of the file" and one puts the real size in eight further bytes; anything
 * below the header it is part of describes no box at all.
 */
function headerAt(data: Uint8Array, at: number): boolean {
  if (!SEGMENT_HEADS.has(wordAt(data, at + 4))) return false
  const size = wordAt(data, at)
  return size === 1 || size >= 8
}

/**
 * Whether the head of a segment stands at `at`.
 *
 * A header too short to read counts as one: fewer than eight bytes is a segment still arriving,
 * not a stream that has lost its place, and throwing those bytes away would lose the segment
 * behind them.
 */
export function isoUnitStartsAt(data: Uint8Array, at: number): boolean {
  if (at + 8 > data.byteLength) return at < data.byteLength
  return headerAt(data, at)
}

/** The next offset at or after `from` where a segment starts; -1 when there is none in reach. */
export function isoResync(data: Uint8Array, from: number): number {
  for (let at = Math.max(0, from); at + 8 <= data.byteLength; at++) {
    if (headerAt(data, at)) return at
  }
  return -1
}

export function splitIso(data: Uint8Array): Split {
  const units: StreamUnit[] = []
  let consumed = 0

  for (const box of topLevelBoxes(data)) {
    const end = box.start + box.size

    // A box that stated no size of its own was given the rest of the buffer by the reader. In a
    // file that is the last box; in a stream still arriving it is a box whose end has not come,
    // and closing a segment on it would hand out a segment cut in half.
    if (wordAt(data, box.start) === 0) break

    if (box.type === 'moov') units.push({ kind: 'init', bytes: data.subarray(consumed, end) })
    else if (box.type === 'mdat') units.push({ kind: 'media', bytes: data.subarray(consumed, end) })
    else continue

    consumed = end
  }

  return { units, consumed }
}
