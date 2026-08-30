// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { CropBox, CropControls } from '../../src/editor/inspector/crop'
import type { CropRatio } from '../../src/core/encode/crop'

const host = document.createElement('div')
document.body.append(host)

afterEach(() => {
  render(null, host)
  vi.restoreAllMocks()
})

const at = <T extends HTMLElement>(testid: string): T =>
  host.querySelector<T>(`[data-testid="${testid}"]`)!

const point = (target: Element, type: string, clientX: number, clientY: number): void => {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, clientX, clientY, pointerId: 1 }),
  )
}

describe('the crop frame', () => {
  it('draws its source geometry in percentages with all eight handles', () => {
    render(
      <CropBox
        crop={{ x: 480, y: 270, width: 960, height: 540 }}
        frameSize={{ width: 1920, height: 1080 }}
        onCrop={vi.fn()}
      />,
      host,
    )

    const box = at<HTMLDivElement>('crop-box')
    expect(box.style.left).toBe('25%')
    expect(box.style.top).toBe('25%')
    expect(box.style.width).toBe('50%')
    expect(box.style.height).toBe('50%')
    expect(box.querySelectorAll('.tc-crop-handle')).toHaveLength(8)
  })

  it('moves the whole frame during a drag and closes the gesture with its final value', () => {
    const onCrop = vi.fn()
    render(
      <CropBox
        crop={{ x: 480, y: 270, width: 960, height: 540 }}
        frameSize={{ width: 1920, height: 1080 }}
        onCrop={onCrop}
      />,
      host,
    )
    vi.spyOn(at<HTMLDivElement>('crop-host'), 'getBoundingClientRect').mockReturnValue({
      width: 640,
      height: 360,
      x: 0,
      y: 0,
      top: 0,
      right: 640,
      bottom: 360,
      left: 0,
      toJSON: () => ({}),
    })

    const box = at<HTMLDivElement>('crop-box')
    point(box, 'pointerdown', 100, 100)
    point(box, 'pointermove', 110, 105)
    expect(onCrop).toHaveBeenNthCalledWith(
      1,
      { x: 510, y: 285, width: 960, height: 540 },
      true,
    )

    point(box, 'pointerup', 112, 106)
    expect(onCrop).toHaveBeenLastCalledWith(
      { x: 516, y: 288, width: 960, height: 540 },
      false,
    )
  })

  it('keeps a corner resize inside the source and no smaller than the crop minimum', () => {
    const onCrop = vi.fn()
    render(
      <CropBox
        crop={{ x: 100, y: 100, width: 200, height: 200 }}
        frameSize={{ width: 400, height: 300 }}
        onCrop={onCrop}
      />,
      host,
    )
    vi.spyOn(at<HTMLDivElement>('crop-host'), 'getBoundingClientRect').mockReturnValue({
      width: 400,
      height: 300,
      x: 0,
      y: 0,
      top: 0,
      right: 400,
      bottom: 300,
      left: 0,
      toJSON: () => ({}),
    })

    const southeast = at('crop-handle-se')
    point(southeast, 'pointerdown', 0, 0)
    point(southeast, 'pointermove', 500, 500)
    expect(onCrop).toHaveBeenLastCalledWith(
      { x: 100, y: 100, width: 300, height: 200 },
      true,
    )

    const northwest = at('crop-handle-nw')
    point(northwest, 'pointerdown', 0, 0)
    point(northwest, 'pointermove', -500, -500)
    expect(onCrop).toHaveBeenLastCalledWith(
      { x: 0, y: 0, width: 300, height: 300 },
      true,
    )

    point(northwest, 'pointerdown', 0, 0)
    point(northwest, 'pointermove', 500, 500)
    expect(onCrop).toHaveBeenLastCalledWith(
      { x: 236, y: 236, width: 64, height: 64 },
      true,
    )
    point(northwest, 'pointerup', 500, 500)
    expect(onCrop).toHaveBeenLastCalledWith(
      { x: 236, y: 236, width: 64, height: 64 },
      false,
    )
  })
})

describe('the crop controls', () => {
  const show = () => {
    const onRatio = vi.fn<(ratio: CropRatio) => void>()
    const onReset = vi.fn()
    const onApplyToAll = vi.fn()
    render(
      <CropControls
        crop={{ x: 480, y: 270, width: 960, height: 540 }}
        geometry={{ width: 960, height: 540, framerate: 30 }}
        onRatio={onRatio}
        onReset={onReset}
        onApplyToAll={onApplyToAll}
      />,
      host,
    )
    return { onRatio, onReset, onApplyToAll }
  }

  it('offers all four presets and sends each ratio under its own name', () => {
    const { onRatio } = show()

    for (const ratio of ['16:9', '9:16', '1:1', '4:5'] as const) {
      at<HTMLButtonElement>(`crop-ratio-${ratio}`).click()
    }

    expect(onRatio.mock.calls.map(([ratio]) => ratio)).toEqual(['16:9', '9:16', '1:1', '4:5'])
  })

  it('resets this crop and applies it to every clip through separate actions', () => {
    const { onReset, onApplyToAll } = show()

    at<HTMLButtonElement>('crop-reset').click()
    expect(onReset).toHaveBeenCalledTimes(1)

    at<HTMLButtonElement>('crop-apply-all').click()
    expect(onApplyToAll).toHaveBeenCalledTimes(1)
  })

  it('names the geometry the file will contain', () => {
    show()

    expect(at('crop-geometry').textContent).toBe('960 × 540')
  })
})
