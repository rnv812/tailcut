import { assembleMp4 } from '../core/export/assemble'
import { planRanges, readsFor } from '../core/export/ranges'
import { saveAllMp4 } from '../core/export/save'
import { bytesFrom } from '../core/export/source'
import type { SaveSource } from './session-store'

/**
 * The one place a save becomes bytes.
 *
 * Two kinds of material reach it and the difference between them is where the bytes are, which is
 * the only difference there ever was: captured segments are already in this frame, and the
 * material of a plain source is still on somebody's server. Everything above this — the popup,
 * the badge, the frame addressing, the summary — asks neither which it is looking at.
 *
 * One writer for both, and for the clips the editor exports besides: the captured path used to
 * copy its fragments into a fragmented file whole, which no edit list survives (§8.2) and which
 * carries no sample tables to seek by. Both roads now end in `buildProgressiveMp4`.
 *
 * Null when nothing could be written. A captured session may hold no material at all, and it may
 * hold material the parser can make nothing of — an init whose sample entry it does not know,
 * segments it could not read — and the writer answers both with no bytes. A download of zero
 * bytes would be worse than a refusal: the user gets a file no player opens and no word about it.
 * For a plain source it is a read that was refused, and that can only be known by trying.
 */
export async function writeSaveFile(source: SaveSource): Promise<Uint8Array | null> {
  if (source.kind === 'captured') {
    const file = saveAllMp4(source.tracks)
    return file.byteLength > 0 ? file : null
  }

  const plan = source.plan
  if (plan.tracks.length === 0) return null

  // Few and large rather than many and small: the samples of one clip lie in one stretch of the
  // mdat, so this is a single read on an ordinary file. See core/export/ranges.ts for the
  // arithmetic behind bridging a hole instead of making another request.
  const reads = readsFor(planRanges(plan))
  const buffers: Uint8Array[] = []

  try {
    for (const at of reads) {
      const answer = await source.read(at.at, at.length)
      // Short of what was asked for: the file has changed under us, or the host stopped part way.
      // A file written out of it would hold a frame of somebody else's bytes.
      if (answer.bytes.byteLength < at.length) return null
      buffers.push(answer.bytes)
    }
  } catch {
    return null
  }

  return assembleMp4(plan, bytesFrom(reads, buffers))
}
