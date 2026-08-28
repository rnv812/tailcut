// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { FrameTable, type Frame } from '../../src/core/timeline/frames'
import { thumbSource } from '../../src/editor/player/thumbs'

/** Ten frames of forty milliseconds, the shape a preview of 25 fps material has. */
const table = FrameTable.of(
  Array.from({ length: 10 }, (_, index): Frame => ({
    pts: index * 0.04,
    out: index * 0.04,
    duration: 0.04,
    sync: index === 0,
    source: { at: 0, length: 1 },
  })),
)

interface Fake {
  id: number
  closed: boolean
}

/** A stand-in for ImageBitmap: happy-dom has neither createImageBitmap nor a canvas to draw on. */
const fakes: Fake[] = []
const capture = vi.fn(async (): Promise<ImageBitmap> => {
  const fake: Fake = { id: fakes.length, closed: false }
  fakes.push(fake)
  return { ...fake, close: () => { fake.closed = true } } as unknown as ImageBitmap
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const stand = (options = {}) => {
  const video = document.createElement('video')
  const drawn: number[] = []
  const source = thumbSource(video, table, () => drawn.push(video.currentTime), { capture, ...options })
  // happy-dom does not decode anything, so the element is told it has arrived by hand.
  const arrive = async (): Promise<void> => {
    video.dispatchEvent(new Event('seeked'))
    await settle()
  }
  return { video, source, drawn, arrive }
}

describe('thumbSource', () => {
  it('keeps one seek in flight and lets the last request win', async () => {
    const { video, source, arrive } = stand()

    source.want(1)
    source.want(5)
    source.want(9)

    // Three requests, one seek: the two the pointer swept over are never asked for.
    expect(source.seeks).toBe(1)
    expect(video.currentTime).toBeCloseTo(table.seekTimeOf(1), 9)

    await arrive()
    expect(source.seeks).toBe(2)
    expect(video.currentTime).toBeCloseTo(table.seekTimeOf(9), 9)
  })

  it('costs nothing to come back to a frame already seen', async () => {
    const { source, arrive } = stand()

    source.want(3)
    await arrive()
    const after = source.seeks

    source.want(3)
    expect(source.seeks).toBe(after)
    expect(source.shown(3)).toEqual({ bitmap: expect.anything(), exact: true })
  })

  it('offers a near frame while the exact one is on its way, and says it is not the one', async () => {
    const { source, arrive } = stand()

    source.want(3)
    await arrive()

    // Frame 5 is eighty milliseconds from frame 3: near enough to stand in for it.
    const near = source.shown(5)
    expect(near?.exact).toBe(false)
    expect(near?.bitmap).toBe(source.shown(3)!.bitmap)
  })

  it('offers nothing rather than a picture from somewhere else', async () => {
    const { source, arrive } = stand({ nearSeconds: 0.05 })

    source.want(0)
    await arrive()

    expect(source.shown(9)).toBeNull()
  })

  it('throws the oldest picture away when the cache is full, and closes it', async () => {
    // The neighbourhood is narrowed along with the cache. All ten frames of this table lie inside
    // the default half second of each other, so a frame thrown out is still answered by the one
    // beside it, and `null` would be a claim about the reach of `shown` and not about eviction.
    const { source, arrive } = stand({ cache: 2, nearSeconds: 0.05 })

    source.want(0)
    await arrive()
    const oldest = fakes[fakes.length - 1]!
    source.want(4)
    await arrive()
    source.want(8)
    await arrive()

    expect(source.shown(0)).toBeNull()
    // An ImageBitmap holds memory outside the JS heap: dropping the reference is not enough.
    expect(oldest.closed).toBe(true)
  })

  it('holds the element still while a picture is being taken off it', async () => {
    // createImageBitmap reads the frame the element is showing at the moment it runs. A seek
    // issued while that read is outstanding moves the element under it, and the picture filed
    // against one frame is of another.
    let finish = (): void => {}
    const slow = async (): Promise<ImageBitmap> => {
      await new Promise<void>((resolve) => { finish = resolve })
      return capture()
    }
    const { source, arrive } = stand({ capture: slow })

    source.want(2)
    await arrive()
    expect(source.seeks).toBe(1)

    source.want(7)
    expect(source.seeks).toBe(1)

    finish()
    await settle()
    expect(source.seeks).toBe(2)
  })

  it('lets go of the element and of every picture when it is closed', async () => {
    const { video, source, arrive } = stand()

    source.want(2)
    await arrive()
    const held = fakes[fakes.length - 1]!
    // A seek is left in flight on purpose. With nothing outstanding a listener still on the
    // element answers a `seeked` by returning at its first line, and "it did not throw" is a
    // sentence that is just as true of a source that never let go.
    source.want(7)
    const taken = fakes.length
    source.close()

    expect(held.closed).toBe(true)
    expect(source.shown(2)).toBeNull()

    // A listener left on the element keeps the whole source alive with it, and goes on taking
    // pictures off a video nobody is looking at.
    video.dispatchEvent(new Event('seeked'))
    await settle()
    expect(fakes).toHaveLength(taken)
  })
})
