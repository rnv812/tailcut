import { useRef } from 'preact/hooks'
import type { EncodeGeometry } from '../../core/encode/codec'
import { CROP_RATIOS, MIN_CROP_PX, fullCrop, type Crop, type CropRatio, type SourceSize } from '../../core/encode/crop'

/** The eight handles, as the sides each one moves. A null side is one that handle leaves alone. */
const HANDLES = [
  { id: 'nw', x: 'left', y: 'top' },
  { id: 'n', x: null, y: 'top' },
  { id: 'ne', x: 'right', y: 'top' },
  { id: 'e', x: 'right', y: null },
  { id: 'se', x: 'right', y: 'bottom' },
  { id: 's', x: null, y: 'bottom' },
  { id: 'sw', x: 'left', y: 'bottom' },
  { id: 'w', x: 'left', y: null },
] as const

type Handle = (typeof HANDLES)[number]

interface Drag {
  /** Null for a drag of the middle: the whole rectangle moves and no side is resized. */
  handle: Handle | null
  startX: number
  startY: number
  from: Crop
  /** Source pixels per screen pixel, measured once when the gesture began. */
  scale: number
}

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

const percent = (part: number, whole: number): string => `${whole > 0 ? (part / whole) * 100 : 0}%`

/**
 * Where the rectangle goes for a pointer that has moved this far, in source pixels.
 *
 * A drag of the middle moves it whole; a handle moves the one or two sides it names and leaves
 * the rest where they were. The edges of the picture and `MIN_CROP_PX` are held here rather than
 * left to the reducer, because a frame that visibly escapes the player and is silently pulled
 * back on the next render reads as a broken control. `normalizeCrop` still has the last word: it
 * rounds all four numbers down to even, in every format, because what is cut from is a 4:2:0
 * frame and not a container (§8.5). So the rectangle this returns may still move by a pixel, and
 * it is the reducer's copy that the clip keeps.
 */
function nextCrop(state: Drag, dx: number, dy: number, source: SourceSize): Crop {
  const { from, handle } = state

  if (!handle) {
    return {
      ...from,
      x: Math.round(clamp(from.x + dx, 0, Math.max(0, source.width - from.width))),
      y: Math.round(clamp(from.y + dy, 0, Math.max(0, source.height - from.height))),
    }
  }

  let { x, y, width, height } = from

  if (handle.x === 'left') {
    const left = clamp(from.x + dx, 0, from.x + from.width - MIN_CROP_PX)
    x = left
    width = from.x + from.width - left
  }
  if (handle.x === 'right') {
    width = clamp(from.x + from.width + dx, from.x + MIN_CROP_PX, source.width) - from.x
  }
  if (handle.y === 'top') {
    const top = clamp(from.y + dy, 0, from.y + from.height - MIN_CROP_PX)
    y = top
    height = from.y + from.height - top
  }
  if (handle.y === 'bottom') {
    height = clamp(from.y + from.height + dy, from.y + MIN_CROP_PX, source.height) - from.y
  }

  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

export interface CropBoxProps {
  /** The rectangle, in the source's own pixels; null means the whole picture. */
  crop: Crop | null
  frameSize: SourceSize
  /** True for every event of a gesture but the last — §8.5: one press of Ctrl+Z per gesture. */
  onCrop: (crop: Crop, dragging: boolean) => void
}

/**
 * The crop rectangle, drawn over the player.
 *
 * Two coordinate systems meet here and the meeting happens in exactly one line each way. The
 * rectangle **is** in the source's pixels, and it goes into the action in them: keeping it in
 * fractions instead would be tempting and wrong, because a fraction times 1920 is not a whole
 * number, `normalizeCrop` rounds, and the frame the user placed would creep by a pixel on every
 * redraw. Screen pixels enter only as a pointer delta, multiplied by a scale measured once when
 * the gesture began — so a player resized mid-drag cannot make the frame jump.
 *
 * The box is *drawn* in per cent of the frame, which needs no measurement at all: a 960×540 crop
 * of a 1920×1080 picture is half the player's width whatever the player's width is, and stays
 * right through a resize that fires no event here.
 */
export function CropBox({ crop, frameSize, onCrop }: CropBoxProps) {
  const host = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const frame = crop ?? fullCrop(frameSize)

  function begin(event: PointerEvent, handle: Handle | null) {
    event.preventDefault()
    event.stopPropagation()
    const width = host.current?.getBoundingClientRect().width ?? 0
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
    drag.current = {
      handle,
      startX: event.clientX,
      startY: event.clientY,
      from: frame,
      // A host of no width has not been laid out yet. A gesture on it moves the frame by nothing,
      // which is the only harmless answer; dividing by it would move the frame by infinity.
      scale: width > 0 ? frameSize.width / width : 0,
    }
  }

  function moveBy(event: PointerEvent, dragging: boolean) {
    const state = drag.current
    if (!state) return
    if (!dragging) drag.current = null

    onCrop(
      nextCrop(
        state,
        (event.clientX - state.startX) * state.scale,
        (event.clientY - state.startY) * state.scale,
        frameSize,
      ),
      dragging,
    )
  }

  return (
    <div class="tc-crop-host" ref={host} data-testid="crop-host">
      <div
        class="tc-crop-box"
        data-testid="crop-box"
        style={{
          left: percent(frame.x, frameSize.width),
          top: percent(frame.y, frameSize.height),
          width: percent(frame.width, frameSize.width),
          height: percent(frame.height, frameSize.height),
        }}
        onPointerDown={(event) => begin(event, null)}
        onPointerMove={(event) => moveBy(event, true)}
        onPointerUp={(event) => moveBy(event, false)}
        onPointerCancel={() => (drag.current = null)}
      >
        {HANDLES.map((handle) => (
          <span
            key={handle.id}
            class={`tc-crop-handle tc-crop-${handle.id}`}
            data-testid={`crop-handle-${handle.id}`}
            onPointerDown={(event) => begin(event, handle)}
            onPointerMove={(event) => moveBy(event, true)}
            onPointerUp={(event) => moveBy(event, false)}
            onPointerCancel={() => (drag.current = null)}
          />
        ))}
      </div>
    </div>
  )
}

export interface CropControlsProps {
  crop: Crop | null
  /** What the file will actually be — the crop, or the whole picture when there is no crop. */
  geometry: EncodeGeometry
  onRatio: (ratio: CropRatio) => void
  onReset: () => void
  onApplyToAll: () => void
}

/**
 * The four presets, the reset and "apply to all", with the output geometry said out loud.
 *
 * The line under the buttons names the picture that will be written — not the rectangle in screen
 * pixels, which is a number about this window and about nothing the user is going to keep.
 */
export function CropControls({ crop, geometry, onRatio, onReset, onApplyToAll }: CropControlsProps) {
  return (
    <div class="tc-crop-controls">
      {CROP_RATIOS.map((ratio) => (
        <button
          key={ratio}
          type="button"
          data-testid={`crop-ratio-${ratio}`}
          onClick={() => onRatio(ratio)}
        >
          {ratio}
        </button>
      ))}

      <button type="button" data-testid="crop-reset" disabled={crop === null} onClick={onReset}>
        Reset
      </button>
      <button type="button" data-testid="crop-apply-all" onClick={onApplyToAll}>
        Apply to all clips
      </button>

      <span class="muted" data-testid="crop-geometry">
        {geometry.width} × {geometry.height}
      </span>
    </div>
  )
}
