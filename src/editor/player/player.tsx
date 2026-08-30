import type { ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { FrameTable } from '../../core/timeline/frames'
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

export interface PlaybackRange {
  /** First session PTS included in preview playback. */
  in: number
  /** First session PTS excluded from preview playback. */
  out: number
}

export type PlaybackEndMode = 'stop' | 'loop'

interface PlaybackFrames {
  first: number
  last: number
}

/** First frame whose session PTS is at or after the boundary. */
function lowerBound(table: FrameTable, boundary: number): number {
  const frames = table.frames()
  let low = 0
  let high = frames.length

  while (low < high) {
    const middle = (low + high) >> 1
    if (frames[middle]!.pts < boundary) low = middle + 1
    else high = middle
  }

  return low
}

/** Frames displayed by the half-open session range, or null when it contains no picture. */
function playbackFrames(table: FrameTable, range: PlaybackRange): PlaybackFrames | null {
  const first = lowerBound(table, range.in)
  const last = lowerBound(table, range.out) - 1
  return first <= last && first < table.count() ? { first, last } : null
}

export interface PlayerProps {
  preview: Preview
  /** Drawn in the exact box of the coded picture, above the video and below the transport. */
  overlay?: ComponentChildren
  /** The frame the transport is on, owned above: the timeline moves it too. */
  index: number
  playing: boolean
  /** Playback rate while running — the forward half of the shuttle. */
  rate: number
  /** What the transport is doing, in words: '', '4×', '8× back'. */
  note: string
  /** Half-open preview boundary in the recording's session PTS, not the preview file's clock. */
  playbackRange: PlaybackRange
  /** What the preview alone does after displaying the last frame before playbackRange.out. */
  endMode: PlaybackEndMode
  /** Change the controlled preview-only behavior at the end of playbackRange. */
  onEndMode: (mode: PlaybackEndMode) => void
  /** Move by a number of frames. Relative, so a burst of key repeats composes instead of racing. */
  onStep: (delta: number) => void
  /** Go to a frame outright: this is what playback reports. */
  onSeek: (index: number) => void
  onPlaying: (playing: boolean) => void
}

export function Player({
  preview,
  overlay,
  index,
  playing,
  rate,
  note,
  playbackRange,
  endMode,
  onEndMode,
  onStep,
  onSeek,
  onPlaying,
}: PlayerProps) {
  const element = useRef<HTMLVideoElement | null>(null)
  const seeker = useRef<FrameSeeker | null>(null)
  const indexRef = useRef(index)
  const onSeekRef = useRef(onSeek)
  const onPlayingRef = useRef(onPlaying)
  const [catchingUp, setCatchingUp] = useState(false)
  const [ready, setReady] = useState(false)

  indexRef.current = index
  onSeekRef.current = onSeek
  onPlayingRef.current = onPlaying

  const table = preview.frames
  const fps = table.fps()
  const frame = table.at(index)
  const boundary = useMemo(
    () => playbackFrames(table, playbackRange),
    [table, playbackRange.in, playbackRange.out],
  )

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

    if (!playing) {
      video.pause()
      return
    }

    if (!boundary) {
      video.pause()
      onPlayingRef.current(false)
      return
    }

    // The owner may change the active clip while the player stands elsewhere, or Play may be
    // pressed after a previous range ended. This seek belongs to playback, so it goes straight to
    // the element; frameSeeker deliberately ignores seeks it did not issue.
    if (ready && (indexRef.current < boundary.first || indexRef.current > boundary.last)) {
      video.currentTime = table.seekTimeOf(boundary.first)
      onSeekRef.current(boundary.first)
    }

    void video.play().catch(() => onPlayingRef.current(false))
  }, [playing, ready, table, boundary])

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
    // was written by the exporter, which closed the holes in the decode timeline. Where
    // a hole could not be closed the frame in front of the seam simply lasts longer, and skipping
    // over it would run away from the sound that never stopped.
    let entered = Boolean(
      boundary && indexRef.current >= boundary.first && indexRef.current <= boundary.last,
    )

    const follow = (mediaTime: number): void => {
      if (!boundary) {
        stopped = true
        video.pause()
        onPlayingRef.current(false)
        return
      }

      const shown = Math.max(0, table.indexAtOut(mediaTime))
      // A callback for the old range may arrive while the seek to In is taking effect. It is not
      // the end of this range, because this range has not begun yet.
      if (!entered && (shown < boundary.first || shown > boundary.last)) return
      entered = true

      if (shown >= boundary.last) {
        if (endMode === 'loop') {
          entered = false
          video.currentTime = table.seekTimeOf(boundary.first)
          onSeekRef.current(boundary.first)
        } else {
          stopped = true
          video.pause()
          onSeekRef.current(boundary.last)
          onPlayingRef.current(false)
        }
        return
      }

      onSeekRef.current(shown)
    }

    if (video.requestVideoFrameCallback) {
      const tick = (_now: number, metadata: { mediaTime: number }): void => {
        if (stopped) return
        follow(metadata.mediaTime)
        if (!stopped) handle = video.requestVideoFrameCallback!(tick)
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
  }, [playing, table, boundary, endMode])

  return (
    <section class="player" data-testid="player">
      <div class="tc-picture-frame">
        <video ref={element} src={preview.url} preload="auto" data-testid="preview" />
        {overlay}
      </div>

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
        <button
          data-testid="end-mode"
          onClick={() => onEndMode(endMode === 'stop' ? 'loop' : 'stop')}
        >
          At end: {endMode === 'stop' ? 'Stop' : 'Loop'}
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
