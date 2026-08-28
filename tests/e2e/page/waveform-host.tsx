import { render } from 'preact'
import { useState } from 'preact/hooks'
import { ingestInit } from '../../../src/core/container'
import { parseFragment } from '../../../src/core/iso/fragment'
import { concatBytes } from '../../../src/core/iso/writer'
import { planSnapshot, type SnapshotSource, type SnapshotSourceTrack } from '../../../src/core/snapshot/build'
import { materialOf } from '../../../src/core/snapshot/material'
import { SnapshotReader } from '../../../src/core/snapshot/read'
import { METRICS, laneTop } from '../../../src/core/timeline/layout'
import { lanesOf } from '../../../src/core/timeline/lanes'
import { startWaveform, type WaveformState } from '../../../src/editor/source/waveform'
import { PALETTE } from '../../../src/editor/timeline/draw'
import { Timeline } from '../../../src/editor/timeline/timeline'
import type { Viewport } from '../../../src/core/timeline/view'
import type { Chunk } from '../../../src/shared/types'

/**
 * The whole path bar the file: fixtures fetched, laid out as a snapshot in memory, read back
 * through SnapshotReader, and handed to startWaveform. Only OPFS is left out, and OPFS is
 * somebody else's test.
 */
const PAGE = {
  sessionKey: 'host',
  url: 'https://tailcut.test/waveform-host',
  title: 'Waveform host',
  createdAt: 0,
  lastSeenAt: 0,
  refusedTracks: false,
}

const bytesOf = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await (await fetch(`/fixtures/${path}`)).arrayBuffer())

/**
 * One five-second segment of picture.
 *
 * The sound is what is being read, but a recording of sound alone has one lane, and on a timeline
 * of one lane "the wave is drawn on the sound lane" is a sentence no test can fail. With a
 * picture above it the sound is the second lane and its band is somewhere in particular.
 */
async function pictureTrack(): Promise<SnapshotSourceTrack> {
  const initBytes = await bytesOf('minute/init-stream0.m4s')
  const info = ingestInit(initBytes)!.info
  const timescale = info.tracks[0]!.timescale
  const bytes = await bytesOf('minute/chunk-stream0-00001.m4s')
  const fragment = parseFragment(bytes)!

  return {
    id: 'v',
    bufferId: 'sb-v',
    representation: 'video:avc1',
    kinds: ['video'],
    info,
    initBytes,
    chunks: [
      {
        start: fragment.baseMediaDecodeTime / timescale,
        end: (fragment.baseMediaDecodeTime + fragment.duration) / timescale,
        bytes,
      },
    ],
  }
}

/** AAC: a minute in twelve segments of five seconds, the shape a real site delivers. */
async function aacSource(drop: number[]): Promise<SnapshotSource> {
  const initBytes = await bytesOf('minute/init-stream1.m4s')
  const info = ingestInit(initBytes)!.info
  const timescale = info.tracks[0]!.timescale
  const chunks: Chunk[] = []

  for (let index = 1; index <= 12; index++) {
    if (drop.includes(index)) continue
    const bytes = await bytesOf(`minute/chunk-stream1-${String(index).padStart(5, '0')}.m4s`)
    const fragment = parseFragment(bytes)!
    chunks.push({
      start: fragment.baseMediaDecodeTime / timescale,
      end: (fragment.baseMediaDecodeTime + fragment.duration) / timescale,
      bytes,
    })
  }

  return {
    page: PAGE,
    tracks: [
      await pictureTrack(),
      { id: 'a', bufferId: 'sb-a', representation: 'audio:mp4a', kinds: ['audio'], info, initBytes, chunks },
    ],
  }
}

/** Opus, as it arrives: WebM in, ISO out, converted by the same code the capture uses. */
async function opusSource(): Promise<SnapshotSource> {
  const ingested = ingestInit(await bytesOf('webm/init-stream1.webm'), 'audio/webm; codecs="opus"')!
  const chunks: Chunk[] = []

  for (let index = 1; index <= 4; index++) {
    const converted = ingested.convert!(await bytesOf(`webm/chunk-stream1-${String(index).padStart(5, '0')}.webm`))
    if (converted) chunks.push({ start: converted.start, end: converted.end, bytes: converted.bytes })
  }

  return {
    page: PAGE,
    tracks: [
      {
        id: 'a',
        bufferId: 'sb-a',
        representation: 'audio:Opus',
        kinds: ['audio'],
        info: ingested.info,
        initBytes: ingested.initBytes,
        chunks,
      },
    ],
  }
}

/** A recording with a picture and no sound at all. */
async function silentSource(): Promise<SnapshotSource> {
  return { page: PAGE, tracks: [await pictureTrack()] }
}

const WORKER_URL = `${location.origin}${location.pathname}-worker.js`

function Host() {
  const [wave, setWave] = useState<WaveformState | null>(null)
  const [lanes, setLanes] = useState(lanesOf([]))
  const [view, setView] = useState<Viewport>({ start: 0, scale: 0.06, widthPx: 1000 })
  const [slices, setSlices] = useState(0)

  const shared = globalThis as unknown as Record<string, unknown>
  shared.tcPalette = PALETTE
  shared.tcWave = () => (wave ? { covered: wave.covered, done: wave.done, refused: wave.refused, pieces: wave.peaks.map((piece) => ({ start: piece.start, buckets: piece.min.length, loudest: Math.max(...piece.max) })) } : null)
  shared.tcSlices = () => slices
  shared.tcLanes = () => lanes.map((lane) => lane.kind)
  /** Where the sound lane is on the canvas, in CSS pixels; null when there is no sound lane. */
  shared.tcBand = () => {
    const index = lanes.findIndex((lane) => lane.kind === 'audio')
    if (index < 0) return null
    return { index, top: laneTop(METRICS, index), height: METRICS.laneHeight - METRICS.zoneHeight }
  }

  shared.tcStart = async (kind: 'aac' | 'opus' | 'silent', drop: number[] = []): Promise<void> => {
    const source = kind === 'aac' ? await aacSource(drop) : kind === 'opus' ? await opusSource() : await silentSource()
    const plan = planSnapshot(source, { id: 'host', capturedAt: 0, producer: 'host' })
    const file = concatBytes(plan.parts)
    const reader = (await SnapshotReader.open(
      async (at, length) => file.subarray(at, at + length),
      file.byteLength,
    ))!

    setLanes(lanesOf(reader.index.tracks))
    startWaveform(reader, materialOf(reader.index), (state) => {
      setWave(state)
      setSlices((count) => count + 1)
    }, { workerUrl: WORKER_URL })
  }

  /** The worst gap between animation frames while the worker is busy. */
  shared.tcJitter = (forMs: number): Promise<number> =>
    new Promise((resolve) => {
      let worst = 0
      let last = performance.now()
      const until = last + forMs
      const tick = (now: number): void => {
        worst = Math.max(worst, now - last)
        last = now
        if (now < until) requestAnimationFrame(tick)
        else resolve(worst)
      }
      requestAnimationFrame(tick)
    })

  return (
    <Timeline
      lanes={lanes}
      clips={[]}
      markers={[]}
      view={view}
      playhead={0}
      fps={25}
      frames={new Float64Array()}
      snap={{ targets: [], keyframes: new Float64Array() }}
      snapping={false}
      peaks={wave ? { peaks: wave.peaks, covered: wave.covered } : undefined}
      onResize={(widthPx) => setView((current) => ({ ...current, widthPx }))}
      onGesture={() => {}}
    />
  )
}

render(<Host />, document.getElementById('root')!)
