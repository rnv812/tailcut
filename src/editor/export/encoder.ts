import { codedSampleEntry } from '../../core/encode/entry'
import type { EncodingChoice } from '../../core/encode/codec'
import type { FramePlan } from '../../core/encode/plan'
import type { EncodedVideo } from '../../core/encode/assemble'
import type { OutSample } from '../../core/iso/progressive'
import { decodedFrames, MAX_FRAMES_IN_FLIGHT, type Codecs, type FrameSource } from './frames'
import { codecFailure } from './failure'

/**
 * How often a key frame is asked for.
 *
 * Two seconds, which is what the sites this program records write themselves. It decides what
 * seeking in the finished clip costs and nothing else: a clip is played, not edited again.
 */
export const KEY_INTERVAL_SECONDS = 2

export interface EncodeResult {
  video: EncodedVideo
  /** Frames written. Equal to `plan.kept` unless the job was called off. */
  frames: number
}

/**
 * What the encoder is told about one frame, on the rung that takes a quantizer.
 *
 * The `hevc` member is not in the DOM library's `VideoEncoderEncodeOptions`; it is declared in
 * `src/shared/webcodecs.d.ts`, and the reason is written down there.
 */
function optionsFor(choice: EncodingChoice, keyFrame: boolean): VideoEncoderEncodeOptions {
  if (choice.kind === 'hevc-hw') return { keyFrame, hevc: { quantizer: choice.quantizer } }
  if (choice.kind === 'h264-hw') return { keyFrame, avc: { quantizer: choice.quantizer } }
  // The software rung takes a bitrate and refuses `quantizer` mode outright, so there is nothing
  // per-frame to say to it. Promising constant quality here would be promising what openh264
  // does not implement.
  return { keyFrame }
}

/**
 * The clip, encoded: frames in, one track out.
 *
 * The output is built in the order the encoder emits, which **is** decode order — an encoder
 * hands a frame back when it is decodable, and that is the order a file states its samples in.
 * Nothing here sorts. The composition offset of each sample is worked out from the timestamp it
 * came back with, so an encoder that reorders is handled without being asked not to, and one that
 * does not reorder comes out with every `cts` at zero: the same code path with nothing to do.
 *
 * Durations come from the plan and never from the timestamps. The transport counts microseconds
 * and the file counts ticks; going through microseconds would put a rounding error on every one
 * of eighteen hundred frames, and they would add up.
 *
 * The frames arrive already cut to `plan.crop` (see `decodedFrames`), so nothing here knows what
 * a crop is: `plan.geometry` is the size of what comes in and the size the encoder is configured
 * with, and those are the same number by construction.
 */
export async function encodeToTrack(
  plan: FramePlan,
  choice: EncodingChoice,
  source: FrameSource,
  codecs: Codecs,
  onFrames: (frames: number) => void,
): Promise<EncodeResult | null> {
  const kept = plan.frames.filter((frame) => frame.keep)
  // Timestamp of a frame, in the microseconds the transport counts, to the ticks the file counts.
  // The map is the only bridge between the two scales, and it is keyed by the number the encoder
  // gives back unchanged.
  const ticksAt = new Map<number, number>()
  for (const frame of kept) {
    ticksAt.set(Math.round((frame.pts * 1_000_000) / plan.timescale), frame.duration)
  }

  const emitted: Array<{ bytes: Uint8Array; sync: boolean; timestamp: number }> = []
  let description: Uint8Array | null = null
  let failed: Error | null = null
  const encodingFailure = (cause: unknown): Error =>
    codecFailure('encode', plan.decoder.codec, choice.config.codec, cause)

  let encoder
  try {
    encoder = codecs.encoder(choice.config, {
      chunk(chunk, metadata) {
        const config = metadata?.decoderConfig
        if (config?.description && !description) {
          const raw = config.description
          description =
            raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBuffer)
        }
        const bytes = new Uint8Array(chunk.byteLength)
        chunk.copyTo(bytes)
        // A chunk whose timestamp is not one we handed in cannot be placed in the track. It has
        // never been seen and would be a bug in the encoder, not in the clip — dropping it silently
        // would lose a frame, so it is a failure with a name.
        if (!ticksAt.has(chunk.timestamp)) {
          failed = new Error('The encoder returned a frame that was never sent to it.')
          return
        }
        emitted.push({ bytes, sync: chunk.type === 'key', timestamp: chunk.timestamp })
      },
      error(error) {
        failed = encodingFailure(error)
      },
    })
  } catch (error) {
    throw encodingFailure(error)
  }

  let sent = 0
  const keyInterval = KEY_INTERVAL_SECONDS * plan.timescale
  let ticksSinceKey = 0

  try {
    for await (const frame of decodedFrames(plan, source, codecs)) {
      // The frame belongs to this loop the moment it is handed over, and the end of a job is
      // exactly where one gets forgotten: `for await` closes what the stream is still holding,
      // never what it has already given away. A `VideoFrame` nobody closes is a buffer the
      // collector does not count — three megabytes of 1080p, for as long as the tab is open.
      if (failed || source.stale()) {
        frame.close()
        if (failed) throw failed
        return null
      }

      const wantsKey = sent === 0 || ticksSinceKey >= keyInterval
      try {
        try {
          encoder.encode(frame, optionsFor(choice, wantsKey))
        } catch (error) {
          throw failed ?? encodingFailure(error)
        }
      } finally {
        // Always, and immediately. A held frame is a buffer the collector does not count.
        frame.close()
      }

      // The frame's own duration, looked up by its timestamp. Not `kept[sent]`: the decoder
      // hands frames back in presentation order while `kept` is in decode order, and on material
      // with B-frames those are two different sequences.
      const duration = ticksAt.get(frame.timestamp) ?? 0
      ticksSinceKey = wantsKey ? duration : ticksSinceKey + duration
      sent += 1
      onFrames(emitted.length)

      // The one place the whole chain waits. Everything upstream is bounded by this.
      if (encoder.queued > MAX_FRAMES_IN_FLIGHT) {
        try {
          await encoder.drainTo(MAX_FRAMES_IN_FLIGHT)
        } catch (error) {
          throw failed ?? encodingFailure(error)
        }
      }
    }

    try {
      await encoder.flush()
    } catch (error) {
      throw failed ?? encodingFailure(error)
    }
    if (failed) throw failed
    if (source.stale()) return null

    if (!description) throw new Error('The encoder produced no decoder configuration.')

    return {
      video: {
        sampleEntry: codedSampleEntry(
          choice.kind === 'hevc-hw' ? 'hvc1' : 'avc1',
          description,
          plan.geometry.width,
          plan.geometry.height,
        ),
        width: plan.geometry.width,
        height: plan.geometry.height,
        timescale: plan.timescale,
        samples: samplesOf(emitted, kept, plan),
      },
      frames: emitted.length,
    }
  } finally {
    try {
      encoder.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * The emitted chunks as samples of a track: emission order kept, durations from the plan, and the
 * clip's presentation zeroed on its entry point.
 *
 * **Emission order is decode order and nothing re-sorts it.** An encoder emits a frame when it is
 * decodable, which is exactly the order a file states its samples in; sorting here — by anything
 * — would write a track in some other order and leave every reader to decode the wrong picture.
 *
 * **The zeroing is the second half of the synchronisation invariant.** The timestamps that come
 * back are in the *source's* scale: the first frame of a clip that starts in the middle of a
 * group carries `headTicks`, not nought. The copy path hides that head with an edit list; this
 * path did not encode it at all, so there is no list — and if the numbers went into the file as
 * they came, the picture would start a whole group of frames after the sound, which is seconds.
 * Subtracting `plan.headTicks` here, once, at the one place the transport's clock becomes the
 * file's, is what makes `assembleEncoded`'s `skipTicks: 0` true.
 *
 * `dts` is the running sum of the durations of the kept frames **in presentation order** — the
 * decode clock a constant-rate stream would have — so the track's length is the clip's length
 * whatever order the samples came in. A negative `cts` is legal and is exactly what a `ctts`
 * version 1 exists for (see progressive.ts).
 *
 * **Where this is exact and where it is only right in total.** The nth emitted chunk is given the
 * nth duration of the presentation-ordered list. At a constant frame rate every duration is the
 * same number and the pairing is exact. Where the durations vary — a recording whose frames are
 * not all the same length — the sum still comes out right, and so does the order, but an
 * individual sample can be handed its neighbour's duration and have its `cts` moved by the
 * difference. Pairing by timestamp instead would fix that one sample and break the decode clock,
 * which has to be a running sum in emission order; a file whose total length and sample order are
 * right is the answer worth having, and the test below pins the total rather than pretending the
 * pairing is more than it is.
 */
function samplesOf(
  emitted: Array<{ bytes: Uint8Array; sync: boolean; timestamp: number }>,
  kept: Array<{ pts: number; duration: number }>,
  plan: { timescale: number; headTicks: number },
): OutSample[] {
  const durations = kept
    .slice()
    .sort((a, b) => a.pts - b.pts)
    .map((frame) => frame.duration)

  let dts = 0

  return emitted.map((chunk, at) => {
    const duration = durations[at] ?? 0
    const pts = Math.round((chunk.timestamp * plan.timescale) / 1_000_000) - plan.headTicks
    const sample: OutSample = { bytes: chunk.bytes, duration, cts: pts - dts, sync: chunk.sync }
    dts += duration
    return sample
  })
}
