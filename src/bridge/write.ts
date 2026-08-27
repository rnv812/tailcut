import { assembleMp4 } from '../core/export/assemble'
import { planRanges, readsFor } from '../core/export/ranges'
import { bytesFrom } from '../core/export/source'
import { muxFragmentedMp4 } from '../core/mux'
import type { SaveSource } from './session-store'

/**
 * The one place a save becomes bytes.
 *
 * Two kinds of material reach it and the difference between them is where the bytes are, which is
 * the only difference there ever was: captured segments are already in this frame, and the
 * material of a plain source is still on somebody's server. Everything above this — the popup,
 * the badge, the frame addressing, the summary — asks neither which it is looking at.
 *
 * Null when nothing could be written. For a captured session that is settled before we get here
 * (the plan holds no material); for a plain one it is a read that was refused, and that can only
 * be known by trying.
 */
export async function writeSaveFile(source: SaveSource): Promise<Uint8Array | null> {
  if (source.kind === 'captured') {
    return source.tracks.length > 0 ? muxFragmentedMp4(source.tracks) : null
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
