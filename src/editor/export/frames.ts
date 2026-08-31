import type { Crop } from '../../core/encode/crop'
import type { FramePlan } from '../../core/encode/plan'
import type { Located } from '../../shared/types'
import { codecFailure } from './failure'

/**
 * How many chunks the decoder is allowed to owe frames for at once.
 *
 * A bound on both halves of the loop, and it is one only because it is checked **before** a chunk
 * is handed over: the decoder never holds more than this many, so it never owes more than this
 * many frames, so the queue this file drains into never grows past it either. Eight frames of
 * 1080p in NV12 is about twenty-five megabytes, and that is the whole of what this path adds to
 * the tab's memory besides the sample it is reading and the file it is building. Deeper buys
 * nothing — the encoder is the slow half — and shallower leaves the decoder idle between frames.
 */
export const MAX_FRAMES_IN_FLIGHT = 8

export interface DecoderLike {
  decode(chunk: EncodedVideoChunk): void
  flush(): Promise<void>
  close(): void
  /** Chunks handed over that have not come back as frames. `VideoDecoder.decodeQueueSize`. */
  readonly queued: number
  /** Resolves when that queue has fallen to `limit` or below — on `dequeue`, never on a timer. */
  drainTo(limit: number): Promise<void>
}

export interface EncoderLike {
  encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void
  flush(): Promise<void>
  close(): void
  readonly queued: number
  /** Resolves when the encoder's own queue has fallen to `limit` or below. */
  drainTo(limit: number): Promise<void>
}

/** Everything of WebCodecs the export path touches, in one place, so a test can replace it. */
export interface Codecs {
  decoder(
    config: VideoDecoderConfig,
    on: { frame(frame: VideoFrame): void; error(error: Error): void },
  ): DecoderLike
  encoder(
    config: VideoEncoderConfig,
    on: {
      chunk(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void
      error(error: Error): void
    },
  ): EncoderLike
  chunk(init: EncodedVideoChunkInit): EncodedVideoChunk
  /** Copies a frame into ordinary CPU-backed storage accepted by the software encoder. */
  normalize(frame: VideoFrame): Promise<VideoFrame>
  /**
   * The crop, cut out of a decoded frame — the one place a picture is made smaller than it was
   * recorded, and the reason it is a method rather than three lines inline is that a unit test
   * has no `VideoFrame` constructor to call.
   *
   * The caller closes the frame it handed in; this returns a new one and owns nothing.
   */
  cut(frame: VideoFrame, crop: Crop): VideoFrame
}

/** A yield that Chrome does not clamp. `setTimeout` nested this deep is floored at 4 ms. */
const yieldToTasks = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })

export interface FrameSource {
  /** The coded bytes of one sample, read from the snapshot. */
  read(at: Located): Promise<Uint8Array>
  /** Called off: the loop stops at the next frame and lets everything go. */
  stale(): boolean
}

/**
 * The frames of a clip, decoded, in decode order, bounded.
 *
 * An async generator rather than a callback, and the reason is cancellation: `for await` with a
 * `break` runs this function's `finally`, so a job called off in the middle closes the decoder
 * and every frame still in hand without anybody having to remember to. The consumer owns each
 * frame it is given and closes it; the frames the entry point excludes never leave here.
 *
 * Software decoding is asked for on purpose. Hardware decode of the very same clip measured 16.1
 * s against 9.1 for software, because a frame decoded on the GPU has to be read back over the bus
 * before an encoder can have it.
 */
export async function* decodedFrames(
  plan: FramePlan,
  source: FrameSource,
  codecs: Codecs,
  normalize = false,
): AsyncGenerator<VideoFrame> {
  const ready: VideoFrame[] = []
  let failed: Error | null = null
  const decodingFailure = (cause: unknown): Error =>
    codecFailure('decode', plan.decoder.codec, null, cause)

  let decoder: DecoderLike
  try {
    decoder = codecs.decoder(
      { ...plan.decoder, hardwareAcceleration: 'prefer-software' },
      {
        frame(frame) {
          // Before the entry point: decoded because what follows is predicted from it, never shown.
          // This is the whole of what replaces the edit list on this path.
          if (frame.timestamp < plan.headUs) {
            frame.close()
            return
          }

          if (!plan.crop) {
            ready.push(frame)
            return
          }

          // This is the one place in the program a picture is made smaller than it was recorded.
          // It has to happen here because `VideoEncoder` does not crop: handed the whole frame with
          // a config the size of the rectangle, it *scales* — a squashed clip of exactly the size
          // that was asked for, which is the shape a wrong answer takes here. `plan.crop` is in the
          // source's own pixels and `plan.geometry` is its size, so what comes out needs no
          // resizing on the way into the encoder.
          try {
            ready.push(codecs.cut(frame, plan.crop))
          } finally {
            frame.close()
          }
        },
        error(error) {
          failed = decodingFailure(error)
        },
      },
    )
  } catch (error) {
    throw decodingFailure(error)
  }

  try {
    for (const sample of plan.frames) {
      if (source.stale()) return

      // Hand over everything decoded so far before asking for more. The consumer awaits the
      // encoder, so this is where the whole chain finds its pace: no timer decides it.
      while (ready.length) {
        if (failed) throw failed
        const frame = ready.shift()!
        if (!normalize) {
          yield frame
          continue
        }
        try {
          yield await codecs.normalize(frame)
        } finally {
          frame.close()
        }
      }

      // A yield the browser does not clamp, once a sample. It is what keeps the tab painting
      // through a minute of work — a page that stops redrawing for a minute reads as hung — and
      // it is a `MessageChannel` rather than a timer for the measured reason above.
      await yieldToTasks()

      const bytes = await source.read(sample.source)

      // The bound, and the reason it is one: it is checked before the chunk goes in, so the
      // decoder never holds more than `MAX_FRAMES_IN_FLIGHT` and therefore never owes more than
      // that many frames. Waiting is on `dequeue`; polling here would be a nested `setTimeout`,
      // floored at 4 ms, capping the whole loop at about 140 frames a second.
      if (decoder.queued >= MAX_FRAMES_IN_FLIGHT) {
        try {
          await decoder.drainTo(MAX_FRAMES_IN_FLIGHT - 1)
        } catch (error) {
          throw failed ?? decodingFailure(error)
        }
      }

      try {
        decoder.decode(
          codecs.chunk({
            type: sample.sync ? 'key' : 'delta',
            timestamp: Math.round((sample.pts * 1_000_000) / plan.timescale),
            duration: Math.round((sample.duration * 1_000_000) / plan.timescale),
            data: bytes,
          }),
        )
      } catch (error) {
        throw failed ?? decodingFailure(error)
      }
    }

    try {
      await decoder.flush()
    } catch (error) {
      throw failed ?? decodingFailure(error)
    }
    if (failed) throw failed
    while (ready.length) {
      const frame = ready.shift()!
      if (!normalize) {
        yield frame
        continue
      }
      try {
        yield await codecs.normalize(frame)
      } finally {
        frame.close()
      }
    }
  } finally {
    for (const frame of ready) frame.close()
    ready.length = 0
    // Closing a decoder that has already been closed by an error throws; the job is over either
    // way and a throw here would replace the real failure with a bookkeeping one.
    try {
      decoder.close()
    } catch {
      /* already gone */
    }
  }
}
/**
 * The real thing.
 *
 * `drainTo` is where the pace of the whole export is decided, on both sides, and it listens to
 * `dequeue` rather than polling. A poll here would be a `setTimeout`, and Chrome floors a nested
 * one at 4 ms — which caps any loop built on it at about 140 frames a second whatever the codecs
 * are doing. That cap has already been mistaken once for a property of a codec.
 */
export function liveCodecs(): Codecs {
  /** Both queues drain the same way; only the object they belong to differs. */
  const drainer = (
    codec: VideoDecoder | VideoEncoder,
    depth: () => number,
  ): ((limit: number) => Promise<void>) =>
    (limit) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (depth() <= limit) {
            codec.removeEventListener('dequeue', check)
            resolve()
          }
        }
        codec.addEventListener('dequeue', check)
        check()
      })

  return {
    decoder(config, on) {
      const decoder = new VideoDecoder({ output: on.frame, error: on.error })
      decoder.configure(config)
      return {
        decode: (chunk) => decoder.decode(chunk),
        flush: () => decoder.flush(),
        close: () => decoder.close(),
        get queued() {
          return decoder.decodeQueueSize
        },
        drainTo: drainer(decoder, () => decoder.decodeQueueSize),
      }
    },

    encoder(config, on) {
      const encoder = new VideoEncoder({ output: on.chunk, error: on.error })
      encoder.configure(config)
      return {
        encode: (frame, options) => encoder.encode(frame, options),
        flush: () => encoder.flush(),
        close: () => encoder.close(),
        get queued() {
          return encoder.encodeQueueSize
        },
        drainTo: drainer(encoder, () => encoder.encodeQueueSize),
      }
    },

    chunk: (init) => new EncodedVideoChunk(init),

    normalize: async (frame) => {
      const visible = frame.visibleRect
      if (!visible) throw new Error('The decoded frame has no visible picture to normalize.')
      const rect = {
        x: visible.x,
        y: visible.y,
        width: visible.width,
        height: visible.height,
      }

      // A hardware decoder may expose an opaque GPU frame: its `format` is null and neither
      // `allocationSize()` nor `copyTo()` is supported, even when RGBA is explicitly requested.
      // Canvas is the browser-provided readback path for that frame. `getImageData()` matters:
      // constructing from the canvas itself could produce another opaque frame and send the retry
      // around the same failure again.
      if (frame.format === null) {
        const canvas = new OffscreenCanvas(rect.width, rect.height)
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Could not create a canvas for CPU frame conversion.')
        // A VideoFrame is rendered through its visible rectangle already. In the crop path that
        // rectangle is the selected piece, so applying its coded x/y again would cut it twice.
        context.drawImage(frame, 0, 0, rect.width, rect.height)
        const pixels = context.getImageData(0, 0, rect.width, rect.height)
        return new VideoFrame(pixels.data, {
          format: 'RGBA',
          codedWidth: rect.width,
          codedHeight: rect.height,
          timestamp: frame.timestamp,
          ...(frame.duration === null ? {} : { duration: frame.duration }),
        })
      }

      const options: VideoFrameCopyToOptions = { format: 'RGBA', rect }
      const bytes = new Uint8Array(frame.allocationSize(options))
      const layout = await frame.copyTo(bytes, options)
      return new VideoFrame(bytes, {
        format: 'RGBA',
        codedWidth: rect.width,
        codedHeight: rect.height,
        layout: [...layout],
        timestamp: frame.timestamp,
        ...(frame.duration === null ? {} : { duration: frame.duration }),
      })
    },

    /**
     * The crop, and the only line of this program that cuts a picture.
     *
     * `visibleRect` is how WebCodecs says "this rectangle of it": the encoder reads the visible
     * rectangle and writes it at the size it was configured with, and those two are equal here by
     * construction — `plan.geometry` is `geometryOf(plan.crop, …)`. Without this the encoder
     * would be handed the whole frame and would *scale* it into that box.
     *
     * The timestamp is carried over deliberately: it is the key the encoded chunk is found by on
     * the way back, and a frame that lost it could not be placed in the track.
     */
    cut: (frame, crop) =>
      new VideoFrame(frame, {
        visibleRect: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
        timestamp: frame.timestamp,
        ...(frame.duration === null ? {} : { duration: frame.duration }),
      }),
  }
}
