import { childBoxes, topLevelBoxes, type Box } from '../../src/core/iso/reader'

/**
 * The same stream described the other way the standard allows: the sample duration lifted out of
 * every tfhd and stated once, in the trex of the movie header.
 *
 * ISO/IEC 14496-12 §8.8.3 gives a packager three places to say how long a sample lasts, and a
 * reader has to fall through all three — the trun per sample, the tfhd per fragment, the trex per
 * movie. ffmpeg writes the second, so every fixture in this repository states it in the tfhd.
 * dzen.ru writes the third and nothing else: its video truns carry no durations and its tfhd
 * carries no default, and the whole length of every fragment lives in one field of the init
 * segment. Measured there — 92 seconds of picture came out as 6.
 *
 * So the same material is put through the program both ways and has to come out the same. These
 * two turn one description into the other, byte for byte, and nothing else about the stream
 * changes.
 */

const TFHD_BASE_DATA_OFFSET = 0x000001
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008

const TRUN_DATA_OFFSET = 0x000001

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const find = (boxes: Box[], type: string): Box | undefined => boxes.find((b) => b.type === type)

/** Writes `duration` into the trex of `trackId`, leaving the init otherwise as it was. */
export function withTrexDefault(init: Uint8Array, trackId: number, duration: number): Uint8Array {
  const out = init.slice()
  const data = view(out)

  const moov = find(topLevelBoxes(out), 'moov')
  if (!moov) throw new Error('the init segment has no moov')
  const mvex = find(childBoxes(out, moov), 'mvex')
  if (!mvex) throw new Error('the init segment has no mvex')

  for (const trex of childBoxes(out, mvex)) {
    if (trex.type !== 'trex') continue
    const body = trex.start + trex.headerSize
    // version and flags, track_ID, sample_description_index, then default_sample_duration.
    if (data.getUint32(body + 4) !== trackId) continue
    data.setUint32(body + 12, duration)
    return out
  }

  throw new Error(`the init segment has no trex for track ${trackId}`)
}

/**
 * Takes default_sample_duration out of the tfhd of a media segment: the field goes, its flag goes
 * with it, every box around it shrinks by the four bytes, and the trun's offset to its samples is
 * corrected for the move. What the fragment states about its own length afterwards is nothing.
 */
export function withoutTfhdDefault(segment: Uint8Array): Uint8Array {
  const moof = find(topLevelBoxes(segment), 'moof')
  if (!moof) throw new Error('the media segment has no moof')
  const traf = find(childBoxes(segment, moof), 'traf')
  if (!traf) throw new Error('the media segment has no traf')

  const children = childBoxes(segment, traf)
  const tfhd = find(children, 'tfhd')
  if (!tfhd) throw new Error('the media segment has no tfhd')

  const source = view(segment)
  const body = tfhd.start + tfhd.headerSize
  const flags = source.getUint32(body) & 0x00ffffff
  if (!(flags & TFHD_DEFAULT_SAMPLE_DURATION)) throw new Error('the tfhd states no default already')

  // Where the field sits: version and flags, track_ID, then whatever the earlier flags asked for.
  let at = body + 8
  if (flags & TFHD_BASE_DATA_OFFSET) at += 8
  if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) at += 4

  const out = new Uint8Array(segment.byteLength - 4)
  out.set(segment.subarray(0, at), 0)
  out.set(segment.subarray(at + 4), at)

  const data = view(out)
  data.setUint32(body, (source.getUint32(body) & 0xff000000) | (flags & ~TFHD_DEFAULT_SAMPLE_DURATION))

  // Three boxes lost four bytes each, and each states its own size.
  for (const box of [moof, traf, tfhd]) data.setUint32(box.start, box.size - 4)

  // trun addresses its samples from the start of the moof, and the moof is four bytes shorter.
  // Boxes standing behind the removed field moved with it; those in front of it did not.
  for (const child of children) {
    if (child.type !== 'trun') continue
    const trunBody = (child.start > at ? child.start - 4 : child.start) + child.headerSize
    if (!(data.getUint32(trunBody) & TRUN_DATA_OFFSET)) continue
    data.setInt32(trunBody + 8, data.getInt32(trunBody + 8) - 4)
  }

  return out
}
