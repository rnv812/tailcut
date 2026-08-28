import { THUMB_NEAR_SECONDS, THUMB_WIDTH_PX } from '../../core/timeline/hover'
import type { FrameTable } from '../../core/timeline/frames'

/** How many pictures are kept. Sixty kilobytes each, so the whole cache is under three megabytes. */
export const THUMB_CACHE = 48

export interface Shown {
  bitmap: ImageBitmap
  /** False when this is a neighbour standing in while the frame asked for is decoded. */
  exact: boolean
}

export interface ThumbOptions {
  /** Turns what the element is showing into a picture. Replaced in tests, where there is none. */
  capture?: (video: HTMLVideoElement) => Promise<ImageBitmap>
  cache?: number
  nearSeconds?: number
}

export interface ThumbSource {
  /** Asks for a frame. At most one seek is ever in flight, and the last request wins. */
  want(index: number): void
  /** What can be drawn for that frame right now. */
  shown(index: number): Shown | null
  /** How many seeks the element has been sent — the number the browser test is about. */
  readonly seeks: number
  close(): void
}

const defaultCapture = (video: HTMLVideoElement): Promise<ImageBitmap> =>
  createImageBitmap(video, { resizeWidth: THUMB_WIDTH_PX, resizeQuality: 'low' })

/**
 * Frames of the preview, taken one at a time and kept.
 *
 * The dropping of requests is the whole design. A seek costs from sixteen milliseconds to a
 * hundred and thirty depending on the codec and on how deep inside a group of pictures it lands,
 * and a pointer sweeping the strip asks sixty times a second. Queued, the picture would fall
 * seconds behind the cursor and stay there; dropped, it lags by one seek and lands wherever the
 * hand stopped.
 */
export function thumbSource(
  video: HTMLVideoElement,
  table: FrameTable,
  onFrame: () => void,
  options: ThumbOptions = {},
): ThumbSource {
  const capture = options.capture ?? defaultCapture
  const limit = options.cache ?? THUMB_CACHE
  const near = options.nearSeconds ?? THUMB_NEAR_SECONDS
  const cache = new Map<number, ImageBitmap>()

  let wanted = -1
  /** The frame the element was last sent to; −1 when nothing is in flight. */
  let asked = -1
  let taking = false
  let seeks = 0
  let closed = false

  const store = (index: number, bitmap: ImageBitmap): void => {
    cache.set(index, bitmap)
    while (cache.size > limit) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.get(oldest.value)?.close()
      cache.delete(oldest.value)
    }
  }

  const issue = (): void => {
    if (closed || taking || asked !== -1 || wanted < 0 || cache.has(wanted)) return
    asked = wanted
    seeks++
    video.currentTime = table.seekTimeOf(asked)
  }

  const onSeeked = (): void => {
    // A seek nobody here asked for. Two parties correcting one element is a fight neither wins.
    if (asked === -1) return

    const done = asked
    asked = -1
    taking = true

    void capture(video)
      .then((bitmap) => {
        if (closed) {
          bitmap.close()
          return
        }
        store(done, bitmap)
        onFrame()
      })
      .catch(() => {
        // A frame that would not decode is a frame not shown; the pointer is still moving.
      })
      .finally(() => {
        taking = false
        // The picture is taken before the next seek is issued: the element must not move while
        // the bitmap is being made off it.
        if (wanted !== done) issue()
      })
  }

  video.addEventListener('seeked', onSeeked)

  return {
    get seeks(): number {
      return seeks
    },

    want(index: number): void {
      wanted = Math.min(Math.max(index, 0), Math.max(table.count() - 1, 0))
      if (cache.has(wanted)) {
        onFrame()
        return
      }
      issue()
    },

    shown(index: number): Shown | null {
      const exact = cache.get(index)
      if (exact) return { bitmap: exact, exact: true }

      const frame = table.at(index)
      if (!frame) return null

      let best: Shown | null = null
      let apart = near

      for (const [at, bitmap] of cache) {
        const other = table.at(at)
        if (!other) continue
        const distance = Math.abs(other.pts - frame.pts)
        if (distance <= apart) {
          apart = distance
          best = { bitmap, exact: false }
        }
      }

      return best
    },

    close(): void {
      closed = true
      video.removeEventListener('seeked', onSeeked)
      for (const bitmap of cache.values()) bitmap.close()
      cache.clear()
    },
  }
}
