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
 * **Two different sets of material live in here, and the split is deliberate.** `frames`,
 * `keyframes` and `fps` describe the **open representation** — the one `materialOf` chose and
 * `buildPreview` assembled, the only one there are frames of. `runs`, `zones` and `duration`
 * describe the **whole recording**, every representation of it, because that is what the
 * timeline draws and what the inspector counts: a page that dropped to 480p for a minute did
 * record that minute, and hiding it would be a lie about the recording.
 *
 * The consequences are named rather than discovered. `ctx.duration` can be longer than anything
 * the preview can show. `zoneAt`/`runAt` can answer about a stretch the playhead cannot reach —
 * `seek` quantises onto `frames`, so it never lands there, and `normalizeClip` clamps a clip
 * into its own zone, so a clip cannot be stretched across it either. `startClip` may take a
 * `run.end` from beyond the open representation; `normalizeClip` pulls it back the same way.
 * Nothing downstream is allowed to assume the two sets agree, and no field is quietly
 * reinterpreted to make them.
 */
export interface EditContext {
  /** Frame boundaries of the **open representation**, ascending (see timeline/grid.ts). */
  frames: Float64Array
  /** Times of the sync samples: `FrameTable.keyframeTimes()`. Snapping reads it. */
  keyframes: Float64Array
  /** Frames a second of the open representation. */
  fps: number
  /**
   * Coded size of the **open representation**: what a crop is a rectangle of.
   *
   * Beside `frames`, `keyframes` and `fps` rather than beside `duration`, and for the same reason
   * they are: it describes the one representation there are frames of, not the whole recording.
   * Where it comes from is `deriveMaterial`, off the file the player is playing — see the next
   * step, and see why a zero here would be a crop that silently collapses to nothing.
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
  /** Continuous stretches of the picture across **all** representations, in time order. */
  runs: Span[]
  /** Quality zones of the picture across **all** representations, in time order. */
  zones: Zone[]
  /** End of the whole recording, seconds — not of the open representation. */
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
