import { buildProgressiveMp4 } from '../iso/progressive'
import type { ExportPlan } from './plan'
import type { Located } from '../../shared/types'

/**
 * The plan, plus the bytes it names, as a file.
 *
 * The split is the point: everything that decides what a clip is made of is arithmetic over
 * numbers and can be checked without a byte of media, and everything that touches the media is
 * this function. `bytesOf` is whatever holds the material — a snapshot read out of OPFS, a buffer
 * of segments in a test — and the caller has already made sure it can answer, because a plan that
 * runs out of bytes halfway is a half-written file.
 */
export function assembleMp4(plan: ExportPlan, bytesOf: (at: Located) => Uint8Array): Uint8Array {
  return buildProgressiveMp4(
    plan.tracks.map((track, index) => ({
      // Numbered here and not carried over: two representations of one recording arrive as two
      // init segments that both call their track 1, and a file with two track 1s loses one.
      trackId: index + 1,
      kind: track.kind,
      timescale: track.timescale,
      sampleEntry: track.sampleEntry,
      width: track.width,
      height: track.height,
      samples: track.samples.map((sample) => ({
        bytes: bytesOf(sample.source),
        duration: sample.duration,
        cts: sample.cts,
        sync: sample.sync,
      })),
      skipTicks: track.skipTicks,
    })),
  )
}
