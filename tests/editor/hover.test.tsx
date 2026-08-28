// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from 'preact'
import { FrameTable, type Frame } from '../../src/core/timeline/frames'
import { THUMB_WIDTH_PX, tooltipLeft } from '../../src/core/timeline/hover'
import { FramePreview } from '../../src/editor/timeline/hover'
import type { Preview } from '../../src/editor/source/preview'

/**
 * 24000/1001 material — 23.976 frames a second, counted at 24.
 *
 * Not a round 25, and the difference is the whole of one test below. On a table whose frames sit
 * exactly 1/fps apart, the frame field of a timecode is the index of the frame inside its second
 * whichever of the two times is formatted, so "the frame the pointer is on" and "the instant the
 * pointer stands at" print the same string on every pixel of the strip.
 */
const FPS = 24_000 / 1_001
const STEP = 1 / FPS

const frames = Array.from({ length: 250 }, (_, index): Frame => ({
  pts: index * STEP,
  out: index * STEP,
  duration: STEP,
  sync: index % 24 === 0,
  source: { at: 0, length: 1 },
}))

const preview: Preview = {
  url: 'blob:tailcut/preview',
  bytes: 1_024,
  frames: FrameTable.of(frames),
  release: () => {},
}

interface Draw {
  op: string
  args: number[]
  bitmap?: unknown
}

/** What the box drew. happy-dom has no 2d context, so it is given a recording one. */
let draws: Draw[] = []

function installContext(): void {
  const context = {
    clearRect: (...args: number[]) => draws.push({ op: 'clearRect', args }),
    drawImage: (bitmap: unknown, ...args: number[]) => draws.push({ op: 'drawImage', args, bitmap }),
  }
  // Cast whole: getContext is declared as five overloads, and a stub that answers one of them is
  // not assignable to the lot of them.
  HTMLCanvasElement.prototype.getContext = (() =>
    context) as unknown as HTMLCanvasElement['getContext']
}

const host = document.createElement('div')
document.body.append(host)

beforeEach(() => {
  draws = []
  installContext()
})

afterEach(() => {
  render(null, host)
  vi.unstubAllGlobals()
})

/**
 * The turn on which preact runs the effects of a render.
 *
 * `useLayoutEffect` runs during the render and `useEffect` does not: preact flushes it from a
 * `setTimeout` scheduled inside its own frame callback. The source of pictures is made in a
 * `useEffect`, so a test that does not wait for one has no source at all.
 */
const afterEffects = async (): Promise<void> => {
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('FramePreview', () => {
  it('stays out of the way while the pointer is not over the strip', async () => {
    let taken = 0
    vi.stubGlobal('createImageBitmap', async () => {
      taken++
      return { close: () => {} } as unknown as ImageBitmap
    })

    render(<FramePreview preview={preview} hover={null} widthPx={1_000} fps={FPS} />, host)
    await afterEffects()

    expect(host.querySelector<HTMLElement>('[data-testid="thumb"]')!.hidden).toBe(true)
    // The element is still there: unmounting it would throw away the cache and the decoder, and
    // the next hover would start from nothing again.
    const video = host.querySelector('video')!
    expect(video.src).toBe('blob:tailcut/preview')

    // Mounted is not working. With no pointer there is no frame, and a box that read that as
    // frame 0 would sit behind the timeline asking for a decode nobody wanted and answering a
    // `seeked` that belongs to whoever else moved the element.
    video.dispatchEvent(new Event('seeked'))
    await afterEffects()

    expect(taken).toBe(0)
    expect(video.dataset.seeks).toBeUndefined()
    expect(host.querySelector('[data-testid="thumb-shot"]')!.getAttribute('data-exact')).toBe('no')
    expect(draws.some((call) => call.op === 'drawImage')).toBe(false)
  })

  it('says the timecode of the frame under the pointer straight away', () => {
    render(<FramePreview preview={preview} hover={{ xPx: 400, time: 3.5 }} widthPx={1_000} fps={FPS} />, host)

    // The picture is a seek away; the number is not, and it is the frame the pointer is on and
    // not the instant between two frames it stands at: 3.5 s falls inside frame 83, which begins
    // at 3.4618 s, and at 24 counted frames a second those are frames 11 and 12 of that second.
    expect(host.querySelector('[data-testid="thumb-time"]')!.textContent).toBe('00:00:03:11')
    expect(host.querySelector<HTMLElement>('[data-testid="thumb"]')!.hidden).toBe(false)
  })

  it('keeps the box inside the strip', () => {
    render(<FramePreview preview={preview} hover={{ xPx: 995, time: 3.5 }} widthPx={1_000} fps={FPS} />, host)

    const box = host.querySelector<HTMLElement>('[data-testid="thumb"]')!
    expect(box.style.left).toBe(`${tooltipLeft(995, 1_000, THUMB_WIDTH_PX)}px`)
  })

  it('shows the frame beside the one asked for, dimmed, until the right one arrives', async () => {
    // The only stand-in for a decoder happy-dom can be given. The element never seeks and never
    // fires `seeked` of its own, so both are done by hand below.
    const bitmap = { close: () => {} } as unknown as ImageBitmap
    vi.stubGlobal('createImageBitmap', async () => bitmap)

    // 1.0 s falls inside frame 23, 1.2 s inside frame 28 — a fifth of a second apart, well inside
    // the half second a neighbour may stand at.
    render(<FramePreview preview={preview} hover={{ xPx: 400, time: 1 }} widthPx={1_000} fps={FPS} />, host)
    await afterEffects()
    host.querySelector('video')!.dispatchEvent(new Event('seeked'))
    await afterEffects()

    const shot = host.querySelector<HTMLCanvasElement>('[data-testid="thumb-shot"]')!
    expect(shot.getAttribute('data-exact')).toBe('yes')
    expect(shot.style.opacity).toBe('1')

    draws.length = 0
    render(<FramePreview preview={preview} hover={{ xPx: 420, time: 1.2 }} widthPx={1_000} fps={FPS} />, host)
    await afterEffects()

    // The timecode is already the new frame's — that costs a lookup — while the picture is still
    // the old one. Dimming it is the only honest way to say so: shown at full strength it is a
    // frame claiming to be a frame it is not.
    expect(host.querySelector('[data-testid="thumb-time"]')!.textContent).toBe('00:00:01:04')
    expect(shot.getAttribute('data-exact')).toBe('no')
    expect(shot.style.opacity).toBe('0.55')
    expect(draws.filter((call) => call.op === 'drawImage').map((call) => call.bitmap)).toEqual([bitmap])
  })

  it('lets go of the pictures when the box leaves the page', async () => {
    let closed = false
    const bitmap = { close: () => { closed = true } } as unknown as ImageBitmap
    vi.stubGlobal('createImageBitmap', async () => bitmap)

    render(<FramePreview preview={preview} hover={{ xPx: 400, time: 1 }} widthPx={1_000} fps={FPS} />, host)
    await afterEffects()
    host.querySelector('video')!.dispatchEvent(new Event('seeked'))
    await afterEffects()
    expect(closed).toBe(false)

    render(null, host)

    // Up to forty-eight of these at a time, and their memory lies outside the JS heap: dropping
    // the component that holds them is not dropping them.
    expect(closed).toBe(true)
  })

  it('shows nothing rather than a stale picture before the first frame arrives', () => {
    render(<FramePreview preview={preview} hover={{ xPx: 400, time: 3.5 }} widthPx={1_000} fps={FPS} />, host)

    expect(host.querySelector('[data-testid="thumb-shot"]')!.getAttribute('data-exact')).toBe('no')
    // Nothing has been decoded yet, so the box is empty — and empty means wiped, not merely not
    // drawn on. A canvas that is only ever drawn on keeps the frame of the last hover standing
    // under the timecode of this one.
    expect(draws.map((call) => call.op)).toEqual(['clearRect'])
  })
})
