import { boundaryIndexAt, quantize, shiftBy } from '../timeline/grid'
import type { Zone } from '../timeline/lanes'
import type { EditContext } from './context'

export interface Clip {
  id: string
  name: string
  /** Media time of the session, seconds. Both edges sit on frame boundaries and in < out. */
  in: number
  out: number
  /** §8.3: a clip lives inside one representation, and this names it. */
  representation: string
  sound: boolean
  /** Stage 4: cropping. The inspector draws it disabled and says why. */
  crop: null
  format: 'mp4'
}

export interface Marker {
  id: string
  time: number
  label: string
}

/** The shortest a clip may be: one frame to enter on, one to leave on. */
export const MIN_CLIP_FRAMES = 2

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

/**
 * The zone a clip belongs to.
 *
 * A representation can hold the screen twice — quality that flaps goes 480p, 720p, 480p — so the
 * name alone does not point at one stretch. The nearest stretch of that name to the in point does.
 *
 * A zone is a stretch of one quality and nothing else: it is not ended by a hole in the recording
 * (lanes.ts). So the bounds below are the bounds of a **quality**, and a clip is free to run
 * across a gap inside one — which is what §8.2 collapses on the way to the file.
 */
function homeZone(clip: Clip, ctx: EditContext): Zone | undefined {
  let best: Zone | undefined
  let bestDistance = Number.POSITIVE_INFINITY

  for (const zone of ctx.zones) {
    if (zone.representation !== clip.representation) continue
    const distance =
      clip.in < zone.start ? zone.start - clip.in : clip.in > zone.end ? clip.in - zone.end : 0
    if (distance < bestDistance) {
      best = zone
      bestDistance = distance
    }
  }

  return best
}

/**
 * The change of quality a clip is standing against, or null when it is standing against none.
 *
 * The inspector asks this to know whether it has anything to say, and what it says is one line
 * with no button behind it: the handle stops here and cannot be made to go further, because two
 * resolutions in one track need an encoder (§8.3, stage 4). The zone that comes back is the one
 * on the other side, and it is there so the line can name the quality instead of gesturing at
 * it. A clip whose edges are nowhere near a boundary gets null and no line.
 */
export function heldByQuality(clip: Clip, ctx: EditContext): Zone | null {
  const home = homeZone(clip, ctx)
  if (!home) return null

  const after = ctx.zones.find((zone) => zone.start >= home.end)
  if (after && clip.out >= home.end) return after

  const before = ctx.zones.filter((zone) => zone.end <= home.start).pop()
  if (before && clip.in <= home.start) return before

  return null
}

/**
 * A clip put right: both edges on frame boundaries, inside its quality, long enough to be a clip.
 *
 * `moved` names the edge that has just been dragged — it is the one that gives way when the two
 * meet. Returns the clip it was given when there was nothing to correct, which is what lets the
 * reducer answer "nothing changed" by identity.
 *
 * The bounds are the bounds of the **zone**, which is a stretch of one quality and is not ended
 * by a hole: a clip may run across a gap freely, and it is a change of quality — not a pause in
 * the recording — that stops a handle. That stop is final in this stage: a file with two
 * resolutions inside needs an encoder to bring them to one, so §8.3 waits for stage 4 and the
 * inspector explains the wall rather than offering a way through it.
 */
export function normalizeClip(clip: Clip, ctx: EditContext, moved: 'in' | 'out' = 'out'): Clip {
  if (!ctx.frames.length) {
    const low = Math.min(clip.in, clip.out)
    const high = Math.max(clip.in, clip.out)
    return low === clip.in && high === clip.out ? clip : { ...clip, in: low, out: high }
  }

  const zone = homeZone(clip, ctx)
  const low = zone ? zone.start : 0
  const high = zone ? zone.end : ctx.duration

  let start = quantize(ctx.frames, clamp(clip.in, low, high))
  let end = quantize(ctx.frames, clamp(clip.out, low, high))

  // Frames are counted by index rather than by subtracting times: a gap in the middle makes the
  // difference of two times say nothing about how many frames are between them.
  const frames = boundaryIndexAt(ctx.frames, end) - boundaryIndexAt(ctx.frames, start)
  if (frames < MIN_CLIP_FRAMES) {
    // Clamped into the zone a second time: with the playhead on the last frame of a zone there is
    // nowhere to give way to, and the clip comes out empty — which is what the caller checks for
    // before adding it. Growing past the zone instead would make a clip that spans a change of
    // quality nobody asked to span.
    if (moved === 'in') {
      start = quantize(ctx.frames, Math.max(low, shiftBy(ctx.frames, end, -MIN_CLIP_FRAMES)))
    } else {
      end = quantize(ctx.frames, Math.min(high, shiftBy(ctx.frames, start, MIN_CLIP_FRAMES)))
    }
  }

  return start === clip.in && end === clip.out ? clip : { ...clip, in: start, out: end }
}

const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))

/** A timecode a file name can carry: dots, not colons. */
export function stamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const head = `${pad(Math.floor((whole % 3600) / 60))}.${pad(whole % 60)}`
  return hours > 0 ? `${pad(hours)}.${head}` : head
}

/** As much of a page title as a name can carry. */
const TITLE_LIMIT = 40

function shortTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim()
  if (!clean) return 'Clip'
  if (clean.length <= TITLE_LIMIT) return clean
  const cut = clean.slice(0, TITLE_LIMIT)
  const space = cut.lastIndexOf(' ')
  return (space > TITLE_LIMIT / 2 ? cut.slice(0, space) : cut).trim()
}

/** The name a new clip is born with: the page it came from and when it starts. */
export function clipName(input: { title: string; at: number; taken: Iterable<string> }): string {
  const base = `${shortTitle(input.title)} ${stamp(input.at)}`
  const taken = new Set(input.taken)
  if (!taken.has(base)) return base

  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})`
    if (!taken.has(candidate)) return candidate
  }

  return `${base} (${Date.now()})`
}
