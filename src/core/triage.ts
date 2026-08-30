export interface VideoSignals {
  /** Element width on screen in CSS pixels. */
  widthPx: number
  muted: boolean
  loop: boolean
  controls: boolean
  /** The element is on screen and its tab is visible. */
  visible: boolean
  /**
   * Whether the video is playing now.
   *
   * `triage` deliberately does not read this field. The watcher increments `playedSeconds` only
   * while a video is playing and visible, so pausing already freezes elapsed-time accumulation.
   * Making the verdict depend on `playing` as well would revoke a promotion when a qualified
   * video is paused, and would suppress immediate rejection before the grace period.
   *
   * The field remains part of the signals because the watcher gathers `VideoSignals` as a unit
   * and uses this value to decide whether to increment elapsed time.
   */
  playing: boolean
  /** Seconds for which the element has actually played. */
  playedSeconds: number
  /**
   * Something else on this page is playing the sound for this element.
   *
   * The one signal here that is not about the element itself, and it is here because the banner
   * rule below cannot be right without it. That rule reads "muted, looping, no controls" as
   * decoration, and it is correct about nearly everything on the web — but it is exactly the
   * shape of one half of a work whose other half is an `<audio>` playing beside it: a
   * short silent loop of picture under a long soundtrack, which is what one site of the seven
   * surveyed is made of. Such a picture is not silent at all; the sound is simply in another
   * element, and the page is playing it.
   *
   * It says nothing about width or watching, and it removes none of the other refusals: a
   * looping silent picture on a page with music behind it still has to be a real player of a real
   * size, watched through the whole grace period, before anything is kept of it.
   */
  soundApart: boolean
  /**
   * A CDM is attached to this element: the page called `setMediaKeys` with actual keys.
   *
   * This signal applies only to this element. Page-wide refusal is separate because protection is
   * a property of the material. It is detected in the bytes (`src/core/container.ts`) or through
   * the element's `encrypted` event (`src/page/watcher.ts`); either result overrides triage and
   * discards the entire page.
   *
   * A page merely asking the browser about a key system does not count. One measured CNN page
   * made sixteen such probes over an unencrypted stream; asking does not make the material
   * protected. An attached CDM, however, means this element is preparing to play protected media
   * and should not be recorded.
   */
  hasDrm: boolean
}

export interface TriageConfig {
  gracePeriodSeconds: number
  minWidthPx: number
  recordMuted: boolean
}

export const BALANCED: TriageConfig = {
  gracePeriodSeconds: 6,
  minWidthPx: 320,
  recordMuted: true,
}

export const LOOSE: TriageConfig = {
  gracePeriodSeconds: 3,
  minWidthPx: 200,
  recordMuted: true,
}

export const STRICT: TriageConfig = {
  gracePeriodSeconds: 12,
  minWidthPx: 480,
  recordMuted: false,
}

export type TriageVerdict = 'reject' | 'hold' | 'promote'

export function triage(signals: VideoSignals, config: TriageConfig): TriageVerdict {
  if (signals.hasDrm) return 'reject'
  // NaN means the width has not been measured: the element has no layout box and
  // getBoundingClientRect returned no usable number. An unverified minimum is a rejection, or an
  // unmeasured element would bypass the width filter. Fractional values are compared as-is, so
  // 319.6 pixels remains below a 320-pixel threshold.
  if (Number.isNaN(signals.widthPx) || signals.widthPx < config.minWidthPx) return 'reject'
  if (!signals.visible) return 'reject'

  // A muted loop without controls is a banner rather than a video unless its sound is playing in
  // another element. In that case the page has split picture and sound, so this is half of the
  // work rather than decoration.
  if (signals.muted && signals.loop && !signals.controls && !signals.soundApart) return 'reject'
  if (signals.muted && !config.recordMuted) return 'reject'

  // Use accumulated time alone. A pause is already represented by playedSeconds not increasing;
  // see VideoSignals.playing.
  if (signals.playedSeconds >= config.gracePeriodSeconds) return 'promote'

  return 'hold'
}
