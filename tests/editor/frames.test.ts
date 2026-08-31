import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  decodedFrames,
  liveCodecs,
  MAX_FRAMES_IN_FLIGHT,
  type Codecs,
  type FrameSource,
} from '../../src/editor/export/frames'
import type { Crop } from '../../src/core/encode/crop'
import type { FramePlan, FrameToKeep } from '../../src/core/encode/plan'
import type { Located } from '../../src/shared/types'

/**
 * The frame stream, over a decoder that is an ordinary object.
 *
 * Everything here is measured on fakes on purpose: `VideoDecoder` does not exist in this
 * environment, and the three things this file has to get right — the order frames come out in,
 * the head that never comes out at all, and the bound on how far ahead the decoder may run — are
 * properties of the loop and not of any codec. A fake that answers "here is your frame" the
 * instant it is asked would prove none of them, so the ones below hold frames back the way a
 * decoder does, and one of them hands them out in the wrong order on purpose.
 */

const TIMESCALE = 12288
/** One frame of 24-a-second material in ticks of that scale, as the H.264 fixture states it. */
const FRAME_TICKS = 512

const usOf = (ticks: number): number => Math.round((ticks * 1_000_000) / TIMESCALE)

/** The microseconds one frame lasts. Not a whole number of them, which is the point. */
const FRAME_US = usOf(FRAME_TICKS)

const bytesFor = (at: Located): Uint8Array => Uint8Array.of(at.at % 251, at.length % 251)

/**
 * A plan of `count` frames at a constant rate, with `headTicks` of it standing before the entry.
 *
 * `keep` is worked out here in ticks — `pts >= headTicks` — and `decodedFrames` works the same
 * boundary out in microseconds off the decoded frame's own timestamp. Two computations of one
 * line, which is what makes "as many frames as the plan keeps" an equality worth asserting rather
 * than a restatement.
 */
function planOf(count: number, over: { headTicks?: number; crop?: Crop | null } = {}): FramePlan {
  const headTicks = over.headTicks ?? 0
  const crop = over.crop ?? null

  const frames: FrameToKeep[] = Array.from({ length: count }, (_, at) => {
    const pts = at * FRAME_TICKS
    return {
      source: { at: 1000 + at * 64, length: 16 + at },
      pts,
      duration: FRAME_TICKS,
      sync: at % 12 === 0,
      keep: pts >= headTicks,
    }
  })

  return {
    frames,
    kept: frames.filter((frame) => frame.keep).length,
    headTicks,
    headUs: usOf(headTicks),
    timescale: TIMESCALE,
    crop,
    decoder: { codec: 'avc1.4d400d', description: Uint8Array.of(1, 100, 3) },
    sourceFormat: 'avc1',
    geometry: { width: crop?.width ?? 320, height: crop?.height ?? 240, framerate: 24 },
    audio: null,
    duration: (count * FRAME_TICKS) / TIMESCALE,
  }
}

/** A decoded frame, as far as this file is concerned: a timestamp and a close that can be counted. */
interface FakeFrame {
  timestamp: number
  duration: number | null
  /** Which side of the crop it came from. */
  from: 'decoded' | 'cut' | 'cpu'
  closed: number
  close(): void
}

/**
 * When the fake decoder lets go of the frames it owes.
 *
 * A real one owes several at a time and hands them over in bursts; the loop's bound is about
 * exactly that, so the fakes below owe frames too rather than answering on the spot.
 */
type Emission = 'on-flush' | 'drip' | 'burst'

function frameOf(timestamp: number, from: 'decoded' | 'cut' | 'cpu'): FakeFrame {
  const frame: FakeFrame = {
    timestamp,
    duration: FRAME_US,
    from,
    closed: 0,
    close: () => {
      frame.closed += 1
    },
  }
  return frame
}

interface Fakes {
  codecs: Codecs
  configs: VideoDecoderConfig[]
  chunks: EncodedVideoChunkInit[]
  /** Frames the decoder handed out, in the order it handed them out. */
  decoded: FakeFrame[]
  cuts: Array<{ frame: FakeFrame; crop: Crop }>
  /** What `cut` gave back, in order. */
  cutOut: FakeFrame[]
  /** CPU-backed copies made for an encoder retry. */
  normalized: FakeFrame[]
  normalizedFrom: FakeFrame[]
  /** Every frame either side of the crop ever made — what "closed" is counted over. */
  produced: FakeFrame[]
  decoderClosed: number
  /** The deepest the decoder was ever in debt: chunks handed over that had not come back. */
  maxQueued: number
  openNow(): number
}

function fakeCodecs(
  options: {
    emit?: Emission
    order?: number[]
    scramble?: boolean
    failAfter?: number
    hangOnFlush?: boolean
    normalizeReject?: boolean
  } = {},
): Fakes {
  const emit = options.emit ?? 'on-flush'

  const fakes: Fakes = {
    codecs: null as unknown as Codecs,
    configs: [],
    chunks: [],
    decoded: [],
    cuts: [],
    cutOut: [],
    normalized: [],
    normalizedFrom: [],
    produced: [],
    decoderClosed: 0,
    maxQueued: 0,
    openNow: () => fakes.produced.filter((frame) => frame.closed === 0).length,
  }

  const made = (timestamp: number, from: 'decoded' | 'cut' | 'cpu'): FakeFrame => {
    const frame = frameOf(timestamp, from)
    fakes.produced.push(frame)
    return frame
  }

  let decodes = 0

  fakes.codecs = {
    decoder(config, on) {
      fakes.configs.push(config)
      /** Timestamps handed over that have not come back as frames. */
      const owed: number[] = []
      let broken = false

      const emitOne = (): void => {
        const frame = made(owed.shift()!, 'decoded')
        fakes.decoded.push(frame)
        on.frame(frame as unknown as VideoFrame)
      }

      /** A decoder that hands back what it owes newest first: an order, and not the one it was fed. */
      const scrambled = (): void => {
        if (options.scramble) owed.reverse()
      }

      return {
        decode(chunk) {
          decodes += 1
          if (decodes === options.failAfter) {
            broken = true
            const error = new Error('Encoding error.')
            error.name = 'EncodingError'
            on.error(error)
            return
          }
          owed.push(chunk.timestamp)
          // After the hand-over, which is where the bound is stated: the loop is supposed to look
          // before it hands one over, so this is the number that may not pass the limit.
          fakes.maxQueued = Math.max(fakes.maxQueued, owed.length)
        },
        async flush() {
          // A decoder that died and never finished its flush. The wait this stands for is the
          // whole of the difference between "throws" and "hangs", and only one line of the loop
          // is in a position to tell them apart.
          if (broken && options.hangOnFlush) await new Promise<void>(() => {})
          if (broken) return
          if (options.order) {
            const taken = options.order.map((at) => owed[at]!)
            owed.length = 0
            owed.push(...taken)
          }
          scrambled()
          while (owed.length) emitOne()
        },
        close() {
          fakes.decoderClosed += 1
        },
        get queued() {
          return owed.length
        },
        async drainTo(limit) {
          if (broken) return
          if (emit === 'burst') {
            scrambled()
            while (owed.length) emitOne()
            return
          }
          if (emit === 'drip') {
            scrambled()
            while (owed.length > limit) emitOne()
            return
          }
          // Nothing to give until the flush. A loop that got here with this fake would wait for a
          // frame that is not coming, so say so instead of hanging.
          throw new Error('this fake holds every frame until flush, and the loop asked for one')
        },
      }
    },

    encoder() {
      throw new Error('the frame stream has no business building an encoder')
    },

    chunk(init) {
      fakes.chunks.push(init)
      return init as unknown as EncodedVideoChunk
    },

    async normalize(frame) {
      fakes.normalizedFrom.push(frame as unknown as FakeFrame)
      if (options.normalizeReject) throw new Error('CPU frame copy failed.')
      const out = made(frame.timestamp, 'cpu')
      fakes.normalized.push(out)
      return out as unknown as VideoFrame
    },

    cut(frame, crop) {
      const from = frame as unknown as FakeFrame
      fakes.cuts.push({ frame: from, crop })
      const out = made(from.timestamp, 'cut')
      fakes.cutOut.push(out)
      return out as unknown as VideoFrame
    },
  }

  return fakes
}

function sourceOf(over: Partial<FrameSource> = {}): FrameSource & { reads: Located[] } {
  const reads: Located[] = []
  return {
    reads,
    read: async (at) => {
      reads.push(at)
      return bytesFor(at)
    },
    stale: () => false,
    ...over,
  }
}

/** Walk the stream to the end, closing nothing, and hand back what came out. */
async function collect(
  plan: FramePlan,
  source: FrameSource,
  codecs: Codecs,
  each?: (frame: FakeFrame) => void,
  normalize = false,
): Promise<FakeFrame[]> {
  const out: FakeFrame[] = []
  for await (const frame of decodedFrames(plan, source, codecs, normalize)) {
    const fake = frame as unknown as FakeFrame
    out.push(fake)
    each?.(fake)
  }
  return out
}

describe('decodedFrames: what comes out, and in what order', () => {
  it('hands frames on in the order the decoder gave them, and only those the plan keeps', async () => {
    // Decoded in one order and composed in another — a decoder emits in presentation order, and
    // on material with B-frames that is not the order it was fed. The permutation is the whole
    // reason this case exists: sorting the output by anything at all would pass on flat material.
    const plan = planOf(6, { headTicks: 2 * FRAME_TICKS })
    const fakes = fakeCodecs({ order: [0, 2, 1, 3, 5, 4] })
    const source = sourceOf()

    // The premises: there is a head to hide, and the fixture keeps some frames and not others.
    expect(plan.kept).toBe(4)
    expect(plan.kept).toBeLessThan(plan.frames.length)
    expect(plan.headUs).toBeGreaterThan(0)

    const out = await collect(plan, source, fakes.codecs)

    // Software, and asked for by name. Hardware decoding of this very work measured 16.1 s
    // against 9.1 for software, because a frame decoded on the GPU has to be read back over the
    // bus before an encoder can have it.
    expect(fakes.configs).toEqual([
      { ...plan.decoder, hardwareAcceleration: 'prefer-software' },
    ])

    // Every sample of the plan is decoded, head and all, in the order the plan states them: the
    // frames before the entry point are what the ones after them are predicted from.
    expect(fakes.chunks).toEqual(
      plan.frames.map((frame) => ({
        type: frame.sync ? 'key' : 'delta',
        timestamp: usOf(frame.pts),
        duration: FRAME_US,
        data: bytesFor(frame.source),
      })),
    )
    expect(source.reads).toEqual(plan.frames.map((frame) => frame.source))

    expect(out).toHaveLength(plan.kept)
    // Emission order, which is neither the order they went in nor sorted by time.
    expect(out.map((frame) => frame.timestamp)).toEqual([
      usOf(2 * FRAME_TICKS),
      usOf(3 * FRAME_TICKS),
      usOf(5 * FRAME_TICKS),
      usOf(4 * FRAME_TICKS),
    ])
    expect(out.map((frame) => frame.timestamp)).not.toEqual(
      out
        .map((frame) => frame.timestamp)
        .slice()
        .sort((a, b) => a - b),
    )

    // And the same again through the other door. Everything above came out of the flush at the
    // end; frames that arrive in the middle of a walk leave by a different line of the loop, and
    // it has to keep the order just as much. This decoder hands back what it owes newest first.
    const long = planOf(20, { headTicks: 2 * FRAME_TICKS })
    const bursty = fakeCodecs({ emit: 'burst', scramble: true })
    const walked = await collect(long, sourceOf(), bursty.codecs)
    const gave = bursty.decoded.filter((frame) => frame.timestamp >= long.headUs)

    // The premise: what that decoder handed back really was out of order, so "in the order it
    // was given" is a claim about something.
    expect(gave.map((frame) => frame.timestamp)).not.toEqual(
      gave
        .map((frame) => frame.timestamp)
        .slice()
        .sort((a, b) => a - b),
    )
    expect(walked).toEqual(gave)
  })

  it('closes the frames before the entry point and lets none of them out', async () => {
    const plan = planOf(6, { headTicks: 2 * FRAME_TICKS })
    const fakes = fakeCodecs()

    const out = await collect(plan, sourceOf(), fakes.codecs)

    const dropped = fakes.decoded.filter((frame) => frame.timestamp < plan.headUs)
    // The premise: the decoder really did hand over frames from before the entry point. With a
    // head of nothing every assertion below is about an empty list.
    expect(dropped).toHaveLength(2)
    expect(fakes.decoded).toHaveLength(plan.frames.length)

    for (const frame of dropped) expect(frame.closed).toBe(1)
    expect(out).not.toContain(dropped[0])
    expect(out).not.toContain(dropped[1])
    expect(out.every((frame) => frame.timestamp >= plan.headUs)).toBe(true)
    // And the ones that did come out are still open: the consumer owns them and closes them.
    for (const frame of out) expect(frame.closed).toBe(0)
  })
})

describe('decodedFrames: the crop', () => {
  it('copies the cropped visible picture into CPU storage only when a retry asks for it', async () => {
    const crop: Crop = { x: 48, y: 28, width: 160, height: 90 }
    const plan = planOf(4, { crop })
    const fakes = fakeCodecs()

    const out = await collect(plan, sourceOf(), fakes.codecs, undefined, true)

    expect(fakes.cuts).toHaveLength(plan.kept)
    expect(fakes.normalizedFrom).toEqual(fakes.cutOut)
    expect(out).toEqual(fakes.normalized)
    expect(out.every((frame) => frame.from === 'cpu')).toBe(true)
    for (const frame of fakes.cutOut) expect(frame.closed).toBe(1)
    for (const frame of out) expect(frame.closed).toBe(0)
  })

  it('cuts every frame it hands on, and closes the frame it cut from', async () => {
    const crop: Crop = { x: 48, y: 28, width: 160, height: 90 }
    const plan = planOf(6, { headTicks: 2 * FRAME_TICKS, crop })
    const fakes = fakeCodecs()

    const out = await collect(plan, sourceOf(), fakes.codecs)

    // Cut once per frame handed on, and not once per frame decoded: the head is thrown away
    // before the knife, not after.
    expect(fakes.cuts).toHaveLength(plan.kept)
    expect(fakes.cuts.map((call) => call.crop)).toEqual(Array(plan.kept).fill(crop))
    expect(out).toEqual(fakes.cutOut)
    expect(out.every((frame) => frame.from === 'cut')).toBe(true)

    // Every frame the decoder made is closed exactly once — the two of the head by the callback,
    // the four that were cut from by the cut itself — and the four that came out are not: those
    // belong to whoever asked for them.
    expect(fakes.decoded).toHaveLength(plan.frames.length)
    for (const frame of fakes.decoded) expect(frame.closed).toBe(1)
    for (const frame of out) expect(frame.closed).toBe(0)
  })

  it('hands the frame itself on where there is no rectangle to cut', async () => {
    const plan = planOf(6, { headTicks: 2 * FRAME_TICKS })
    const fakes = fakeCodecs()

    // The premise: the same material with a crop does go through the knife, so an empty list
    // below is a decision and not a fake that cannot cut.
    expect(plan.crop).toBeNull()
    const cropped = fakeCodecs()
    await collect(planOf(6, { headTicks: 2 * FRAME_TICKS, crop: { x: 0, y: 0, width: 2, height: 2 } }), sourceOf(), cropped.codecs)
    expect(cropped.cuts.length).toBeGreaterThan(0)

    const out = await collect(plan, sourceOf(), fakes.codecs)

    expect(fakes.cuts).toEqual([])
    expect(out).toEqual(fakes.decoded.filter((frame) => frame.timestamp >= plan.headUs))
    expect(out.every((frame) => frame.from === 'decoded')).toBe(true)
  })
})

describe('liveCodecs: CPU frame normalization', () => {
  it('copies only the visible picture to an RGBA buffer with the frame clock intact', async () => {
    const rect = { x: 48, y: 28, width: 160, height: 90 }
    const options: VideoFrameCopyToOptions[] = []
    const layout = [{ offset: 0, stride: rect.width * 4 }]
    const made: Array<{ bytes: Uint8Array; init: VideoFrameBufferInit }> = []
    class FakeVideoFrame {
      constructor(bytes: Uint8Array, init: VideoFrameBufferInit) {
        made.push({ bytes, init })
      }
    }
    vi.stubGlobal('VideoFrame', FakeVideoFrame)

    try {
      const source = {
        visibleRect: rect,
        timestamp: 7_654_321,
        duration: 41_667,
        allocationSize(one: VideoFrameCopyToOptions) {
          options.push(one)
          return rect.width * rect.height * 4
        },
        async copyTo(bytes: Uint8Array, one: VideoFrameCopyToOptions) {
          options.push(one)
          bytes[0] = 0x7b
          return layout
        },
      } as unknown as VideoFrame

      await liveCodecs().normalize(source)

      expect(options).toEqual([
        { format: 'RGBA', rect },
        { format: 'RGBA', rect },
      ])
      expect(made).toHaveLength(1)
      expect(made[0]!.bytes).toHaveLength(160 * 90 * 4)
      expect(made[0]!.bytes[0]).toBe(0x7b)
      expect(made[0]!.init).toEqual({
        format: 'RGBA',
        codedWidth: 160,
        codedHeight: 90,
        layout,
        timestamp: 7_654_321,
        duration: 41_667,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reads an opaque decoded frame through a canvas before constructing the CPU frame', async () => {
    const rect = { x: 48, y: 28, width: 160, height: 90 }
    const pixels = {
      width: rect.width,
      height: rect.height,
      data: new Uint8ClampedArray(rect.width * rect.height * 4),
    }
    const draws: unknown[][] = []
    const made: Array<{ source: unknown; init: VideoFrameInit }> = []

    class FakeOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}

      getContext() {
        return {
          drawImage: (...args: unknown[]) => draws.push(args),
          getImageData: () => pixels,
        }
      }
    }
    class FakeVideoFrame {
      constructor(source: unknown, init: VideoFrameInit) {
        made.push({ source, init })
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    vi.stubGlobal('VideoFrame', FakeVideoFrame)

    const source = {
      format: null,
      visibleRect: rect,
      timestamp: 7_654_321,
      duration: 41_667,
      allocationSize() {
        throw new DOMException('Operation is not supported when format is null.', 'NotSupportedError')
      },
    } as unknown as VideoFrame

    try {
      await liveCodecs().normalize(source)

      expect(draws).toEqual([[source, 0, 0, rect.width, rect.height]])
      expect(made).toEqual([{
        source: pixels.data,
        init: {
          format: 'RGBA',
          codedWidth: 160,
          codedHeight: 90,
          timestamp: 7_654_321,
          duration: 41_667,
        },
      }])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('decodedFrames: normalization failure', () => {
  it('closes the rejected frame and every decoded frame waiting behind it', async () => {
    const plan = planOf(4)
    const fakes = fakeCodecs({ normalizeReject: true })

    await expect(
      collect(plan, sourceOf(), fakes.codecs, undefined, true),
    ).rejects.toThrow('CPU frame copy failed.')

    expect(fakes.normalizedFrom).toHaveLength(1)
    expect(fakes.decoderClosed).toBe(1)
    for (const frame of fakes.decoded) expect(frame.closed).toBe(1)
    expect(fakes.openNow()).toBe(0)
  })
})

describe('decodedFrames: the bound', () => {
  it('never lets the decoder owe more frames than the bound, however it hands them back', async () => {
    const plan = planOf(20)
    // The premise: there is more work here than the bound, so the bound is reached rather than
    // merely not exceeded.
    expect(plan.frames.length).toBeGreaterThan(MAX_FRAMES_IN_FLIGHT)

    for (const emit of ['drip', 'burst'] as const) {
      const fakes = fakeCodecs({ emit })
      const out = await collect(plan, sourceOf(), fakes.codecs)

      // Exactly the bound, not merely under it: the loop looks before it hands a chunk over, so
      // the debt reaches the limit and stops there. One off in either direction is a different
      // number.
      expect(fakes.maxQueued, `owed too many with a ${emit} decoder`).toBe(MAX_FRAMES_IN_FLIGHT)
      // And nothing was lost to the waiting.
      expect(out).toHaveLength(plan.kept)
    }
  })

  it('never holds more frames than the bound at once', async () => {
    const plan = planOf(20)
    // A decoder that hands over everything it owes the moment it is asked — the shape that fills
    // the queue this loop drains into, all at once.
    const fakes = fakeCodecs({ emit: 'burst' })

    let open = 0
    const out = await collect(plan, sourceOf(), fakes.codecs, (frame) => {
      // Counted before the consumer lets go of the one it was given: the frame in hand is held
      // as much as the ones still waiting.
      open = Math.max(open, fakes.openNow())
      frame.close()
    })

    expect(out).toHaveLength(plan.kept)
    expect(open).toBe(MAX_FRAMES_IN_FLIGHT)
    for (const frame of fakes.produced) expect(frame.closed).toBe(1)
  })
})

describe('decodedFrames: when it ends early', () => {
  it('closes the decoder and every frame still in hand when the walk is broken off', async () => {
    const plan = planOf(20)
    const fakes = fakeCodecs({ emit: 'burst' })
    let openAtBreak = 0

    let seen = 0
    for await (const frame of decodedFrames(plan, sourceOf(), fakes.codecs)) {
      seen += 1
      if (seen === 3) {
        openAtBreak = fakes.openNow()
        // The consumer owns the frame it was handed, and closes it. Everything else is the
        // stream's to let go of.
        ;(frame as unknown as FakeFrame).close()
        break
      }
      ;(frame as unknown as FakeFrame).close()
    }

    // The premise: there really were frames waiting behind the one we walked out on. Break after
    // the last frame and the `finally` would have nothing to do.
    expect(openAtBreak).toBeGreaterThan(1)
    expect(seen).toBe(3)
    expect(fakes.decoderClosed).toBe(1)
    for (const frame of fakes.produced) expect(frame.closed).toBe(1)
  })

  it('hands a decoder failure to the consumer as a throw, not as a wait', { timeout: 2000 }, async () => {
    const plan = planOf(12)
    // Broken on the tenth chunk, by which time it has already handed some frames over, and never
    // finishing the flush it was asked for afterwards — which is what a decoder that died looks
    // like from here. A loop that only looked at the failure after the flush would wait for ever,
    // and the timeout on this case is what says so.
    const fakes = fakeCodecs({ emit: 'drip', failAfter: 10, hangOnFlush: true })
    const seen: FakeFrame[] = []

    await expect(
      collect(plan, sourceOf(), fakes.codecs, (frame) => {
        seen.push(frame)
        frame.close()
      }),
    ).rejects.toThrow(
      'Decoding avc1.4d400d failed (EncodingError): Encoding error.',
    )

    // The premise: frames were flowing when it broke.
    expect(seen.length).toBeGreaterThan(0)
    expect(fakes.decoderClosed).toBe(1)
    // Nothing was left open by the failure — the ones handed out were closed by the consumer,
    // the ones still waiting by the stream.
    for (const frame of fakes.produced) expect(frame.closed).toBe(1)

    // And the other end of it: broken on the first chunk, with not a frame ever handed over, so
    // nothing in the walk itself is in a position to notice. This one is only ever seen after the
    // flush, and it is a throw too — a job that quietly produced no frames would be written out
    // as an empty file.
    const dead = fakeCodecs({ emit: 'drip', failAfter: 1 })
    await expect(collect(plan, sourceOf(), dead.codecs)).rejects.toThrow(
      'Decoding avc1.4d400d failed (EncodingError): Encoding error.',
    )
    expect(dead.decoded).toEqual([])
    expect(dead.decoderClosed).toBe(1)
  })

  it('stops reading the material the moment the job is called off', async () => {
    const plan = planOf(20)
    const fakes = fakeCodecs({ emit: 'burst' })
    let called = false
    const source = sourceOf({ stale: () => called })

    const out: FakeFrame[] = []
    for await (const frame of decodedFrames(plan, source, fakes.codecs)) {
      out.push(frame as unknown as FakeFrame)
      ;(frame as unknown as FakeFrame).close()
      // Called off in the middle, the way the queue calls a job off: the flag flips and nothing
      // else happens.
      if (out.length === 2) called = true
    }

    // The premise: there was work left to walk away from.
    expect(out.length).toBeLessThan(plan.kept)
    const read = source.reads.length
    expect(read).toBeLessThan(plan.frames.length)
    // Nothing more was asked of the snapshot after the flag flipped — the loop stops at the
    // sample, not at the end of the plan.
    expect(source.reads).toEqual(plan.frames.slice(0, read).map((frame) => frame.source))
    expect(fakes.decoderClosed).toBe(1)
    for (const frame of fakes.produced) expect(frame.closed).toBe(1)
  })
})

describe('decodedFrames: what paces it', () => {
  it('has no timer in it: the pace is the queue and the yield is a message', () => {
    const source = readFileSync('src/editor/export/frames.ts', 'utf8')
    // Comments off first — they say the word `setTimeout` while explaining why there is none,
    // and a check that could not survive its own explanation would be a check on prose.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    // The premise: what is left is the module and not an empty string.
    expect(code).toContain('export async function* decodedFrames')
    expect(code).toContain('MessageChannel')

    // A nested `setTimeout` is floored at 4 ms by Chrome, which caps any loop built on one at
    // about 140 frames a second whatever the codecs are doing. That ceiling has already been
    // mistaken once in this project for a property of a codec.
    expect(code).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/)
  })
})
