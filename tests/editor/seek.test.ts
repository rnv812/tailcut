// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { frameSeeker, type SeekState } from '../../src/editor/player/seek'
import { FrameTable, type Frame } from '../../src/core/timeline/frames'

/** Ten frames of a twenty-fifth of a second each, starting at zero. */
const table = FrameTable.of(
  Array.from({ length: 10 }, (_, at): Frame => ({
    pts: at / 25,
    out: at / 25,
    duration: 1 / 25,
    sync: at % 5 === 0,
    source: { at: at * 10, length: 10 },
  })),
)

/**
 * A <video> that seeks only when told to. A real element decides for itself when a seek is done,
 * and what is under test here is exactly what happens in between.
 */
function fakeVideo() {
  const listeners = new Set<() => void>()
  const asked: number[] = []

  const element = {
    currentTime: 0,
    addEventListener(type: string, listener: () => void) {
      if (type === 'seeked') listeners.add(listener)
    },
    removeEventListener(_type: string, listener: () => void) {
      listeners.delete(listener)
    },
  }

  Object.defineProperty(element, 'currentTime', {
    get: () => asked[asked.length - 1] ?? 0,
    set: (value: number) => {
      asked.push(value)
    },
  })

  return {
    element: element as unknown as HTMLVideoElement,
    asked,
    /** The element finishes the seek it was last given. */
    settle: () => [...listeners].forEach((listener) => listener()),
    listeners,
  }
}

const record = () => {
  const seen: SeekState[] = []
  return { seen, onChange: (state: SeekState) => seen.push(state) }
}

describe('frameSeeker', () => {
  it('asks for the middle of the frame and not its boundary', () => {
    const video = fakeVideo()
    const seeker = frameSeeker(video.element, table, () => {})

    seeker.show(3)
    expect(video.asked).toEqual([table.seekTimeOf(3)])
    seeker.detach()
  })

  it('keeps one seek in flight: while the first runs, the rest are not issued', () => {
    const video = fakeVideo()
    const seeker = frameSeeker(video.element, table, () => {})

    seeker.show(1)
    seeker.show(2)
    seeker.show(3)
    seeker.show(4)

    expect(video.asked, 'the queue of seeks has started to grow').toEqual([table.seekTimeOf(1)])
    seeker.detach()
  })

  it('catches up to the last request afterwards and skips the ones between', () => {
    const video = fakeVideo()
    const seeker = frameSeeker(video.element, table, () => {})

    seeker.show(1)
    seeker.show(2)
    seeker.show(3)
    video.settle()

    expect(video.asked).toEqual([table.seekTimeOf(1), table.seekTimeOf(3)])

    video.settle()
    expect(video.asked, 'having caught up, it seeked once more into nothing').toHaveLength(2)
    seeker.detach()
  })

  it('says so while the picture is catching up', () => {
    const video = fakeVideo()
    const { seen, onChange } = record()
    const seeker = frameSeeker(video.element, table, onChange)

    seeker.show(4)
    expect(seen.at(-1)).toEqual({ wanted: 4, catchingUp: true })

    video.settle()
    expect(seeker.state()).toEqual({ wanted: 4, catchingUp: false })
    expect(seen.at(-1)).toEqual({ wanted: 4, catchingUp: false })
    seeker.detach()
  })

  it('lets the requested frame outrun the picture: what is reported is what was asked', () => {
    const video = fakeVideo()
    const seeker = frameSeeker(video.element, table, () => {})

    seeker.show(1)
    seeker.show(9)
    // The picture is still on the first frame, and the interface has to show the ninth: the
    // playhead is led by the keyboard and not by the decoder.
    expect(seeker.state().wanted).toBe(9)
    seeker.detach()
  })

  it('pulls an index off either end back onto the material', () => {
    const video = fakeVideo()
    const seeker = frameSeeker(video.element, table, () => {})

    seeker.show(-3)
    expect(seeker.state().wanted).toBe(0)
    video.settle()

    seeker.show(99)
    expect(seeker.state().wanted).toBe(9)
    seeker.detach()
  })

  it('seeks nowhere when the same frame is asked for twice', () => {
    const video = fakeVideo()
    const seeker = frameSeeker(video.element, table, () => {})

    seeker.show(2)
    video.settle()
    seeker.show(2)

    expect(video.asked).toHaveLength(1)
    seeker.detach()
  })

  it('does not undo a seek somebody else made', () => {
    // Playback and a drag on the timeline seek for themselves; correcting them is a fight.
    const video = fakeVideo()
    const seeker = frameSeeker(video.element, table, () => {})

    video.settle()
    expect(video.asked).toEqual([])
    seeker.detach()
  })

  it('unsubscribes from the element on detach', () => {
    const video = fakeVideo()
    const seeker = frameSeeker(video.element, table, () => {})

    seeker.detach()
    expect(video.listeners.size).toBe(0)
  })
})
