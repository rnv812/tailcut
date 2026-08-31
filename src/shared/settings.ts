import { BALANCED, LOOSE, STRICT, type TriageConfig } from '../core/triage'

/**
 * Everything the user can decide, as data. No chrome.*, no effects, no defaults hidden anywhere
 * else: defaults are written once here, and everything that reads a setting reads this shape.
 *
 * One key holds all of it in chrome.storage.local (see settings-store.ts). Not `sync`: an item
 * there is capped at 8192 bytes, which a list of domains outgrows, and ninety quick writes in a
 * minute end in MAX_WRITE_OPERATIONS_PER_MINUTE — one drag of a slider. Not five keys either:
 * five in one `set()` cost the same 0.5 ms as one, and one key means one `newValue` in
 * `onChanged` rather than five arriving in no particular order.
 */
export const SETTINGS_KEY = 'settings'
/** Bump only when the material terms change and require a fresh acknowledgement. */
export const LEGAL_VERSION = 1

export type RecordingMode = 'all' | 'allowlist' | 'off'
export type ExportFormat = 'mp4' | 'webp'
export type ExportCodec = 'auto' | 'hevc' | 'h264'
export type ExportQuality = 'high' | 'medium' | 'low'
export type DetectionPreset = 'loose' | 'balanced' | 'strict' | 'custom'

export interface RecordingSettings {
  mode: RecordingMode
  /** How far back a session may be rewound, in media seconds. */
  bufferSeconds: number
  /** Hosts recorded in `allowlist` mode; a host stands for itself and its subdomains. */
  allow: string[]
  /** Hosts never recorded, in any mode. */
  deny: string[]
}

export interface HistorySettings {
  /** `Save recordings to disk`. Off means nothing new is written; existing history stays. */
  toDisk: boolean
  keepDays: number
  ceilingBytes: number
}

export interface ExportSettings {
  format: ExportFormat
  codec: ExportCodec
  rewriteHead: boolean
  nameTemplate: string
  askWhere: boolean
  quality: ExportQuality
}

export interface LegalSettings {
  acceptedVersion: number
  acceptedAt: number
}

export interface Settings {
  recording: RecordingSettings
  /**
   * Structurally a TriageConfig, and that is the point: the watcher hands this straight to
   * triage() with no translation between the two. A layer of renaming here would be the one place
   * a preset could quietly become another preset.
   */
  detection: TriageConfig
  history: HistorySettings
  export: ExportSettings
  legal: LegalSettings
}

/**
 * The settings-side defaults. A gigabyte is 1024³ bytes here and everywhere else in this
 * program; see `formatBytes`.
 *
 * The table also says a new clip starts in `Original`. That is an edit-model default rather than
 * a setting: `startClip` writes it into `Clip.mode`, and the inspector edits it per clip.
 */
export const DEFAULTS: Settings = {
  recording: { mode: 'all', bufferSeconds: 180, allow: [], deny: [] },
  detection: { ...BALANCED },
  history: { toDisk: true, keepDays: 7, ceilingBytes: 4 * 1024 ** 3 },
  export: {
    format: 'mp4',
    codec: 'auto',
    rewriteHead: false,
    // The default clip name combines the page title with its starting timecode. Written as a
    // template so that the setting has something to change.
    nameTemplate: '{title} {in}',
    askWhere: false,
    quality: 'high',
  },
  legal: { acceptedVersion: 0, acceptedAt: 0 },
}

/**
 * What a number may be, whoever stored it.
 *
 * Not for the interface — the sliders have their own steps — but for the merge: the settings are
 * read out of storage, which another build wrote, and a buffer of a million seconds would be a
 * frame holding every byte of a stream until the tab fell over.
 */
export const LIMITS = {
  bufferSeconds: { min: 15, max: 1_800 },
  keepDays: { min: 1, max: 90 },
  ceilingBytes: { min: 256 * 1024 * 1024, max: 64 * 1024 ** 3 },
  gracePeriodSeconds: { min: 0, max: 60 },
  minWidthPx: { min: 0, max: 1_920 },
} as const

/**
 * What a second of an ordinary 1080p stream weighs, in bits: 6 Mbit/s, the rate the large sites
 * serve it at.
 *
 * One number in one place, because two things read it and they must not come to disagree: the
 * settings page shows what a buffer of the chosen length will cost in memory (until the history
 * has a real rate to offer, which is better), and the frame sizes its own memory ceiling by it.
 * A page promising three minutes for 135 MB beside a frame that would keep 512 MB whatever the
 * setting said is exactly the disagreement this removes.
 */
export const REFERENCE_BITS_PER_SECOND = 6_000_000

/**
 * Room a document keeps for the sessions beside the one the buffer length promises.
 *
 * The other half of `memoryCeilingFor`, and the half that does what the ceiling exists for: a
 * page opening sessions without end — a feed, an autoplaying playlist — stops here instead of
 * taking the tab down with it. Three more buffers of the default length at the reference rate,
 * which is where the flat 512 MiB that stood in the frame before came from.
 */
export const SPARE_MEMORY_BYTES = 384 * 1024 ** 2

/**
 * The most one document keeps in memory across every session of its frame, at this buffer length.
 *
 * Derived from the setting and not a constant beside it, and that is the whole point. The buffer
 * length bounds each session; this bounds their number — and a flat ceiling can only bound their
 * number at one length. At 512 MiB an ordinary 1080p session passes the ceiling on its own at
 * about eleven minutes, and past that a user who asked for half an hour was losing the whole
 * recording every few minutes instead of keeping the half hour they set. The first term is the
 * promise of the setting, the second is room for the others.
 *
 * The rate is the reference one and not what this user actually records: the frame would have to
 * measure itself to know, and a ceiling that moved with the material it is meant to bound would
 * be arguing with itself. A stream above the reference rate is answered further down instead —
 * `SessionStore.dropOverCeiling` shortens the one session that is over the ceiling by itself
 * rather than throwing it away, and the settings page says what will be kept.
 *
 * It is not a setting of its own. Asking a user to tune a number they cannot see would be worse
 * than deriving one from the number they can. It is per document
 * because a registry lives in a frame and can see neither its neighbours nor other tabs.
 */
export function memoryCeilingFor(bufferSeconds: number): number {
  return (Math.max(0, bufferSeconds) * REFERENCE_BITS_PER_SECOND) / 8 + SPARE_MEMORY_BYTES
}

const clamp = (value: number, limit: { min: number; max: number }): number =>
  Math.min(Math.max(value, limit.min), limit.max)

const asNumber = (value: unknown, fallback: number, limit: { min: number; max: number }): number =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, limit) : fallback

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const asOneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype

/**
 * A host out of whatever the user typed, or empty when it is not one.
 *
 * People paste addresses into a list of domains, and they type them with a space in front. The
 * whole address is read for its host, a bare host is taken as it stands, and everything is
 * lowercased — hosts are case-insensitive and a list that thinks otherwise refuses to match the
 * site the user was looking at.
 */
function asHost(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim().toLowerCase()
  if (!text) return ''

  if (text.includes('://')) {
    try {
      return new URL(text).hostname
    } catch {
      return ''
    }
  }

  // A bare host and nothing else: URL parsing removes a port and turns an internationalized name
  // into the ASCII form that URL.hostname uses when the current page is matched.
  if (!/^[\p{L}\p{N}.:-]+$/u.test(text)) return ''
  try {
    return new URL(`https://${text}`).hostname
  } catch {
    return ''
  }
}

function asHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const hosts: string[] = []
  for (const entry of value) {
    const host = asHost(entry)
    // Cleaned rather than dropped: one entry the user mistyped is no reason to lose the list.
    if (host && !hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

/**
 * Settings out of whatever was stored, always complete and always of the right kinds.
 *
 * Everything that reads settings reads the answer of this function, so nothing downstream has to
 * ask whether a field is there. What is stored was written by a build that may be older (a group
 * that did not exist yet) or newer (a group this build does not know), and it is read after an
 * update in both directions.
 */
export function merge(stored: unknown): Settings {
  const source = isPlainRecord(stored) ? stored : {}
  const group = (name: string): Record<string, unknown> => {
    const value = source[name]
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  }

  const recording = group('recording')
  const detection = group('detection')
  const history = group('history')
  const exported = group('export')
  const legal = group('legal')
  const acceptedVersion = legal.acceptedVersion
  const acceptedAt = legal.acceptedAt
  const legalAccepted =
    acceptedVersion === LEGAL_VERSION &&
    typeof acceptedAt === 'number' &&
    Number.isFinite(acceptedAt) &&
    acceptedAt > 0

  return {
    recording: {
      mode: asOneOf(recording.mode, ['all', 'allowlist', 'off'] as const, DEFAULTS.recording.mode),
      bufferSeconds: asNumber(
        recording.bufferSeconds,
        DEFAULTS.recording.bufferSeconds,
        LIMITS.bufferSeconds,
      ),
      allow: asHosts(recording.allow),
      deny: asHosts(recording.deny),
    },
    detection: {
      gracePeriodSeconds: asNumber(
        detection.gracePeriodSeconds,
        DEFAULTS.detection.gracePeriodSeconds,
        LIMITS.gracePeriodSeconds,
      ),
      minWidthPx: asNumber(detection.minWidthPx, DEFAULTS.detection.minWidthPx, LIMITS.minWidthPx),
      recordMuted: asBoolean(detection.recordMuted, DEFAULTS.detection.recordMuted),
    },
    history: {
      toDisk: asBoolean(history.toDisk, DEFAULTS.history.toDisk),
      keepDays: asNumber(history.keepDays, DEFAULTS.history.keepDays, LIMITS.keepDays),
      ceilingBytes: asNumber(history.ceilingBytes, DEFAULTS.history.ceilingBytes, LIMITS.ceilingBytes),
    },
    export: {
      format: asOneOf(exported.format, ['mp4', 'webp'] as const, DEFAULTS.export.format),
      codec: asOneOf(exported.codec, ['auto', 'hevc', 'h264'] as const, DEFAULTS.export.codec),
      rewriteHead: asBoolean(exported.rewriteHead, DEFAULTS.export.rewriteHead),
      nameTemplate:
        typeof exported.nameTemplate === 'string' && exported.nameTemplate.trim()
          ? exported.nameTemplate
          : DEFAULTS.export.nameTemplate,
      askWhere: asBoolean(exported.askWhere, DEFAULTS.export.askWhere),
      quality: asOneOf(exported.quality, ['high', 'medium', 'low'] as const, DEFAULTS.export.quality),
    },
    legal: legalAccepted
      ? { acceptedVersion, acceptedAt }
      : { ...DEFAULTS.legal },
  }
}

/** Whether this profile acknowledged the material terms shipped by this build. */
export function termsAccepted(settings: Settings): boolean {
  return (
    settings.legal.acceptedVersion === LEGAL_VERSION &&
    Number.isFinite(settings.legal.acceptedAt) &&
    settings.legal.acceptedAt > 0
  )
}

const PRESETS: Array<{ name: Exclude<DetectionPreset, 'custom'>; config: TriageConfig }> = [
  { name: 'loose', config: LOOSE },
  { name: 'balanced', config: BALANCED },
  { name: 'strict', config: STRICT },
]

/**
 * Which of the three presets these values are, or `custom` when they are none of them.
 *
 * Worked out rather than stored, so that there is one source of truth. A stored preset name
 * beside the values it stands for is a name that lies the moment the user opens `Advanced` and
 * moves one of them.
 */
export function presetOf(detection: TriageConfig): DetectionPreset {
  const found = PRESETS.find(
    (preset) =>
      preset.config.gracePeriodSeconds === detection.gracePeriodSeconds &&
      preset.config.minWidthPx === detection.minWidthPx &&
      preset.config.recordMuted === detection.recordMuted,
  )
  return found?.name ?? 'custom'
}

/** The values of a named preset; `custom` has none, and balanced is the default. */
export function presetNamed(name: DetectionPreset): TriageConfig {
  return { ...(PRESETS.find((preset) => preset.name === name)?.config ?? BALANCED) }
}

/** Does this entry of a list cover this host? A host stands for itself and its subdomains. */
export function hostMatches(entry: string, host: string): boolean {
  return host === entry || host.endsWith(`.${entry}`)
}

/**
 * Is anything recorded at this address at all?
 *
 * Read on the hot path — the frame asks it of every page it stands in — so it takes the settings
 * it is given rather than reading storage: every context that asks holds a live copy already
 * (see settings-store.ts).
 *
 * An address that cannot be read is not recorded. A frame at about:blank, a data: document, a
 * referrer the site stripped: there is nothing to weigh a list against, and a recording the
 * settings page cannot turn off is worse than no recording.
 */
export function siteAllows(settings: Settings, url: string): boolean {
  if (settings.recording.mode === 'off') return false

  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!host) return false

  if (settings.recording.deny.some((entry) => hostMatches(entry, host))) return false
  if (settings.recording.mode === 'all') return true
  return settings.recording.allow.some((entry) => hostMatches(entry, host))
}
