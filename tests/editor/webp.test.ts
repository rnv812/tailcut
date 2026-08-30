import { describe, expect, it } from 'vitest'
import type { FramePlan, FrameToKeep } from '../../src/core/encode/plan'
import { chunksOf } from '../../src/core/webp/riff'
import { frameDurations, keptForRate, WEBP_QUALITY } from '../../src/core/webp/timing'
import {
  encodeWebp,
  probeWebpBytes,
  STILL_HEADER_BYTES,
  type Surface,
} from '../../src/editor/export/webp'
import type { Codecs, FrameSource } from '../../src/editor/export/frames'

const TIMESCALE = 30_000
const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0))
const u32 = (value: number): number[] => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
]

function chunk(tag: string, body: readonly number[]): number[] {
  return [...ascii(tag), ...u32(body.length), ...body, ...(body.length & 1 ? [0] : [])]
}

/** A browser-shaped still: RIFF + VP8X/ICCP (482 bytes together) + one VP8 image chunk. */
function stillOfSize(size: number, width: number, height: number): Uint8Array {
  const pictureSize = size - 502
  if (pictureSize < 10 || pictureSize % 2 !== 0) throw new Error('The fake still size must be even.')

  const picture = new Array<number>(pictureSize).fill(0)
  picture.splice(
    0,
    10,
    0x10,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    width >>> 8,
    height & 0xff,
    height >>> 8,
  )
  const parts = [
    chunk('VP8X', [0x20, 0, 0, 0, width - 1, 0, 0, height - 1, 0, 0]),
    chunk('ICCP', new Array<number>(456).fill(7)),
    chunk('VP8 ', picture),
  ]
  const payload = parts.flat()
  const bytes = Uint8Array.of(...ascii('RIFF'), ...u32(payload.length + 4), ...ascii('WEBP'), ...payload)
  expect(bytes.byteLength).toBe(size)
  return bytes
}

interface FakeFrame {
  timestamp: number
  duration: number | null
  closed: number
  close(): void
}

interface Fakes {
  codecs: Codecs
  produced: FakeFrame[]
  decoderClosed: number
}

/** A decoder that accepts decode order and emits presentation order, including reordered B-frames. */
function fakeCodecs(): Fakes {
  const fakes: Fakes = { codecs: null as unknown as Codecs, produced: [], decoderClosed: 0 }

  fakes.codecs = {
    decoder(_config, on) {
      const chunks: EncodedVideoChunkInit[] = []
      return {
        decode(chunk) {
          chunks.push({
            type: chunk.type,
            timestamp: chunk.timestamp,
            duration: chunk.duration ?? undefined,
            data: new Uint8Array(chunk.byteLength),
          })
        },
        async flush() {
          for (const chunk of chunks.slice().sort((a, b) => a.timestamp - b.timestamp)) {
            const frame: FakeFrame = {
              timestamp: chunk.timestamp,
              duration: chunk.duration ?? null,
              closed: 0,
              close() {
                frame.closed += 1
              },
            }
            fakes.produced.push(frame)
            on.frame(frame as unknown as VideoFrame)
          }
        },
        close() {
          fakes.decoderClosed += 1
        },
        queued: 0,
        drainTo: () => Promise.resolve(),
      }
    },
    encoder: () => {
      throw new Error('WebP does not use VideoEncoder.')
    },
    chunk: (init) =>
      ({
        ...init,
        byteLength: init.data.byteLength,
      }) as unknown as EncodedVideoChunk,
    cut: () => {
      throw new Error('These plans do not crop.')
    },
  }

  return fakes
}

interface FakeSurface extends Surface {
  sizes: Array<{ width: number; height: number }>
  drawn: number[]
  qualities: number[]
  stillCalls: number
}

function fakeSurface(options: {
  stillSizes?: number[]
  rejectAt?: number
  afterStill?: (calls: number) => void
} = {}): FakeSurface {
  let width = 1
  let height = 1
  let current = 0

  const surface: FakeSurface = {
    sizes: [],
    drawn: [],
    qualities: [],
    stillCalls: 0,
    resize(nextWidth, nextHeight) {
      width = nextWidth
      height = nextHeight
      surface.sizes.push({ width, height })
    },
    draw(frame) {
      current = frame.timestamp
      surface.drawn.push(current)
    },
    async still(quality) {
      surface.stillCalls += 1
      surface.qualities.push(quality)
      if (surface.stillCalls === options.rejectAt) throw new Error('canvas failed')
      const sizes = options.stillSizes ?? [600]
      const bytes = stillOfSize(sizes[(surface.stillCalls - 1) % sizes.length]!, width, height)
      options.afterStill?.(surface.stillCalls)
      // Keep the timestamp observable in the fake without changing the valid bitstream header.
      bytes[bytes.length - 1] = current & 0xff
      return bytes
    },
  }
  return surface
}

interface SourceFake extends FrameSource {
  reads: number[]
  calledOff: boolean
}

function sourceOf(): SourceFake {
  const source: SourceFake = {
    reads: [],
    calledOff: false,
    async read(at) {
      source.reads.push(at.at)
      return Uint8Array.of(at.at & 0xff)
    },
    stale: () => source.calledOff,
  }
  return source
}

function planOf(
  count: number,
  fps: 10 | 30,
  over: { order?: number[]; width?: number; height?: number; syncEvery?: number } = {},
): FramePlan {
  const step = TIMESCALE / fps
  const order = over.order ?? Array.from({ length: count }, (_, at) => at)
  const syncEvery = over.syncEvery ?? fps
  const frames: FrameToKeep[] = order.map((shownAt, decodeAt) => ({
    source: { at: 1000 + decodeAt, length: 1 },
    pts: shownAt * step,
    duration: step,
    sync: shownAt % syncEvery === 0,
    keep: true,
  }))

  return {
    frames,
    kept: frames.length,
    headTicks: 0,
    headUs: 0,
    timescale: TIMESCALE,
    crop: null,
    decoder: { codec: 'avc1.4d400d', description: Uint8Array.of(1, 100, 3) },
    sourceFormat: 'avc1',
    geometry: { width: over.width ?? 320, height: over.height ?? 240, framerate: fps },
    audio: null,
    duration: count / fps,
  }
}

const usOf = (ticks: number): number => Math.round((ticks * 1_000_000) / TIMESCALE)

function durationsOf(bytes: Uint8Array): number[] {
  return chunksOf(bytes)
    .filter(({ tag }) => tag === 'ANMF')
    .map(({ at }) => bytes[at + 12]! | (bytes[at + 13]! << 8) | (bytes[at + 14]! << 16))
}

describe('encodeWebp', () => {
  it('thins a fast clip, reports each written frame and closes every decoded frame', async () => {
    const plan = planOf(30, 30, { width: 1280, height: 720 })
    const source = sourceOf()
    const fakes = fakeCodecs()
    const surface = fakeSurface()
    const progress: number[] = []

    const bytes = await encodeWebp(plan, source, fakes.codecs, surface, (frames) => progress.push(frames))

    expect(bytes).not.toBeNull()
    expect(chunksOf(bytes!).filter(({ tag }) => tag === 'ANMF')).toHaveLength(15)
    expect(surface.sizes).toEqual([{ width: 640, height: 360 }])
    expect(surface.drawn).toEqual(keptForRate(30, 30, 15).map((at) => usOf(at * 1000)))
    expect(surface.qualities).toEqual(new Array(15).fill(WEBP_QUALITY))
    expect(surface.qualities.every((quality) => quality < 1)).toBe(true)
    expect(progress).toEqual(Array.from({ length: 15 }, (_, at) => at + 1))
    expect(fakes.produced).toHaveLength(30)
    expect(fakes.produced.every((frame) => frame.closed === 1)).toBe(true)
    expect(fakes.decoderClosed).toBe(1)
  })

  it('keeps every slow frame and derives the whole duration from its own ticks', async () => {
    const plan = planOf(10, 10)
    const source = sourceOf()
    const fakes = fakeCodecs()
    const bytes = await encodeWebp(plan, source, fakes.codecs, fakeSurface(), () => undefined)
    const ticks = plan.frames.map(({ pts }) => pts)
    const expected = frameDurations(ticks, ticks.at(-1)! + plan.frames.at(-1)!.duration, TIMESCALE)

    expect(durationsOf(bytes!)).toEqual(expected)
    expect(durationsOf(bytes!)).toHaveLength(10)
    expect(durationsOf(bytes!).reduce((sum, duration) => sum + duration, 0)).toBe(1000)
  })

  it('lays reordered decoded frames into the animation in presentation order', async () => {
    const plan = planOf(6, 30, { order: [0, 2, 1, 3, 5, 4] })
    const surface = fakeSurface()
    const bytes = await encodeWebp(plan, sourceOf(), fakeCodecs().codecs, surface, () => undefined)

    expect(bytes).not.toBeNull()
    expect(surface.drawn).toEqual([0, 2, 4].map((at) => usOf(at * 1000)))
  })

  it('returns null instead of assembling work that was called off', async () => {
    const plan = planOf(10, 10)
    const source = sourceOf()
    const surface = fakeSurface({ afterStill: () => (source.calledOff = true) })
    const bytes = await encodeWebp(plan, source, fakeCodecs().codecs, surface, () => undefined)

    expect(surface.stillCalls).toBeGreaterThan(0)
    expect(bytes).toBeNull()
  })

  it('closes the current and waiting frames when the canvas rejects one', async () => {
    const fakes = fakeCodecs()
    const surface = fakeSurface({ rejectAt: 2 })

    await expect(
      encodeWebp(planOf(10, 10), sourceOf(), fakes.codecs, surface, () => undefined),
    ).rejects.toThrow('canvas failed')
    expect(surface.drawn).toHaveLength(2)
    expect(fakes.produced.every((frame) => frame.closed === 1)).toBe(true)
  })
})

describe('probeWebpBytes', () => {
  it('probes each frame once on a short reordered clip', async () => {
    const plan = planOf(3, 30, { order: [0, 2, 1], syncEvery: 30 })
    const surface = fakeSurface()
    const bytes = await probeWebpBytes(plan, sourceOf(), fakeCodecs().codecs, surface)

    expect(bytes).not.toBeNull()
    expect(surface.drawn).toEqual([0, 1, 2].map((at) => usOf(at * 1000)))
    expect(surface.stillCalls).toBe(3)
  })

  it('decodes only three short runs and includes the animation container overhead', async () => {
    const plan = planOf(180, 30, { syncEvery: 30 })
    const source = sourceOf()
    const surface = fakeSurface({ stillSizes: [600, 700, 800] })
    const bytes = await probeWebpBytes(plan, source, fakeCodecs().codecs, surface)
    const average = 700
    const frames = keptForRate(plan.kept, 30, 15).length
    const expected = (average - STILL_HEADER_BYTES + 12) * frames + 44

    expect(surface.stillCalls).toBe(3)
    expect(source.reads.length).toBeLessThan(plan.frames.length / 10)
    expect(bytes).toBe(expected)
  })

  it('returns no estimate when the source is already stale', async () => {
    const source = sourceOf()
    source.calledOff = true
    const surface = fakeSurface()

    await expect(probeWebpBytes(planOf(30, 30), source, fakeCodecs().codecs, surface)).resolves.toBeNull()
    expect(source.reads).toEqual([])
    expect(surface.stillCalls).toBe(0)
  })
})
