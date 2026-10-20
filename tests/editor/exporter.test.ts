// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  downloadIo,
  encodeIo,
  geometryKey,
  openClipSource,
  planOf,
  requestsFor,
  type PaceReport,
} from '../../src/editor/export/exporter'
import { planSnapshot, type SnapshotSource } from '../../src/core/snapshot/build'
import { SnapshotReader } from '../../src/core/snapshot/read'
import { materialOf } from '../../src/core/snapshot/material'
import { concatBytes } from '../../src/core/iso/writer'
import { topLevelBoxes } from '../../src/core/iso/reader'
import { parseInit } from '../../src/core/iso/init'
import { samplesInMovie } from '../../src/core/iso/movie'
import { videoSampleEntry } from '../../src/core/iso/entry'
import { assembleMp4 } from '../../src/core/export/assemble'
import { clipSourceFrom, movieTracksOf } from '../../src/core/export/source'
import { planClip, type ClipSource } from '../../src/core/export/plan'
import { saveAllMp4 } from '../../src/core/export/save'
import { ENCODED_AS_VP9 } from '../../src/core/export/compatible'
import { exportTrack } from '../support/export-fixture'
import { NO_ENCODER, createRunner } from '../../src/core/export/run'
import { framesOf, laneOf } from '../../src/core/encode/path'
import { geometryOf } from '../../src/core/encode/crop'
import { webpGeometry } from '../../src/core/webp/timing'
import type { Clip } from '../../src/core/edit/clip'
import { EMPTY_CONTEXT, type EditContext } from '../../src/core/edit/context'
import {
  ladderFor,
  vp9Level,
  type EncodeGeometry,
  type EncodingChoice,
} from '../../src/core/encode/codec'
import type { ExportRequest } from '../../src/core/export/run'
import type { Codecs } from '../../src/editor/export/frames'
import { CodecFailure } from '../../src/editor/export/failure'
import type { Surface } from '../../src/editor/export/webp'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/** The movie box of a complete file, where its sample tables live. */
const moovOf = (file: Uint8Array): Uint8Array => {
  const moov = topLevelBoxes(file).find((box) => box.type === 'moov')!
  return file.subarray(moov.start, moov.start + moov.size)
}

/** The captured shape: an init segment and media segments, walked for their moofs. */
const INIT = read('h264/init-stream0.m4s')
const SEGMENTS = [1, 2, 3].map((n) => read(`h264/chunk-stream0-0000${n}.m4s`))

/**
 * The other shape, and the common one: an ordinary complete file the extension never intercepted.
 *
 * Six seconds, sixty frames at 256×144 with sound beside them, and its movie box at the very end.
 * Eighteen of the twenty-one live pages that delivered video at all delivered it like this, so a
 * path that only knows about fragments is a path that cannot export most of the web.
 */
const WHOLE = read('plain/whole.mp4')

/** The listeners of the stubbed `chrome.downloads.onChanged`, shared by every stub below. */
const changeListeners = new Set<(delta: { id: number; state?: { current: string } }) => void>()

/** What Chrome says once a download is on the disk. */
const finished = (id: number): void => {
  setTimeout(() => changeListeners.forEach((listener) => listener({ id, state: { current: 'complete' } })), 0)
}

/** Chrome's downloads, finishing every download a moment after answering with its id. */
function finishingDownloads(asked: Array<Record<string, unknown>>, id = 7) {
  return {
    download: (options: Record<string, unknown>, done: (id: number) => void) => {
      asked.push(options)
      done(id)
      finished(id)
    },
    onChanged: {
      addListener: (listener: (delta: { id: number }) => void) => changeListeners.add(listener),
      removeListener: (listener: (delta: { id: number }) => void) => changeListeners.delete(listener),
    },
    onErased: { addListener: () => undefined, removeListener: () => undefined },
  }
}

/** YouTube's pair in an mp4, and the pair Premiere imports. */
const VP9_FILE = saveAllMp4([exportTrack('webm', 0, 'webm'), exportTrack('webm', 1, 'webm')])
const H264_FILE = WHOLE

/**
 * One buffer carrying both kinds, as a page that muxes its own material sends them.
 *
 * Two traks in the init and two trafs in every segment, and each trak states an edit list of its
 * own. There is no second stream anywhere: the sound of this recording exists only inside the
 * segments the picture arrived in.
 */
const MUXED_INIT = read('muxed-edits/init-stream0.m4s')
const MUXED_SEGMENTS = [1, 2, 3].map((n) => read(`muxed-edits/chunk-stream0-0000${n}.m4s`))

const page = {
  sessionKey: 'https://site.example/watch|avc1|inf',
  url: 'https://site.example/watch?v=abc',
  title: 'Clip — site.example',
  createdAt: 1_756_022_100_000,
  lastSeenAt: 1_756_022_399_000,
  refusedTracks: false,
}

async function snapshotFrom(source: SnapshotSource): Promise<SnapshotReader> {
  const plan = planSnapshot(source, { id: 'x', capturedAt: 1_756_022_400_000, producer: 'test' })
  const file = concatBytes(plan.parts)
  const reader = await SnapshotReader.open(
    async (at, length) => file.subarray(at, at + length),
    file.byteLength,
  )
  return reader!
}

const capturedTrack = {
  id: 't0',
  bufferId: 'sb-1',
  representation: 'video:avc1.4d401e:320x240',
  kinds: ['video' as const],
  info: {
    tracks: [
      {
        trackId: 1,
        kind: 'video' as const,
        timescale: 12_288,
        codec: 'avc1.4d401e',
        width: 320,
        height: 240,
      },
    ],
  },
  initBytes: INIT,
}

/** A snapshot of segments, laid out at the seconds they were watched at. */
const capturedSnapshot = (): Promise<SnapshotReader> =>
  snapshotFrom({
    page,
    tracks: [
      {
        ...capturedTrack,
        chunks: SEGMENTS.map((bytes, at) => ({ start: at * 2, end: at * 2 + 2, bytes })),
      },
    ],
  })

/**
 * A snapshot of one ordinary file, with its movie box named inside it — and something in front.
 *
 * The something matters. A file laid down first begins at byte zero of the snapshot, and there a
 * table read as if it addressed its own file and a table read as if it addressed the snapshot say
 * exactly the same thing. Two seconds of captured material ahead of it moves the file off zero,
 * and the two readings part company by that many bytes.
 */
const fileSnapshot = (): Promise<SnapshotReader> => {
  const moov = topLevelBoxes(WHOLE).find((box) => box.type === 'moov')!

  return snapshotFrom({
    page,
    tracks: [
      {
        ...capturedTrack,
        // Two seconds against the file's six, so the file is still the richest picture there is
        // and the editor opens on it.
        chunks: [{ start: 0, end: 2, bytes: SEGMENTS[0]! }],
      },
      {
        id: 't1',
        bufferId: 'file',
        representation: 'file:avc1+mp4a',
        kinds: ['video', 'audio'],
        info: parseInit(WHOLE)!,
        initBytes: WHOLE,
        movie: { at: moov.start, length: moov.size },
        chunks: [{ start: 0, end: 6, bytes: new Uint8Array(0) }],
      },
    ],
  })
}

/** That buffer as a snapshot: one captured track, both kinds, no file to fall back on. */
const muxedSnapshot = (): Promise<SnapshotReader> =>
  snapshotFrom({
    page,
    tracks: [
      {
        id: 't0',
        bufferId: 'sb-1',
        representation: 'muxed:avc1.4d401e+mp4a.40.2:320x240',
        kinds: ['video', 'audio'],
        info: parseInit(MUXED_INIT)!,
        initBytes: MUXED_INIT,
        chunks: MUXED_SEGMENTS.map((bytes, at) => ({ start: at * 2, end: at * 2 + 2, bytes })),
      },
    ],
  })

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c1',
  name: 'A page about cats 01.23',
  in: 1,
  out: 3,
  representation: '480p',
  sound: true,
  crop: null,
  format: 'mp4',
  mode: 'original',
  ...over,
})

const requests = (source: Parameters<typeof requestsFor>[0], clips: readonly Clip[]) => {
  // These tests hold naming, reading and copy assembly rather than path selection. Declare their
  // chosen starts as sync samples so the copy premise is explicit under automatic exact starts.
  const starts = Float64Array.from(clips.map((one) => one.in))
  return requestsFor(
    source,
    clips,
    { ...EMPTY_CONTEXT, frames: starts, keyframes: starts },
    new Map(),
    false,
  )
}

const copyPlan = (request: ExportRequest) => {
  if (request.path.kind !== 'copy') throw new Error('the fixture did not take the copy path')
  return request.path.plan
}

const contextOf = (source: ClipSource, fps: number): EditContext => {
  const shown = source.video.samples
    .map((sample) => sample.pts / source.video.timescale)
    .sort((a, b) => a - b)
  const keyframes = source.video.samples
    .filter((sample) => sample.sync)
    .map((sample) => sample.pts / source.video.timescale)
    .sort((a, b) => a - b)
  const duration = Math.max(...shown) + 1 / fps

  return {
    frames: Float64Array.from(shown),
    keyframes: Float64Array.from(keyframes),
    fps,
    frameSize: { width: source.video.width, height: source.video.height },
    newClipFormat: 'mp4',
    runs: [{ start: 0, end: duration }],
    zones: [
      {
        start: 0,
        end: duration,
        representation: 'fixture',
        codec: 'avc1',
        width: source.video.width,
        height: source.video.height,
      },
    ],
    duration,
    title: 'Fixture',
  }
}

const softwareChoice = (geometry: EncodeGeometry): EncodingChoice => ({
  kind: 'h264-sw',
  config: {
    codec: 'avc1.42001e',
    width: geometry.width,
    height: geometry.height,
    framerate: geometry.framerate,
    bitrate: 800_000,
  },
  control: 'fixed-bitrate',
  bitrate: 800_000,
})

type PaceArgs = [
  kind: 'mp4' | 'webp',
  geometry: EncodeGeometry,
  frames: number,
  ms: number,
]

const choicesFor = (
  clips: readonly Clip[],
  ctx: EditContext,
): ReadonlyMap<string, EncodingChoice> =>
  new Map(
    clips.map((one) => {
      const geometry = geometryOf(one.crop, ctx.frameSize, ctx.fps)
      return [geometryKey(geometry), softwareChoice(geometry)] as const
    }),
  )

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0))
const u32 = (value: number): number[] => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
]

/** A minimal lossy still accepted by the RIFF packer. */
const stillWebp = (width: number, height: number): Uint8Array => {
  const picture = [
    0x10,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    width >>> 8,
    height & 0xff,
    height >>> 8,
  ]
  const chunk = [...ascii('VP8 '), ...u32(picture.length), ...picture]
  return Uint8Array.of(...ascii('RIFF'), ...u32(chunk.length + 4), ...ascii('WEBP'), ...chunk)
}

interface IntegrationSurface extends Surface {
  resized: Array<{ width: number; height: number }>
  drawn: number[]
  stills: number
}

const integrationSurface = (): IntegrationSurface => {
  let width = 1
  let height = 1
  const surface: IntegrationSurface = {
    resized: [],
    drawn: [],
    stills: 0,
    resize(nextWidth, nextHeight) {
      width = nextWidth
      height = nextHeight
      surface.resized.push({ width, height })
    },
    draw(frame) {
      surface.drawn.push(frame.timestamp)
    },
    async still() {
      surface.stills += 1
      return stillWebp(width, height)
    },
  }
  return surface
}

interface IntegrationCodecs {
  codecs: Codecs
  encoderConfigs: VideoEncoderConfig[]
  decoded: number
  encoded: number
  normalized: number
  closed: number
}

/** Enough WebCodecs to exercise the exporter seam without constructing a browser object. */
const integrationCodecs = (
  behavior: {
    failHardware?: boolean
    rejectUnnormalized?: boolean
    /** An encoder that refuses this configuration, with this error — or null to take it. */
    refuse?: (config: VideoEncoderConfig) => Error | null
  } = {},
): IntegrationCodecs => {
  const avcC = videoSampleEntry(INIT)!.children.get('avcC')!
  const fakes: IntegrationCodecs = {
    codecs: null as unknown as Codecs,
    encoderConfigs: [],
    decoded: 0,
    encoded: 0,
    normalized: 0,
    closed: 0,
  }

  fakes.codecs = {
    decoder(_config, on) {
      return {
        decode(chunk) {
          fakes.decoded += 1
          const frame = {
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            normalized: false,
            close: () => {
              fakes.closed += 1
            },
          }
          on.frame(frame as unknown as VideoFrame)
        },
        flush: () => Promise.resolve(),
        close: () => undefined,
        queued: 0,
        drainTo: () => Promise.resolve(),
      }
    },
    encoder(config, on) {
      fakes.encoderConfigs.push(config)
      let first = true
      return {
        encode(frame, options) {
          fakes.encoded += 1
          if (
            behavior.rejectUnnormalized &&
            !(frame as unknown as { normalized?: boolean }).normalized
          ) {
            const error = new Error('Encoding error. (Unexpected frame format.)')
            error.name = 'OperationError'
            on.error(error)
            return
          }
          if (behavior.failHardware && config.hardwareAcceleration === 'prefer-hardware') {
            const error = new Error('Encoding error.')
            error.name = 'EncodingError'
            on.error(error)
            return
          }
          const refused = behavior.refuse?.(config)
          if (refused) {
            on.error(refused)
            return
          }
          const bytes = Uint8Array.of(0, 0, 0, 1, fakes.encoded & 0xff)
          on.chunk(
            {
              type: options?.keyFrame ? 'key' : 'delta',
              timestamp: frame.timestamp,
              byteLength: bytes.byteLength,
              copyTo: (target: Uint8Array) => target.set(bytes),
            } as unknown as EncodedVideoChunk,
            first
              ? ((config.codec.startsWith('vp09')
                  // libvpx's account of itself: a codec string, and no description at all.
                  ? { decoderConfig: { codec: config.codec } }
                  : { decoderConfig: { codec: 'avc1.42001e', description: avcC } }) as EncodedVideoChunkMetadata)
              : undefined,
          )
          first = false
        },
        flush: () => Promise.resolve(),
        close: () => undefined,
        queued: 0,
        drainTo: () => Promise.resolve(),
      }
    },
    chunk: (init) => init as unknown as EncodedVideoChunk,
    normalize: async (frame) => {
      fakes.normalized += 1
      const source = frame as unknown as {
        timestamp: number
        duration: number | null
      }
      return {
        timestamp: source.timestamp,
        duration: source.duration,
        normalized: true,
        close: () => {
          fakes.closed += 1
        },
      } as unknown as VideoFrame
    },
    cut(frame) {
      return frame
    },
  }

  return fakes
}

describe('openClipSource', () => {
  it('indexes the samples of captured material and addresses them in the snapshot', async () => {
    const reader = await capturedSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!

    expect(source, 'the editor found nothing to cut in a recording it can play').not.toBeNull()
    // Three segments of the fixture, 48 frames apiece.
    expect(source.video.samples).toHaveLength(144)

    // Addressed where they lie in the snapshot and not from the first byte of a segment: the
    // index and the init stand in front of them, so a sample at zero would be the file's header.
    const first = source.video.samples[0]!.source
    expect(first.at).toBeGreaterThan(INIT.byteLength)
    const bytes = await reader.bytesOf(first)
    expect(bytes.byteLength).toBe(first.length)
  })

  it('keeps SourceBuffer timestamp offsets on samples used by export', async () => {
    const repeated = SEGMENTS[0]!
    const reader = await snapshotFrom({
      page,
      tracks: [
        {
          ...capturedTrack,
          chunks: [
            { start: 0, end: 2, bytes: repeated },
            { start: 2, end: 4, bytes: repeated.slice(), timestampOffset: 2 },
          ],
        },
      ],
    })
    const source = (await openClipSource(reader, materialOf(reader.index)))!

    // Both chunks carry identical raw decode times. The SourceBuffer placed the second at two
    // seconds, and the snapshot is the only place the editor can recover that fact. Dropping the
    // offset while opening the export source makes all 48 samples collide with the first chunk;
    // the overlap filter then erases the entire second half before a clip can be planned from it.
    expect(source.video.samples).toHaveLength(96)
    expect(source.video.dropped).toBe(0)
    expect(source.video.samples[48]!.dts).toBe(2 * source.video.timescale)

    const plan = planOf(source, clip({ in: 2, out: 4 }))
    expect(plan.duration).toBeCloseTo(2, 6)
    expect(plan.tracks[0]!.samples[0]!.source).toEqual(source.video.samples[48]!.source)
  })

  it('cuts an ordinary complete file, where there are no fragments to walk', async () => {
    // The material most sites actually deliver. Left to the fragmented path this comes back null,
    // the Export button never leaves its disabled state, and the tab shows a preview of a
    // recording it will not write — which is what it did before this branch existed.
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!

    expect(source, 'the editor refused a file it has the tables of').not.toBeNull()
    expect(source.video.kind).toBe('video')
    expect(source.video.samples).toHaveLength(60)
    expect(source.audio, 'the sound of the file was left behind').toBeDefined()
  })

  it('takes the sound of a muxed buffer out of the picture\u2019s own segments', async () => {
    // One SourceBuffer for both kinds, which is the shape where the material has no sound track
    // to point at: the audio slot is empty and the sound is inside the picture's segments under
    // a track number of its own. Read as picture alone the recording exports silent, and there
    // is nothing on the screen to say so \u2014 the panel offers the clip and the file is mute.
    const reader = await muxedSnapshot()
    const material = materialOf(reader.index)

    expect(material.audio, 'the fixture has a sound track of its own to find').toBeNull()
    expect(material.video!.kinds).toEqual(['video', 'audio'])

    const source = (await openClipSource(reader, material))!
    expect(source.audio, 'the sound was left behind in the buffer it shares').toBeDefined()

    const asked = requests(source, [clip({ in: 1, out: 3 })])
    expect(copyPlan(asked[0]!).tracks.map((track) => track.kind)).toEqual(['video', 'audio'])

    const saved: Uint8Array[] = []
    const runner = createRunner({
      read: (at) => reader.bytesOf(at),
      encode: async () => null,
      save: async (file) => {
        saved.push(file)
      },
    })
    runner.enqueue(asked)
    await runner.settled()

    expect(runner.queue().jobs[0]!.state, runner.queue().jobs[0]!.error ?? '').toBe('done')
    // And it is in the file at the end of it, not merely in the plan.
    expect(parseInit(saved[0]!)!.tracks.map((track) => track.kind)).toEqual(['video', 'audio'])
  })

  it('cuts the same file out of a snapshot as it would out of the file standing alone', async () => {
    // The whole way down: the source, the plan, the reads the runner makes of the snapshot, the
    // writer. Comparing the result with itself would prove nothing — an address that forgot where
    // the file lies in the snapshot reads somebody else's bytes and still writes a file of the
    // right size and shape. So the answer is compared with the same cut of the same file read out
    // of the file itself, where the addresses are its own from the first byte.
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const asked = clip({ in: 1, out: 3 })

    const saved: Uint8Array[] = []
    const runner = createRunner({
      read: (at) => reader.bytesOf(at),
      encode: async () => null,
      save: async (file) => {
        saved.push(file)
      },
    })
    runner.enqueue(requests(source, [asked]))
    await runner.settled()

    expect(runner.queue().jobs[0]!.state, runner.queue().jobs[0]!.error ?? '').toBe('done')

    const alone = clipSourceFrom(movieTracksOf(moovOf(WHOLE), WHOLE.byteLength))!
    const expected = assembleMp4(planOf(alone, asked), (at) =>
      WHOLE.subarray(at.at, at.at + at.length),
    )
    expect(expected.byteLength).toBeGreaterThan(1_000)
    expect(saved[0]).toEqual(expected)
  })

  it('opens a recording whose only track is the sound one', async () => {
    // Material with nothing in its picture slot: a file of sound alone fills the other one. The
    // tab has nothing to play and Export still has to work — the popup has offered to save such
    // a session since the capture stage, and the editor cannot be the one that refuses.
    const reader = await fileSnapshot()
    const material = materialOf(reader.index)

    expect(
      await openClipSource(reader, { ...material, video: null, audio: material.video }),
    ).not.toBeNull()
  })

  it('has nothing to cut when the snapshot holds no track at all', async () => {
    const reader = await capturedSnapshot()
    const material = materialOf(reader.index)

    expect(await openClipSource(reader, { ...material, video: null, audio: null })).toBeNull()
  })
})

describe('requestsFor', () => {
  it('names every file after its clip and numbers two clips named the same', async () => {
    const reader = await capturedSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!

    const asked = requests(source, [
      clip({ id: 'c1', name: 'Cats 01.23' }),
      clip({ id: 'c2', name: 'Dogs: 02.00' }),
      clip({ id: 'c3', name: 'Cats 01.23' }),
    ])

    expect(asked.map((one) => one.fileName)).toEqual([
      'Cats 01.23.mp4',
      'Dogs 02.00.mp4',
      'Cats 01.23 (2).mp4',
    ])
    expect(asked.map((one) => one.clipId)).toEqual(['c1', 'c2', 'c3'])
    // The plan on the request is the plan the estimate was made of, and not a second one.
    expect(copyPlan(asked[0]!).bytes).toBe(planOf(source, clip({ id: 'c1' })).bytes)
  })

  it('carries the sound switch of every clip into the plan it is written from', async () => {
    // The one setting of a clip that decides what goes into the file, and the estimate is made
    // of the same plan: with the switch fixed, the editor writes silent
    // clips out of a recording that has sound in it and quotes the silent weight for both.
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    expect(source.audio, 'the fixture has no sound to leave out').toBeDefined()

    const loud = planOf(source, clip({ sound: true }))
    const silent = planOf(source, clip({ sound: false }))

    expect(loud.tracks.map((track) => track.kind)).toEqual(['video', 'audio'])
    expect(silent.tracks.map((track) => track.kind)).toEqual(['video'])
    expect(silent.bytes).toBeLessThan(loud.bytes)

    // And it is that plan the runner is handed, clip by clip, rather than one built for the lot.
    const asked = requests(source, [
      clip({ id: 'c1', name: 'Loud', sound: true }),
      clip({ id: 'c2', name: 'Quiet', sound: false }),
    ])
    expect(asked.map((one) => copyPlan(one).tracks.map((track) => track.kind))).toEqual([
      ['video', 'audio'],
      ['video'],
    ])
  })

  it('plans what the clip asks for and not what the recording holds', async () => {
    const reader = await capturedSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!

    const short = planOf(source, clip({ in: 1, out: 2 }))
    const long = planOf(source, clip({ in: 1, out: 5 }))

    expect(short.duration).toBeLessThan(long.duration)
    expect(short.bytes).toBeLessThan(long.bytes)
  })

  it('sends every clip down the path it asks for and into that path lane', async () => {
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const ctx = contextOf(source, 10)
    const keyframe = ctx.keyframes[0]!
    const nonKeyframe = [...ctx.frames].find((frame) => !ctx.keyframes.includes(frame))!
    const crop = {
      x: 0,
      y: 0,
      width: Math.floor(ctx.frameSize.width / 4) * 2,
      height: Math.floor(ctx.frameSize.height / 4) * 2,
    }
    const clips = [
      clip({ id: 'copy', name: 'Copy', in: keyframe, out: 2 }),
      clip({ id: 'crop', name: 'Crop', in: keyframe, out: 2, crop }),
      clip({ id: 'webp', name: 'WebP', in: keyframe, out: 2, format: 'webp' }),
      clip({ id: 'optimize', name: 'Optimize', in: keyframe, out: 2, mode: 'optimize' }),
      clip({ id: 'head', name: 'Head', in: nonKeyframe, out: 2 }),
    ]

    const asked = requestsFor(source, clips, ctx, choicesFor(clips, ctx), true)

    expect(asked.map(({ path }) => path.kind)).toEqual([
      'copy',
      'encode',
      'webp',
      'encode',
      'encode',
    ])
    expect(asked.map(({ path }) => laneOf(path))).toEqual([
      'copy',
      'encode',
      'encode',
      'encode',
      'encode',
    ])
  })

  it('uses the encoder answer for each geometry in a batch', async () => {
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const ctx = contextOf(source, 10)
    const clips = [
      clip({ id: 'full', name: 'Full', in: 0, out: 2, mode: 'optimize' }),
      clip({
        id: 'half',
        name: 'Half',
        in: 0,
        out: 2,
        crop: { x: 0, y: 0, width: 128, height: 72 },
      }),
      clip({
        id: 'quarter',
        name: 'Quarter',
        in: 0,
        out: 2,
        crop: { x: 0, y: 0, width: 64, height: 72 },
      }),
    ]
    const all = choicesFor(clips, ctx)
    const firstOnly = new Map([[...all][0]!])

    const answered = requestsFor(source, clips, ctx, all, false)
    const partlyAnswered = requestsFor(source, clips, ctx, firstOnly, false)

    expect(answered.map(({ path }) => path.kind)).toEqual(['encode', 'encode', 'encode'])
    expect(partlyAnswered.map(({ path }) => path.kind)).toEqual([
      'encode',
      'blocked',
      'blocked',
    ])
    expect(partlyAnswered.map(({ path }) => laneOf(path))).toEqual([
      'encode',
      'encode',
      'encode',
    ])
  })

  it('keeps MP4 and WebP names separate while uniquifying each format', async () => {
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const ctx = contextOf(source, 10)
    const clips = [
      clip({ id: 'mp4', name: 'Same', in: 0, out: 2 }),
      clip({ id: 'webp-1', name: 'Same', in: 0, out: 2, format: 'webp' }),
      clip({ id: 'webp-2', name: 'Same', in: 0, out: 2, format: 'webp' }),
    ]

    const asked = requestsFor(source, clips, ctx, choicesFor(clips, ctx), false)

    expect(asked.map(({ fileName }) => fileName)).toEqual([
      'Same.mp4',
      'Same.webp',
      'Same (2).webp',
    ])
  })
})

describe('encodeIo', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('inherits WebP content type and save options from the downloader', async () => {
    const blobs: Blob[] = []
    const downloads: Array<Record<string, unknown>> = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob)
      return 'blob:webp'
    })
    vi.stubGlobal('chrome', { downloads: finishingDownloads(downloads), runtime: { lastError: undefined } })
    const saved: number[] = []
    const io = encodeIo({} as SnapshotReader, integrationCodecs().codecs, integrationSurface, {
      askWhere: true,
      onSaved: () => saved.push(1),
      onPace: () => undefined,
    })

    await io.save(new Uint8Array([1, 2, 3]), 'Animation.webp')

    expect(blobs.map(({ type }) => type)).toEqual(['image/webp'])
    expect(downloads[0]).toMatchObject({ filename: 'Animation.webp', saveAs: true })
    expect(saved).toEqual([1])
  })

  it('leaves copy requests to the runner without reading or constructing a surface', async () => {
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const ctx = contextOf(source, 10)
    const start = ctx.keyframes[0]!
    const request = requestsFor(
      source,
      [clip({ in: start, out: Math.min(ctx.duration, start + 2) })],
      ctx,
      new Map(),
      false,
    )[0]!
    const read = vi.spyOn(reader, 'bytesOf')
    const fakes = integrationCodecs()
    const makeSurface = vi.fn(integrationSurface)
    const pace: PaceArgs[] = []
    const onPace: PaceReport = (...report: PaceArgs) => pace.push(report)

    const file = await encodeIo(reader, fakes.codecs, makeSurface, {
      onPace,
    }).encode(request, () => undefined, () => false)

    expect(request.path.kind).toBe('copy')
    expect(file).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(makeSurface).not.toHaveBeenCalled()
    expect(fakes.decoded).toBe(0)
    expect(fakes.encoded).toBe(0)
    expect(pace).toEqual([])
  })

  it('reports every MP4 frame, preserves optional audio, and records successful pace', async () => {
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const ctx = contextOf(source, 10)
    const clips = [
      clip({ id: 'loud', name: 'Loud', in: 0, out: 2, mode: 'optimize', sound: true }),
      clip({ id: 'silent', name: 'Silent', in: 0, out: 2, mode: 'optimize', sound: false }),
    ]
    const [loud, silent] = requestsFor(source, clips, ctx, choicesFor(clips, ctx), false)
    const fakes = integrationCodecs()
    const makeSurface = vi.fn(integrationSurface)
    const pace: PaceArgs[] = []
    const onPace: PaceReport = (...report: PaceArgs) => pace.push(report)
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(350)
      .mockReturnValueOnce(500)
      .mockReturnValueOnce(800)
    const io = encodeIo(reader, fakes.codecs, makeSurface, {
      onPace,
    })
    const loudProgress: number[] = []
    const silentProgress: number[] = []

    const loudFile = await io.encode(
      loud!,
      (frames: number) => loudProgress.push(frames),
      () => false,
    )
    const silentFile = await io.encode(
      silent!,
      (frames: number) => silentProgress.push(frames),
      () => false,
    )

    if (loud!.path.kind !== 'encode' || silent!.path.kind !== 'encode') {
      throw new Error('the fixtures did not take the encode path')
    }
    expect(loudProgress).toEqual(
      Array.from({ length: framesOf(loud!.path)! }, (_, at) => at + 1),
    )
    expect(silentProgress).toEqual(
      Array.from({ length: framesOf(silent!.path)! }, (_, at) => at + 1),
    )
    expect(parseInit(loudFile!)!.tracks.map(({ kind }) => kind)).toEqual(['video', 'audio'])
    expect(parseInit(silentFile!)!.tracks.map(({ kind }) => kind)).toEqual(['video'])
    expect(samplesInMovie(loudFile!, loudFile!.byteLength)[1]!.samples).toHaveLength(
      loud!.path.plan.audio!.samples.length,
    )
    expect(makeSurface).not.toHaveBeenCalled()
    expect(pace).toEqual([
      ['mp4', loud!.path.plan.geometry, framesOf(loud!.path), 250],
      ['mp4', silent!.path.plan.geometry, framesOf(silent!.path), 300],
    ])
  })

  it('retries a lying HEVC hardware encoder through H.264 hardware and software', async () => {
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const ctx = contextOf(source, 10)
    const asked = clip({ in: 0, out: 2, mode: 'optimize', sound: false })
    const geometry = geometryOf(asked.crop, ctx.frameSize, ctx.fps)
    const hevc: EncodingChoice = {
      kind: 'hevc-hw',
      config: {
        codec: 'hev1.1.6.L93.B0',
        width: geometry.width,
        height: geometry.height,
        framerate: geometry.framerate,
        hardwareAcceleration: 'prefer-hardware',
        bitrateMode: 'quantizer',
        latencyMode: 'quality',
      },
      control: 'quantizer',
      quantizer: 22,
    }
    const request = requestsFor(
      source,
      [asked],
      ctx,
      new Map([[geometryKey(geometry), hevc]]),
      false,
    )[0]!
    const fakes = integrationCodecs({ failHardware: true })

    const file = await encodeIo(reader, fakes.codecs, integrationSurface, {
      onPace: () => undefined,
    }).encode(request, () => undefined, () => false)

    expect(fakes.encoderConfigs.map((config) => [
      config.codec,
      config.hardwareAcceleration,
      config.bitrateMode,
    ])).toEqual([
      ['hev1.1.6.L93.B0', 'prefer-hardware', 'quantizer'],
      ['avc1.64001e', 'prefer-hardware', 'quantizer'],
      ['avc1.64001e', 'prefer-software', 'constant'],
    ])
    expect(fakes.encoderConfigs[2]).toMatchObject({
      bitrate: 36_864,
      avc: { format: 'avc' },
    })
    expect(parseInit(file!)!.tracks.map(({ codec }) => codec)).toEqual(['avc1'])
  })

  it('retries the software encoder with a normalized frame after it rejects decoder storage', async () => {
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const ctx = contextOf(source, 10)
    const asked = clip({ in: 0, out: 2, mode: 'optimize', sound: false })
    const request = requestsFor(source, [asked], ctx, choicesFor([asked], ctx), false)[0]!
    const fakes = integrationCodecs({ rejectUnnormalized: true })

    const file = await encodeIo(reader, fakes.codecs, integrationSurface, {
      onPace: () => undefined,
    }).encode(request, () => undefined, () => false)

    expect(request.path.kind).toBe('encode')
    expect(fakes.encoderConfigs.map((config) => [
      config.codec,
      config.hardwareAcceleration,
    ])).toEqual([
      ['avc1.42001e', undefined],
      ['avc1.42001e', undefined],
    ])
    expect(fakes.normalized).toBe(
      request.path.kind === 'encode' ? request.path.plan.kept : 0,
    )
    expect(parseInit(file!)!.tracks.map(({ codec }) => codec)).toEqual(['avc1'])
  })

  /** Yandex Browser, as measured: no OpenH264, and a hardware encoder that says yes and is not. */
  const openH264Missing = (config: VideoEncoderConfig): Error | null => {
    if (config.codec.startsWith('vp09')) return null
    const error = new Error(
      config.hardwareAcceleration === 'prefer-hardware'
        ? 'Encoder creation error.'
        : 'Encoder initialization error. (Failed to create OpenH264 encoder.)',
    )
    error.name = 'OperationError'
    return error
  }

  const ladderChoice = (geometry: EncodeGeometry, kind: string): EncodingChoice =>
    ladderFor(geometry, { codec: 'h264', quality: 'medium' })
      .find((rung) => rung.choice.kind === kind)!.choice as EncodingChoice

  it('falls through every H.264 rung to VP9 in MP4 when the browser has no H.264 encoder', async () => {
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const ctx = contextOf(source, 10)
    const asked = clip({ in: 0, out: 2, mode: 'optimize', sound: false })
    const geometry = geometryOf(asked.crop, ctx.frameSize, ctx.fps)
    const request = requestsFor(
      source,
      [asked],
      ctx,
      new Map([[geometryKey(geometry), ladderChoice(geometry, 'h264-hw')]]),
      false,
    )[0]!
    const fakes = integrationCodecs({ refuse: openH264Missing })

    const file = await encodeIo(reader, fakes.codecs, integrationSurface, {
      onPace: () => undefined,
    }).encode(request, () => undefined, () => false)

    expect(fakes.encoderConfigs.map((config) => [config.codec, config.hardwareAcceleration])).toEqual([
      ['avc1.64001e', 'prefer-hardware'],
      ['avc1.64001e', 'prefer-software'],
      [`vp09.00.${vp9Level(geometry)}.08`, 'prefer-software'],
    ])
    expect(parseInit(file!)!.tracks.map(({ codec }) => codec)).toEqual(['vp09'])
  })

  it('names every rung that failed, not only the last one, when nothing could encode', async () => {
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const ctx = contextOf(source, 10)
    const asked = clip({ in: 0, out: 2, mode: 'optimize', sound: false })
    const geometry = geometryOf(asked.crop, ctx.frameSize, ctx.fps)
    const request = requestsFor(
      source,
      [asked],
      ctx,
      new Map([[geometryKey(geometry), ladderChoice(geometry, 'h264-hw')]]),
      false,
    )[0]!
    const fakes = integrationCodecs({
      refuse: (config) => {
        if (!config.codec.startsWith('vp09')) return openH264Missing(config)
        const error = new Error('Encoder initialization error.')
        error.name = 'OperationError'
        return error
      },
    })

    const failure = await encodeIo(reader, fakes.codecs, integrationSurface, {
      onPace: () => undefined,
    }).encode(request, () => undefined, () => false).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CodecFailure)
    expect((failure as CodecFailure).stage).toBe('encode')
    expect((failure as Error).message).toBe(
      'Encoding avc1.4d400b failed on every encoder tried: ' +
        'avc1.64001e (hardware): OperationError: Encoder creation error.; ' +
        'avc1.64001e (software): OperationError: Encoder initialization error. (Failed to create OpenH264 encoder.); ' +
        `vp09.00.${vp9Level(geometry)}.08 (software): OperationError: Encoder initialization error.`,
    )

    // A header that declares a wider picture than the samples are coded at: the encoders were
    // configured for a picture the browser was never asked about, and the failure says so.
    const declared = { ...ctx, frameSize: { width: ctx.frameSize.width + 80, height: ctx.frameSize.height } }
    const wide = geometryOf(asked.crop, declared.frameSize, declared.fps)
    const unasked = requestsFor(
      source,
      [asked],
      declared,
      new Map([[geometryKey(wide), ladderChoice(wide, 'h264-hw')]]),
      false,
    )[0]!
    const second = await encodeIo(reader, integrationCodecs({ refuse: () => new Error('No.') }).codecs,
      integrationSurface, { onPace: () => undefined },
    ).encode(unasked, () => undefined, () => false).catch((error: unknown) => error)
    expect((second as Error).message).toMatch(
      new RegExp(`\\(the browser was asked about ${wide.width}×${wide.height}; this clip is coded at ${geometry.width}×${geometry.height}\\)$`),
    )
  })

  it('reports every WebP frame without reading the clip sound and records WebP pace', async () => {
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const ctx = contextOf(source, 10)
    const request = requestsFor(
      source,
      [clip({ in: 0, out: 2, format: 'webp', sound: true })],
      ctx,
      new Map(),
      false,
    )[0]!
    if (request.path.kind !== 'webp' || !request.path.plan.audio) {
      throw new Error('the fixture did not plan a WebP with source audio')
    }
    // Make both WebP transformations observable: the animation caps this picture at 640×360
    // and thins its declared 30 fps to 15. The fixture's native 256×144@10 would let raw geometry
    // and `plan.kept` survive as accidentally correct answers.
    request.path.plan.geometry = { width: 1280, height: 720, framerate: 30 }
    const audio = request.path.plan.audio.samples.map(({ source: at }) => at)
    const reads: Array<{ at: number; length: number }> = []
    const tracked = SnapshotReader.over(async (at, length) => {
      reads.push({ at, length })
      return reader.bytesOf({ at, length })
    }, reader.index)
    const fakes = integrationCodecs()
    const surface = integrationSurface()
    const pace: PaceArgs[] = []
    const onPace: PaceReport = (...report: PaceArgs) => pace.push(report)
    const progress: number[] = []
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(400)

    const file = await encodeIo(tracked, fakes.codecs, () => surface, {
      onPace,
    }).encode(request, (frames: number) => progress.push(frames), () => false)

    const written = framesOf(request.path)!
    expect(progress).toEqual(Array.from({ length: written }, (_, at) => at + 1))
    expect(file!.subarray(0, 4)).toEqual(Uint8Array.of(...ascii('RIFF')))
    expect(surface.stills).toBe(written)
    expect(
      reads.some((read) =>
        audio.some(
          (sample) =>
            read.at <= sample.at && read.at + read.length >= sample.at + sample.length,
        ),
      ),
    ).toBe(false)
    expect(pace).toEqual([
      [
        'webp',
        webpGeometry(
          request.path.plan.crop ?? request.path.plan.geometry,
          request.path.plan.geometry.framerate,
        ),
        written,
        300,
      ],
    ])
  })

  it('does not finish or record pace when cancellation arrives during the audio read', async () => {
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const ctx = contextOf(source, 10)
    const asked = clip({ in: 0, out: 2, mode: 'optimize', sound: true })
    const request = requestsFor(source, [asked], ctx, choicesFor([asked], ctx), false)[0]!
    if (request.path.kind !== 'encode' || !request.path.plan.audio) {
      throw new Error('the fixture did not plan encoded video with copied audio')
    }
    const audio = request.path.plan.audio.samples.map(({ source: at }) => at)
    let releaseAudio!: () => void
    const audioReleased = new Promise<void>((resolve) => {
      releaseAudio = resolve
    })
    let announceAudio!: () => void
    const audioStarted = new Promise<void>((resolve) => {
      announceAudio = resolve
    })
    let announced = false
    const parked = SnapshotReader.over(async (at, length) => {
      const isAudio = audio.some(
        (sample) => at <= sample.at && at + length >= sample.at + sample.length,
      )
      if (isAudio) {
        if (!announced) {
          announced = true
          announceAudio()
        }
        await audioReleased
      }
      return reader.bytesOf({ at, length })
    }, reader.index)
    let stale = false
    const pace: PaceArgs[] = []
    const onPace: PaceReport = (...report: PaceArgs) => pace.push(report)
    const result = encodeIo(parked, integrationCodecs().codecs, integrationSurface, {
      onPace,
    }).encode(request, () => undefined, () => stale)

    await audioStarted
    stale = true
    releaseAudio()

    await expect(result).resolves.toBeNull()
    expect(pace).toEqual([])
  })
})

describe('downloadIo', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const stubDownloads = (id: number | undefined) => {
    const asked: Array<{ url: string; filename: string }> = []
    vi.stubGlobal('chrome', {
      downloads: {
        ...finishingDownloads(asked as unknown as Array<Record<string, unknown>>),
        download: (
          options: { url: string; filename: string },
          done: (id: number | undefined) => void,
        ) => {
          asked.push(options)
          done(id)
          if (id !== undefined) finished(id)
        },
      },
      runtime: { lastError: id === undefined ? { message: 'refused' } : undefined },
    })
    return asked
  }

  it('refuses re-encoding because this io only copies and downloads', async () => {
    await expect(
      downloadIo({} as SnapshotReader).encode({} as ExportRequest, () => undefined, () => false),
    ).rejects.toThrow(NO_ENCODER)
  })

  it('hands the file to the browser under the name the clip was given', async () => {
    const asked = stubDownloads(11)
    await downloadIo({} as SnapshotReader).save(new Uint8Array([1, 2, 3]), 'Cats.mp4')

    expect(asked).toHaveLength(1)
    expect(asked[0]!.filename).toBe('Cats.mp4')
    expect(asked[0]!.url).toMatch(/^blob:/)
  })

  it('uses the file extension as the Blob content type', async () => {
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob)
      return `blob:${blobs.length}`
    })
    stubDownloads(11)

    await downloadIo({} as SnapshotReader).save(new Uint8Array([1]), 'Cats.webp')
    await downloadIo({} as SnapshotReader).save(new Uint8Array([2]), 'Cats.mp4')

    expect(blobs.map(({ type }) => type)).toEqual(['image/webp', 'video/mp4'])
  })

  it('lets the address outlive the call, so the download is not cut off halfway', async () => {
    // Chrome does not read the blob while `download` is running: it takes the address, answers
    // with an id, and comes back for the bytes afterwards. Revoked as the call returns, the
    // address is gone before the read \u2014 and what lands on disk is a part-written mp4 that no
    // player will open, with the row in the panel reading "Saved" over it.
    vi.useFakeTimers()
    const revoked: string[] = []
    const revoke = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation((url: string) => void revoked.push(url))

    try {
      const asked = stubDownloads(11)
      await downloadIo({} as SnapshotReader).save(new Uint8Array([1, 2, 3]), 'Cats.mp4')

      expect(revoked, 'the address was let go as the call returned').toEqual([])
      vi.advanceTimersByTime(10_000)
      expect(revoked, 'the address was let go ten seconds into the download').toEqual([])

      // And it is let go in the end: an address held for ever holds the whole file in memory
      // for as long as the tab is open, and a session is exported clip after clip.
      vi.advanceTimersByTime(60_000)
      expect(revoked).toEqual([asked[0]!.url])
    } finally {
      revoke.mockRestore()
      vi.useRealTimers()
    }
  })

  it('lets go at once of an address no download ever took', async () => {
    // The other side of the same wait. Nothing is reading this one, so there is nothing to cut
    // off, and holding it for a minute would pin a refused file in memory for no reason at all.
    vi.useFakeTimers()
    const revoked: string[] = []
    const revoke = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation((url: string) => void revoked.push(url))

    try {
      const asked = stubDownloads(undefined)
      await expect(
        downloadIo({} as SnapshotReader).save(new Uint8Array([1, 2, 3]), 'Cats.mp4'),
      ).rejects.toThrow(/refused to save/)

      vi.advanceTimersByTime(0)
      expect(revoked).toEqual([asked[0]!.url])
    } finally {
      revoke.mockRestore()
      vi.useRealTimers()
    }
  })

  it('leaves the browser to put the file where it always puts it', async () => {
    // The default save mode, which a queue of six clips needs: six dialogs for one press of
    // Export is not a setting anybody leaves on. `uniquify` is what keeps the sixth from writing
    // over the first when two clips of one page come out under one name.
    const asked = stubDownloads(11) as unknown as Array<Record<string, unknown>>
    await downloadIo({} as SnapshotReader).save(new Uint8Array([1]), 'Cats.mp4')

    expect(asked[0]!.saveAs).toBe(false)
    expect(asked[0]!.conflictAction).toBe('uniquify')
  })

  it('asks where every clip goes when the settings say to', async () => {
    const asked = stubDownloads(11) as unknown as Array<Record<string, unknown>>
    await downloadIo({} as SnapshotReader, { askWhere: true }).save(new Uint8Array([1]), 'Cats.mp4')

    expect(asked[0]!.saveAs).toBe(true)
  })

  it('says a clip was written, so that a recording cut from counts as used', async () => {
    // A session the user cuts from ranks second only to pinned sessions, and the editor is the
    // only place that knows a clip came out of one. Told after the browser took the file and not
    // before: a refused download is not a session anybody got anything out of.
    stubDownloads(11)
    const saved: number[] = []
    await downloadIo({} as SnapshotReader, { onSaved: () => saved.push(1) }).save(
      new Uint8Array([1]),
      'Cats.mp4',
    )

    expect(saved).toHaveLength(1)
  })

  it('says nothing of a clip the browser refused', async () => {
    stubDownloads(undefined)
    const saved: number[] = []

    await expect(
      downloadIo({} as SnapshotReader, { onSaved: () => saved.push(1) }).save(
        new Uint8Array([1]),
        'Cats.mp4',
      ),
    ).rejects.toThrow(/refused to save/)
    expect(saved).toEqual([])
  })

  it('fails the job when the browser refuses the download', async () => {
    // Chrome answers an id of undefined and says why in lastError. A promise that resolved here
    // would leave the row reading "Saved" over a file that was never written.
    stubDownloads(undefined)

    await expect(
      downloadIo({} as SnapshotReader).save(new Uint8Array([1, 2, 3]), 'Cats.mp4'),
    ).rejects.toThrow(/refused to save/)
  })

  it('says what the browser said when it refused', async () => {
    // lastError is the only account of what went wrong — a name the file system will not take,
    // a downloads folder that is gone — and it used to be read and thrown away.
    stubDownloads(undefined)

    await expect(
      downloadIo({} as SnapshotReader).save(new Uint8Array([1]), 'Cats.mp4'),
    ).rejects.toThrow('The browser refused to save the file: refused')
  })
})

describe('downloadIo and the Save dialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  type Delta = { id: number; state?: { current: string }; error?: { current: string } }

  /**
   * Chrome as it behaves with `saveAs`: the call answers with an id as soon as the item exists,
   * which is before the dialog has even opened, and what the user did with the dialog arrives
   * later through `onChanged` (Chromium: DownloadManagerImpl runs the start callback right after
   * creating the item, and target determination — the dialog — comes after the file is set up).
   */
  const stubDialog = () => {
    const listeners = new Set<(delta: Delta) => void>()
    const erasers = new Set<(id: number) => void>()
    vi.stubGlobal('chrome', {
      downloads: {
        download: (_options: unknown, done: (id: number) => void) => done(7),
        onChanged: {
          addListener: (listener: (delta: Delta) => void) => listeners.add(listener),
          removeListener: (listener: (delta: Delta) => void) => listeners.delete(listener),
        },
        onErased: {
          addListener: (listener: (id: number) => void) => erasers.add(listener),
          removeListener: (listener: (id: number) => void) => erasers.delete(listener),
        },
      },
      runtime: { lastError: undefined },
    })
    return {
      change: (delta: Delta) => [...listeners].forEach((listener) => listener(delta)),
      erase: (id: number) => [...erasers].forEach((listener) => listener(id)),
      listening: () => listeners.size + erasers.size,
    }
  }

  it('does not call a clip saved while the dialog is still open', async () => {
    const chrome = stubDialog()
    const saved: number[] = []
    let settled = false
    const saving = downloadIo({} as SnapshotReader, { askWhere: true, onSaved: () => saved.push(1) })
      .save(new Uint8Array([1]), 'Cats.mp4')
      .then(() => { settled = true })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled, 'the row said Saved before the user chose where').toBe(false)
    expect(saved).toEqual([])

    chrome.change({ id: 99, state: { current: 'complete' } })
    chrome.change({ id: 7, state: { current: 'complete' } })
    await saving
    expect(saved).toEqual([1])
    expect(chrome.listening(), 'the listener outlived its download').toBe(0)
  })

  it('fails a clip whose Save dialog was cancelled, and says nothing of it being saved', async () => {
    const chrome = stubDialog()
    const saved: number[] = []
    const saving = downloadIo({} as SnapshotReader, { askWhere: true, onSaved: () => saved.push(1) })
      .save(new Uint8Array([1]), 'Cats.mp4')

    await new Promise((resolve) => setTimeout(resolve, 0))
    chrome.change({ id: 7, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } })

    await expect(saving).rejects.toThrow('The Save dialog was closed without saving the file.')
    expect(saved).toEqual([])
    expect(chrome.listening()).toBe(0)
  })

  it('fails a clip whose download was erased before it finished, rather than waiting for ever', async () => {
    const chrome = stubDialog()
    const saving = downloadIo({} as SnapshotReader, { askWhere: true }).save(new Uint8Array([1]), 'Cats.mp4')

    await new Promise((resolve) => setTimeout(resolve, 0))
    chrome.erase(99)
    chrome.erase(7)

    await expect(saving).rejects.toThrow('The download was removed before it finished.')
    expect(chrome.listening(), 'a listener outlived its download').toBe(0)
  })

  it('names what interrupted a download the user did not cancel', async () => {
    const chrome = stubDialog()
    const saving = downloadIo({} as SnapshotReader, { askWhere: true }).save(new Uint8Array([1]), 'Cats.mp4')

    await new Promise((resolve) => setTimeout(resolve, 0))
    chrome.change({ id: 7, state: { current: 'interrupted' }, error: { current: 'FILE_NO_SPACE' } })

    await expect(saving).rejects.toThrow('FILE_NO_SPACE')
  })
})

describe('downloadIo and the encode lane', () => {
  const vp9 = clipSourceFrom(movieTracksOf(VP9_FILE, VP9_FILE.byteLength))!
  const h264 = clipSourceFrom(movieTracksOf(H264_FILE, H264_FILE.byteLength))!
  const copyOf = (source: ClipSource, fileName: string): ExportRequest => ({
    clipId: 'c',
    name: 'c',
    fileName,
    path: { kind: 'copy', plan: planClip(source, { in: 0, out: 1, sound: true }) },
  })

  it('counts a VP9 copy into an mp4 as the heavy work it is', () => {
    expect(downloadIo({} as SnapshotReader).converts!(copyOf(vp9, 'Cats.mp4'))).toBe(true)
  })

  it('leaves an H.264 copy in the lane of the copies', () => {
    expect(downloadIo({} as SnapshotReader).converts!(copyOf(h264, 'Cats.mp4'))).toBe(false)
  })
})

describe('downloadIo and the VP9 it encoded itself', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const encodeOf = (source: ClipSource): ExportRequest => ({
    clipId: 'c',
    name: 'c',
    fileName: 'Cats.mp4',
    path: { kind: 'encode', plan: planClip(source, { in: 0, out: 1, sound: true }) },
  } as unknown as ExportRequest)

  it('saves the VP9 of the last encoder rung as it is, and says why it is VP9', async () => {
    // VP9 out of the encode lane is the rung below every H.264 encoder: there is no H.264 to
    // convert it to here, and where there were, converting would be a second lossy encode.
    const getURL = vi.fn(() => 'chrome-extension://x/shared/convert-mp4.js')
    vi.stubGlobal('chrome', { runtime: { getURL } })
    const vp9 = clipSourceFrom(movieTracksOf(VP9_FILE, VP9_FILE.byteLength))!

    const prepared = await downloadIo({} as SnapshotReader).prepare!(
      VP9_FILE,
      'Cats.mp4',
      () => false,
      encodeOf(vp9),
    )

    expect(prepared!.file).toBe(VP9_FILE)
    expect(prepared!.note).toBe(ENCODED_AS_VP9)
    expect(getURL, 'the converter was loaded for a file it must not touch').not.toHaveBeenCalled()
  })
})
