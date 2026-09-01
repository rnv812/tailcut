import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  FromWaveformWorker,
  ToWaveformWorker,
} from '../../src/editor/source/waveform-worker'

const own = (path: string): ArrayBuffer => {
  const bytes = readFileSync(path)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

afterEach(() => {
  vi.resetModules()
  delete (globalThis as { self?: unknown }).self
  delete (globalThis as { AudioDecoder?: unknown }).AudioDecoder
  delete (globalThis as { EncodedAudioChunk?: unknown }).EncodedAudioChunk
})

describe('waveform worker packet timing', () => {
  it('adds each segment timestampOffset to the chunks handed to AudioDecoder', async () => {
    const timestamps: number[] = []
    let receive: ((event: MessageEvent) => void) | null = null
    let finish!: (message: FromWaveformWorker) => void
    const done = new Promise<FromWaveformWorker>((resolve) => {
      finish = resolve
    })

    ;(globalThis as { self?: unknown }).self = {
      addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
        receive = listener
      },
      postMessage(message: FromWaveformWorker) {
        if (message.type === 'done' || message.type === 'failed') finish(message)
      },
    }

    ;(globalThis as { EncodedAudioChunk?: unknown }).EncodedAudioChunk = class {
      readonly timestamp: number
      constructor(init: EncodedAudioChunkInit) {
        this.timestamp = init.timestamp
      }
    }

    ;(globalThis as { AudioDecoder?: unknown }).AudioDecoder = class {
      static async isConfigSupported(config: AudioDecoderConfig): Promise<AudioDecoderSupport> {
        return { supported: true, config }
      }

      configure(): void {}
      decode(chunk: EncodedAudioChunk): void {
        timestamps.push(chunk.timestamp)
      }
      async flush(): Promise<void> {}
      close(): void {}
    }

    await import('../../src/editor/source/waveform-worker')

    const segment = own('tests/fixtures/h264/chunk-stream1-00001.m4s')
    const job: ToWaveformWorker = {
      type: 'peaks',
      init: own('tests/fixtures/h264/init-stream1.m4s'),
      trackId: 1,
      timescale: 44_100,
      sliceSeconds: 1,
      runs: [
        {
          start: 0,
          segments: [
            { bytes: segment.slice(0) },
            { bytes: segment.slice(0), timestampOffset: 4 },
          ],
        },
      ],
    }

    expect(receive).not.toBeNull()
    receive!({ data: job } as MessageEvent)
    expect(await done).toMatchObject({ type: 'done' })

    expect(timestamps.length).toBeGreaterThan(0)
    expect(timestamps.length % 2).toBe(0)
    const packets = timestamps.length / 2
    expect(timestamps.slice(packets)).toEqual(
      timestamps.slice(0, packets).map((timestamp) => timestamp + 4_000_000),
    )
  })
})
