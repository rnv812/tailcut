import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseClusters, parseFragment } from '../../src/core/webm/fragment'
import { parseInit } from '../../src/core/webm/init'
import { ID } from '../../src/core/webm/reader'

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(`tests/fixtures/webm/${name}`))

const init = load('init-stream1.webm')
const audio1 = load('chunk-stream1-00001.webm')
const audio2 = load('chunk-stream1-00002.webm')
const audio3 = load('chunk-stream1-00003.webm')
const audio4 = load('chunk-stream1-00004.webm')
const video1 = load('chunk-stream0-00001.webm')
const video2 = load('chunk-stream0-00002.webm')

describe('parseFragment', () => {
  it('reads where the first Opus segment starts and how long it lasts', () => {
    // The fixture is fixed: 99 Opus frames of 20 ms, the cluster starting at zero.
    expect(parseFragment(audio1)).toEqual({
      trackId: 2,
      baseMediaDecodeTime: 0,
      duration: 1981,
    })
  })

  it('each segment starts where the one before it ended', () => {
    // Nothing in the container states the length of a fragment: it is worked out from the frames.
    // A reading that is off by a frame shows up here as a gap or an overlap between segments.
    const chain = [audio1, audio2, audio3, audio4].map((s) => parseFragment(s)!)
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.baseMediaDecodeTime)
        .toBe(chain[i - 1]!.baseMediaDecodeTime + chain[i - 1]!.duration)
    }
    expect(chain.map((f) => f.baseMediaDecodeTime)).toEqual([0, 1981, 3981, 5981])
  })

  it('does the same for the video track, whose frames are five times longer', () => {
    const first = parseFragment(video1)!
    const second = parseFragment(video2)!
    expect(first).toEqual({ trackId: 1, baseMediaDecodeTime: 14, duration: 2000 })
    expect(second.baseMediaDecodeTime).toBe(first.baseMediaDecodeTime + first.duration)
  })

  it('the length in seconds is the length of the segment', () => {
    const timescale = parseInit(init)!.tracks[0]!.timescale
    expect(timescale).toBe(1000)
    expect(parseFragment(audio2)!.duration / timescale).toBe(2)
  })

  it('gives a segment holding one frame a length of zero', () => {
    // The tail of the recording: a single Opus frame with no neighbour to measure the step
    // against and no stated duration. Understated on purpose — see the note on parseFragment.
    expect(parseClusters(audio4)[0]!.frames).toHaveLength(1)
    expect(parseFragment(audio4)).toEqual({ trackId: 2, baseMediaDecodeTime: 5981, duration: 0 })
  })

  it('returns null for an init segment', () => {
    expect(parseFragment(init)).toBeNull()
  })

  it('returns null for a fragmented mp4 media segment', () => {
    expect(parseFragment(new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))))
      .toBeNull()
  })

  it('returns null for bytes that are not media at all', () => {
    const html = '<!DOCTYPE html><html><body>not a video</body></html>'
    expect(parseFragment(Uint8Array.from(html, (c) => c.charCodeAt(0)))).toBeNull()
    expect(parseFragment(new Uint8Array(0))).toBeNull()
    expect(parseFragment(new Uint8Array(512))).toBeNull()
  })

  it('survives the media segment cut off at any length', () => {
    for (let length = 0; length <= audio1.byteLength; length++) {
      const fragment = parseFragment(audio1.subarray(0, length))
      if (fragment) expect(fragment.trackId).toBe(2)
    }
  })
})

describe('parseClusters on the fixtures', () => {
  it('reads one cluster of many blocks and places every frame absolutely', () => {
    const clusters = parseClusters(audio1)
    expect(clusters).toHaveLength(1)

    const cluster = clusters[0]!
    expect(cluster.timestamp).toBe(0)
    expect(cluster.frames).toHaveLength(99)

    // Opus frames are 20 ms apart and every one of them stands on its own.
    expect(cluster.frames.map((f) => f.timestamp).slice(0, 4)).toEqual([0, 21, 41, 61])
    expect(cluster.frames.every((f) => f.keyframe)).toBe(true)
    expect(cluster.frames.every((f) => f.trackNumber === 2)).toBe(true)
    expect(cluster.frames.every((f) => f.data.byteLength > 0)).toBe(true)

    // No block here states a duration, and none is invented for it.
    expect(cluster.frames.every((f) => f.duration === 0)).toBe(true)
  })

  it('marks the one key frame of a video cluster', () => {
    const cluster = parseClusters(video1)[0]!
    expect(cluster.timestamp).toBe(14)
    expect(cluster.frames).toHaveLength(20)
    expect(cluster.frames.filter((f) => f.keyframe)).toHaveLength(1)
    expect(cluster.frames[0]!.keyframe).toBe(true)
    // the key frame is also the fat one: an intra frame against nineteen static ones
    expect(cluster.frames[0]!.data.byteLength).toBeGreaterThan(cluster.frames[1]!.data.byteLength * 5)
  })

  it('gives no clusters for an init segment', () => {
    expect(parseClusters(init)).toEqual([])
  })
})

// --- Synthetic media segments, for the shapes the fixtures do not contain ---

function id(value: number): number[] {
  const out: number[] = []
  let rest = value
  while (rest > 0) {
    out.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  }
  return out.length ? out : [0]
}

function size(value: number): number[] {
  let length = 1
  while (value > 2 ** (7 * length) - 2) length++

  const out: number[] = []
  let rest = value
  for (let i = 0; i < length; i++) {
    out.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  }
  out[0]! |= 0x80 >> (length - 1)
  return out
}

/** An element around a body given as one array — the form that survives a body of many thousands. */
const wrap = (elementId: number, body: number[]): number[] =>
  [...id(elementId), ...size(body.length), ...body]

const element = (elementId: number, ...body: number[]): number[] => wrap(elementId, body)

const openElement = (elementId: number, ...body: number[]): number[] =>
  [...id(elementId), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...body]

function uint(elementId: number, value: number): number[] {
  const bytes: number[] = []
  let rest = value
  do {
    bytes.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  } while (rest > 0)
  return element(elementId, ...bytes)
}

/** A track number as a one-byte variable-length integer, the way a block writes it. */
const trackVint = (track: number): number[] => [0x80 | track]

/** The signed sixteen-bit offset from the cluster's timestamp. */
function offset16(value: number): number[] {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setInt16(0, value)
  return [...out]
}

const LACING_XIPH = 1
const LACING_FIXED = 2
const LACING_EBML = 3

interface BlockSpec {
  track?: number
  offset?: number
  keyframe?: boolean
  lacing?: number
  payload: number[]
}

function blockBody(spec: BlockSpec, keyframeBit: boolean): number[] {
  const flags = (keyframeBit && spec.keyframe !== false ? 0x80 : 0) | ((spec.lacing ?? 0) << 1)
  return [...trackVint(spec.track ?? 1), ...offset16(spec.offset ?? 0), flags, ...spec.payload]
}

const simpleBlock = (spec: BlockSpec): number[] =>
  element(ID.simpleBlock, ...blockBody(spec, true))

/** A BlockGroup: a Block, and whatever the group states about it. */
function blockGroup(spec: BlockSpec & { duration?: number; reference?: number }): number[] {
  const body: number[] = [...element(ID.block, ...blockBody(spec, false))]
  if (spec.duration !== undefined) body.push(...uint(ID.blockDuration, spec.duration))
  if (spec.reference !== undefined) body.push(...element(ID.referenceBlock, spec.reference & 0xff))
  return element(ID.blockGroup, ...body)
}

const clusterOf = (timestamp: number, children: number[][]): number[] =>
  wrap(ID.cluster, [...uint(ID.timestamp, timestamp), ...children.flat()])

const cluster = (timestamp: number, ...children: number[][]): number[] =>
  clusterOf(timestamp, children)

const segment = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat())

const PARSE_BUDGET_MS = 1000

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now()
  const value = fn()
  return { value, ms: performance.now() - start }
}

describe('parseClusters on synthetic segments', () => {
  it('reads several blocks of one cluster', () => {
    const bytes = segment(cluster(
      1000,
      simpleBlock({ offset: 0, payload: [1] }),
      simpleBlock({ offset: 20, keyframe: false, payload: [2, 2] }),
      simpleBlock({ offset: 40, keyframe: false, payload: [3, 3, 3] }),
    ))

    const frames = parseClusters(bytes)[0]!.frames
    expect(frames.map((f) => f.timestamp)).toEqual([1000, 1020, 1040])
    expect(frames.map((f) => f.keyframe)).toEqual([true, false, false])
    expect(frames.map((f) => [...f.data])).toEqual([[1], [2, 2], [3, 3, 3]])
  })

  it('reads a block presented before its own cluster', () => {
    // The offset is signed: the first cluster of a stream with B-frames does exactly this.
    const bytes = segment(cluster(100, simpleBlock({ offset: -30, payload: [1] })))
    expect(parseClusters(bytes)[0]!.frames[0]!.timestamp).toBe(70)
  })

  it('reads several clusters of one segment', () => {
    const bytes = segment(
      cluster(0, simpleBlock({ payload: [1] }), simpleBlock({ offset: 40, payload: [2] })),
      cluster(80, simpleBlock({ payload: [3] })),
    )

    const clusters = parseClusters(bytes)
    expect(clusters.map((c) => c.timestamp)).toEqual([0, 80])
    expect(clusters.flatMap((c) => c.frames).map((f) => f.timestamp)).toEqual([0, 40, 80])
    expect(parseFragment(bytes)).toEqual({ trackId: 1, baseMediaDecodeTime: 0, duration: 120 })
  })

  it('reads clusters wrapped in a Segment as well as bare ones', () => {
    const bare = segment(cluster(0, simpleBlock({ payload: [1] })))
    const wrapped = segment(openElement(ID.segment, ...cluster(0, simpleBlock({ payload: [1] }))))

    expect(parseClusters(wrapped)).toEqual(parseClusters(bare))
    expect(parseFragment(wrapped)).toEqual(parseFragment(bare))
  })

  it('skips a cluster that states no timestamp of its own', () => {
    // Its blocks carry an offset and nothing to offset from. Reading them as if the cluster began
    // at zero would drop them onto the start of the recording.
    const bytes = segment(
      element(ID.cluster, ...simpleBlock({ payload: [1] })),
      cluster(500, simpleBlock({ payload: [2] })),
    )

    const clusters = parseClusters(bytes)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.timestamp).toBe(500)
  })
})

describe('BlockGroup', () => {
  it('takes the duration the group states', () => {
    const bytes = segment(cluster(0, blockGroup({ offset: 0, duration: 40, payload: [1] })))
    const frame = parseClusters(bytes)[0]!.frames[0]!
    expect(frame.duration).toBe(40)
    // and a single frame that states its own length is not understated the way a bare block is
    expect(parseFragment(bytes)).toEqual({ trackId: 1, baseMediaDecodeTime: 0, duration: 40 })
  })

  it('calls a block a key frame when the group names nothing it was predicted from', () => {
    // A Block has no key frame bit of its own; the absence of a ReferenceBlock is what says so.
    const keyed = segment(cluster(0, blockGroup({ payload: [1] })))
    const predicted = segment(cluster(0, blockGroup({ payload: [1], reference: -40 })))

    expect(parseClusters(keyed)[0]!.frames[0]!.keyframe).toBe(true)
    expect(parseClusters(predicted)[0]!.frames[0]!.keyframe).toBe(false)
  })

  it('skips a group with no Block in it', () => {
    const bytes = segment(cluster(
      0,
      element(ID.blockGroup, ...uint(ID.blockDuration, 40)),
      simpleBlock({ offset: 40, payload: [2] }),
    ))
    expect(parseClusters(bytes)[0]!.frames.map((f) => f.timestamp)).toEqual([40])
  })

  it('mixes groups and simple blocks in one cluster', () => {
    const bytes = segment(cluster(
      0,
      simpleBlock({ payload: [1] }),
      blockGroup({ offset: 40, duration: 40, reference: -40, payload: [2] }),
    ))
    const frames = parseClusters(bytes)[0]!.frames
    expect(frames.map((f) => f.timestamp)).toEqual([0, 40])
    expect(frames.map((f) => f.keyframe)).toEqual([true, false])
    expect(frames.map((f) => f.duration)).toEqual([0, 40])
  })
})

describe('lacing', () => {
  it('reads a block of one frame when nothing is laced', () => {
    const bytes = segment(cluster(0, simpleBlock({ payload: [1, 2, 3, 4] })))
    expect(parseClusters(bytes)[0]!.frames.map((f) => [...f.data])).toEqual([[1, 2, 3, 4]])
  })

  it('splits a Xiph-laced block', () => {
    // Three frames of 2, 3 and the remaining 4 bytes; the sizes of all but the last are written out.
    const payload = [2, 2, 3, 1, 1, 2, 2, 2, 3, 3, 3, 3]
    const bytes = segment(cluster(0, simpleBlock({ lacing: LACING_XIPH, payload })))

    expect(parseClusters(bytes)[0]!.frames.map((f) => [...f.data])).toEqual([
      [1, 1], [2, 2, 2], [3, 3, 3, 3],
    ])
  })

  it('reads a Xiph size written as a run of 0xff bytes', () => {
    const first = new Array<number>(300).fill(7)
    const payload = [1, 0xff, 45, ...first, 9, 9]
    const bytes = segment(cluster(0, simpleBlock({ lacing: LACING_XIPH, payload })))

    const frames = parseClusters(bytes)[0]!.frames
    expect(frames.map((f) => f.data.byteLength)).toEqual([300, 2])
  })

  it('splits a fixed-lace block into equal parts', () => {
    const payload = [2, 1, 1, 2, 2, 3, 3]
    const bytes = segment(cluster(0, simpleBlock({ lacing: LACING_FIXED, payload })))

    expect(parseClusters(bytes)[0]!.frames.map((f) => [...f.data])).toEqual([[1, 1], [2, 2], [3, 3]])
  })

  it('splits an EBML-laced block, whose sizes are differences', () => {
    // First size 2 outright, then +1 for the second; the third takes what is left.
    const payload = [2, 0x82, 0xc0, 1, 1, 2, 2, 2, 3, 3, 3, 3]
    const bytes = segment(cluster(0, simpleBlock({ lacing: LACING_EBML, payload })))

    expect(parseClusters(bytes)[0]!.frames.map((f) => [...f.data])).toEqual([
      [1, 1], [2, 2, 2], [3, 3, 3, 3],
    ])
  })

  it('spreads the stated duration of a laced block over its frames', () => {
    // The frames of one block share a timestamp in the container. What the group states for the
    // block as a whole is what places them apart from each other.
    const payload = [1, 1, 1, 2, 2]
    const bytes = segment(cluster(100, blockGroup({ lacing: LACING_XIPH, duration: 40, payload })))

    const frames = parseClusters(bytes)[0]!.frames
    expect(frames.map((f) => f.timestamp)).toEqual([100, 120])
    expect(frames.map((f) => f.duration)).toEqual([20, 20])
    expect(frames.map((f) => [...f.data])).toEqual([[1], [2, 2]])
  })

  it('leaves laced frames on the block timestamp when nothing states a duration', () => {
    const payload = [1, 1, 1, 2, 2]
    const bytes = segment(cluster(100, simpleBlock({ lacing: LACING_XIPH, payload })))

    const frames = parseClusters(bytes)[0]!.frames
    expect(frames.map((f) => f.timestamp)).toEqual([100, 100])
    expect(frames.map((f) => f.duration)).toEqual([0, 0])
  })

  it('drops a block whose lacing does not add up', () => {
    // Reading it as one frame would hand several packets on as a single sample.
    const short = segment(cluster(0, simpleBlock({ lacing: LACING_XIPH, payload: [3, 5, 5, 1, 2] })))
    expect(parseClusters(short)[0]!.frames).toEqual([])

    const uneven = segment(cluster(0, simpleBlock({ lacing: LACING_FIXED, payload: [2, 1, 2, 3, 4] })))
    expect(parseClusters(uneven)[0]!.frames).toEqual([])

    const noHeader = segment(cluster(0, simpleBlock({ lacing: LACING_EBML, payload: [] })))
    expect(parseClusters(noHeader)[0]!.frames).toEqual([])
  })

  it('drops one broken block without losing the rest of the cluster', () => {
    const bytes = segment(cluster(
      0,
      simpleBlock({ lacing: LACING_XIPH, payload: [9, 5, 5, 1] }),
      simpleBlock({ offset: 40, payload: [2] }),
    ))
    expect(parseClusters(bytes)[0]!.frames.map((f) => f.timestamp)).toEqual([40])
  })
})

describe('broken blocks', () => {
  it('drops a block whose header is not all there', () => {
    // A block is a track number, two bytes of offset and one of flags before anything else.
    for (const body of [[], [0x81], [0x81, 0x00], [0x81, 0x00, 0x00]]) {
      const bytes = segment(cluster(0, element(ID.simpleBlock, ...body)))
      expect(parseClusters(bytes)[0]!.frames).toEqual([])
      expect(parseFragment(bytes)).toBeNull()
    }
  })

  it('reads a block whose header is all there and whose payload is empty', () => {
    const bytes = segment(cluster(0, element(ID.simpleBlock, 0x81, 0x00, 0x00, 0x80)))
    const frames = parseClusters(bytes)[0]!.frames
    expect(frames).toHaveLength(1)
    expect(frames[0]!.data.byteLength).toBe(0)
  })

  it('takes a block claiming 256 laced frames without hanging', () => {
    const { value, ms } = timed(() => parseClusters(
      segment(cluster(0, simpleBlock({ lacing: LACING_XIPH, payload: [0xff, 1, 2, 3] }))),
    ))
    expect(value[0]!.frames).toEqual([])
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('takes a cluster of unknown size cut off inside a block', () => {
    const whole = segment(openElement(
      ID.cluster,
      ...uint(ID.timestamp, 0),
      ...simpleBlock({ payload: [1, 2, 3, 4] }),
      ...simpleBlock({ offset: 40, payload: [5, 6, 7, 8] }),
    ))

    for (let length = 0; length <= whole.byteLength; length++) {
      const { value, ms } = timed(() => parseClusters(whole.subarray(0, length)))
      expect(value.length).toBeLessThanOrEqual(1)
      expect(ms).toBeLessThan(PARSE_BUDGET_MS)
    }

    // whole again at the end: the truncation sweep is not passing because nothing parses
    expect(parseClusters(whole)[0]!.frames).toHaveLength(2)
  })

  it('takes a cluster of two hundred thousand blocks without hanging', () => {
    // Past the point where a spread argument list gives out: this many frames may not be handed
    // to Array.push or to Math.max at once, and a page is free to send a segment holding them.
    const count = 200_000
    const blocks: number[][] = []
    for (let i = 0; i < count; i++) blocks.push(simpleBlock({ offset: i % 30000, payload: [1] }))
    const bytes = segment(clusterOf(0, blocks))

    const { value, ms } = timed(() => parseFragment(bytes))
    expect(value!.trackId).toBe(1)
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('takes a cluster whose blocks all sit at one timestamp', () => {
    // Every frame is the last frame: whatever is worked out over the frames shown last runs over
    // all of them at once.
    const blocks: number[][] = []
    for (let i = 0; i < 200_000; i++) blocks.push(simpleBlock({ offset: 0, payload: [1] }))
    const bytes = segment(clusterOf(500, blocks))

    const { value, ms } = timed(() => parseFragment(bytes))
    expect(value).toEqual({ trackId: 1, baseMediaDecodeTime: 500, duration: 0 })
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })
})

describe('the extent of a fragment', () => {
  it('measures over presentation times, not over the order blocks are stored in', () => {
    // The B-frame pattern: the block written last is not the frame shown last.
    const bytes = segment(cluster(
      0,
      simpleBlock({ offset: 0, payload: [1] }),
      simpleBlock({ offset: 80, keyframe: false, payload: [2] }),
      simpleBlock({ offset: 40, keyframe: false, payload: [3] }),
    ))

    // sorted by presentation: 0, 40, 80 — so the step at the tail is 40, not -40
    expect(parseFragment(bytes)).toEqual({ trackId: 1, baseMediaDecodeTime: 0, duration: 120 })
  })

  it('takes the track of the first block and passes the rest over in silence', () => {
    // The same rule the mp4 side follows with a muxed moof: one traf is read, the other ignored.
    const bytes = segment(cluster(
      1000,
      simpleBlock({ track: 3, offset: 0, payload: [1] }),
      simpleBlock({ track: 4, offset: 0, payload: [2] }),
      simpleBlock({ track: 3, offset: 20, payload: [3] }),
      simpleBlock({ track: 4, offset: 500, payload: [4] }),
    ))

    expect(parseFragment(bytes)).toEqual({
      trackId: 3,
      baseMediaDecodeTime: 1000,
      duration: 40, // 1020 plus the 20 step, less 1000 — the other track's 500 plays no part
    })
  })

  it('prefers a stated duration to the step between frames', () => {
    const bytes = segment(cluster(
      0,
      blockGroup({ offset: 0, duration: 40, payload: [1] }),
      blockGroup({ offset: 40, duration: 100, payload: [2] }),
    ))
    expect(parseFragment(bytes)!.duration).toBe(140)
  })

  it('measures a fragment of two clusters end to end', () => {
    const bytes = segment(
      cluster(0, simpleBlock({ payload: [1] }), simpleBlock({ offset: 500, payload: [2] })),
      cluster(1000, simpleBlock({ payload: [3] })),
    )
    expect(parseFragment(bytes)).toEqual({
      trackId: 1,
      baseMediaDecodeTime: 0,
      duration: 1500, // the last frame at 1000 plus the 500 step before it
    })
  })
})
