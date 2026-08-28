import { useEffect, useRef, useState } from 'preact/hooks'
import { formatTimecode } from '../../core/timeline/timecode'
import { frameSeeker, type FrameSeeker } from './seek'
import type { Preview } from '../source/preview'

/** A `<video>` that can say which frame it is showing. Chromium can; the type does not know it. */
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?(
    callback: (now: number, metadata: { mediaTime: number }) => void,
  ): number
  cancelVideoFrameCallback?(handle: number): void
}

export interface PlayerProps {
  preview: Preview
  /** The frame the transport is on, owned above: the timeline moves it too. */
  index: number
  playing: boolean
  /** Playback rate while running — the forward half of the shuttle. */
  rate: number
  /** What the transport is doing, in words: '', '4×', '8× back'. */
  note: string
  /** Move by a number of frames. Relative, so a burst of key repeats composes instead of racing. */
  onStep: (delta: number) => void
  /** Go to a frame outright: this is what playback reports. */
  onSeek: (index: number) => void
  onPlaying: (playing: boolean) => void
}

export function Player({ preview, index, playing, rate, note, onStep, onSeek, onPlaying }: PlayerProps) {
  const element = useRef<HTMLVideoElement | null>(null)
  const seeker = useRef<FrameSeeker | null>(null)
  const [catchingUp, setCatchingUp] = useState(false)
  const [ready, setReady] = useState(false)

  const table = preview.frames
  const fps = table.fps()
  const frame = table.at(index)

  useEffect(() => {
    const video = element.current
    if (!video) return

    const made = frameSeeker(video, table, (state) => setCatchingUp(state.catchingUp))
    seeker.current = made
    return () => {
      made.detach()
      seeker.current = null
    }
  }, [table])

  // A currentTime set before the element has read the file is a request into nothing.
  useEffect(() => {
    const video = element.current
    if (!video) return

    const onMetadata = () => setReady(true)
    if (video.readyState >= 1) setReady(true)
    video.addEventListener('loadedmetadata', onMetadata)
    return () => video.removeEventListener('loadedmetadata', onMetadata)
  }, [preview])

  // Stepping is for a stopped player. While it runs the picture leads and the number follows it.
  useEffect(() => {
    if (ready && !playing) seeker.current?.show(index)
  }, [index, playing, ready])

  useEffect(() => {
    const video = element.current
    if (!video) return

    if (playing) void video.play().catch(() => onPlaying(false))
    else video.pause()
  }, [playing, onPlaying])

  // The forward half of the shuttle is the element's own doing: it decodes ahead and keeps the
  // sound with it up to about four times, which nothing we could write would do better.
  useEffect(() => {
    const video = element.current
    if (video) video.playbackRate = rate
  }, [rate, playing])

  useEffect(() => {
    const video = element.current as FrameCallbackVideo | null
    if (!video || !playing) return

    let handle = 0
    let stopped = false

    // The number under the player follows the picture, and nothing here jumps anywhere: the file
    // was written by the export plan, which closed the holes in the decode timeline (§8.2). Where
    // a hole could not be closed the frame in front of the seam simply lasts longer, and skipping
    // over it would run away from the sound that never stopped.
    const follow = (mediaTime: number): void => {
      onSeek(Math.max(0, table.indexAtOut(mediaTime)))
    }

    if (video.requestVideoFrameCallback) {
      const tick = (_now: number, metadata: { mediaTime: number }): void => {
        if (stopped) return
        follow(metadata.mediaTime)
        handle = video.requestVideoFrameCallback!(tick)
      }
      handle = video.requestVideoFrameCallback(tick)

      return () => {
        stopped = true
        video.cancelVideoFrameCallback?.(handle)
      }
    }

    // Chromium has requestVideoFrameCallback; this is the floor under a browser that has not.
    const onTime = () => follow(video.currentTime)
    video.addEventListener('timeupdate', onTime)
    return () => video.removeEventListener('timeupdate', onTime)
  }, [playing, table, onSeek])

  return (
    <section class="player" data-testid="player">
      <video ref={element} src={preview.url} preload="auto" data-testid="preview" />

      <div class="transport">
        <button data-testid="prev" disabled={index <= 0} onClick={() => onStep(-1)}>
          ◀ frame
        </button>
        <button data-testid="play" onClick={() => onPlaying(!playing)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button data-testid="next" disabled={index >= table.count() - 1} onClick={() => onStep(1)}>
          frame ▶
        </button>
      </div>

      <div class={catchingUp ? 'readout catching-up' : 'readout'}>
        <span data-testid="timecode">{formatTimecode(frame?.pts ?? 0, fps)}</span>
        {' · frame '}
        <span data-testid="frame">{index + 1}</span>
        {' of '}
        <span data-testid="frame-count">{table.count()}</span>
        {note && <span data-testid="rate"> · {note}</span>}
        {catchingUp && <span data-testid="stale"> · catching up</span>}
      </div>
    </section>
  )
}
