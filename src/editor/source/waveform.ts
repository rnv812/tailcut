import { mergePeaks, type Peaks } from '../../core/audio/peaks'
import type { Material } from '../../core/snapshot/material'
import type { SnapshotReader } from '../../core/snapshot/read'
import type { FromWaveformWorker, ToWaveformWorker } from './waveform-worker'

/** Seconds of sound folded before a slice comes back: the wave grows in steps this long. */
export const WAVEFORM_SLICE_SECONDS = 5

const WORKER_PATH = 'editor/waveform-worker.js'

export interface WaveformState {
  /** In time order, one entry per stretch of sound that has been read. */
  peaks: Peaks[]
  /** Media time the reading has got to. */
  covered: number
  done: boolean
  /** There is sound and it will not give up its peaks: no decoder here, or a codec refused. */
  refused: boolean
}

export const NO_WAVEFORM: WaveformState = { peaks: [], covered: 0, done: true, refused: false }

export interface WaveformJob {
  cancel(): void
}

export interface WaveformOptions {
  /** Where the worker is. The editor tab knows it as a file of the extension. */
  workerUrl?: string
  sliceSeconds?: number
}

/** A buffer of its own: bytesOfMany hands back views over one shared read, and views cannot be
 *  transferred one by one. */
const own = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer

/**
 * Reads the sound of the recording into peaks, in the background, slice by slice.
 *
 * `onChange` is called with a fresh state on every slice, so the timeline can draw the wave as it
 * fills in. Measured: the first slice lands about 35 ms after the editor opens and three minutes
 * are complete in 1.1 s, against 0.93 s read in one go — twenty per cent for the privilege of
 * showing something immediately.
 */
export function startWaveform(
  reader: SnapshotReader,
  material: Material,
  onChange: (state: WaveformState) => void,
  options: WaveformOptions = {},
): WaveformJob {
  const track = material.audio
  const declared = track?.track.info.tracks.find((one) => one.kind === 'audio')

  let cancelled = false
  let worker: Worker | null = null

  const stop = (): void => {
    worker?.terminate()
    worker = null
  }

  const report = (state: WaveformState): void => {
    if (!cancelled) onChange(state)
  }

  if (!track?.span || !declared || typeof AudioDecoder === 'undefined') {
    // No sound in the recording at all: lanesOf makes no audio lane, so there is nothing to draw
    // a wave on and nothing here to do — no worker, no read, no byte. `refused` is what tells
    // that apart from sound this browser will not decode, which the inspector says out loud.
    queueMicrotask(() => report({ ...NO_WAVEFORM, refused: Boolean(track?.span) }))
    return { cancel: () => { cancelled = true } }
  }

  const state: WaveformState = { peaks: [], covered: track.span.start, done: false, refused: false }

  void (async () => {
    const init = await reader.bytesOf(track.track.init)
    const runs = await Promise.all(
      track.runs.map(async (run) => ({
        start: run.start,
        segments: (await reader.bytesOfMany(run.chunks.map((chunk) => chunk.source))).map(
          (bytes, index) => ({
            bytes: own(bytes),
            ...(run.chunks[index]!.timestampOffset === undefined
              ? {}
              : { timestampOffset: run.chunks[index]!.timestampOffset }),
          }),
        ),
      })),
    )
    if (cancelled) return

    worker = new Worker(options.workerUrl ?? chrome.runtime.getURL(WORKER_PATH))

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as FromWaveformWorker

      if (message.type === 'slice') {
        state.peaks = mergePeaks(state.peaks, {
          start: message.start,
          min: message.min,
          max: message.max,
        })
        state.covered = message.covered
        report({ ...state })
        return
      }

      // Never backwards: a run that yielded nothing must not pull the dimmed edge back over
      // material that has already been read.
      if (message.type === 'done') state.covered = Math.max(state.covered, message.covered)
      state.done = true
      state.refused = message.type === 'failed'
      report({ ...state })
      stop()
    }

    worker.onerror = () => {
      state.done = true
      state.refused = true
      report({ ...state })
      stop()
    }

    const request: ToWaveformWorker = {
      type: 'peaks',
      init: own(init),
      trackId: declared.trackId,
      timescale: declared.timescale,
      sliceSeconds: options.sliceSeconds ?? WAVEFORM_SLICE_SECONDS,
      runs,
    }
    worker.postMessage(request, [
      request.init,
      ...runs.flatMap((run) => run.segments.map((segment) => segment.bytes)),
    ])
  })()

  return {
    cancel(): void {
      cancelled = true
      stop()
    },
  }
}
