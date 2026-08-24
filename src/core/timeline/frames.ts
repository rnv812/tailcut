import { editOffset, sampleRunOf, trackDefaults, type PlacedSegment } from '../iso/samples'
import type { Located } from '../../shared/types'

export interface Frame {
  /**
   * When the frame is shown, in seconds of the session's presentation timeline — the convention
   * every module of this program states time in: (pts − editOffset) / timescale.
   */
  pts: number
  /**
   * The same frame in the file the editor plays, in seconds.
   *
   * Equal to `pts` as built: the two clocks part company only where an export plan closes a hole
   * or hides a head, and only the plan knows by how much. `retimeToPlan` is what fills this in.
   */
  out: number
  duration: number
  sync: boolean
  /** Where the bytes of this frame live in whatever byte source the segments came from. */
  source: Located
}

export interface FrameInput {
  /** Init segment of the representation, ISO BMFF. */
  init: Uint8Array
  /** Which ISO track inside it the frames belong to. */
  trackId: number
  /** Ticks per second of that track. */
  timescale: number
  /** Media segments, with the place of their bytes in the source they were read out of. */
  segments: readonly PlacedSegment[]
}

/**
 * The shape of an export plan's track, stated structurally.
 *
 * `PlannedTrack` from `core/export/plan.ts` satisfies it, and this module does not import it: the
 * frame table is a function of the containers and nothing else, and the arrow between the two
 * modules has to point one way only.
 */
export interface PlannedTiming {
  timescale: number
  skipTicks: number
  samples: ReadonlyArray<{ source: Located; duration: number; cts: number }>
}

/**
 * The frames of one representation, in the order they are shown.
 *
 * Built from the containers and not from the decoder: `<video>` can say which frame it landed on
 * and never which frames there are. This is the only source of that, and everything downstream —
 * the frame number in the readout, the grid the handles snap to, stepping, the keyframes an entry
 * point is chosen from — reads it.
 *
 * A pure function of an init segment and some media segments, which is why it lives here beside
 * the sample index rather than in the editor: the export plan needs the same table the player
 * does, and a second implementation would be a second chance to disagree about the edit offset.
 *
 * Which is why the walk itself is not here. `sampleRunOf` is the one place segments become
 * samples, and a recording that overlaps itself — an ordinary re-watch — is thinned there, by
 * decode time in ticks, once for both readers. This table counted the repeats out by comparing
 * seconds while the index a clip is cut from kept them, and the two answers were six seconds and
 * eight. How many samples the overlap cost is `SampleRun.dropped`, and the export index is where
 * it is kept (`SourceTrack.dropped`): a table of what is shown has nobody to tell.
 */
export function framesOf(input: FrameInput): Frame[] {
  const { timescale } = input
  if (!(timescale > 0)) return []

  // The edit list is not junk: it compensates the delay of B-frames, of AAC priming and of Opus
  // pre-roll, the player takes it off every time, and a table built without subtracting it sits
  // exactly that delay away from what <video> reports — 83 ms on our own fixture.
  const edit = editOffset(input.init, input.trackId)
  const run = sampleRunOf({
    segments: input.segments,
    trackId: input.trackId,
    defaults: trackDefaults(input.init),
  })

  const frames: Frame[] = run.samples.map((sample) => {
    const pts = (sample.pts - edit) / timescale
    return {
      pts,
      out: pts,
      duration: sample.duration / timescale,
      sync: sample.sync,
      source: sample.source,
    }
  })

  // Decode order is not display order: composition offsets put B-frames out of it, and a table of
  // frames is a table of what is shown and when.
  frames.sort((a, b) => a.pts - b.pts)

  return frames
}

/**
 * The same frames, timed as the file an export plan describes will hold them.
 *
 * The preview the editor plays is written by that plan and by the clip writer, so the two clocks
 * part company wherever the plan closed a hole (§8.2) or hid a head. The plan is the only place
 * that knows by how much, and the only place a second is rounded into a tick: this walks the
 * planned samples in decode order, adds their durations up on the timeline the writer will lay
 * down, and hands each frame the second the file will show it at. Nothing here rounds anything.
 *
 * A frame the plan does not carry is dropped: a recording may start mid-group, and a frame with no
 * keyframe in front of it is not in the file to be stepped onto.
 *
 * `out` comes out ascending wherever `pts` is, because a plan preserves composition order; the
 * binary search in `indexAtOut` relies on exactly that.
 */
export function retimeToPlan(frames: readonly Frame[], track: PlannedTiming): Frame[] {
  if (!(track.timescale > 0)) return []

  const shown = new Map<number, number>()
  let decode = 0
  for (const sample of track.samples) {
    shown.set(sample.source.at, (decode + sample.cts - track.skipTicks) / track.timescale)
    decode += sample.duration
  }

  const timed: Frame[] = []
  for (const frame of frames) {
    const out = shown.get(frame.source.at)
    if (out === undefined) continue
    timed.push({ ...frame, out })
  }

  return timed
}

export class FrameTable {
  private constructor(private readonly rows: Frame[]) {}

  static of(frames: Frame[]): FrameTable {
    return new FrameTable(frames)
  }

  count(): number {
    return this.rows.length
  }

  at(index: number): Frame | undefined {
    return this.rows[index]
  }

  frames(): readonly Frame[] {
    return this.rows
  }

  /** The frame shown at this moment of the session; -1 before the first of them. */
  indexAt(media: number): number {
    return this.lastNotAfter((frame) => frame.pts, media)
  }

  /** The same question asked in the file's own clock — what requestVideoFrameCallback reports. */
  indexAtOut(out: number): number {
    return this.lastNotAfter((frame) => frame.out, out)
  }

  private lastNotAfter(time: (frame: Frame) => number, at: number): number {
    let low = 0
    let high = this.rows.length - 1
    let found = -1

    while (low <= high) {
      const middle = (low + high) >> 1
      if (time(this.rows[middle]!) <= at) {
        found = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }

    return found
  }

  /** The nearest sync sample at or before the frame: the entry point of an edit list (§8.2). */
  syncBefore(index: number): number {
    for (let at = Math.min(index, this.rows.length - 1); at >= 0; at--) {
      if (this.rows[at]!.sync) return at
    }
    return -1
  }

  keyframeTimes(): Float64Array {
    return Float64Array.from(this.rows.filter((frame) => frame.sync).map((frame) => frame.pts))
  }

  /**
   * The currentTime to hand the preview so that this frame, and not its neighbour, is on screen.
   *
   * The middle of the frame and not its boundary. Measured over fifteen clips and twelve points in
   * each: the boundary misses every time and always into the frame before, the middle hits every
   * time — including the first frame, the last frame, and ninety frames deep into a group.
   *
   * **A currentTime, and never a way to name a frame to anything else.** The half frame is a cure
   * for how a browser rounds a seek and for nothing besides: hand it to a filter that selects the
   * first frame at or after an instant — ffmpeg's `select='gte(t,…)'` — and it lands one frame
   * late, every time, on every frame. What names a frame outside the player is its index.
   *
   * An index off the end is pulled back onto the material: the caller is a keyboard, and the end
   * of a recording is a wall rather than an error.
   */
  seekTimeOf(index: number): number {
    const frame = this.rows[Math.min(Math.max(index, 0), this.rows.length - 1)]
    return frame ? frame.out + frame.duration / 2 : 0
  }

  /**
   * Frames a second, off the median frame length. The mean is dragged about by the odd long frame
   * at the end of a segment, and a constant is wrong on 24000/1001 material.
   */
  fps(): number {
    const lengths = this.rows
      .map((frame) => frame.duration)
      .filter((length) => length > 0)
      .sort((a, b) => a - b)

    const middle = lengths[lengths.length >> 1]
    return middle && middle > 0 ? 1 / middle : 0
  }
}
