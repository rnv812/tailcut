import type { ExportFormat } from '../../shared/settings'
import type { Span, Zone } from '../timeline/lanes'
import type { ViewBounds } from '../timeline/view'

/**
 * Everything an edit needs to know about the material.
 *
 * Not state: it is derived from the snapshot when a representation is opened, it never changes
 * under an action, and it never goes into the history — a frame table copied into every undo step
 * would double the memory of the tab for nothing. Everything in it is plain data, so the whole
 * model is testable from a dozen numbers.
 *
 * **Two different sets of material live in here, and the split is deliberate.** `frames`, `runs`
 * and `duration` describe the visible monitor. Usually that is one representation; an ABR
 * composite can traverse every representation that belonged to the same SourceBuffer.
 * `keyframes`, `fps`, `frameSize` and `zones` describe only the selected representation, because
 * its bytes and geometry are the only source an edit may export.
 *
 * The consequences are named rather than discovered. A composite playhead can stand on a frame
 * owned by another representation while `zoneAt` answers nothing. That stretch is viewable, not
 * editable. `startClip` refuses it, and normalization keeps every existing clip inside one of the
 * selected representation's zones. Nothing downstream may infer edit ownership from a frame.
 */
export interface EditContext {
  /** Frame boundaries of the visible monitor, ascending (see timeline/grid.ts). */
  frames: Float64Array
  /** Times of the selected representation's sync samples. Copy-boundary checks read it. */
  keyframes: Float64Array
  /** Frames a second in the selected representation, used for export geometry and timecodes. */
  fps: number
  /**
   * Coded size of the **selected representation**: what a crop is a rectangle of.
   *
   * Beside `keyframes` and `fps` rather than beside `duration`, because all three describe the
   * source an edit exports, not every picture the monitor can show. Where it comes from is
   * `deriveMaterial`, off the selected picture — see why a zero here would be a crop that silently
   * collapses to nothing.
   */
  frameSize: { width: number; height: number }
  /**
   * Initial clip format, read once when the editor tab opens.
   *
   * Here for the same reason `nameTemplate` is here: a new clip is made by the reducer, which is
   * pure and knows nothing but this context, and a setting that never reaches the reducer is a
   * setting that does nothing. When absent, it defaults to `'mp4'`.
   */
  newClipFormat: ExportFormat
  /** Continuous stretches the visible monitor can play, in time order. */
  runs: Span[]
  /** Editable stretches owned by the selected representation, in time order. */
  zones: Zone[]
  /** End of the visible monitor, in seconds. */
  duration: number
  /** Title of the page: clips are named after it. */
  title: string
  /**
   * The user's file-name template, read once when the tab opens. When absent, naming builds the
   * file name from the title and timecode.
   *
   * It sits here rather than being read where a clip is named because naming happens in the
   * reducer, which is pure and knows nothing but this context. Absent and empty are two different
   * things: absent is a tab opened before the settings came back, empty is a field the user
   * cleared, and `clipName` answers the second with the title alone.
   */
  nameTemplate?: string
  /** Host of the page the recording came from: the `{host}` a template may ask for. */
  host?: string
}

/** The context of an editor with nothing open yet. Total functions need a total starting point. */
export const EMPTY_CONTEXT: EditContext = {
  frames: new Float64Array(),
  keyframes: new Float64Array(),
  fps: 0,
  frameSize: { width: 0, height: 0 },
  newClipFormat: 'mp4',
  runs: [],
  zones: [],
  duration: 0,
  title: '',
}

export function zoneAt(ctx: EditContext, time: number): Zone | undefined {
  return ctx.zones.find((zone) => time >= zone.start && time <= zone.end)
}

export function runAt(ctx: EditContext, time: number): Span | undefined {
  return ctx.runs.find((run) => time >= run.start && time <= run.end)
}

export function viewBounds(ctx: EditContext): ViewBounds {
  return { duration: ctx.duration, fps: ctx.fps }
}
