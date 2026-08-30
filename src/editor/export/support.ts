import { cacheKeyOf, type Probe } from '../../core/encode/codec'

/**
 * The probe as the browser answers it.
 *
 * `isConfigSupported` throws on a configuration it considers malformed rather than unsupported —
 * a codec string it cannot parse, a zero dimension — and a throw here would take the whole
 * choice down instead of moving to the next rung. So a throw is an answer, and the answer is no.
 */
export function liveProbe(): Probe {
  return async (config) => {
    try {
      const answer = await VideoEncoder.isConfigSupported(config)
      return answer.supported === true
    } catch {
      return false
    }
  }
}

/**
 * The same probe, asked once per question.
 *
 * The question is the whole key — codec, size, framerate, acceleration — and never a single
 * boolean per install: support flips with every one of the four. The cache lives as long as the
 * tab: a browser that grew a codec while the editor was open is not a case worth a stale answer
 * for, and a tab that reopened has asked again anyway.
 */
export function cachedProbe(probe: Probe): Probe {
  const answers = new Map<string, Promise<boolean>>()

  return (config) => {
    const key = cacheKeyOf(config)
    const known = answers.get(key)
    if (known) return known

    // The promise is cached, not the answer: two clips of one geometry probed in the same tick
    // would otherwise ask the browser twice and race to fill the map.
    const asked = probe(config)
    answers.set(key, asked)
    return asked
  }
}
