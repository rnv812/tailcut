import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'preact/hooks'
import { THUMB_WIDTH_PX, tooltipLeft, type Hover } from '../../core/timeline/hover'
import { formatTimecode } from '../../core/timeline/timecode'
import { thumbSource, type ThumbSource } from '../player/thumbs'
import type { Preview } from '../source/preview'

export interface FramePreviewProps {
  preview: Preview
  /** Where the pointer stands over the strip; null keeps the box hidden. */
  hover: Hover | null
  /** Width of the strip, so the box can be kept inside it. */
  widthPx: number
  fps: number
}

/**
 * The frame under the pointer, with its timecode.
 *
 * The timecode is right immediately and the picture catches up, never the other way round: the
 * number costs a lookup in the frame table, the picture costs a decode from the last keyframe.
 * When the exact frame is not decoded yet, a neighbour within half a second is shown dimmed —
 * which is the difference between "the picture is coming" and "this is the frame".
 */
export function FramePreview({ preview, hover, widthPx, fps }: FramePreviewProps) {
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const source = useRef<ThumbSource | null>(null)
  // A counter nothing reads. Bumping it is how a bitmap that arrived outside the render cycle
  // asks for a repaint; the action is typed `void` so that the bump takes no argument.
  const [, arrived] = useReducer((count: number, _bump: void) => count + 1, 0)
  const [height, setHeight] = useState(Math.round((THUMB_WIDTH_PX * 9) / 16))

  const table = preview.frames
  const index = hover ? Math.max(0, table.indexAt(hover.time)) : -1

  useEffect(() => {
    const element = video.current
    if (!element) return

    // The count of seeks goes onto the element as an attribute rather than into state: it exists
    // for the browser test, and a number in state would repaint the component to carry it.
    const arrivedAt = (): void => {
      element.dataset.seeks = String(source.current?.seeks ?? 0)
      arrived()
    }

    const made = thumbSource(element, table, arrivedAt)
    source.current = made
    return () => {
      made.close()
      source.current = null
    }
  }, [table])

  useEffect(() => {
    if (index >= 0) source.current?.want(index)
  }, [index])

  const shown = index >= 0 ? (source.current?.shown(index) ?? null) : null

  useLayoutEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, THUMB_WIDTH_PX, height)
    if (shown) context.drawImage(shown.bitmap, 0, 0, THUMB_WIDTH_PX, height)
  }, [shown, height])

  const measure = (): void => {
    const element = video.current
    if (!element?.videoWidth) return
    setHeight(Math.round((THUMB_WIDTH_PX * element.videoHeight) / element.videoWidth))
  }

  return (
    <div
      class="tc-thumb"
      data-testid="thumb"
      hidden={!hover}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: `${tooltipLeft(hover?.xPx ?? 0, widthPx, THUMB_WIDTH_PX)}px`,
        pointerEvents: 'none',
      }}
    >
      {/* The element the pictures are taken off. It is never seen and never played, and it is
          kept mounted so that the cache outlives the pointer leaving the strip. */}
      <video
        ref={video}
        src={preview.url}
        preload="auto"
        muted
        playsInline
        onLoadedMetadata={measure}
        style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0 }}
      />
      <canvas
        ref={canvas}
        width={THUMB_WIDTH_PX}
        height={height}
        data-testid="thumb-shot"
        data-exact={shown?.exact ? 'yes' : 'no'}
        style={{ display: 'block', background: '#000', opacity: shown && !shown.exact ? 0.55 : 1 }}
      />
      <div class="tc-thumb-time" data-testid="thumb-time">
        {formatTimecode(table.at(index)?.pts ?? hover?.time ?? 0, fps)}
      </div>
    </div>
  )
}
