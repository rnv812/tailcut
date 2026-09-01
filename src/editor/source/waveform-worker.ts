import { PeakBuilder, peaksEnd, type Peaks } from '../../core/audio/peaks'
import { audioDecoderConfig, type AudioDecoderSetup } from '../../core/codec/audio'
import { audioSampleEntry } from '../../core/iso/entry'
import { samplesInSegment, trackDefaults, type SampleDefaults } from '../../core/iso/samples'

/**
 * Peaks, computed where they cost nothing.
 *
 * A dedicated worker has AudioDecoder; a document has it too, but the sound of three minutes is
 * half a second of solid work and the measured jitter it costs the main thread from here is
 * eighteen milliseconds — one frame at 60 Hz. Nothing of the PCM crosses back: the sound is folded
 * into buckets inside the output callback and the AudioData is closed on the way out of it.
 */

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  postMessage(message: unknown, transfer?: Transferable[]): void
}

export type ToWaveformWorker = {
  type: 'peaks'
  /** ftyp and moov of the representation the sound belongs to. */
  init: ArrayBuffer
  trackId: number
  timescale: number
  /** Seconds of sound to fold before a slice is posted. */
  sliceSeconds: number
  /** One entry per continuous stretch of material, in time order. */
  runs: Array<{
    start: number
    segments: Array<{ bytes: ArrayBuffer; timestampOffset?: number }>
  }>
}

export type FromWaveformWorker =
  | { type: 'slice'; start: number; min: Int8Array; max: Int8Array; covered: number }
  | { type: 'done'; covered: number }
  | { type: 'failed'; error: string }

const scope = self as unknown as WorkerScope
const MICROSECONDS = 1_000_000

interface Packet {
  bytes: Uint8Array
  timestamp: number
  duration: number
}

/** Every sample of one run, in decode order. An mdat holds two to five hundred of them. */
function packetsOf(
  job: ToWaveformWorker,
  defaults: Map<number, SampleDefaults>,
  run: { segments: Array<{ bytes: ArrayBuffer; timestampOffset?: number }> },
): Packet[] {
  const packets: Packet[] = []

  for (const placed of run.segments) {
    const segment = new Uint8Array(placed.bytes)
    const timestampOffset = placed.timestampOffset ?? 0
    for (const track of samplesInSegment(segment, defaults)) {
      if (track.trackId !== job.trackId) continue
      for (const sample of track.samples) {
        packets.push({
          bytes: segment.subarray(sample.at, sample.at + sample.size),
          timestamp: Math.round(
            (sample.dts / job.timescale + timestampOffset) * MICROSECONDS,
          ),
          duration: Math.round((sample.duration / job.timescale) * MICROSECONDS),
        })
      }
    }
  }

  return packets
}

/**
 * One run, its own decoder.
 *
 * Measured: fed a capture with a hole in it, Chromium renumbers its output consecutively and
 * swallows the hole — the first packet after a forty-second gap came back stamped a single packet
 * after the last one before it, and the whole recording landed inside a shorter timeline. So the
 * decoder is not asked to carry a gap: it is started again on the far side of one, and the
 * buckets are counted off the start of the run rather than off what the decoder says the time is.
 * A restart costs nothing — 372 ms against 458 for three minutes read straight through.
 */
async function readRun(
  setup: AudioDecoderSetup,
  job: ToWaveformWorker,
  defaults: Map<number, SampleDefaults>,
  run: {
    start: number
    segments: Array<{ bytes: ArrayBuffer; timestampOffset?: number }>
  },
  post: (peaks: Peaks) => void,
): Promise<void> {
  let builder: PeakBuilder | null = null
  /**
   * The builder of this run, made when the first block comes out and at the rate that block came
   * out at.
   *
   * Not at the rate the container declares: the two part company: HE-AAC's SBR doubles the rate
   * off the AudioSpecificConfig, and a container that states the wrong pair has the description
   * correct it. A bucket is ten milliseconds of what the decoder produced, so counting it off
   * the declaration draws the wave stretched or squeezed against the picture it stands under.
   */
  const folding = (rate: number): PeakBuilder => (builder ??= new PeakBuilder(rate, run.start))
  const planes: Float32Array[] = []
  let failure: unknown = null

  const decoder = new AudioDecoder({
    output: (data) => {
      const fold = folding(data.sampleRate)

      try {
        const frames = data.numberOfFrames
        const channels: Float32Array[] = []

        for (let plane = 0; plane < data.numberOfChannels; plane++) {
          let buffer = planes[plane]
          if (!buffer || buffer.length < frames) {
            buffer = new Float32Array(frames)
            planes[plane] = buffer
          }
          data.copyTo(buffer, { planeIndex: plane, format: 'f32-planar' })
          channels.push(buffer)
        }

        fold.push(channels, frames)
      } finally {
        // 69 MB of PCM against 36 KB of peaks: the sound must not outlive this callback.
        data.close()
      }

      if (fold.pending >= job.sliceSeconds) post(fold.take())
    },
    error: (cause) => {
      failure = cause
    },
  })

  decoder.configure(setup)
  for (const packet of packetsOf(job, defaults, run)) {
    // Every packet of AAC and of Opus stands on its own; there is no other kind here.
    decoder.decode(
      new EncodedAudioChunk({
        type: 'key',
        timestamp: packet.timestamp,
        duration: packet.duration,
        data: packet.bytes,
      }),
    )
  }

  await decoder.flush()
  post(folding(setup.sampleRate).finish())
  decoder.close()

  if (failure) throw failure
}

async function readAll(job: ToWaveformWorker): Promise<void> {
  const init = new Uint8Array(job.init)
  const entry = audioSampleEntry(init)
  const setup = entry ? audioDecoderConfig(entry) : null

  if (!setup) {
    scope.postMessage({ type: 'failed', error: 'the sound of this track is not described' })
    return
  }

  const support = await AudioDecoder.isConfigSupported(setup)
  if (!support.supported) {
    scope.postMessage({ type: 'failed', error: `${setup.codec} is not decoded here` })
    return
  }

  const defaults = trackDefaults(init)
  let covered = 0

  const post = (peaks: Peaks): void => {
    if (!peaks.min.length) return
    covered = peaksEnd(peaks)
    const message: FromWaveformWorker = {
      type: 'slice',
      start: peaks.start,
      min: peaks.min,
      max: peaks.max,
      covered,
    }
    scope.postMessage(message, [peaks.min.buffer as ArrayBuffer, peaks.max.buffer as ArrayBuffer])
  }

  for (const run of job.runs) await readRun(setup, job, defaults, run, post)

  scope.postMessage({ type: 'done', covered })
}

scope.addEventListener('message', (event: MessageEvent) => {
  const job = event.data as ToWaveformWorker
  if (job?.type !== 'peaks') return

  void readAll(job).catch((cause) => {
    scope.postMessage({ type: 'failed', error: String(cause) })
  })
})
