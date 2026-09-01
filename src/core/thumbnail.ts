import { keyframeClassifier } from './codec/keyframe'
import { decoderConfigOf } from './encode/decoder'
import type { SourceTrack } from './export/plan'
import type { Located } from '../shared/types'

export const THUMBNAIL_MAX_PX = 168
export const THUMBNAIL_WEBP_QUALITY = 0.7

const TARGET_SECONDS = 1

/** Recorded picture bytes and the index that names them. */
export interface ThumbnailSource {
  video: SourceTrack
  read(at: Located): Promise<Uint8Array>
}

/** The part of a decoded frame needed to make a still. */
export interface ThumbnailFrame {
  readonly displayWidth: number
  readonly displayHeight: number
  close(): void
}

export interface ThumbnailDecoder<Chunk> {
  decode(chunk: Chunk): void
  flush(): Promise<void>
  close(): void
}

export interface ThumbnailSurface<Frame extends ThumbnailFrame> {
  /** Draws and encodes the frame at the requested output size. */
  still(frame: Frame, width: number, height: number, quality: number): Promise<Uint8Array>
  close(): void
}

/** Browser operations injected at the edge so this module remains usable and testable in core. */
export interface ThumbnailRuntime<Frame extends ThumbnailFrame, Chunk> {
  supported(config: VideoDecoderConfig): Promise<boolean>
  decoder(
    config: VideoDecoderConfig,
    on: { frame(frame: Frame): void; error(error: Error): void },
  ): ThumbnailDecoder<Chunk>
  chunk(init: EncodedVideoChunkInit): Chunk
  surface(): ThumbnailSurface<Frame>
}

interface Picture {
  sample: SourceTrack['samples'][number]
  bytes: Uint8Array
}

/**
 * The real random-access picture closest to one second into the recording.
 *
 * Container dependency flags are only a hint. Each candidate is checked against its coded bytes
 * when the codec exposes a classifier, so a sample marked sync but containing a delta picture is
 * never handed to a decoder as a key chunk.
 */
async function pictureNearOneSecond(source: ThumbnailSource): Promise<Picture | null> {
  const track = source.video
  const firstPts = track.samples.reduce(
    (first, sample) => Math.min(first, sample.pts),
    Number.POSITIVE_INFINITY,
  )
  if (!Number.isFinite(firstPts)) return null

  const target = firstPts + TARGET_SECONDS * track.timescale
  const candidates = track.samples
    .filter((sample) => sample.sync)
    .slice()
    .sort((left, right) => {
      const distance = Math.abs(left.pts - target) - Math.abs(right.pts - target)
      return distance || left.pts - right.pts
    })

  for (const sample of candidates) {
    const bytes = await source.read(sample.source)
    // A fresh classifier makes an out-of-order thumbnail probe independent of any state learned
    // while inspecting a different AV1 sample.
    const judged = keyframeClassifier(track.sampleEntry)?.(bytes) ?? null
    if (judged === false) continue
    return { sample, bytes }
  }

  return null
}

function thumbnailSize(frame: ThumbnailFrame, track: SourceTrack): {
  width: number
  height: number
} | null {
  const sourceWidth = frame.displayWidth > 0 ? frame.displayWidth : track.width
  const sourceHeight = frame.displayHeight > 0 ? frame.displayHeight : track.height
  if (sourceWidth <= 0 || sourceHeight <= 0) return null

  const scale = Math.min(1, THUMBNAIL_MAX_PX / Math.max(sourceWidth, sourceHeight))
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  }
}

function closeResource(resource: { close(): void } | null): void {
  try {
    resource?.close()
  } catch {
    // A failed codec may already have closed itself. Cleanup must not replace the useful result.
  }
}

/**
 * Makes one small WebP without decoding the recording before or after the selected sync picture.
 * Unsupported codecs, unavailable bytes, decode failures, and canvas failures are a missing
 * optional thumbnail rather than a failed recording.
 */
export async function thumbnailOf<Frame extends ThumbnailFrame, Chunk>(
  source: ThumbnailSource,
  runtime: ThumbnailRuntime<Frame, Chunk>,
): Promise<Uint8Array | null> {
  const config = decoderConfigOf(source.video.sampleEntry)
  if (!config) return null

  let decoder: ThumbnailDecoder<Chunk> | null = null
  let frame: Frame | null = null
  let failed = false

  try {
    if (!(await runtime.supported(config))) return null
    const picture = await pictureNearOneSecond(source)
    if (!picture) return null

    decoder = runtime.decoder(config, {
      frame(output) {
        if (frame) closeResource(output)
        else frame = output
      },
      error() {
        failed = true
      },
    })
    decoder.decode(
      runtime.chunk({
        type: 'key',
        timestamp: Math.round((picture.sample.pts * 1_000_000) / source.video.timescale),
        duration: Math.round((picture.sample.duration * 1_000_000) / source.video.timescale),
        data: picture.bytes,
      }),
    )
    await decoder.flush()
    if (failed || !frame) return null

    const size = thumbnailSize(frame, source.video)
    if (!size) return null

    let surface: ThumbnailSurface<Frame> | null = null
    try {
      surface = runtime.surface()
      const bytes = await surface.still(
        frame,
        size.width,
        size.height,
        THUMBNAIL_WEBP_QUALITY,
      )
      return bytes.byteLength ? bytes : null
    } finally {
      closeResource(surface)
    }
  } catch {
    return null
  } finally {
    closeResource(decoder)
    closeResource(frame)
  }
}

/**
 * Defers thumbnail work until it is requested, shares one in-flight attempt, and caches success.
 * A failed attempt is not cached because a live recording may acquire usable bytes later.
 */
export function createLazyThumbnail<Frame extends ThumbnailFrame, Chunk>(
  source: ThumbnailSource,
  runtime: ThumbnailRuntime<Frame, Chunk>,
): () => Promise<Uint8Array | null> {
  let cached: Uint8Array | null = null
  let pending: Promise<Uint8Array | null> | null = null

  return () => {
    if (cached) return Promise.resolve(cached)
    if (pending) return pending

    pending = thumbnailOf(source, runtime)
      .then((thumbnail) => {
        if (thumbnail) cached = thumbnail
        return thumbnail
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
}
