import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { FrameTable } from '../../core/timeline/frames'
import { formatTimecode } from '../../core/timeline/timecode'
import { frameSeeker, type FrameSeeker } from './seek'
import type { Preview } from '../source/preview'
import { Icon, type IconName } from '../icon'

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

interface IconButtonProps {
  testId: string
  label: string
  icon: IconName
  disabled?: boolean
  onClick: () => void
  onPointerDown?: JSX.PointerEventHandler<HTMLButtonElement>
  onPointerUp?: JSX.PointerEventHandler<HTMLButtonElement>
  onPointerCancel?: JSX.PointerEventHandler<HTMLButtonElement>
  onLostPointerCapture?: JSX.PointerEventHandler<HTMLButtonElement>
}

function IconButton({
  testId,
  label,
  icon,
  disabled,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
}: IconButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
    >
      <Icon name={icon} />
    </button>
  )
}

/** A held frame button begins like a key press, then repeats at half the source frame rate. */
function HeldStepButton({
  testId,
  label,
  icon,
  disabled,
  repeatEveryMs,
  onClick,
}: IconButtonProps & { repeatEveryMs: number }) {
  const delay = useRef<number | null>(null)
  const repeat = useRef<number | null>(null)
  const pointer = useRef<number | null>(null)
  const ignoreClick = useRef(false)
  const action = useRef(onClick)
  action.current = onClick

  const clearTimers = (): void => {
    if (delay.current !== null) window.clearTimeout(delay.current)
    if (repeat.current !== null) window.clearInterval(repeat.current)
    delay.current = null
    repeat.current = null
  }

  const stop = (keepPointerClick: boolean): void => {
    clearTimers()
    pointer.current = null
    if (!keepPointerClick) ignoreClick.current = false
  }

  useLayoutEffect(
    () => () => {
      stop(false)
    },
    [],
  )

  useEffect(() => {
    if (disabled) stop(false)
  }, [disabled])

  const begin: JSX.PointerEventHandler<HTMLButtonElement> = (event) => {
    if (disabled || event.button !== 0 || pointer.current !== null) return

    pointer.current = event.pointerId
    ignoreClick.current = true
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // A synthetic event has no active browser pointer. Its timer semantics are still testable.
    }

    action.current()
    delay.current = window.setTimeout(() => {
      if (pointer.current === null) return
      action.current()
      repeat.current = window.setInterval(() => action.current(), repeatEveryMs)
    }, 300)
  }

  const release: JSX.PointerEventHandler<HTMLButtonElement> = (event) => {
    if (pointer.current !== event.pointerId) return
    // The click dispatched after pointerup is the activation already performed on pointerdown.
    stop(true)
  }

  const abandon: JSX.PointerEventHandler<HTMLButtonElement> = (event) => {
    if (pointer.current !== event.pointerId) return
    // Cancellation and an unexpected loss of capture do not produce that trailing click.
    stop(false)
  }

  const activate = (): void => {
    if (ignoreClick.current) {
      ignoreClick.current = false
      return
    }
    action.current()
  }

  return (
    <IconButton
      testId={testId}
      label={label}
      icon={icon}
      disabled={disabled}
      onClick={activate}
      onPointerDown={begin}
      onPointerUp={release}
      onPointerCancel={abandon}
      onLostPointerCapture={abandon}
    />
  )
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
  /** Clip and position controls that belong under the monitor rather than on the timeline. */
  editorControls?: ComponentChildren
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
  /** Controlled preview volume from silent (0) to full (1). */
  volume: number
  muted: boolean
  onVolume: (volume: number) => void
  onMuted: (muted: boolean) => void
  hasPreviousMarker: boolean
  hasNextMarker: boolean
  onRecordingStart: () => void
  onRecordingEnd: () => void
  onRangeStart: () => void
  onRangeEnd: () => void
  onPreviousMarker: () => void
  onNextMarker: () => void
  /** Move by a number of frames. Relative, so a burst of key repeats composes instead of racing. */
  onStep: (delta: number) => void
  /** Go to a frame outright: this is what playback reports. */
  onSeek: (index: number) => void
  onPlaying: (playing: boolean) => void
}

export function Player({
  preview,
  overlay,
  editorControls,
  index,
  playing,
  rate,
  note,
  playbackRange,
  endMode,
  onEndMode,
  volume,
  muted,
  onVolume,
  onMuted,
  hasPreviousMarker,
  hasNextMarker,
  onRecordingStart,
  onRecordingEnd,
  onRangeStart,
  onRangeEnd,
  onPreviousMarker,
  onNextMarker,
  onStep,
  onSeek,
  onPlaying,
}: PlayerProps) {
  const element = useRef<HTMLVideoElement | null>(null)
  const seeker = useRef<FrameSeeker | null>(null)
  const indexRef = useRef(index)
  const onSeekRef = useRef(onSeek)
  const onPlayingRef = useRef(onPlaying)
  const reportedIndex = useRef<number | null>(null)
  const [catchingUp, setCatchingUp] = useState(false)
  const [ready, setReady] = useState(false)

  indexRef.current = index
  onSeekRef.current = onSeek
  onPlayingRef.current = onPlaying

  const table = preview.frames
  const fps = table.fps()
  const frameRepeatMs = fps > 0 ? Math.max(100, Math.ceil(2_000 / fps)) : 150
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

  // A stopped player follows every controlled index through the frame-accurate seeker. A running
  // player uses the effect below so a manual jump does not pause or restart playback.
  useEffect(() => {
    if (ready && !playing) seeker.current?.show(index)
  }, [index, playing, ready])

  // A timeline, marker or transport jump changes the controlled index while the element keeps
  // playing. Move the element without restarting it. An index just reported by the element is
  // only the owner reflecting requestVideoFrameCallback back to us and must not seek it again.
  useLayoutEffect(() => {
    if (!ready || !playing) return
    if (reportedIndex.current === index) {
      reportedIndex.current = null
      return
    }

    const video = element.current
    if (video) video.currentTime = table.seekTimeOf(index)
  }, [index, playing, ready, table])

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
    if (
      ready &&
      (indexRef.current < boundary.first ||
        indexRef.current > boundary.last ||
        (endMode === 'stop' && indexRef.current === boundary.last))
    ) {
      video.currentTime = table.seekTimeOf(boundary.first)
      reportedIndex.current = boundary.first
      onSeekRef.current(boundary.first)
    }

    void video.play().catch(() => onPlayingRef.current(false))
  }, [playing, ready, table, boundary, endMode])

  // The forward half of the shuttle is the element's own doing: it decodes ahead and keeps the
  // sound with it up to about four times, which nothing we could write would do better.
  useEffect(() => {
    const video = element.current
    if (video) video.playbackRate = rate
  }, [rate, playing])

  useEffect(() => {
    const video = element.current
    if (!video) return
    video.volume = Math.max(0, Math.min(1, volume))
    video.muted = muted
  }, [volume, muted])

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
          reportedIndex.current = boundary.first
          onSeekRef.current(boundary.first)
        } else {
          stopped = true
          video.pause()
          reportedIndex.current = boundary.last
          onSeekRef.current(boundary.last)
          onPlayingRef.current(false)
        }
        return
      }

      reportedIndex.current = shown
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

  const playLabel = playing ? 'Pause preview' : 'Play preview'
  const muteLabel = muted ? 'Unmute preview' : 'Mute preview'
  const endLabel = endMode === 'loop' ? 'Repeat' : 'Stop after'

  return (
    <section class="player" data-testid="player">
      <div class="tc-picture-frame">
        <video ref={element} src={preview.url} preload="auto" data-testid="preview" />
        {overlay}
      </div>

      <div class="transport">
        <div class="transport-left">
          <div class="transport-jump transport-jump-start">
            <IconButton
              testId="recording-start"
              label="Go to recording start"
              icon="recording-start"
              onClick={onRecordingStart}
            />
            <IconButton
              testId="range-start"
              label="Go to active range start"
              icon="range-start"
              disabled={!boundary}
              onClick={onRangeStart}
            />
            <IconButton
              testId="previous-marker"
              label="Go to previous marker"
              icon="previous-marker"
              disabled={!hasPreviousMarker}
              onClick={onPreviousMarker}
            />
          </div>
          {editorControls && (
            <div class="transport-edit" data-testid="player-edit-controls">
              {editorControls}
            </div>
          )}
        </div>

        <div class="transport-center">
          <div class="transport-playback">
            <HeldStepButton
              testId="prev"
              label="Previous frame"
              icon="previous-frame"
              disabled={index <= 0}
              repeatEveryMs={frameRepeatMs}
              onClick={() => onStep(-1)}
            />
            <IconButton
              testId="play"
              label={playLabel}
              icon={playing ? 'pause' : 'play'}
              onClick={() => onPlaying(!playing)}
            />
            <HeldStepButton
              testId="next"
              label="Next frame"
              icon="next-frame"
              disabled={index >= table.count() - 1}
              repeatEveryMs={frameRepeatMs}
              onClick={() => onStep(1)}
            />
          </div>
        </div>

        <div class="transport-right">
          <div class="transport-jump transport-jump-end">
            <IconButton
              testId="next-marker"
              label="Go to next marker"
              icon="next-marker"
              disabled={!hasNextMarker}
              onClick={onNextMarker}
            />
            <IconButton
              testId="range-end"
              label="Go to active range end"
              icon="range-end"
              disabled={!boundary}
              onClick={onRangeEnd}
            />
            <IconButton
              testId="recording-end"
              label="Go to recording end"
              icon="recording-end"
              onClick={onRecordingEnd}
            />
          </div>

          <button
            type="button"
            data-testid="end-mode"
            class="transport-end-mode"
            aria-label={`End behavior: ${endLabel}`}
            title={`End behavior: ${endLabel}`}
            onClick={() => onEndMode(endMode === 'stop' ? 'loop' : 'stop')}
          >
            {endLabel}
          </button>

          <div class="transport-volume">
            <IconButton
              testId="mute"
              label={muteLabel}
              icon={muted ? 'muted' : 'volume'}
              onClick={() => onMuted(!muted)}
            />
            <input
              type="range"
              data-testid="volume"
              min="0"
              max="1"
              step="0.05"
              value={Math.max(0, Math.min(1, volume))}
              aria-label="Volume"
              title="Volume"
              onInput={(event) => onVolume(event.currentTarget.valueAsNumber)}
            />
          </div>
        </div>
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
