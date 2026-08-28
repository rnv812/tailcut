import type { FrameTable } from '../../core/timeline/frames'

export interface SeekState {
  /** The frame that was asked for. The interface follows this and not the picture. */
  wanted: number
  /** True while the element is still on its way there. */
  catchingUp: boolean
}

export interface FrameSeeker {
  state(): SeekState
  show(index: number): void
  detach(): void
}

/**
 * Puts the preview on a frame, with at most one seek in flight and the last request winning.
 *
 * A seek is a decode from the last keyframe, and the price is measured: 61 steps a second in SD,
 * 26 on H.264 1080p, 7 on AV1 1080p. A held arrow repeats about thirty times a second. Queued,
 * those requests would put the picture seconds behind the keyboard and it would never catch up;
 * dropped, the picture advances as fast as the decoder can and lands exactly where the finger
 * stopped. The playhead and the frame number never wait for either — they follow the request.
 */
export function frameSeeker(
  video: HTMLVideoElement,
  table: FrameTable,
  onChange: (state: SeekState) => void,
): FrameSeeker {
  let wanted = 0
  /** The frame the element was last given; -1 when nothing is in flight. */
  let asked = -1

  const state = (): SeekState => ({ wanted, catchingUp: asked !== -1 })
  const notify = (): void => onChange(state())

  const issue = (): void => {
    asked = wanted
    video.currentTime = table.seekTimeOf(wanted)
    notify()
  }

  const onSeeked = (): void => {
    // A seek nobody here asked for: playback crossing a gap, or a drag on the timeline. Correcting
    // it would be two parties fighting over the same element.
    if (asked === -1) return

    const done = asked
    asked = -1
    if (wanted !== done) issue()
    else notify()
  }

  video.addEventListener('seeked', onSeeked)

  return {
    state,
    show(index: number): void {
      const clamped = Math.min(Math.max(index, 0), Math.max(table.count() - 1, 0))
      if (clamped === wanted && asked === -1) return

      wanted = clamped
      if (asked === -1) issue()
      else notify()
    },
    detach(): void {
      video.removeEventListener('seeked', onSeeked)
    },
  }
}
