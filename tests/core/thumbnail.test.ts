import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SourceTrack } from '../../src/core/export/plan'
import { videoSampleEntry } from '../../src/core/iso/entry'
import {
  createLazyThumbnail,
  thumbnailOf,
  THUMBNAIL_MAX_PX,
  THUMBNAIL_WEBP_QUALITY,
  type ThumbnailFrame,
  type ThumbnailRuntime,
  type ThumbnailSource,
} from '../../src/core/thumbnail'

const VP9_ENTRY = videoSampleEntry(
  new Uint8Array(readFileSync('tests/fixtures/vp9/init-stream0.m4s')),
)!.bytes
const KEY = Uint8Array.of(0x80)
const DELTA = Uint8Array.of(0x84)
const WEBP = Uint8Array.of(0x52, 0x49, 0x46, 0x46)

const sample = (at: number, pts: number) => ({
  dts: pts,
  pts,
  duration: 40,
  sync: true,
  source: { at, length: 1 },
})

function track(samples = [sample(0, 0), sample(1, 960), sample(2, 1_600)]): SourceTrack {
  return {
    kind: 'video',
    timescale: 1_000,
    sampleEntry: VP9_ENTRY,
    width: 320,
    height: 240,
    editOffset: 0,
    samples,
    dropped: 0,
  }
}

function sourceOf(
  bytes: ReadonlyMap<number, Uint8Array>,
  video = track(),
): ThumbnailSource {
  return {
    video,
    async read(at) {
      const found = bytes.get(at.at)
      if (!found) throw new Error(`No sample at ${at.at}`)
      return found
    },
  }
}

interface FakeFrame extends ThumbnailFrame {
  closed: number
}

interface Fakes {
  runtime: ThumbnailRuntime<FakeFrame, EncodedVideoChunkInit>
  decoded: EncodedVideoChunkInit[]
  decoderClosed: number
  frames: FakeFrame[]
  stills: Array<{ frame: FakeFrame; width: number; height: number; quality: number }>
  surfaceClosed: number
  supportedCalls: number
}

interface FakeOptions {
  supported?: boolean
  supportGate?: Promise<void>
  extraFrame?: boolean
  failSurface?: boolean
  decoderError?: boolean
}

function fakes(options: FakeOptions = {}): Fakes {
  const state: Fakes = {
    runtime: null as unknown as ThumbnailRuntime<FakeFrame, EncodedVideoChunkInit>,
    decoded: [],
    decoderClosed: 0,
    frames: [],
    stills: [],
    surfaceClosed: 0,
    supportedCalls: 0,
  }

  state.runtime = {
    async supported() {
      state.supportedCalls += 1
      await options.supportGate
      return options.supported ?? true
    },
    decoder(_config, on) {
      return {
        decode(chunk) {
          state.decoded.push(chunk)
        },
        async flush() {
          const frame = fakeFrame(320, 240)
          state.frames.push(frame)
          on.frame(frame)
          if (options.extraFrame) {
            const extra = fakeFrame(320, 240)
            state.frames.push(extra)
            on.frame(extra)
          }
          if (options.decoderError) on.error(new Error('decoder failed'))
        },
        close() {
          state.decoderClosed += 1
        },
      }
    },
    chunk: (init) => init,
    surface() {
      return {
        async still(frame, width, height, quality) {
          state.stills.push({ frame, width, height, quality })
          if (options.failSurface) throw new Error('surface failed')
          return WEBP
        },
        close() {
          state.surfaceClosed += 1
        },
      }
    },
  }

  return state
}

function fakeFrame(displayWidth: number, displayHeight: number): FakeFrame {
  const frame: FakeFrame = {
    displayWidth,
    displayHeight,
    closed: 0,
    close() {
      frame.closed += 1
    },
  }
  return frame
}

describe('thumbnailOf', () => {
  it('finds the real sync picture nearest one second and decodes only that sample', async () => {
    const source = sourceOf(new Map([[0, KEY], [1, DELTA], [2, KEY]]))
    const fake = fakes()

    const result = await thumbnailOf(source, fake.runtime)

    expect(result).toBe(WEBP)
    expect(fake.decoded).toHaveLength(1)
    expect(fake.decoded[0]).toMatchObject({
      type: 'key',
      timestamp: 1_600_000,
      duration: 40_000,
    })
    expect([...(fake.decoded[0]!.data as Uint8Array)]).toEqual([...KEY])
    expect(fake.stills).toEqual([
      {
        frame: fake.frames[0],
        width: THUMBNAIL_MAX_PX,
        height: 126,
        quality: THUMBNAIL_WEBP_QUALITY,
      },
    ])
  })

  it('falls back to the first decodable sync picture', async () => {
    const source = sourceOf(
      new Map([[0, KEY], [1, DELTA]]),
      track([sample(0, 0), sample(1, 960)]),
    )
    const fake = fakes()

    await expect(thumbnailOf(source, fake.runtime)).resolves.toBe(WEBP)

    expect(fake.decoded).toHaveLength(1)
    expect(fake.decoded[0]!.timestamp).toBe(0)
  })

  it('returns null without reading material when decoding is unsupported', async () => {
    let reads = 0
    const source: ThumbnailSource = {
      video: track(),
      async read() {
        reads += 1
        return KEY
      },
    }
    const fake = fakes({ supported: false })

    await expect(thumbnailOf(source, fake.runtime)).resolves.toBeNull()

    expect(reads).toBe(0)
    expect(fake.decoded).toHaveLength(0)
  })

  it('closes decoder, surface, and every output frame when encoding fails', async () => {
    const source = sourceOf(new Map([[0, KEY], [1, DELTA], [2, KEY]]))
    const fake = fakes({ extraFrame: true, failSurface: true })

    await expect(thumbnailOf(source, fake.runtime)).resolves.toBeNull()

    expect(fake.decoderClosed).toBe(1)
    expect(fake.surfaceClosed).toBe(1)
    expect(fake.frames.map((frame) => frame.closed)).toEqual([1, 1])
  })

  it('returns null and closes an emitted frame after an asynchronous decoder error', async () => {
    const source = sourceOf(new Map([[0, KEY], [1, DELTA], [2, KEY]]))
    const fake = fakes({ decoderError: true })

    await expect(thumbnailOf(source, fake.runtime)).resolves.toBeNull()

    expect(fake.decoderClosed).toBe(1)
    expect(fake.frames[0]!.closed).toBe(1)
    expect(fake.stills).toHaveLength(0)
  })
})

describe('createLazyThumbnail', () => {
  it('coalesces concurrent work and caches a successful thumbnail', async () => {
    let releaseSupport = (): void => undefined
    const supportGate = new Promise<void>((resolve) => {
      releaseSupport = resolve
    })
    const source = sourceOf(new Map([[0, KEY], [1, DELTA], [2, KEY]]))
    const fake = fakes({ supportGate })
    const thumbnail = createLazyThumbnail(source, fake.runtime)

    const first = thumbnail()
    const concurrent = thumbnail()

    expect(concurrent).toBe(first)
    expect(fake.supportedCalls).toBe(1)
    releaseSupport()
    await expect(first).resolves.toBe(WEBP)
    await expect(thumbnail()).resolves.toBe(WEBP)
    expect(fake.supportedCalls).toBe(1)
    expect(fake.decoded).toHaveLength(1)
  })
})
