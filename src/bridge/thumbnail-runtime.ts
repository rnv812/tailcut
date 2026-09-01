import type { ThumbnailRuntime } from '../core/thumbnail'

/** Closing an errored WebCodecs object may itself report that the object is already closed. */
function closeDecoder(decoder: VideoDecoder): void {
  try {
    decoder.close()
  } catch {
    // Cleanup must remain safe after either a synchronous configure failure or decoder error.
  }
}

/** Browser operations used by the core thumbnail generator. */
export function liveThumbnailRuntime(): ThumbnailRuntime<VideoFrame, EncodedVideoChunk> {
  return {
    async supported(config) {
      try {
        const answer = await VideoDecoder.isConfigSupported(config)
        return answer.supported === true
      } catch {
        return false
      }
    },

    decoder(config, on) {
      const decoder = new VideoDecoder({ output: on.frame, error: on.error })
      try {
        decoder.configure(config)
      } catch (error) {
        closeDecoder(decoder)
        throw error
      }

      let closed = false
      return {
        decode: (chunk) => decoder.decode(chunk),
        flush: () => decoder.flush(),
        close() {
          if (closed) return
          closed = true
          closeDecoder(decoder)
        },
      }
    },

    chunk: (init) => new EncodedVideoChunk(init),

    surface() {
      let closed = false
      return {
        async still(frame, width, height, quality) {
          if (closed) throw new Error('The thumbnail surface is closed.')
          const canvas = new OffscreenCanvas(width, height)
          const context = canvas.getContext('2d')
          if (!context) throw new Error('Could not create a canvas for the thumbnail.')

          context.drawImage(frame, 0, 0, width, height)
          const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
          return new Uint8Array(await blob.arrayBuffer())
        },
        close() {
          closed = true
        },
      }
    },
  }
}
