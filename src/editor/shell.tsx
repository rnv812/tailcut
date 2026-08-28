import { useState } from 'preact/hooks'
import { gapsBetween, type Material, type MaterialTrack } from '../core/snapshot/material'
import type { SnapshotReader } from '../core/snapshot/read'
import { Player } from './player/player'
import type { Preview } from './source/preview'
import type { SnapshotFailure } from './source/snapshot'

export type EditorState =
  | { status: 'opening' }
  | { status: 'failed'; reason: SnapshotFailure }
  | {
      status: 'ready'
      reader: SnapshotReader
      material: Material
      /** 'building' while the preview is being assembled; null when the snapshot has no picture. */
      preview: Preview | 'building' | null
    }

/**
 * What the editor says when there is nothing to edit.
 *
 * Four states and four sentences. A blank screen would be the same screen for a snapshot the
 * browser reclaimed, a write that was cut off and an address somebody typed — and the three want
 * three different things done about them.
 */
export const FAILURE_TEXT: Record<SnapshotFailure, string> = {
  'no-id': 'This page opens from the tailcut popup. Press Edit on a recording to open it here.',
  missing:
    'This recording is no longer in storage. The browser reclaims space on its own, and a snapshot is not kept forever.',
  unfinished:
    'This recording was not finished being written. It was interrupted partway, and there is nothing to open.',
  empty: 'This recording holds no material to edit yet.',
}

const HOST = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

const duration = (seconds: number): string => {
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const weight = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

function TrackLine({ track }: { track: MaterialTrack }) {
  const declared = track.track.info.tracks[0]
  const size = declared && declared.width > 0 ? `${declared.width}×${declared.height}` : ''

  return (
    <div class="track" data-testid="track">
      <span class="kind">{track.kinds.join(' + ')}</span>
      <span class="codec">{declared?.codec ?? 'unknown'}</span>
      {size && <span class="muted">{size}</span>}
      <span class="muted">
        {duration(track.duration)} · {weight(track.bytes)}
      </span>
    </div>
  )
}

function Inspector({ material }: { material: Material }) {
  return (
    <aside class="inspector" data-testid="inspector">
      <h2>Source</h2>
      <div class="tracks">
        {material.tracks.map((track) => (
          <TrackLine key={track.track.id} track={track} />
        ))}
      </div>

      <h2>Clip</h2>
      <label class="option">
        <input type="checkbox" data-testid="crop" disabled />
        Crop
      </label>
      <label class="option">
        <input type="checkbox" data-testid="webp" disabled />
        Animated WebP
      </label>
      <p class="muted" data-testid="reencode-note">
        Cropping and WebP need re-encoding, which this version does not do. The clip is copied
        from the recording as it is.
      </p>
    </aside>
  )
}

export function Shell({ state }: { state: EditorState }) {
  const [index, setIndex] = useState(0)

  if (state.status === 'opening') {
    return <div class="pad muted">Opening the recording…</div>
  }

  if (state.status === 'failed') {
    return (
      <div class="pad failure" data-testid="failure" role="alert">
        {FAILURE_TEXT[state.reason]}
      </div>
    )
  }

  const { material } = state
  const page = state.reader.index.page
  const gaps = material.video ? gapsBetween(material.video.runs) : []
  const preview = state.preview
  const total = preview && preview !== 'building' ? preview.frames.count() : 0
  // Relative, and clamped where the total is known: a burst of key repeats lands in one batch,
  // and thirty handlers each adding one to the same stale number would advance the playhead by one.
  const step = (delta: number) =>
    setIndex((was) => Math.min(Math.max(was + delta, 0), Math.max(total - 1, 0)))

  return (
    <div class="editor">
      <header class="head">
        <div class="title" data-testid="title">
          {page.title || 'Untitled'}
        </div>
        <div class="muted" data-testid="host">
          {HOST(page.url)}
        </div>
        <div class="meta">
          <span data-testid="duration">{duration(material.duration)}</span>
          <span class="muted" data-testid="bytes">
            {weight(material.bytes)}
          </span>
          <span class="muted" data-testid="gaps">
            {gaps.length === 1 ? '1 gap' : `${gaps.length} gaps`}
          </span>
        </div>
      </header>

      {preview === 'building' ? (
        <section class="player" data-testid="player">
          <p class="muted">Building the preview…</p>
        </section>
      ) : preview ? (
        <Player preview={preview} index={index} onStep={step} onSeek={setIndex} />
      ) : (
        <section class="player" data-testid="player">
          <p class="muted">There is no picture in this recording to play back.</p>
        </section>
      )}
      <section class="timeline" data-testid="timeline" />
      <Inspector material={material} />
    </div>
  )
}
