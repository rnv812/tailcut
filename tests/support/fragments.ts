import { childBoxes, topLevelBoxes, type Box } from '../../src/core/iso/reader'
import { concatBytes, fullBoxOf, zeroes } from '../../src/core/iso/writer'

/**
 * Material shaped the way a real packager sends it, built out of the fixtures.
 *
 * What ffmpeg writes is not the whole of what the web serves, and the difference is where the
 * defects live. Everything here takes a fixture segment and gives back the same segment as some
 * site would have sent it — same frames, same timing, one more thing in the container.
 */

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const typeIn = (boxes: Box[], type: string): Box | undefined => boxes.find((b) => b.type === type)

/**
 * The same media segment with a sample-dependency table added to every traf of it.
 *
 * `sdtp` is legal inside a traf (14496-12 §8.6.4) and rutube's packager writes one into every
 * fragment it sends. Nothing here reads it and nothing here writes it — the muxer copies a
 * fragment whole, byte for byte — so what this is for is the file that comes out the other end:
 * a saved rutube clip carries one such table per fragment, and ffmpeg says "Duplicated SDTP atom"
 * over every one after the first.
 *
 * The table itself says nothing: every field of every sample is left at zero, which in that box
 * is the value for "unknown". Filling it in with anything else would be inventing facts about
 * somebody else's frames.
 *
 * Adding a box to a traf is not free, and the arithmetic below is exactly what dropping one from
 * the save path would have cost: the traf grows, the moof grows, and every trun has to be
 * corrected, because a trun addresses its samples from the start of the moof and the mdat has
 * moved that much further away.
 */
export function withSdtp(segment: Uint8Array): Uint8Array {
  const moof = typeIn(topLevelBoxes(segment), 'moof')!

  const added = childBoxes(segment, moof)
    .filter((box) => box.type === 'traf')
    .map((traf) => {
      const trun = typeIn(childBoxes(segment, traf), 'trun')!
      const body = trun.start + trun.headerSize
      // Without a data offset there would be nothing to correct, and this would be quietly
      // building a segment of a shape no packager sends.
      if (!(view(segment).getUint32(body) & 0x000001)) {
        throw new Error('the trun of this fixture states no data offset')
      }
      return { traf, trun, box: fullBoxOf('sdtp', 0, 0, zeroes(view(segment).getUint32(body + 4))) }
    })

  const grown = added.reduce((total, one) => total + one.box.byteLength, 0)

  const parts: Uint8Array[] = []
  let cut = 0
  for (const { traf, trun, box } of added) {
    const end = traf.start + traf.size
    const piece = segment.slice(cut, end)
    const inside = view(piece)

    inside.setUint32(traf.start - cut, traf.size + box.byteLength)
    const offsetAt = trun.start - cut + trun.headerSize + 8
    inside.setInt32(offsetAt, inside.getInt32(offsetAt) + grown)

    parts.push(piece, box)
    cut = end
  }
  parts.push(segment.slice(cut))

  const out = concatBytes(parts)
  view(out).setUint32(moof.start, moof.size + grown)
  return out
}
