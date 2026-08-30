import { describe, it, expect, vi, afterEach } from 'vitest'
import { cachedProbe, liveProbe } from '../../src/editor/export/support'

const config = (over: Partial<VideoEncoderConfig> = {}): VideoEncoderConfig => ({
  codec: 'avc1.640028',
  width: 1920,
  height: 1080,
  framerate: 30,
  hardwareAcceleration: 'prefer-hardware',
  ...over,
})

/** The browser's answer, as `isConfigSupported` gives it: an object whose `supported` may be absent. */
const browserAnswering = (answer: () => Promise<VideoEncoderSupport>): void => {
  vi.stubGlobal('VideoEncoder', { isConfigSupported: () => answer() })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cachedProbe', () => {
  it('asks the browser once for a question it has already answered', async () => {
    const asked: VideoEncoderConfig[] = []
    const probe = cachedProbe(async (candidate) => {
      asked.push(candidate)
      return true
    })

    // Asked in the same tick first, and on a cache that is still empty — which is how the tab
    // asks it: the effect that fills the map walks every clip of the document in one pass. What
    // is cached is the promise and not the answer, so two clips racing still ask the browser
    // once; a cache filled after the await would let both through and race to fill the map.
    const together = await Promise.all([probe(config()), probe(config())])
    expect(together).toEqual([true, true])
    expect(asked).toHaveLength(1)

    // And two clips of one geometry asked one after another — the ordinary case: a document of
    // six clips off one recording asks the same question six times, and it is not free.
    expect(await probe(config())).toBe(true)
    expect(await probe(config())).toBe(true)
    expect(asked).toHaveLength(1)
  })

  it('asks again for a question that only looks the same', async () => {
    const asked: VideoEncoderConfig[] = []
    const probe = cachedProbe(async (candidate) => {
      asked.push(candidate)
      return candidate.hardwareAcceleration !== 'prefer-hardware'
    })

    expect(await probe(config({ framerate: 30 }))).toBe(false)
    // The same frame at another rate is another question, and the browser answers it differently:
    // measured, hardware HEVC says yes at 3840×2160@30 and no at the same frame at 60.
    expect(await probe(config({ framerate: 60 }))).toBe(false)
    // And the rung below is the same codec at the same size, differing only in what it demands.
    // A cache that lumped it in with the refusal above would end the ladder one rung too early —
    // "no encoder" on the machine this is written on, where the software rung is the one that works.
    expect(await probe(config({ hardwareAcceleration: 'prefer-software' }))).toBe(true)
    expect(await probe(config({ width: 1280, height: 720 }))).toBe(false)

    expect(asked).toHaveLength(4)
    expect(asked.map((candidate) => candidate.framerate)).toEqual([30, 60, 30, 30])
  })
})

describe('liveProbe', () => {
  it('takes a throw from the browser as a no, and does not carry it up the ladder', async () => {
    // `isConfigSupported` throws on a configuration it considers malformed rather than
    // unsupported — a codec string it cannot parse, a zero dimension. Thrown from here it would
    // take the whole choice down instead of moving to the next rung, and the clip would fail
    // with a TypeError where the answer is simply "not this one".
    browserAnswering(() => Promise.reject(new TypeError('Failed to execute isConfigSupported')))
    await expect(liveProbe()(config())).resolves.toBe(false)

    // Thrown rather than rejected: the same answer, and the same reason.
    vi.stubGlobal('VideoEncoder', {
      isConfigSupported: () => {
        throw new TypeError('Failed to execute isConfigSupported')
      },
    })
    await expect(liveProbe()(config())).resolves.toBe(false)
  })

  it('reads only a stated yes as a yes', async () => {
    browserAnswering(async () => ({ supported: true, config: config() }))
    expect(await liveProbe()(config())).toBe(true)

    browserAnswering(async () => ({ supported: false, config: config() }))
    expect(await liveProbe()(config())).toBe(false)

    // `supported` is optional in the shape the browser returns, and an absent one is not a yes:
    // read for truthiness through a `?? true` or a bare `answer.supported`, an answer with no
    // field at all would configure an encoder that cannot be configured.
    browserAnswering(async () => ({ config: config() }))
    expect(await liveProbe()(config())).toBe(false)
  })
})
