import { afterEach, describe, expect, it, vi } from 'vitest'
import { liveThumbnailRuntime } from '../../src/bridge/thumbnail-runtime'

const CONFIG: VideoDecoderConfig = {
  codec: 'vp09.00.10.08',
  codedWidth: 320,
  codedHeight: 240,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('liveThumbnailRuntime', () => {
  it('accepts only an explicit yes from VideoDecoder support probing', async () => {
    const asked: VideoDecoderConfig[] = []
    vi.stubGlobal('VideoDecoder', {
      async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
        asked.push(config)
        return { supported: true, config }
      },
    })

    expect(await liveThumbnailRuntime().supported(CONFIG)).toBe(true)
    expect(asked).toEqual([CONFIG])

    vi.stubGlobal('VideoDecoder', {
      async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
        return { config }
      },
    })
    expect(await liveThumbnailRuntime().supported(CONFIG)).toBe(false)

    vi.stubGlobal('VideoDecoder', {
      isConfigSupported(): Promise<VideoDecoderSupport> {
        throw new TypeError('invalid decoder config')
      },
    })
    expect(await liveThumbnailRuntime().supported(CONFIG)).toBe(false)
  })

  it('configures one decoder, wraps chunks, forwards output, and closes safely', async () => {
    let callbacks: VideoDecoderInit | null = null
    let configured: VideoDecoderConfig | null = null
    const decoded: unknown[] = []
    let nativeCloseCalls = 0
    const madeChunks: EncodedVideoChunkInit[] = []

    class FakeVideoDecoder {
      static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
        return { supported: true, config }
      }

      constructor(init: VideoDecoderInit) {
        callbacks = init
      }

      configure(config: VideoDecoderConfig): void {
        configured = config
      }

      decode(chunk: unknown): void {
        decoded.push(chunk)
      }

      async flush(): Promise<void> {}

      close(): void {
        nativeCloseCalls += 1
        throw new DOMException('already closed', 'InvalidStateError')
      }
    }

    class FakeEncodedVideoChunk {
      constructor(readonly init: EncodedVideoChunkInit) {
        madeChunks.push(init)
      }
    }

    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)

    const frames: VideoFrame[] = []
    const errors: Error[] = []
    const runtime = liveThumbnailRuntime()
    const decoder = runtime.decoder(CONFIG, {
      frame: (frame) => frames.push(frame),
      error: (error) => errors.push(error),
    })
    const init: EncodedVideoChunkInit = {
      type: 'key',
      timestamp: 1_000_000,
      duration: 40_000,
      data: Uint8Array.of(1, 2, 3),
    }
    const chunk = runtime.chunk(init)
    decoder.decode(chunk)
    await decoder.flush()

    const frame = { displayWidth: 320, displayHeight: 240 } as VideoFrame
    const error = new DOMException('decode failed', 'EncodingError')
    callbacks!.output(frame)
    callbacks!.error(error)
    decoder.close()
    decoder.close()

    expect(configured).toBe(CONFIG)
    expect(madeChunks).toEqual([init])
    expect(decoded).toEqual([chunk])
    expect(frames).toEqual([frame])
    expect(errors).toEqual([error])
    expect(nativeCloseCalls).toBe(1)
  })

  it('draws into an aspect-sized canvas and returns the asynchronous WebP bytes', async () => {
    const webp = Uint8Array.of(0x52, 0x49, 0x46, 0x46)
    const canvases: FakeOffscreenCanvas[] = []
    const draws: unknown[][] = []
    const conversions: ImageEncodeOptions[] = []

    class FakeOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        canvases.push(this)
      }

      getContext(kind: string): { drawImage(...args: unknown[]): void } | null {
        if (kind !== '2d') return null
        return { drawImage: (...args) => draws.push(args) }
      }

      async convertToBlob(options: ImageEncodeOptions): Promise<Blob> {
        conversions.push(options)
        return new Blob([webp], { type: 'image/webp' })
      }
    }

    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)

    const frame = { displayWidth: 640, displayHeight: 360 } as VideoFrame
    const surface = liveThumbnailRuntime().surface()
    await expect(surface.still(frame, 168, 95, 0.7)).resolves.toEqual(webp)
    surface.close()

    expect(canvases.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 168, height: 95 },
    ])
    expect(draws).toEqual([[frame, 0, 0, 168, 95]])
    expect(conversions).toEqual([{ type: 'image/webp', quality: 0.7 }])
  })
})
