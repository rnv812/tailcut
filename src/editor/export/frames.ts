import type { Crop } from '../../core/encode/crop'
import type { FramePlan } from '../../core/encode/plan'
import type { Located } from '../../shared/types'

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
): AsyncGenerator<VideoFrame> {
  const ready: VideoFrame[] = []
  let failed: Error | null = null

  const decoder = codecs.decoder(
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

        // §8.5, and the one place in the program a picture is made smaller than it was recorded.
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
        failed = error
      },
    },
  )

  try {
    for (const sample of plan.frames) {
      if (source.stale()) return

      // Hand over everything decoded so far before asking for more. The consumer awaits the
      // encoder, so this is where the whole chain finds its pace: no timer decides it.
      while (ready.length) {
        if (failed) throw failed
        yield ready.shift()!
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
      if (decoder.queued >= MAX_FRAMES_IN_FLIGHT) await decoder.drainTo(MAX_FRAMES_IN_FLIGHT - 1)

      decoder.decode(
        codecs.chunk({
          type: sample.sync ? 'key' : 'delta',
          timestamp: Math.round((sample.pts * 1_000_000) / plan.timescale),
          duration: Math.round((sample.duration * 1_000_000) / plan.timescale),
          data: bytes,
        }),
      )
    }

    await decoder.flush()
    if (failed) throw failed
    while (ready.length) yield ready.shift()!
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
