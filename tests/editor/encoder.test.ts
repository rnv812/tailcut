import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { encodeToTrack, KEY_INTERVAL_SECONDS } from '../../src/editor/export/encoder'
import { MAX_FRAMES_IN_FLIGHT, type Codecs, type FrameSource } from '../../src/editor/export/frames'
import type { EncodingChoice } from '../../src/core/encode/codec'
import { codedSampleEntry } from '../../src/core/encode/entry'
import { planFrames, type FramePlan, type FrameToKeep } from '../../src/core/encode/plan'
import {
  planClip,
  type ClipRequest,
  type ClipSource,
  type SourceTrack,
} from '../../src/core/export/plan'
import { presentationTicks } from '../../src/core/iso/progressive'
import { sampleEntryBytes, videoSampleEntry } from '../../src/core/iso/entry'
import { parseInit } from '../../src/core/iso/init'
import { editOffset, sampleRunOf, trackDefaults } from '../../src/core/iso/samples'
import type { Located, TrackKind } from '../../src/shared/types'

/**
 * The encoding loop, over an encoder that is an ordinary object.
 *
 * Two things decide whether the clip comes out right, and neither is about pixels. The first is
 * the order: an encoder hands a frame back when it is decodable, which is the order a file states
 * its samples in, and anything that re-sorts them writes a track no reader can play. The second
 * is the zero: the picture on this path has no edit list to hide its head with, so its own
 * presentation has to start at nought or the sound plays a group of frames early.
 *
 * Most of what follows is measured on the fixture rather than on numbers made up here, so that
 * "the same length the copy path states" is an equality between two computations.
 */

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/** Where a sample's bytes would lie in a snapshot; see `tests/core/encode-plan.test.ts`. */
class Bank {
  private cursor = 0

  add(bytes: Uint8Array): Located {
    const at = this.cursor
    this.cursor += bytes.byteLength
    return { at, length: bytes.byteLength }
  }
}

/** A track indexed the way `sourceTrackOf` indexes one, out of a fixture and a bank of its own. */
function trackFrom(
  bank: Bank,
  init: Uint8Array,
  segments: Uint8Array[],
  kind: TrackKind,
): SourceTrack {
  const declared = parseInit(init)!.tracks.find((track) => track.kind === kind)!
  const entry = kind === 'video' ? videoSampleEntry(init) : null
  const run = sampleRunOf({
    segments: segments.map((bytes) => ({ bytes, source: bank.add(bytes) })),
    trackId: declared.trackId,
    kind,
    defaults: trackDefaults(init),
    loneTrack: true,
  })

  return {
    kind,
    timescale: declared.timescale,
    sampleEntry: sampleEntryBytes(init, declared.trackId)!,
    width: entry?.codedWidth ?? 0,
    height: entry?.codedHeight ?? 0,
    editOffset: editOffset(init, declared.trackId),
    samples: run.samples,
    dropped: run.dropped,
  }
}

/**
 * Six seconds of H.264 with sound: 320×240 at 24 a second, a sync sample every second, and every
 * frame after the first composed out of decode order.
 */
function h264(video: number[], audio: number[]): ClipSource {
  const bank = new Bank()
  return {
    video: trackFrom(
      bank,
      read('tests/fixtures/h264/init-stream0.m4s'),
      video.map((n) => read(`tests/fixtures/h264/chunk-stream0-0000${n}.m4s`)),
      'video',
    ),
    audio: trackFrom(
      bank,
      read('tests/fixtures/h264/init-stream1.m4s'),
      audio.map((n) => read(`tests/fixtures/h264/chunk-stream1-0000${n}.m4s`)),
      'audio',
    ),
  }
}

const whole = h264([1, 2, 3], [1, 2, 3, 4])
/** The same with the middle segment of each track thrown away: a two-second hole. */
const holed = h264([1, 3], [1, 3, 4])

const TIMESCALE = 12288
const FRAME_TICKS = 512
const FRAMERATE = 24

const usOf = (ticks: number): number => Math.round((ticks * 1_000_000) / TIMESCALE)
const sum = (numbers: number[]): number => numbers.reduce((total, one) => total + one, 0)

/** A clip that opens in the middle of a group: a head to throw away, and no seam. */
const MID_GROUP: ClipRequest = { in: 1.5, out: 3, sound: true }
/** The whole recording: long enough for the key frames to have a rhythm. */
const EVERYTHING: ClipRequest = { in: 0, out: 6, sound: true }

const midGroup = planFrames(whole, MID_GROUP, null, FRAMERATE)!
const everything = planFrames(whole, EVERYTHING, null, FRAMERATE)!
const overSeam = planFrames(holed, EVERYTHING, null, FRAMERATE)!

/**
 * A plan of `count` frames at a constant rate, for the cases that are about the loop and not
 * about any material: an emission order written out by hand, a head of nothing, a quantizer.
 */
function planOf(count: number, over: { headTicks?: number } = {}): FramePlan {
  const headTicks = over.headTicks ?? 0

  const frames: FrameToKeep[] = Array.from({ length: count }, (_, at) => {
    const pts = at * FRAME_TICKS
    return {
      source: { at: 1000 + at * 64, length: 16 + at },
      pts,
      duration: FRAME_TICKS,
      sync: at === 0,
      keep: pts >= headTicks,
    }
  })

  return {
    frames,
    kept: frames.filter((frame) => frame.keep).length,
    headTicks,
    headUs: usOf(headTicks),
    timescale: TIMESCALE,
    crop: null,
    decoder: { codec: 'avc1.4d400d', description: Uint8Array.of(1, 100, 3) },
    sourceFormat: 'avc1',
    geometry: { width: 320, height: 240, framerate: FRAMERATE },
    audio: null,
    duration: (count * FRAME_TICKS) / TIMESCALE,
  }
}

const configOf = (codec: string): VideoEncoderConfig => ({
  codec,
  width: 320,
  height: 240,
  framerate: FRAMERATE,
})

/** The three rungs of the ladder, as `chooseCodec` states them. */
const SOFTWARE: EncodingChoice = {
  kind: 'h264-sw',
  config: { ...configOf('avc1.42001e'), bitrate: 800_000 },
  control: 'fixed-bitrate',
  bitrate: 800_000,
}
const AVC_HARDWARE: EncodingChoice = {
  kind: 'h264-hw',
  config: configOf('avc1.64001e'),
  control: 'quantizer',
  quantizer: 27,
}
const HEVC_HARDWARE: EncodingChoice = {
  kind: 'hevc-hw',
  config: configOf('hev1.1.6.L93.B0'),
  control: 'quantizer',
  quantizer: 22,
}

/** What the encoder says about itself on the first chunk. Not read here — carried, byte for byte. */
const DESCRIPTION = Uint8Array.of(1, 0x64, 0x00, 0x1e, 0xff, 0xe1, 0x00, 0x09, 0x67, 0x64)

interface Fed {
  timestamp: number
  options: VideoEncoderEncodeOptions | undefined
}

interface Fakes {
  codecs: Codecs
  encoderConfigs: VideoEncoderConfig[]
  /** Frames handed to the encoder, in the order they were handed over. */
  fed: Fed[]
  /** Timestamps of the chunks the encoder gave back, in the order it gave them back. */
  emitted: number[]
  decoderClosed: number
  encoderClosed: number
  framesMade: number
  framesClosed: number
  /** The deepest the encoder's own queue ever got. */
  maxQueued: number
}

/** The coded bytes of the chunk for the frame at that timestamp: something to tell samples apart by. */
const chunkBytes = (timestamp: number): Uint8Array =>
  Uint8Array.of(0xe0, timestamp & 0xff, (timestamp >> 8) & 0xff, (timestamp >> 16) & 0xff)

function fakeCodecs(
  options: {
    /** The order the encoder gives its chunks back in, as places in the order it was fed. */
    order?: number[]
    /** Which chunk carries the decoder configuration; null for an encoder that never says. */
    describeOn?: number | null
    description?: Uint8Array | ArrayBuffer
    /** A decoder that owes several frames at a time, the way a real one does. */
    decoder?: 'tap' | 'burst'
    /** Have the encoder hand its first chunk back under this timestamp instead of its own. */
    stray?: number
  } = {},
): Fakes {
  const describeOn = options.describeOn === undefined ? 0 : options.describeOn

  const fakes: Fakes = {
    codecs: null as unknown as Codecs,
    encoderConfigs: [],
    fed: [],
    emitted: [],
    decoderClosed: 0,
    encoderClosed: 0,
    framesMade: 0,
    framesClosed: 0,
    maxQueued: 0,
  }

  fakes.codecs = {
    // A decoder that hands each frame back the moment it is asked. What it does with its queue is
    // the other file's subject; here it is a tap — except where a case needs one that owes
    // several frames at a time, because that is what makes the stream run ahead of this loop.
    decoder(_config, on) {
      const owed: number[] = []

      const emitOne = (): void => {
        fakes.framesMade += 1
        const frame = {
          timestamp: owed.shift()!,
          duration: usOf(FRAME_TICKS),
          close: () => {
            fakes.framesClosed += 1
          },
        }
        on.frame(frame as unknown as VideoFrame)
      }

      return {
        decode(chunk) {
          owed.push(chunk.timestamp)
          if (options.decoder !== 'burst') emitOne()
        },
        async flush() {
          while (owed.length) emitOne()
        },
        close() {
          fakes.decoderClosed += 1
        },
        get queued() {
          return owed.length
        },
        async drainTo() {
          while (owed.length) emitOne()
        },
      }
    },

    encoder(config, on) {
      fakes.encoderConfigs.push(config)
      const pending: Fed[] = []
      let given = 0

      const emitOne = (): void => {
        const item = pending.shift()!
        // A chunk for a frame that was never handed over: an encoder inventing one is a bug in
        // the encoder, and the track has nowhere to put it.
        if (options.stray !== undefined && !fakes.emitted.length) item.timestamp = options.stray
        const bytes = chunkBytes(item.timestamp)
        fakes.emitted.push(item.timestamp)
        const metadata =
          given === describeOn
            ? { decoderConfig: { codec: 'avc1.64001e', description: options.description ?? DESCRIPTION } }
            : undefined
        given += 1
        on.chunk(
          {
            type: item.options?.keyFrame ? 'key' : 'delta',
            timestamp: item.timestamp,
            byteLength: bytes.byteLength,
            copyTo: (into: Uint8Array) => into.set(bytes),
          } as unknown as EncodedVideoChunk,
          metadata as EncodedVideoChunkMetadata | undefined,
        )
      }

      return {
        encode(frame, encodeOptions) {
          const item = { timestamp: frame.timestamp, options: encodeOptions }
          fakes.fed.push(item)
          pending.push(item)
          fakes.maxQueued = Math.max(fakes.maxQueued, pending.length)
        },
        async flush() {
          // Whatever is still owed comes back here, and this is where an encoder that reorders
          // says so: the permutation is over the frames it was fed.
          if (options.order) {
            const taken = options.order.map((at) => pending[at]!)
            pending.length = 0
            pending.push(...taken)
          }
          while (pending.length) emitOne()
        },
        close() {
          fakes.encoderClosed += 1
        },
        get queued() {
          return pending.length
        },
        async drainTo(limit) {
          while (pending.length > limit) emitOne()
        },
      }
    },

    chunk: (init) => init as unknown as EncodedVideoChunk,

    cut() {
      throw new Error('nothing here has a crop; the stream is what cuts one')
    },
  }

  return fakes
}

function sourceOf(over: Partial<FrameSource> = {}): FrameSource {
  return {
    read: async (at) => Uint8Array.of(at.at % 251, at.length % 251),
    stale: () => false,
    ...over,
  }
}

/** The presentation time of each sample, rebuilt from the file's own two numbers. */
const shownAt = (samples: Array<{ duration: number; cts: number }>): number[] => {
  let dts = 0
  return samples.map((sample) => {
    const pts = dts + sample.cts
    dts += sample.duration
    return pts
  })
}

describe('encodeToTrack: one sample for one frame', () => {
  it('writes as many samples as the plan keeps, and the length the copy path states', async () => {
    const fakes = fakeCodecs()
    const progress: number[] = []
    const result = (await encodeToTrack(midGroup, SOFTWARE, sourceOf(), fakes.codecs, (frames) =>
      progress.push(frames),
    ))!

    // The premises: this clip has a head that is decoded and not encoded, and the material it is
    // cut from is reordered — so "one sample per kept frame" is not "one sample per sample".
    expect(midGroup.kept).toBeLessThan(midGroup.frames.length)
    expect(midGroup.headTicks).toBeGreaterThan(0)
    const times = midGroup.frames.map((frame) => frame.pts)
    expect(times).not.toEqual([...times].sort((a, b) => a - b))

    expect(result.frames).toBe(midGroup.kept)
    expect(result.video.samples).toHaveLength(midGroup.kept)
    // Every frame the decoder made was let go of, including the ones the head threw away.
    expect(fakes.framesMade).toBe(midGroup.frames.length)
    expect(fakes.framesClosed).toBe(midGroup.frames.length)
    expect(fakes.encoderClosed).toBe(1)
    expect(fakes.decoderClosed).toBe(1)

    // The durations are the plan's ticks and not the transport's microseconds: at this timescale
    // a frame is 512 of the one and 41667 of the other, and only one of them belongs in a file.
    expect(result.video.samples.map((sample) => sample.duration)).toEqual(
      Array(midGroup.kept).fill(FRAME_TICKS),
    )
    expect(sum(result.video.samples.map((sample) => sample.duration))).toBe(
      sum(midGroup.frames.filter((frame) => frame.keep).map((frame) => frame.duration)),
    )

    // And the track shows exactly as much presentation as the copy of the same clip would have:
    // the number `planClip` states for it, worked out here by the same function the writer uses.
    expect(presentationTicks({ samples: result.video.samples, skipTicks: 0 })).toBe(
      Math.round(midGroup.duration * midGroup.timescale),
    )
    expect(midGroup.duration).toBe(planClip(whole, MID_GROUP).duration)

    // One encoder, configured with what the ladder chose and with nothing worked out here.
    expect(fakes.encoderConfigs).toEqual([SOFTWARE.config])

    // The picture is described as what came out of the plan, not as what went into it.
    expect(result.video.timescale).toBe(midGroup.timescale)
    expect(result.video.width).toBe(midGroup.geometry.width)
    expect(result.video.height).toBe(midGroup.geometry.height)

    // Progress is counted in frames **written** and never runs past the total the plan promised.
    // The first frame handed to the encoder is not a frame in the file — the encoder is holding
    // it — so the first thing the queue is told is nought.
    expect(progress).toHaveLength(midGroup.kept)
    expect(progress[0]).toBe(0)
    expect(progress[progress.length - 1]).toBeLessThanOrEqual(midGroup.kept)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
  })
})

describe('encodeToTrack: the order the encoder chose', () => {
  it('writes the samples in the order they came back, and nothing re-sorts them', async () => {
    const plan = planOf(4)
    // An encoder that hands its chunks back out of order — which is what one with B-frames does.
    const fakes = fakeCodecs({ order: [0, 2, 1, 3] })
    const result = (await encodeToTrack(plan, SOFTWARE, sourceOf(), fakes.codecs, () => {}))!

    const fed = plan.frames.map((frame) => usOf(frame.pts))
    expect(fakes.fed.map((one) => one.timestamp)).toEqual(fed)
    // The premise: it really did give them back in another order.
    expect(fakes.emitted).toEqual([fed[0], fed[2], fed[1], fed[3]])
    expect(fakes.emitted).not.toEqual(fed)

    // The bytes lie in the file in the order the encoder produced them. That order is decode
    // order — an encoder emits a frame when it is decodable — and a file states its samples in
    // decode order, so re-sorting here by anything at all would write a track nobody can play.
    expect(result.video.samples.map((sample) => sample.bytes)).toEqual(
      [fed[0], fed[2], fed[1], fed[3]].map((timestamp) => chunkBytes(timestamp!)),
    )
    // And the presentation each sample is given, rebuilt from the file's own decode clock and
    // composition offsets, is the time the frame was handed in with.
    expect(shownAt(result.video.samples)).toEqual([
      plan.frames[0]!.pts,
      plan.frames[2]!.pts,
      plan.frames[1]!.pts,
      plan.frames[3]!.pts,
    ])
    // Which means some of those offsets are negative, and that is what a ctts version 1 is for.
    expect(result.video.samples.some((sample) => sample.cts < 0)).toBe(true)
  })

  it('puts the first frame of the clip at the presentation zero, head or no head', async () => {
    // The premise: this clip begins in the middle of a group, so the timestamps that come back
    // from the encoder are a whole head away from nought. Written into the file as they came, the
    // picture would start that much after the sound — and this path has no edit list to hide it.
    expect(midGroup.headTicks).toBeGreaterThan(0)

    const fakes = fakeCodecs()
    const result = (await encodeToTrack(midGroup, SOFTWARE, sourceOf(), fakes.codecs, () => {}))!
    const shown = shownAt(result.video.samples)

    expect(Math.min(...fakes.fed.map((one) => one.timestamp))).toBe(usOf(midGroup.headTicks))
    expect(Math.min(...shown)).toBe(0)
    expect(Math.min(...shown)).not.toBe(midGroup.headTicks)

    // And a clip that had no head to throw away comes out at nought too — by the same
    // subtraction, of nothing.
    const flat = planOf(6)
    expect(flat.headTicks).toBe(0)
    const second = fakeCodecs()
    const other = (await encodeToTrack(flat, SOFTWARE, sourceOf(), second.codecs, () => {}))!
    expect(Math.min(...shownAt(other.video.samples))).toBe(0)
    expect(shownAt(other.video.samples)).toEqual(flat.frames.map((frame) => frame.pts))
  })
})

describe('encodeToTrack: what the encoder is asked for', () => {
  it('asks for a key frame first and then at the interval, counted in the plan’s own ticks', async () => {
    const fakes = fakeCodecs()
    await encodeToTrack(everything, SOFTWARE, sourceOf(), fakes.codecs, () => {})

    // The premise: the clip is long enough to need more than one key frame, and the material runs
    // at a rate that makes the interval a whole number of frames.
    const perKey = (KEY_INTERVAL_SECONDS * everything.timescale) / FRAME_TICKS
    expect(perKey).toBe(48)
    expect(everything.kept).toBe(144)

    const asked = fakes.fed
      .map((one, at) => (one.options?.keyFrame ? at : -1))
      .filter((at) => at >= 0)
    expect(asked).toEqual([0, 48, 96])
    // Nothing between them was asked for as a key frame, and the first frame of the clip always is
    // one: a file whose first sample is not decodable on its own opens as nothing at all.
    expect(fakes.fed[0]!.options?.keyFrame).toBe(true)
    expect(fakes.fed.filter((one) => one.options?.keyFrame)).toHaveLength(3)

    // And what came back as a key frame is written down as one: the sync table is the whole of
    // what a player has to seek by, and a track that claims every sample is one plays as rubble.
    const result = (await encodeToTrack(everything, SOFTWARE, sourceOf(), fakeCodecs().codecs, () => {}))!
    expect(result.video.samples.map((sample) => sample.sync)).toEqual(
      fakes.fed.map((one) => one.options?.keyFrame === true),
    )
    expect(result.video.samples[0]!.sync).toBe(true)
    expect(result.video.samples.filter((sample) => sample.sync)).toHaveLength(3)
  })

  it('sends the quantizer on the rungs that take one, and nothing per-frame on the one that does not', async () => {
    const plan = planOf(3)

    const hevc = fakeCodecs()
    await encodeToTrack(plan, HEVC_HARDWARE, sourceOf(), hevc.codecs, () => {})
    expect(hevc.fed.map((one) => one.options)).toEqual([
      { keyFrame: true, hevc: { quantizer: HEVC_HARDWARE.quantizer } },
      { keyFrame: false, hevc: { quantizer: HEVC_HARDWARE.quantizer } },
      { keyFrame: false, hevc: { quantizer: HEVC_HARDWARE.quantizer } },
    ])

    const avc = fakeCodecs()
    await encodeToTrack(plan, AVC_HARDWARE, sourceOf(), avc.codecs, () => {})
    expect(avc.fed.map((one) => one.options)).toEqual([
      { keyFrame: true, avc: { quantizer: AVC_HARDWARE.quantizer } },
      { keyFrame: false, avc: { quantizer: AVC_HARDWARE.quantizer } },
      { keyFrame: false, avc: { quantizer: AVC_HARDWARE.quantizer } },
    ])

    // The software rung takes a bitrate and refuses quantizer mode outright, so there is nothing
    // per-frame to tell it. A quantizer here would be a promise openh264 does not implement.
    const software = fakeCodecs()
    await encodeToTrack(plan, SOFTWARE, sourceOf(), software.codecs, () => {})
    expect(software.fed.map((one) => one.options)).toEqual([
      { keyFrame: true },
      { keyFrame: false },
      { keyFrame: false },
    ])
  })
})

describe('encodeToTrack: the account the encoder gives of itself', () => {
  it('writes the description it was given into the sample entry, whichever chunk brought it', async () => {
    const plan = planOf(4)

    const fakes = fakeCodecs()
    const result = (await encodeToTrack(plan, SOFTWARE, sourceOf(), fakes.codecs, () => {}))!
    expect(result.video.sampleEntry).toEqual(
      codedSampleEntry('avc1', DESCRIPTION, plan.geometry.width, plan.geometry.height),
    )

    // Chrome states it on the first chunk; the specification does not promise which one, and a
    // buffer rather than a view is as legal an answer as a view. Both are taken, and the entry
    // that comes out is the same either way.
    const late = fakeCodecs({ describeOn: 2, description: DESCRIPTION.slice().buffer })
    const second = (await encodeToTrack(plan, SOFTWARE, sourceOf(), late.codecs, () => {}))!
    expect(second.video.sampleEntry).toEqual(result.video.sampleEntry)

    // HEVC is described by an entry of its own, and the four letters are the whole of what a
    // reader has to go on: an hvcC under `avc1` is an HEVC track calling itself H.264.
    const hevc = fakeCodecs()
    const third = (await encodeToTrack(plan, HEVC_HARDWARE, sourceOf(), hevc.codecs, () => {}))!
    expect(third.video.sampleEntry).toEqual(
      codedSampleEntry('hvc1', DESCRIPTION, plan.geometry.width, plan.geometry.height),
    )
    expect(third.video.sampleEntry).not.toEqual(result.video.sampleEntry)
  })

  it('refuses to build a track for an encoder that never said how to decode it', async () => {
    const plan = planOf(4)
    const fakes = fakeCodecs({ describeOn: null })

    await expect(
      encodeToTrack(plan, SOFTWARE, sourceOf(), fakes.codecs, () => {}),
    ).rejects.toThrow('The encoder produced no decoder configuration.')

    // The premise: it did produce chunks, so what is missing is the account and not the picture.
    // A file written without it looks whole and plays as nothing.
    expect(fakes.emitted).toHaveLength(plan.kept)
    expect(fakes.encoderClosed).toBe(1)
    expect(fakes.framesClosed).toBe(fakes.framesMade)

    // And the other way an encoder can be no use: a chunk for a frame it was never given. The
    // likeliest such number is not nonsense but a frame of the **head** — one this program
    // decoded as a reference and never handed over — so that is the one used here. There is no
    // tick in the plan for it, because the plan counts the frames that are written and not the
    // frames that are read; dropping the chunk quietly would lose a frame out of the clip, and
    // taking it would write a sample for a picture nobody encoded.
    const dropped = midGroup.frames.find((frame) => !frame.keep)!
    expect(dropped, 'this clip has no head, so it has no frame to mistake one for').toBeDefined()
    const inventive = fakeCodecs({ stray: usOf(dropped.pts) })
    await expect(
      encodeToTrack(midGroup, SOFTWARE, sourceOf(), inventive.codecs, () => {}),
    ).rejects.toThrow('The encoder returned a frame that was never sent to it.')
    expect(inventive.encoderClosed).toBe(1)
  })
})

describe('encodeToTrack: called off, and material that is not a metronome', () => {
  it('stops at the frame the job was called off on, and builds nothing', async () => {
    // A decoder that owes several frames at a time, which is what a real one does and what makes
    // this case say anything: the stream hands over what it already has before it looks at the
    // flag again, so it is this loop that has to stop, at the frame and not at the burst.
    const fakes = fakeCodecs({ decoder: 'burst' })
    let done = 0

    const whole = await encodeToTrack(everything, SOFTWARE, sourceOf(), fakes.codecs, () => {
      done += 1
    })
    // The premise: the same clip with nobody calling anything off is a whole clip.
    expect(whole).not.toBeNull()
    expect(done).toBe(everything.kept)

    const called = fakeCodecs({ decoder: 'burst' })
    done = 0
    const stopped = await encodeToTrack(
      everything,
      SOFTWARE,
      sourceOf({ stale: () => done > 10 }),
      called.codecs,
      () => {
        done += 1
      },
    )

    expect(stopped).toBeNull()
    // Eleven, and not "fewer than the clip": the flag is looked at before every frame, so the
    // eleventh is the last one encoded and the twelfth is not encoded at all.
    expect(called.fed).toHaveLength(11)
    expect(called.encoderClosed).toBe(1)
    expect(called.decoderClosed).toBe(1)
    expect(called.framesClosed).toBe(called.framesMade)

    // Called off after the last frame went in, which no check inside the walk can see: the answer
    // is still nothing. A job the user stopped does not become a file because it had nearly
    // finished.
    const late = fakeCodecs({ decoder: 'burst' })
    done = 0
    const abandoned = await encodeToTrack(
      everything,
      SOFTWARE,
      sourceOf({ stale: () => done >= everything.kept }),
      late.codecs,
      () => {
        done += 1
      },
    )
    expect(late.fed).toHaveLength(everything.kept)
    expect(abandoned).toBeNull()
  })

  it('keeps the total right where the frames are not all the same length', async () => {
    // A recording with a two-second hole in it, which `planClip` closed by shortening the frame in
    // front of the seam. The durations of this clip are therefore not all equal.
    const kept = overSeam.frames.filter((frame) => frame.keep)
    const seam = kept.findIndex((frame) => frame.duration !== FRAME_TICKS)
    expect(seam, 'the holed fixture has no seam in it').toBeGreaterThan(0)

    const fakes = fakeCodecs()
    const result = (await encodeToTrack(overSeam, SOFTWARE, sourceOf(), fakes.codecs, () => {}))!

    expect(result.video.samples).toHaveLength(overSeam.kept)
    expect(sum(result.video.samples.map((sample) => sample.duration))).toBe(
      sum(kept.map((frame) => frame.duration)),
    )
    // The multiset is the plan's too: no duration was invented and none was dropped.
    expect(result.video.samples.map((sample) => sample.duration).sort((a, b) => a - b)).toEqual(
      kept.map((frame) => frame.duration).sort((a, b) => a - b),
    )
    // The order is the encoder's, sample for sample.
    expect(result.video.samples.map((sample) => sample.bytes)).toEqual(
      fakes.emitted.map((timestamp) => chunkBytes(timestamp)),
    )

    // What this case does **not** claim: that each sample got its own duration. The nth chunk is
    // given the nth duration of the presentation-ordered list, which is exact at a constant rate
    // and only right in total where the lengths vary — a sample can be handed its neighbour's
    // duration and have its composition offset moved by the difference. Pairing by timestamp
    // instead would fix that one sample and break the decode clock, which has to be a running sum
    // in the order the samples are stated.
  })
})

describe('encodeToTrack: what waits for what', () => {
  it('waits on the encoder rather than filling it, and lets go of every frame', async () => {
    const fakes = fakeCodecs()
    await encodeToTrack(everything, SOFTWARE, sourceOf(), fakes.codecs, () => {})

    // The premise: there is far more work here than the bound, so the bound is reached.
    expect(everything.kept).toBeGreaterThan(MAX_FRAMES_IN_FLIGHT)

    // The encoder is the slow half, so it is the one that decides the pace of the whole chain:
    // one frame is handed over and then the queue is looked at, which is why the deepest it ever
    // gets is the bound and one. A held frame is a buffer the collector does not count — eight
    // frames of 1080p is twenty-five megabytes.
    expect(fakes.maxQueued).toBe(MAX_FRAMES_IN_FLIGHT + 1)
    expect(fakes.framesMade).toBe(everything.frames.length)
    expect(fakes.framesClosed).toBe(fakes.framesMade)
  })
})
