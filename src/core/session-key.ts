export interface KeyInput {
  url: string
  codecs: string[]
  /** Infinity для прямого эфира */
  durationSeconds: number
}

/** Параметры, которые меняются от захода к заходу и на само видео не влияют. */
const NOISE_PARAMS = [
  't', 'time_continue', 'start', 'index', 'list', 'si', 'feature', 'pp',
  'ref', 'ref_src', 'referrer', 'source', 'share_id', 'lang',
]

export function normalizeUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  parsed.hash = ''

  for (const key of [...parsed.searchParams.keys()]) {
    if (NOISE_PARAMS.includes(key) || key.startsWith('utm_')) {
      parsed.searchParams.delete(key)
    }
  }

  parsed.searchParams.sort()
  return parsed.toString()
}

export function sessionKey(input: KeyInput): string {
  const codecs = [...input.codecs].sort().join(',')
  const duration = Number.isFinite(input.durationSeconds)
    ? Math.round(input.durationSeconds).toString()
    : 'live'

  return `${normalizeUrl(input.url)}|${codecs}|${duration}`
}
