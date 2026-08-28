/**
 * Width of the frame under the pointer, in CSS pixels.
 *
 * Wide enough to recognise a scene, narrow enough that a sweep of the strip is a sweep and not a
 * slideshow: at 168 pixels a bitmap is about 60 KB, and the whole cache of them under three
 * megabytes.
 */
export const THUMB_WIDTH_PX = 168

/** How close to the edge of the strip the box may come. */
export const THUMB_MARGIN_PX = 6

/**
 * How far from the pointer a frame already decoded may stand and still be worth showing while the
 * right one is on its way. Past this the box is left empty: a picture half a minute away from the
 * timecode under it is a lie, not a placeholder.
 */
export const THUMB_NEAR_SECONDS = 0.5

/** Where the pointer stands over the strip, in pixels and in media time. */
export interface Hover {
  xPx: number
  time: number
}

/** Left edge of a box of this width: centred on the pointer, kept inside the strip. */
export function tooltipLeft(
  xPx: number,
  widthPx: number,
  tooltipPx: number,
  marginPx: number = THUMB_MARGIN_PX,
): number {
  const last = widthPx - tooltipPx - marginPx
  if (last < marginPx) return Math.max(0, Math.round((widthPx - tooltipPx) / 2))

  const wanted = Math.round(xPx - tooltipPx / 2)
  return wanted < marginPx ? marginPx : wanted > last ? last : wanted
}
