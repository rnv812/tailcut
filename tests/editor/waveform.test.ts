// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import type { Material } from '../../src/core/snapshot/material'
import type { SnapshotReader } from '../../src/core/snapshot/read'
import {
  NO_WAVEFORM,
  WAVEFORM_SLICE_SECONDS,
  startWaveform,
  type WaveformState,
} from '../../src/editor/source/waveform'
import type { FromWaveformWorker, ToWaveformWorker } from '../../src/editor/source/waveform-worker'

/**
 * The client of the worker, without a worker and without WebCodecs.
 *
 * What it decides — whether there is anything to read, what the interface is told when the
 * reading is refused, and how far the reading has got — is decided before a byte of sound is
 * touched, and the browser spec beside it (tests/e2e/waveform.spec.ts) cannot reach any of it:
 * the fixtures there all decode.
 */
class FakeWorker {
  static made: FakeWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly posted: ToWaveformWorker[] = []
  terminated = 0

  constructor(readonly url: string) {
    FakeWorker.made.push(this)
  }

  postMessage(message: unknown): void {
    this.posted.push(message as ToWaveformWorker)
  }

  terminate(): void {
    this.terminated++
  }

  send(message: FromWaveformWorker): void {
    this.onmessage?.({ data: message } as MessageEvent)
  }
}

const scope = globalThis as unknown as Record<string, unknown>

const withDecoder = (): void => {
  scope.AudioDecoder = class {}
  scope.Worker = FakeWorker
}

afterEach(() => {
  delete scope.AudioDecoder
  delete scope.Worker
  FakeWorker.made.length = 0
})

const reader = {
  bytesOf: async () => new Uint8Array([1, 2, 3, 4]),
  bytesOfMany: async (locs: unknown[]) => locs.map(() => new Uint8Array([5, 6, 7, 8])),
} as unknown as SnapshotReader

/** A snapshot with one stretch of sound in it, as far as `startWaveform` looks. */
const material = (span: { start: number; end: number } | null): Material =>
  ({
    tracks: [],
    video: null,
    audio: {
      track: {
        init: { at: 0, length: 4 },
        info: {
          tracks: [{ trackId: 3, kind: 'audio', timescale: 44_100, codec: 'mp4a.40.2', width: 0, height: 0 }],
        },
      },
      kinds: ['audio'],
      runs: [{ start: 1, end: 6, chunks: [{ source: { at: 4, length: 8 } }] }],
      duration: 5,
      bytes: 8,
      span,
    },
    representations: [],
    duration: 5,
    bytes: 8,
  }) as unknown as Material

const silence = (): Material => ({ ...material(null), audio: null })

/** The reads and the worker are started off microtasks; a turn of the loop is enough for both. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const started = (): { states: WaveformState[]; job: ReturnType<typeof startWaveform> } => {
  const states: WaveformState[] = []
  const job = startWaveform(reader, material({ start: 1, end: 6 }), (state) => states.push(state), {
    workerUrl: 'worker.js',
  })
  return { states, job }
}

describe('startWaveform', () => {
  it('has nothing to draw and nothing to complain about when there is no sound', async () => {
    const states: WaveformState[] = []
    startWaveform(reader, silence(), (state) => states.push(state), { workerUrl: 'worker.js' })
    await settle()

    expect(states).toEqual([NO_WAVEFORM])
    expect(FakeWorker.made).toHaveLength(0)
  })

  it('refuses the sound of a browser that cannot decode it, without reading a byte', async () => {
    // No AudioDecoder here: `refused` is what the inspector turns into "this browser will not
    // decode this sound", and it has to be told apart from a recording that is simply silent.
    scope.Worker = FakeWorker
    const states: WaveformState[] = []
    startWaveform(reader, material({ start: 1, end: 6 }), (state) => states.push(state), {
      workerUrl: 'worker.js',
    })
    await settle()

    expect(states).toEqual([{ peaks: [], covered: 0, done: true, refused: true }])
    expect(FakeWorker.made).toHaveLength(0)
  })

  it('asks the worker for the slices it was told to ask for', async () => {
    withDecoder()
    const { states } = started()
    await settle()

    const request = FakeWorker.made[0]!.posted[0]!
    expect(request.type).toBe('peaks')
    expect(request.trackId).toBe(3)
    expect(request.timescale).toBe(44_100)
    expect(request.sliceSeconds).toBe(WAVEFORM_SLICE_SECONDS)
    expect(request.runs.map((run) => run.start)).toEqual([1])
    // Before a slice has come back the wave is empty and the reading stands at the first sound.
    expect(states).toEqual([])
  })

  it('takes the slice length from the caller when it is given one', async () => {
    withDecoder()
    startWaveform(reader, material({ start: 1, end: 6 }), () => {}, {
      workerUrl: 'worker.js',
      sliceSeconds: 0.5,
    })
    await settle()

    expect(FakeWorker.made[0]!.posted[0]!.sliceSeconds).toBe(0.5)
  })

  it('never lets the finish pull the read edge back over what was read', async () => {
    withDecoder()
    const { states } = started()
    await settle()
    const worker = FakeWorker.made[0]!

    worker.send({ type: 'slice', start: 1, min: Int8Array.from([-9]), max: Int8Array.from([9]), covered: 3.5 })
    // A last run that yielded nothing reports the covered it started with, which is behind the
    // slices already drawn. Taken as it stands, the dimmed edge would slide back to the left
    // over material the wave is already showing.
    worker.send({ type: 'done', covered: 0 })

    expect(states.map((state) => state.covered)).toEqual([3.5, 3.5])
    expect(states[1]).toMatchObject({ done: true, refused: false })
    expect(states[1]!.peaks.map((piece) => piece.start)).toEqual([1])
    expect(worker.terminated).toBe(1)
  })

  it('refuses the sound the worker gives up on, and the worker that falls over', async () => {
    withDecoder()
    const first = started()
    await settle()
    FakeWorker.made[0]!.send({ type: 'failed', error: 'opus is not decoded here' })

    expect(first.states.at(-1)).toMatchObject({ done: true, refused: true })
    expect(FakeWorker.made[0]!.terminated).toBe(1)

    const second = started()
    await settle()
    // An exception inside the worker never arrives as a message: onerror is the only report of
    // it, and without it the wave would stay half-drawn and the inspector would say nothing.
    FakeWorker.made[1]!.onerror?.(new Error('boom'))

    expect(second.states.at(-1)).toMatchObject({ done: true, refused: true })
    expect(FakeWorker.made[1]!.terminated).toBe(1)
  })

  it('says nothing more once it has been cancelled', async () => {
    withDecoder()
    const early = started()
    early.job.cancel()
    await settle()

    // Cancelled while the segments were being read: the worker is never started at all.
    expect(FakeWorker.made).toHaveLength(0)
    expect(early.states).toEqual([])

    const late = started()
    await settle()
    late.job.cancel()
    FakeWorker.made[0]!.send({ type: 'slice', start: 1, min: Int8Array.from([1]), max: Int8Array.from([1]), covered: 2 })

    expect(FakeWorker.made[0]!.terminated).toBe(1)
    expect(late.states).toEqual([])
  })

  it('says nothing more once a silent recording has been cancelled', async () => {
    const states: WaveformState[] = []
    const job = startWaveform(reader, silence(), (state) => states.push(state), { workerUrl: 'worker.js' })
    job.cancel()
    await settle()

    expect(states).toEqual([])
  })
})
