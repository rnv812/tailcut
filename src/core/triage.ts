export interface VideoSignals {
  /** ширина элемента на экране в CSS-пикселях */
  widthPx: number
  muted: boolean
  loop: boolean
  controls: boolean
  /** элемент в видимой области и вкладка не скрыта */
  visible: boolean
  playing: boolean
  /** сколько секунд элемент реально воспроизводился */
  playedSeconds: number
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
  if (signals.widthPx < config.minWidthPx) return 'reject'
  if (!signals.visible) return 'reject'

  // Беззвучное, зациклённое и без панели управления — это баннер, а не видео.
  if (signals.muted && signals.loop && !signals.controls) return 'reject'
  if (signals.muted && !config.recordMuted) return 'reject'

  if (signals.playedSeconds >= config.gracePeriodSeconds) return 'promote'

  return 'hold'
}
