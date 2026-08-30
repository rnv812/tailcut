export interface KeyInput {
  url: string
  codecs: string[]
  /**
   * Full video duration in seconds. `Infinity` means a live stream.
   *
   * NaN is deliberately grouped with live streams: `HTMLMediaElement.duration` is NaN before
   * `loadedmetadata`, and this layer cannot distinguish "live" from "not known yet". A key
   * computed too early would first match a live-stream key, then change when the real duration
   * arrives and split one video's material across two sessions. Callers must therefore wait for
   * `loadedmetadata` before computing the key.
   */
  durationSeconds: number
}

/**
 * Parameters that vary between visits without changing the video itself.
 *
 * Names are matched in full: a name that merely begins with one of these is not noise. `title`,
 * `token`, and `type` are unrelated to `t`; `sig` is unrelated to `si`; and `source_id` is
 * unrelated to `source`. Removing a meaningful parameter would merge different videos into one
 * session, while retaining an extra parameter costs only one extra session.
 *
 * `lang` is deliberately absent. On some sites it selects an audio track rather than an
 * interface language. Dubs of the same video share duration and codecs, so removing `lang`
 * would merge fragments from two languages into one timeline.
 */
const NOISE_PARAMS = [
  't', 'time_continue', 'start', 'index', 'list', 'si', 'feature', 'pp',
  'ref', 'ref_src', 'referrer', 'source', 'share_id',
]

/**
 * Noise matching ignores name case: `?T=42` and `?UTM_Source=x` are the same markers as `?t=42`
 * and `?utm_source=x`. The URL itself is not rewritten, so meaningful `?V=abc` and `?v=abc`
 * remain distinct parameters rather than being collapsed on the site's behalf.
 */
function isNoiseParam(name: string): boolean {
  const key = name.toLowerCase()
  return NOISE_PARAMS.includes(key) || key.startsWith('utm_')
}

/**
 * Normalizes a URL so two visits to the same video are recognized as one.
 *
 * It normalizes how the page was reached: the fragment, query-parameter order, and noise
 * parameters. It does not change where the URL points: scheme, host, and path remain intact, so
 * `http` and `https`, and `/v/1` and `/v/1/`, produce different keys. Collapsing them would assume
 * the site serves the same resource there. URL parsing normalizes host case, but not path case.
 */
export function normalizeUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  parsed.hash = ''

  for (const key of [...parsed.searchParams.keys()]) {
    if (isNoiseParam(key)) {
      parsed.searchParams.delete(key)
    }
  }

  parsed.searchParams.sort()
  return parsed.toString()
}

/**
 * Duration in the form stored in the key: whole seconds or `live`.
 *
 * This is separate because the session registry uses the same representation to decide whether a
 * duration declared by the page is new. It must use exactly the key's precision or it would move
 * the session on every millisecond-level manifest update.
 */
export function durationToken(seconds: number): string {
  return Number.isFinite(seconds) ? Math.round(seconds).toString() : 'live'
}

export function sessionKey(input: KeyInput): string {
  // Copy before sorting because the array belongs to the caller, where codec order may matter.
  const codecs = [...input.codecs].sort().join(',')
  const duration = durationToken(input.durationSeconds)

  // Separators keep components from flowing into each other and giving different sessions the
  // same key (".../v/1" + "avc1" and ".../v/1a" + "vc1" otherwise produce one string).
  //
  // The separator is chosen not to occur in a URL or inside the codec list. A comma fails both
  // tests: it is legal in a URL path and already joins codecs, so ".../v/1" + [avc1, mp4a] and
  // ".../v/1,avc1" + [mp4a] would produce the same key.
  return `${normalizeUrl(input.url)}|${codecs}|${duration}`
}
