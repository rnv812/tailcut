import type { Span, Zone } from '../../src/core/timeline/lanes'
import type { Clip } from '../../src/core/edit/clip'
import type { EditContext } from '../../src/core/edit/context'

export const FPS = 25
/** One frame, and the smallest step anything in the editor takes. */
export const FRAME = 1 / FPS

export const RUNS: Span[] = [
  { start: 0, end: 4 },
  { start: 6, end: 10 },
]

export const ZONES: Zone[] = [
  { start: 0, end: 4, representation: '480p', codec: 'avc1', width: 854, height: 480 },
  { start: 6, end: 10, representation: '720p', codec: 'avc1', width: 1280, height: 720 },
]

/**
 * Frame boundaries: 101 per run, the last of each being the end of the run (see grid.ts).
 *
 * Rounded to the millisecond on purpose. `6 + 99/25` is not the double the literal `9.96` is, and
 * a fixture whose numbers cannot be written down in a test is a fixture that hides its own bugs.
 */
const round = (value: number): number => Math.round(value * 1000) / 1000
const BOUNDARIES = RUNS.flatMap((run) =>
  Array.from({ length: 101 }, (_, i) => round(run.start + i / FPS)),
)

/** Four seconds of 480p, a two-second hole, four seconds of 720p, at 25 fps. */
export const ctx: EditContext = {
  frames: Float64Array.from(BOUNDARIES),
  keyframes: Float64Array.from([0, 2, 6, 8]),
  fps: FPS,
  runs: RUNS,
  zones: ZONES,
  duration: 10,
  title: 'A page about cats',
  // The open representation is the 480p one the sample clip lives in — the picture a crop of
  // this material would be a rectangle of.
  frameSize: { width: 854, height: 480 },
  newClipFormat: 'mp4',
}

export const clip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'c1',
  name: 'One',
  in: 1,
  out: 3,
  representation: '480p',
  sound: true,
  crop: null,
  format: 'mp4',
  mode: 'original',
  ...overrides,
})

/**
 * The same ten seconds recorded at one quality throughout: two runs, one zone over both.
 *
 * This is the ordinary case — a page that paused and carried on — and it is the case the two
 * ideas get confused in. Here the hole is a break in `runs` and no break at all in `zones`.
 */
export const oneQuality: EditContext = {
  ...ctx,
  zones: [{ start: 0, end: 10, representation: '480p', codec: 'avc1', width: 854, height: 480 }],
}
