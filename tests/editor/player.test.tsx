// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { render } from 'preact'
import { FrameTable, type Frame } from '../../src/core/timeline/frames'
import { Player } from '../../src/editor/player/player'
import type { Preview } from '../../src/editor/source/preview'

/**
 * Six displayed frames on two clocks.
 *
 * The preview file closes the recording hole and counts 0…5. Session PTS keeps it and counts
 * 10, 11, 12, 20, 21, 22. A playback boundary stated in session PTS therefore cannot be compared
 * to requestVideoFrameCallback's mediaTime directly.
 */
const rows: Frame[] = [10, 11, 12, 20, 21, 22].map((pts, index) => ({
  pts,
  out: index,
  duration: 1,
  sync: index === 0,
  source: { at: index, length: 1 },
}))

const table = FrameTable.of(rows)
const preview: Preview = {
  url: 'blob:tailcut/player',
  bytes: 6,
  frameSize: { width: 320, height: 240 },
  frames: table,
  release: () => undefined,
}

const range = { in: 11, out: 21 }
const host = document.createElement('div')
document.body.append(host)

type VideoFrameCallback = (now: number, metadata: { mediaTime: number }) => void
let callback: VideoFrameCallback | null = null
let play: Mock<() => Promise<void>>
let pause: Mock<() => void>
let requestFrame: Mock<(next: VideoFrameCallback) => number>
let cancelFrame: Mock<(handle: number) => void>

const turn = (): Promise<void> =>
  new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)))

async function effects(): Promise<void> {
  await turn()
  await turn()
}

function fire(mediaTime: number): void {
  const next = callback
  callback = null
  expect(next, 'the player did not ask for a video-frame callback').not.toBeNull()
  next!(performance.now(), { mediaTime })
}

function mount(input: {
  index: number
  endMode: 'stop' | 'loop'
  onSeek?: (index: number) => void
  onPlaying?: (playing: boolean) => void
  onEndMode?: (mode: 'stop' | 'loop') => void
}): void {
  render(
    <Player
      preview={preview}
      index={input.index}
      playing
      rate={1}
      note=""
      playbackRange={range}
      endMode={input.endMode}
      onStep={() => undefined}
      onSeek={input.onSeek ?? (() => undefined)}
      onPlaying={input.onPlaying ?? (() => undefined)}
      onEndMode={input.onEndMode ?? (() => undefined)}
    />,
    host,
  )
}

beforeEach(() => {
  callback = null
  play = vi.fn<() => Promise<void>>(() => Promise.resolve())
  pause = vi.fn<() => void>()
  requestFrame = vi.fn((next: VideoFrameCallback) => {
    callback = next
    return 1
  })
  cancelFrame = vi.fn()

  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(1)
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value: requestFrame,
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
    configurable: true,
    value: cancelFrame,
  })
})

afterEach(() => {
  render(null, host)
  host.innerHTML = ''
  vi.restoreAllMocks()
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback
})

describe('Player playback boundary', () => {
  it('shows the end mode and asks its owner to switch it', () => {
    const onEndMode = vi.fn()
    mount({ index: 1, endMode: 'stop', onEndMode })

    const button = host.querySelector<HTMLButtonElement>('[data-testid="end-mode"]')!
    expect(button.textContent).toBe('At end: Stop')
    button.click()
    expect(onEndMode).toHaveBeenCalledWith('loop')

    mount({ index: 1, endMode: 'loop', onEndMode })
    expect(button.textContent).toBe('At end: Loop')
    button.click()
    expect(onEndMode).toHaveBeenLastCalledWith('stop')
  })

  it('starts at In when Play is pressed outside the active range', async () => {
    const onSeek = vi.fn()
    mount({ index: 5, endMode: 'stop', onSeek })
    await effects()

    expect(onSeek).toHaveBeenCalledWith(1)
    expect(host.querySelector<HTMLVideoElement>('video')!.currentTime).toBe(table.seekTimeOf(1))
    expect(play).toHaveBeenCalled()
  })

  it('stops on the last displayed frame before Out', async () => {
    const onSeek = vi.fn()
    const onPlaying = vi.fn()
    mount({ index: 1, endMode: 'stop', onSeek, onPlaying })
    await effects()
    onSeek.mockClear()
    onPlaying.mockClear()
    pause.mockClear()

    // Preview time 3 is session PTS 20: the last frame inside [11, 21).
    fire(3)

    expect(onSeek).toHaveBeenCalledWith(3)
    expect(onPlaying).toHaveBeenCalledWith(false)
    expect(pause).toHaveBeenCalledOnce()
    expect(callback).toBeNull()
  })

  it('loops from the last displayed frame before Out back to In', async () => {
    const onSeek = vi.fn()
    const onPlaying = vi.fn()
    mount({ index: 1, endMode: 'loop', onSeek, onPlaying })
    await effects()
    onSeek.mockClear()

    fire(3)

    expect(onSeek).toHaveBeenCalledWith(1)
    expect(host.querySelector<HTMLVideoElement>('video')!.currentTime).toBe(table.seekTimeOf(1))
    expect(onPlaying).not.toHaveBeenCalledWith(false)
    expect(callback).not.toBeNull()
  })

  it('keeps following ordinary frames inside the boundary', async () => {
    const onSeek = vi.fn()
    const onPlaying = vi.fn()
    mount({ index: 1, endMode: 'stop', onSeek, onPlaying })
    await effects()
    onSeek.mockClear()

    fire(2)

    expect(onSeek).toHaveBeenCalledWith(2)
    expect(onPlaying).not.toHaveBeenCalledWith(false)
    expect(callback).not.toBeNull()
  })

  it('does not restart playback when its reported frame rerenders the controlled player', async () => {
    const onSeek = vi.fn()
    mount({ index: 1, endMode: 'stop', onSeek })
    await effects()
    const plays = play.mock.calls.length
    const requests = requestFrame.mock.calls.length
    cancelFrame.mockClear()

    mount({ index: 2, endMode: 'stop', onSeek })
    await effects()

    expect(play).toHaveBeenCalledTimes(plays)
    expect(requestFrame).toHaveBeenCalledTimes(requests)
    expect(cancelFrame).not.toHaveBeenCalled()
  })
})
