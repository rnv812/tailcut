import { describe, it, expect } from 'vitest'
import {
  CROP_RATIOS,
  MIN_CROP_PX,
  fullCrop,
  geometryOf,
  normalizeCrop,
  ratioCrop,
  type Crop,
  type SourceSize,
} from '../../src/core/encode/crop'

const LANDSCAPE: SourceSize = { width: 1920, height: 1080 }
const PORTRAIT: SourceSize = { width: 1080, height: 1920 }

/** Every number of a rectangle has to land on the chroma grid of a 4:2:0 frame (§8.5). */
const allEven = (crop: Crop): boolean =>
  crop.x % 2 === 0 && crop.y % 2 === 0 && crop.width % 2 === 0 && crop.height % 2 === 0

const inside = (crop: Crop, source: SourceSize): boolean =>
  crop.x >= 0 &&
  crop.y >= 0 &&
  crop.x + crop.width <= source.width &&
  crop.y + crop.height <= source.height

describe('ratioCrop', () => {
  it('gives back the whole picture when the picture is already that shape', () => {
    expect(ratioCrop('16:9', LANDSCAPE)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('centres the widest 16:9 rectangle a portrait frame holds', () => {
    // 1080 / (16/9) is 607.5, and the order of the two corrections decides what comes out of it:
    // `Math.round` first — a half goes up — gives 608, which is already even and is left alone.
    // Rounding straight down to even would give 606 and a rectangle a pixel-and-a-half short of
    // the shape that was asked for.
    expect(ratioCrop('16:9', PORTRAIT)).toEqual({ x: 0, y: 656, width: 1080, height: 608 })
  })

  it('keeps every preset in its own shape, centred, inside the picture', () => {
    const wanted: Record<(typeof CROP_RATIOS)[number], number> = {
      '16:9': 16 / 9,
      '9:16': 9 / 16,
      '1:1': 1,
      '4:5': 4 / 5,
    }

    for (const ratio of CROP_RATIOS) {
      const crop = ratioCrop(ratio, LANDSCAPE)

      // Within a pixel of the shape asked for: two roundings to even can move the ratio a little,
      // and on a 1080-tall rectangle that is worth well under a hundredth.
      expect(crop.width / crop.height, `${ratio} came out the wrong shape`).toBeCloseTo(
        wanted[ratio],
        2,
      )
      expect(inside(crop, LANDSCAPE), `${ratio} hangs out of the picture`).toBe(true)
      expect(allEven(crop), `${ratio} is not on the chroma grid`).toBe(true)
      // Centred: what is left of the picture is the same on both sides, to a pixel of rounding.
      expect(crop.x * 2, `${ratio} is not centred across`).toBeCloseTo(LANDSCAPE.width - crop.width, 0)
      expect(crop.y * 2, `${ratio} is not centred down`).toBeCloseTo(LANDSCAPE.height - crop.height, 0)
    }
  })
})

describe('normalizeCrop', () => {
  it('rounds all four numbers down to even', () => {
    // Sides *and* offsets. Evenness here is a property of how the colour is stored in the frame
    // being cut from — 4:2:0 writes the chroma planes half as often as the luma — so it is the
    // same correction whether this clip ends up an MP4 or an animation; `normalizeCrop` is not
    // given the format and there is no branch to give it to.
    expect(normalizeCrop({ x: 101, y: 7, width: 333, height: 187 }, LANDSCAPE)).toEqual({
      x: 100,
      y: 6,
      width: 332,
      height: 186,
    })
  })

  it('corrects an odd rectangle instead of refusing it', () => {
    // The rectangle arrives from a pointer, a preset or a saved document. Throwing here would be
    // an export that failed because a drag ended on an odd pixel.
    for (const crop of [
      { x: 1, y: 1, width: 65, height: 65 },
      { x: 999, y: 3, width: 801, height: 1077 },
      { x: 0, y: 0, width: 1919, height: 1079 },
    ]) {
      expect(() => normalizeCrop(crop, LANDSCAPE)).not.toThrow()

      const put = normalizeCrop(crop, LANDSCAPE)
      expect(allEven(put), `${JSON.stringify(crop)} came back odd`).toBe(true)
      expect(inside(put, LANDSCAPE), `${JSON.stringify(crop)} came back outside`).toBe(true)
    }
  })

  it('pushes a rectangle hanging over the edge back in rather than trimming it', () => {
    // The user was dragging a rectangle of a size they chose. Handing back a narrower one would
    // answer a question they did not ask.
    expect(normalizeCrop({ x: 1800, y: 1000, width: 400, height: 200 }, LANDSCAPE)).toEqual({
      x: 1520,
      y: 880,
      width: 400,
      height: 200,
    })
  })

  it('grows a rectangle smaller than the minimum up to it', () => {
    expect(normalizeCrop({ x: 10, y: 10, width: 20, height: 6 }, LANDSCAPE)).toEqual({
      x: 10,
      y: 10,
      width: MIN_CROP_PX,
      height: MIN_CROP_PX,
    })
  })

  it('gives the whole picture, rounded down to even, when the picture is smaller than the minimum', () => {
    // The minimum is about the person, not the material: a picture 51×33 in size cannot hold a
    // 64-pixel rectangle, and refusing to crop it is better than cropping outside it. The
    // rounding sits **after** the clamp, which is what keeps 51 from coming back as 51: rounding
    // first and clamping second would hand an odd number straight out of the edge of the picture.
    const tiny: SourceSize = { width: 51, height: 33 }

    expect(normalizeCrop({ x: 5, y: 5, width: 10, height: 10 }, tiny)).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 32,
    })
  })
})

describe('geometryOf', () => {
  it('asks for the size of the representation when there is no crop', () => {
    expect(geometryOf(null, LANDSCAPE, 30)).toEqual({ width: 1920, height: 1080, framerate: 30 })
    // Which is what the whole picture is as a rectangle, so the two cannot come apart.
    expect(fullCrop(LANDSCAPE)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('asks for the size of the rectangle when there is one, at the framerate it was given', () => {
    // The framerate comes from the context — the open representation's own — and not from a
    // constant: support is a property of the (codec, frame size, framerate) triple (§8.4), and a
    // geometry that guessed 30 would have the probe answer about a clip nobody asked about.
    const crop: Crop = { x: 100, y: 6, width: 332, height: 186 }

    expect(geometryOf(crop, LANDSCAPE, 60)).toEqual({ width: 332, height: 186, framerate: 60 })
  })
})
