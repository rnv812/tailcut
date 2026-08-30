// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { render, type ComponentChildren } from 'preact'
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
  playing?: boolean
  volume?: number
  muted?: boolean
  hasPreviousMarker?: boolean
  hasNextMarker?: boolean
  onStep?: (delta: number) => void
  onSeek?: (index: number) => void
  onPlaying?: (playing: boolean) => void
  onEndMode?: (mode: 'stop' | 'loop') => void
  onVolume?: (volume: number) => void
  onMuted?: (muted: boolean) => void
  onRecordingStart?: () => void
  onRecordingEnd?: () => void
  onRangeStart?: () => void
  onRangeEnd?: () => void
  onPreviousMarker?: () => void
  onNextMarker?: () => void
  editorControls?: ComponentChildren
}): void {
  render(
    <Player
      preview={preview}
      index={input.index}
      playing={input.playing ?? true}
      rate={1}
      note=""
      playbackRange={range}
      endMode={input.endMode}
      volume={input.volume ?? 0.75}
      muted={input.muted ?? false}
      hasPreviousMarker={input.hasPreviousMarker ?? true}
      hasNextMarker={input.hasNextMarker ?? true}
      onStep={input.onStep ?? (() => undefined)}
      onSeek={input.onSeek ?? (() => undefined)}
      onPlaying={input.onPlaying ?? (() => undefined)}
      onEndMode={input.onEndMode ?? (() => undefined)}
      onVolume={input.onVolume ?? (() => undefined)}
      onMuted={input.onMuted ?? (() => undefined)}
      onRecordingStart={input.onRecordingStart ?? (() => undefined)}
      onRecordingEnd={input.onRecordingEnd ?? (() => undefined)}
      onRangeStart={input.onRangeStart ?? (() => undefined)}
      onRangeEnd={input.onRangeEnd ?? (() => undefined)}
      onPreviousMarker={input.onPreviousMarker ?? (() => undefined)}
      onNextMarker={input.onNextMarker ?? (() => undefined)}
      editorControls={input.editorControls}
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
    expect(button.textContent).toBe('Stop after')
    expect(button.closest('.transport-playback')).toBeNull()
    expect(button.closest('.transport-right')).not.toBeNull()
    expect(host.querySelector('[data-testid="play"]')!.closest('.transport-center')).not.toBeNull()
    button.click()
    expect(onEndMode).toHaveBeenCalledWith('loop')

    mount({ index: 1, endMode: 'loop', onEndMode })
    expect(button.textContent).toBe('Repeat')
    button.click()
    expect(onEndMode).toHaveBeenLastCalledWith('stop')
  })

  it('offers icon-first transport controls with accessible names and tooltips', () => {
    mount({ index: 2, endMode: 'stop' })

    const expected = new Map([
      ['recording-start', 'Go to recording start'],
      ['range-start', 'Go to active range start'],
      ['previous-marker', 'Go to previous marker'],
      ['prev', 'Previous frame'],
      ['play', 'Pause preview'],
      ['next', 'Next frame'],
      ['next-marker', 'Go to next marker'],
      ['range-end', 'Go to active range end'],
      ['recording-end', 'Go to recording end'],
      ['mute', 'Mute preview'],
    ])

    for (const [testId, label] of expected) {
      const control = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
      expect(control, `${testId} is missing`).not.toBeNull()
      expect(control.getAttribute('aria-label')).toBe(label)
      expect(control.title).toBe(label)
      expect(control.textContent?.trim(), `${testId} has no visible icon`).not.toBe('')
      expect(control.textContent?.trim()).not.toBe(label)
    }

    const volume = host.querySelector<HTMLInputElement>('[data-testid="volume"]')!
    expect(volume.getAttribute('aria-label')).toBe('Volume')
    expect(volume.title).toBe('Volume')
  })

  it('keeps edit controls in their own row under the transport', () => {
    mount({
      index: 2,
      endMode: 'stop',
      editorControls: <button data-testid="set-in">Set In</button>,
    })

    const row = host.querySelector('[data-testid="player-edit-controls"]')!
    expect(row).not.toBeNull()
    expect(row.querySelector('[data-testid="set-in"]')?.textContent).toBe('Set In')
    expect(row.closest('.transport')).toBeNull()
  })

  it('runs frame steps and timeline jumps without stopping playback', () => {
    const onPlaying = vi.fn()
    const onStep = vi.fn()
    const jumps = {
      'recording-start': vi.fn(),
      'recording-end': vi.fn(),
      'range-start': vi.fn(),
      'range-end': vi.fn(),
      'previous-marker': vi.fn(),
      'next-marker': vi.fn(),
    }
    mount({
      index: 2,
      endMode: 'stop',
      onPlaying,
      onStep,
      onRecordingStart: jumps['recording-start'],
      onRecordingEnd: jumps['recording-end'],
      onRangeStart: jumps['range-start'],
      onRangeEnd: jumps['range-end'],
      onPreviousMarker: jumps['previous-marker'],
      onNextMarker: jumps['next-marker'],
    })

    host.querySelector<HTMLButtonElement>('[data-testid="prev"]')!.click()
    host.querySelector<HTMLButtonElement>('[data-testid="next"]')!.click()
    expect(onStep.mock.calls).toEqual([[-1], [1]])

    for (const [testId, callback] of Object.entries(jumps)) {
      host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click()
      expect(callback, `${testId} did not reach its owner`).toHaveBeenCalledOnce()
    }
    expect(onPlaying).not.toHaveBeenCalledWith(false)
  })

  it('disables marker jumps only when no marker exists in that direction', () => {
    mount({
      index: 2,
      endMode: 'stop',
      hasPreviousMarker: false,
      hasNextMarker: false,
    })

    expect(host.querySelector<HTMLButtonElement>('[data-testid="previous-marker"]')!.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[data-testid="next-marker"]')!.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[data-testid="range-start"]')!.disabled).toBe(false)
  })

  it('applies controlled volume and mute state and reports their controls', async () => {
    const onVolume = vi.fn()
    const onMuted = vi.fn()
    mount({ index: 2, endMode: 'stop', playing: false, volume: 0.4, onVolume, onMuted })
    await effects()

    const video = host.querySelector<HTMLVideoElement>('video')!
    const slider = host.querySelector<HTMLInputElement>('[data-testid="volume"]')!
    expect(video.volume).toBe(0.4)
    expect(video.muted).toBe(false)
    expect(slider.valueAsNumber).toBe(0.4)

    slider.value = '0.2'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    expect(onVolume).toHaveBeenCalledWith(0.2)
    host.querySelector<HTMLButtonElement>('[data-testid="mute"]')!.click()
    expect(onMuted).toHaveBeenCalledWith(true)

    mount({ index: 2, endMode: 'stop', playing: false, volume: 0.2, muted: true, onMuted })
    await effects()
    expect(video.volume).toBe(0.2)
    expect(video.muted).toBe(true)
    const mute = host.querySelector<HTMLButtonElement>('[data-testid="mute"]')!
    expect(mute.getAttribute('aria-label')).toBe('Unmute preview')
    mute.click()
    expect(onMuted).toHaveBeenLastCalledWith(false)
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

  it('seeks a controlled frame change while playback keeps running', async () => {
    const onPlaying = vi.fn()
    mount({ index: 1, endMode: 'stop', onPlaying })
    await effects()
    const plays = play.mock.calls.length
    pause.mockClear()

    mount({ index: 2, endMode: 'stop', onPlaying })
    await effects()

    expect(host.querySelector<HTMLVideoElement>('video')!.currentTime).toBe(table.seekTimeOf(2))
    expect(play).toHaveBeenCalledTimes(plays)
    expect(pause).not.toHaveBeenCalled()
    expect(onPlaying).not.toHaveBeenCalledWith(false)
  })

  it('does not restart playback when its reported frame rerenders the controlled player', async () => {
    const onSeek = vi.fn()
    mount({ index: 1, endMode: 'stop', onSeek })
    await effects()
    const video = host.querySelector<HTMLVideoElement>('video')!
    video.currentTime = 2
    fire(2)
    const plays = play.mock.calls.length
    const requests = requestFrame.mock.calls.length
    cancelFrame.mockClear()

    mount({ index: 2, endMode: 'stop', onSeek })
    await effects()

    expect(video.currentTime).toBe(2)
    expect(play).toHaveBeenCalledTimes(plays)
    expect(requestFrame).toHaveBeenCalledTimes(requests)
    expect(cancelFrame).not.toHaveBeenCalled()
  })
})
