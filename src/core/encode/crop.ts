import type { EncodeGeometry } from './codec'

/** A rectangle of the source picture, in the pixels the recording is coded in. */
export interface Crop {
  x: number
  y: number
  width: number
  height: number
}

export const CROP_RATIOS = ['16:9', '9:16', '1:1', '4:5'] as const
export type CropRatio = (typeof CROP_RATIOS)[number]

/**
 * The smallest frame worth cutting, in either direction.
 *
 * Not a codec limit. The hardware encoders here start refusing somewhere around 130×34 —
 * measured, on one machine, and it is a fact about that machine's encoder rather than about
 * cropping. That fact is told by the probe, per geometry, which is where it belongs. This one is
 * about the person: a rectangle smaller than this is a slip of the mouse, not a crop.
 */
export const MIN_CROP_PX = 64

const RATIOS: Record<CropRatio, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
}

export interface SourceSize {
  width: number
  height: number
}

const even = (value: number): number => value - (value % 2)

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

/**
 * A crop put right: inside the picture, big enough to be one, and even in all four numbers.
 *
 * **Evenness is a property of how the colour is stored, not of the rectangle and not of the file
 * being written.** What is cut from is a decoded frame in 4:2:0, where the chroma planes are
 * written half as often as the luma, so both the start of the sampling and its length have to
 * land on their grid. An odd *offset* does not give a skewed picture, it refuses to give one at
 * all: `new VideoFrame(frame, { visibleRect: { x: 7, … } })` answers `TypeError: Invalid
 * visibleRect. x is not sample-aligned in plane 1`, measured in this project's own Chromium, and
 * the same odd sides at x = 6 pass. So there is no format branch here: an animation is cut from
 * the same 4:2:0 frame an MP4 is, and telling the two apart would drop a clip rather than move a
 * rectangle by a pixel.
 *
 * Odd numbers are corrected rather than refused. The rectangle arrives from a pointer, a preset
 * or a saved document, and none of the three is in a position to be told it made a mistake.
 *
 * A frame that hangs over an edge is pushed back in rather than trimmed. The user was dragging a
 * rectangle of a chosen size; giving back a narrower one would answer a question they did not ask.
 */
export function normalizeCrop(crop: Crop, source: SourceSize): Crop {
  // Rounded down to even **after** the clamp, all four of them, so that neither the edge of the
  // picture nor the minimum can hand back an odd number the way a round-then-clamp would.
  const width = even(clamp(Math.round(crop.width), Math.min(MIN_CROP_PX, source.width), source.width))
  const height = even(clamp(Math.round(crop.height), Math.min(MIN_CROP_PX, source.height), source.height))

  return {
    x: even(clamp(Math.round(crop.x), 0, source.width - width)),
    y: even(clamp(Math.round(crop.y), 0, source.height - height)),
    width,
    height,
  }
}

/** The largest rectangle of that shape the picture holds, in the middle of it. */
export function ratioCrop(ratio: CropRatio, source: SourceSize): Crop {
  const wanted = RATIOS[ratio]
  const wide = source.width / source.height > wanted

  const width = wide ? source.height * wanted : source.width
  const height = wide ? source.height : source.width / wanted

  return normalizeCrop(
    {
      x: (source.width - width) / 2,
      y: (source.height - height) / 2,
      width,
      height,
    },
    source,
  )
}

/** The whole picture as a crop: what the free frame starts from. */
export const fullCrop = (source: SourceSize): Crop =>
  normalizeCrop({ x: 0, y: 0, width: source.width, height: source.height }, source)

/**
 * What the encoder will be asked for: the crop if there is one, the whole picture otherwise.
 *
 * The one place the three numbers of `EncodeGeometry` are assembled, so that the probe, the
 * estimate and the encoder cannot come to disagree about what is being encoded.
 */
export function geometryOf(crop: Crop | null, source: SourceSize, framerate: number): EncodeGeometry {
  const frame = crop ?? fullCrop(source)
  return { width: frame.width, height: frame.height, framerate }
}
