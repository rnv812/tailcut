import { useEffect, useMemo, useState } from 'preact/hooks'
import { newProject } from '../core/edit/project'
import { newSession } from '../core/edit/session'
import { EMPTY_QUEUE, type Queue } from '../core/export/queue'
import { createRunner } from '../core/export/run'
import type { ClipSource } from '../core/export/plan'
import { STILL, shuttleAdvance, shuttleLabel, type ShuttleState, shuttled } from '../core/edit/shuttle'
import type { Material, MaterialTrack } from '../core/snapshot/material'
import type { SnapshotReader } from '../core/snapshot/read'
import type { Hover } from '../core/timeline/hover'
import type { ClipBand } from '../core/timeline/layout'
import { snapSet } from '../core/timeline/snap'
import { HelpSheet } from './help'
import { downloadIo, openClipSource, planOf, requestsFor } from './export/exporter'
import { Clips } from './inspector/clips'
import { ExportQueue } from './inspector/queue'
import { Player } from './player/player'
import { deriveMaterial } from './source/media'
import type { Preview } from './source/preview'
import { NO_WAVEFORM, startWaveform, type WaveformState } from './source/waveform'
import { createStore, useSession } from './state/store'
import { attachKeys, type Transport } from './state/keys'
import { FramePreview } from './timeline/hover'
import { Timeline } from './timeline/timeline'

export interface WorkbenchProps {
  reader: SnapshotReader
  material: Material
  /** 'building' while the preview is being assembled; null when there is no picture. */
  preview: Preview | 'building' | null
}

const duration = (seconds: number): string => {
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const weight = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const HOST = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

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

/**
 * The editor, assembled.
 *
 * One store, one reducer, one context. The keyboard, the canvas and the inspector are three ways
 * of producing the same actions, and none of them holds any editing state of its own: what is
 * held here beside the store is the transport — running or not, and how fast — which lives
 * exactly as long as the finger and is deliberately outside the undo history.
 */
export function Workbench({ reader, material, preview }: WorkbenchProps) {
  const built = preview === 'building' ? null : preview
  const derived = useMemo(() => deriveMaterial(reader.index, built), [reader, built])
  // A new context is a new store: the frame grid every clip is measured against has changed, and
  // clips measured against the old one would mean something else against the new.
  const store = useMemo(
    () => createStore(newSession(newProject(1_200, derived.ctx)), derived.ctx),
    [derived],
  )

  const session = useSession(store)
  const { doc, ui } = session.project

  const [wave, setWave] = useState<WaveformState>(NO_WAVEFORM)
  const [hover, setHover] = useState<Hover | null>(null)
  const [playing, setPlaying] = useState(false)
  const [shuttle, setShuttle] = useState<ShuttleState>(STILL)
  const [help, setHelp] = useState(false)

  // The queue is outside the project and outside the history on purpose: a file handed to the
  // browser cannot be taken back, so Ctrl+Z has no business touching this.
  const [queue, setQueue] = useState<Queue>(EMPTY_QUEUE)
  const [source, setSource] = useState<ClipSource | null>(null)
  const runner = useMemo(() => createRunner(downloadIo(reader)), [reader])

  useEffect(() => runner.subscribe(setQueue), [runner])

  useEffect(() => {
    let alive = true
    void openClipSource(reader, material).then((opened) => {
      if (alive) setSource(opened)
    })
    return () => {
      alive = false
    }
  }, [reader, material])

  const selected = doc.clips.find((clip) => clip.id === ui.selectedClipId)

  useEffect(() => {
    const job = startWaveform(reader, material, setWave)
    return () => job.cancel()
  }, [reader, material])

  const fps = derived.ctx.fps || 25
  const index = built ? Math.max(0, built.frames.indexAt(ui.playhead)) : 0

  const clips = useMemo<ClipBand[]>(
    () =>
      doc.clips.map((clip) => ({
        id: clip.id,
        name: clip.name,
        in: clip.in,
        out: clip.out,
        selected: clip.id === ui.selectedClipId,
      })),
    [doc.clips, ui.selectedClipId],
  )

  const snap = useMemo(
    () =>
      snapSet({
        keyframes: derived.ctx.keyframes,
        zones: derived.ctx.zones,
        gaps: derived.snapGaps,
        markers: doc.markers,
        clips,
        playhead: ui.playhead,
      }),
    [derived, doc.markers, clips, ui.playhead],
  )

  const transport = useMemo<Transport>(
    () => ({
      toggle: () => {
        setShuttle(STILL)
        setPlaying((was) => !was)
      },
      stop: () => {
        setShuttle(STILL)
        setPlaying(false)
      },
      shuttle: (key) =>
        setShuttle((was) => {
          const next = shuttled(was, key)
          setPlaying(next.direction > 0)
          return next
        }),
    }),
    [],
  )

  useEffect(
    () => attachKeys(window, { dispatch: store.dispatch, transport, onHelp: setHelp }),
    [store, transport],
  )

  // Backwards is not something <video> does: a negative playbackRate is refused. So the playhead
  // is walked back a frame's worth of time at a time and the seeker follows it, dropping whatever
  // it cannot keep up with — which on heavy material is most of it, and is still the only way.
  useEffect(() => {
    if (shuttle.direction !== -1) return

    let frame = 0
    let last = performance.now()

    const tick = (now: number): void => {
      const moved = shuttleAdvance(shuttle, (now - last) / 1_000)
      last = now
      store.dispatch({ type: 'seek', time: Math.max(0, store.get().project.ui.playhead + moved) })
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [shuttle, store])

  const page = reader.index.page

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
          {/* The holes of the lane the cut follows, not of both lanes added up: one break of
              the recording is one gap, however many tracks stopped for it (Task 7). */}
          <span class="muted" data-testid="gaps">
            {derived.gaps.length === 1 ? '1 gap' : `${derived.gaps.length} gaps`}
          </span>
        </div>
      </header>

      {preview === 'building' ? (
        <section class="player" data-testid="player">
          <p class="muted">Building the preview…</p>
        </section>
      ) : built ? (
        <Player
          preview={built}
          index={index}
          playing={playing}
          rate={shuttle.direction > 0 ? shuttle.rate : 1}
          note={shuttleLabel(shuttle)}
          onStep={(frames) => {
            transport.stop()
            store.dispatch({ type: 'step', frames })
          }}
          onSeek={(at) => store.dispatch({ type: 'seek', time: built.frames.at(at)?.pts ?? 0 })}
          onPlaying={(next) => {
            setShuttle(STILL)
            setPlaying(next)
          }}
        />
      ) : (
        <section class="player" data-testid="player">
          <p class="muted">There is no picture in this recording to play back.</p>
        </section>
      )}

      <section class="timeline" data-testid="timeline">
        {/* The peaks go over empty or not: with nothing read yet the sound lane draws as one
            quiet line and fills in from the left as the slices arrive, which is the whole of the
            progress indication — there is no spinner and the measurement says none is needed. */}
        <Timeline
          lanes={derived.lanes}
          clips={clips}
          markers={doc.markers}
          view={ui.view}
          playhead={ui.playhead}
          fps={fps}
          frames={derived.ctx.frames}
          snap={snap}
          snapping={ui.snapping}
          peaks={{ peaks: wave.peaks, covered: wave.covered }}
          onResize={(widthPx) => store.dispatch({ type: 'resize', widthPx })}
          onGesture={(gesture) => store.dispatch(gesture)}
          onHover={setHover}
        />
        {built && (
          <FramePreview preview={built} hover={hover} widthPx={ui.view.widthPx} fps={fps} />
        )}
      </section>

      <aside class="inspector" data-testid="inspector">
        <h2>Source</h2>
        <div class="tracks">
          {material.tracks.map((track) => (
            <TrackLine key={track.track.id} track={track} />
          ))}
        </div>
        {wave.refused && (
          <p class="muted" data-testid="no-wave">
            The sound of this recording cannot be decoded here, so the timeline shows no wave.
          </p>
        )}

        <Clips
          doc={doc}
          ctx={derived.ctx}
          selectedId={ui.selectedClipId}
          playhead={ui.playhead}
          fps={fps}
          dispatch={store.dispatch}
        />

        <ExportQueue
          queue={queue}
          ready={source !== null}
          clips={doc.clips.length}
          estimate={selected && source ? planOf(source, selected).bytes : null}
          onExport={() => source && runner.enqueue(requestsFor(source, doc.clips))}
          onRetry={(id) => runner.retry(id)}
          onCancel={(id) => runner.cancel(id)}
        />

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

      <HelpSheet open={help} onClose={() => setHelp(false)} />
    </div>
  )
}
