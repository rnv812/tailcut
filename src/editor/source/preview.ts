import { assembleMp4 } from '../../core/export/assemble'
import { planPreview } from '../../core/export/plan'
import { audioDecoderConfig } from '../../core/codec/audio'
import { decoderConfigOf } from '../../core/encode/decoder'
import { audioSampleEntry, videoSampleEntry } from '../../core/iso/entry'
import {
  bytesFrom,
  clipSourceFrom,
  clipSourceOf,
  movieTracksOf,
  sourceTrackOf,
  type SourceSegment,
  type SourceTrackInput,
} from '../../core/export/source'
import {
  framesOf,
  framesOfTrack,
  FrameTable,
  retimeToPlan,
  type Frame,
} from '../../core/timeline/frames'
import type { SnapshotTrack } from '../../core/snapshot/format'
import type { Material, MaterialTrack } from '../../core/snapshot/material'
import type { SnapshotReader } from '../../core/snapshot/read'
import type { Located, TrackKind } from '../../shared/types'
import {
  audioMonitorClock,
  compositeFrames,
  monitorShift,
  pictureProgram,
  type PictureProgram,
} from './composite'

export interface PreviewConsumer {
  url: string
  release(): void
}

export interface MonitorPicture {
  trackId: string
  representation: string
  start: number
  end: number
  codec: string
  width: number
  height: number
}

export interface Preview {
  /** Object URL of the file the `<video>` plays. */
  url: string
  bytes: number
  /**
   * Coded size of the picture this file holds: the coordinate space of a crop rectangle.
   *
   * Off the plan's own video track rather than off the `<video>` element, and the difference
   * matters: the element reports the size it is laid out at, which is the window's business, and
   * a crop is a rectangle of the recording. Zero by zero when the file has no picture at all —
   * the same nothing `frames` is then.
   */
  frameSize: { width: number; height: number }
  /**
   * The frames of the picture, on both clocks: `pts` is the session, `out` is this file. There is
   * no third number and no origin — the difference between the two is whatever the plan did.
   */
  frames: FrameTable
  /** Selected representation's frame grid for clip geometry, snapping and encode rate. */
  editFrames?: FrameTable
  /** Chronological ABR ownership. Only parts of the selected track may be cut. */
  monitor?: { pictures: MonitorPicture[] }
  /** A second media element gets an independent MediaSource attachment. Blob previews omit it. */
  openConsumer?: () => PreviewConsumer
  release(): void
}

interface Loaded {
  kind: TrackKind
  initBytes: Uint8Array
  segments: SourceSegment[]
}

/**
 * One track of the snapshot, read into memory and still addressed by where it lies in the file.
 *
 * The addresses matter as much as the bytes: the plan names samples by them, the frame table
 * carries them through, and the export later asks the same file for the same ranges.
 */
async function load(
  reader: SnapshotReader,
  track: MaterialTrack,
  kind: TrackKind,
): Promise<Loaded> {
  const chunks = track.runs.flatMap((run) => run.chunks)
  const [initBytes, segments] = await Promise.all([
    reader.bytesOf(track.track.init),
    // One read for the whole run: the chunks of a track lie next to each other in the snapshot.
    reader.bytesOfMany(chunks.map((chunk) => chunk.source)),
  ])

  return {
    kind,
    initBytes,
    segments: segments.map((bytes, at) => ({
      bytes,
      at: chunks[at]!.source,
      ...(chunks[at]!.timestampOffset === undefined
        ? {}
        : { timestampOffset: chunks[at]!.timestampOffset }),
    })),
  }
}

/** The assembled file and its frame table, wrapped as the thing the player is handed. */
function previewOf(
  file: Uint8Array,
  frames: Frame[],
  frameSize: { width: number; height: number },
): Preview {
  const url = URL.createObjectURL(
    new Blob([file as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }),
  )

  return {
    url,
    bytes: file.byteLength,
    frameSize,
    frames: FrameTable.of(frames),
    release: () => URL.revokeObjectURL(url),
  }
}

interface MonitorSegment {
  bytes: Uint8Array
  timestampOffset: number
  window?: { start: number; end: number }
}

interface MonitorPart {
  mime: string
  initBytes: Uint8Array
  segments: MonitorSegment[]
}

interface MonitorStream {
  parts: MonitorPart[]
}

/** The MIME declaration Chromium expects beside an ISO init segment. */
function mimeOf(initBytes: Uint8Array): string | null {
  const picture = videoSampleEntry(initBytes)
  const sound = audioSampleEntry(initBytes)
  const video = picture ? decoderConfigOf(picture.bytes) : null
  const audio = sound ? audioDecoderConfig(sound) : null
  if ((picture && !video) || (sound && !audio)) return null
  const kind = picture ? 'video' : sound ? 'audio' : null
  if (!kind) return null
  const codecs = [video?.codec, audio?.codec].filter((codec): codec is string => Boolean(codec))
  return codecs.length ? `${kind}/mp4; codecs="${codecs.join(',')}"` : null
}

const append = (buffer: SourceBuffer, bytes: Uint8Array): Promise<void> =>
  new Promise((resolve, reject) => {
    const done = (): void => {
      cleanup()
      resolve()
    }
    const failed = (): void => {
      cleanup()
      reject(new Error('MediaSource rejected preview material'))
    }
    const cleanup = (): void => {
      buffer.removeEventListener('updateend', done)
      buffer.removeEventListener('error', failed)
    }
    buffer.addEventListener('updateend', done, { once: true })
    buffer.addEventListener('error', failed, { once: true })
    try {
      buffer.appendBuffer(bytes.slice().buffer as ArrayBuffer)
    } catch (cause) {
      cleanup()
      reject(cause)
    }
  })

async function appendStream(source: MediaSource, stream: MonitorStream): Promise<void> {
  const first = stream.parts[0]
  if (!first) return
  const buffer = source.addSourceBuffer(first.mime)
  let mime = first.mime

  for (const part of stream.parts) {
    if (part.mime !== mime) {
      if (typeof buffer.changeType !== 'function') throw new Error('MediaSource cannot change codec')
      buffer.changeType(part.mime)
      mime = part.mime
    }
    await append(buffer, part.initBytes)
    for (const segment of part.segments) {
      if (segment.window) {
        buffer.appendWindowEnd = segment.window.end
        buffer.appendWindowStart = segment.window.start
      }
      if (buffer.timestampOffset !== segment.timestampOffset) {
        buffer.timestampOffset = segment.timestampOffset
      }
      await append(buffer, segment.bytes)
    }
  }
}

/** One independently attachable replay of the captured SourceBuffer program. */
function mediaConsumer(streams: MonitorStream[], duration: number): PreviewConsumer {
  const source = new MediaSource()
  const url = URL.createObjectURL(source)
  let released = false

  source.addEventListener(
    'sourceopen',
    () => {
      void Promise.all(streams.map((stream) => appendStream(source, stream)))
        .then(() => {
          if (released || source.readyState !== 'open') return
          if (Number.isFinite(duration) && duration > 0) source.duration = duration
          source.endOfStream()
        })
        .catch(() => {
          if (!released && source.readyState === 'open') {
            try {
              source.endOfStream('decode')
            } catch {
              // The video element reports the decode failure; cleanup must not replace it.
            }
          }
        })
    },
    { once: true },
  )

  return {
    url,
    release: () => {
      if (released) return
      released = true
      URL.revokeObjectURL(url)
    },
  }
}

/**
 * The preview of material that arrived as an ordinary complete file.
 *
 * No init segment and no fragments to walk: the snapshot holds the file whole, its movie box
 * describes every sample of every track, and the index is read straight out of it. From there on
 * it is the same three steps as below — the export plan, the clip writer, the frame table retimed
 * to what the plan laid down — because the point of doing it this way round is that a preview and
 * a clip cannot come out differently.
 *
 * The whole of the material is read in one call. It is what the fragmented path does too, and for
 * an ordinary file there is nothing else to be done: the samples of every stretch lie in the one
 * `mdat`, and the file was copied into the snapshot precisely so that the editor would not have
 * to go back to somebody's server for them.
 */
async function fileMaterialPreview(
  reader: SnapshotReader,
  track: SnapshotTrack,
  whole: Located,
): Promise<Preview | null> {
  const bytes = await reader.bytesOf(whole)
  // Short of the file: the snapshot was truncated under us. A plan over it would name samples
  // that are not there, and the writer would throw halfway through a frame.
  if (bytes.byteLength !== whole.length) return null

  const from = track.init.at - whole.at
  const moov = bytes.subarray(from, from + track.init.length)

  // Addressed where the file actually lies, and not from its own first byte: the samples are
  // read back out of the snapshot, which has the index and everything before it in front.
  const source = clipSourceFrom(movieTracksOf(moov, whole.length, whole.at))
  if (!source) return null

  const plan = planPreview(source)
  const file = assembleMp4(plan, bytesFrom([whole], [bytes]))
  if (!file.byteLength) return null

  const shown = plan.tracks.find((one) => one.kind === 'video')
  return previewOf(
    file,
    shown ? retimeToPlan(framesOfTrack(source.video), shown) : [],
    { width: shown?.width ?? 0, height: shown?.height ?? 0 },
  )
}

function segmentByAddress(loaded: Loaded): Map<number, SourceSegment> {
  return new Map(loaded.segments.map((segment) => [segment.at.at, segment]))
}

const sampleKey = (sample: { source: Located }): string =>
  `${sample.source.at}:${sample.source.length}`

/** Audio appends retimed by the same kept-packet and common-seam policy as `planPreview`. */
function monitorAudioSegments(
  program: PictureProgram,
  frames: FrameTable,
  loaded: Loaded,
): MonitorSegment[] | null {
  const original = sourceTrackOf({
    kind: 'audio',
    initBytes: loaded.initBytes,
    segments: loaded.segments,
  })
  if (!original) return null

  const clock = audioMonitorClock(program, frames, original)
  const raw = new Map(original.samples.map((sample) => [sampleKey(sample), sample]))
  const output: MonitorSegment[] = []

  for (const segment of loaded.segments) {
    const inside = clock.audio.samples
      .filter(
        (sample) =>
          sample.source.at >= segment.at.at &&
          sample.source.at + sample.source.length <= segment.at.at + segment.at.length,
      )
      .sort((a, b) => a.dts - b.dts || a.pts - b.pts)
    if (!inside.length) continue

    const groups: typeof inside[] = []
    for (const sample of inside) {
      const originalSample = raw.get(sampleKey(sample))
      if (!originalSample) continue
      const correction = sample.pts - originalSample.pts
      const last = groups[groups.length - 1]
      const previous = last?.[last.length - 1]
      const previousRaw = previous ? raw.get(sampleKey(previous)) : undefined
      const previousCorrection = previous && previousRaw ? previous.pts - previousRaw.pts : correction
      const time = (sample.pts - clock.audio.editOffset) / clock.audio.timescale
      const previousTime = previous
        ? (previous.pts - clock.audio.editOffset) / clock.audio.timescale
        : time
      if (
        !last ||
        !previous ||
        sample.dts > previous.dts + previous.duration ||
        correction !== previousCorrection ||
        clock.shiftAt(time) !== clock.shiftAt(previousTime)
      ) groups.push([sample])
      else last.push(sample)
    }

    for (const group of groups) {
      const first = group[0]!
      const firstRaw = raw.get(sampleKey(first))!
      const start = (first.pts - clock.audio.editOffset) / clock.audio.timescale
      const end = Math.max(
        ...group.map(
          (sample) =>
            (sample.pts + sample.duration - clock.audio.editOffset) / clock.audio.timescale,
        ),
      )
      const shift = clock.shiftAt(start)
      const window = { start: Math.max(0, start + shift), end: end + shift }
      if (!(window.end > window.start)) continue
      output.push({
        bytes: segment.bytes,
        timestampOffset:
          (segment.timestampOffset ?? 0) +
          (first.pts - firstRaw.pts) / clock.audio.timescale +
          shift,
        window,
      })
    }
  }

  return output
}

/** A monitor of every ABR picture part. Clip indexing remains on `material.video`. */
async function compositeMonitorPreview(
  reader: SnapshotReader,
  material: Material,
  program: PictureProgram,
): Promise<Preview | null> {
  if (typeof MediaSource === 'undefined') return null

  const pictures = [
    ...new Map(program.parts.map((part) => [part.track.track.id, part.track])).values(),
  ]
  const loadedPictures = await Promise.all(
    pictures.map(async (track) => ({ track, loaded: await load(reader, track, 'video') })),
  )
  const loadedByTrack = new Map(
    loadedPictures.map((entry) => [entry.track.track.id, entry.loaded]),
  )

  const pictureFrameSources = loadedPictures.flatMap(({ track, loaded }) => {
    const declared = track.track.info.tracks.find((candidate) => candidate.kind === 'video')
    if (!declared || !(declared.timescale > 0)) return []
    return [
      {
        trackId: track.track.id,
        frames: framesOf({
          init: loaded.initBytes,
          trackId: declared.trackId,
          timescale: declared.timescale,
          segments: loaded.segments.map((segment) => ({
            bytes: segment.bytes,
            source: segment.at,
            ...(segment.timestampOffset
              ? { decodeTimeOffset: Math.round(segment.timestampOffset * declared.timescale) }
              : {}),
          })),
        }),
      },
    ]
  })
  const frames = compositeFrames(program, pictureFrameSources)
  if (!frames.count()) return null

  const pictureParts: MonitorPart[] = []
  for (const part of program.parts) {
    const loaded = loadedByTrack.get(part.track.track.id)
    const mime = loaded ? mimeOf(loaded.initBytes) : null
    if (!loaded || !mime || !MediaSource.isTypeSupported(mime)) return null
    const segments = segmentByAddress(loaded)
    pictureParts.push({
      mime,
      initBytes: loaded.initBytes,
      segments: part.chunks.flatMap((chunk) => {
        const segment = segments.get(chunk.source.at)
        return segment
          ? [{
              bytes: segment.bytes,
              timestampOffset:
                (chunk.timestampOffset ?? 0) + monitorShift(program, chunk.start),
              window: {
                start: part.start + monitorShift(program, part.start),
                end: part.end + monitorShift(program, part.end),
              },
            }]
          : []
      }),
    })
  }

  const streams: MonitorStream[] = [{ parts: pictureParts }]
  let bytes = loadedPictures.reduce(
    (sum, entry) =>
      sum +
      entry.loaded.initBytes.byteLength +
      entry.loaded.segments.reduce((track, segment) => track + segment.bytes.byteLength, 0),
    0,
  )

  if (material.audio?.span) {
    const sound = await load(reader, material.audio, 'audio')
    const mime = mimeOf(sound.initBytes)
    if (!mime || !MediaSource.isTypeSupported(mime)) return null
    const segments = monitorAudioSegments(program, frames, sound)
    if (!segments) return null
    streams.push({
      parts: [{
        mime,
        initBytes: sound.initBytes,
        segments,
      }],
    })
    bytes += sound.initBytes.byteLength
    for (const segment of sound.segments) bytes += segment.bytes.byteLength
  }

  const last = frames.at(frames.count() - 1)!
  const duration = last.out + last.duration
  const consumers = new Set<PreviewConsumer>()
  const openConsumer = (): PreviewConsumer => {
    const opened = mediaConsumer(streams, duration)
    const release = opened.release
    const tracked: PreviewConsumer = {
      url: opened.url,
      release: () => {
        consumers.delete(tracked)
        release()
      },
    }
    consumers.add(tracked)
    return tracked
  }
  const primary = openConsumer()
  const declared = material.video?.track.info.tracks.find((track) => track.kind === 'video')
  const selectedFrames = pictureFrameSources.find(
    (source) => source.trackId === material.video?.track.id,
  )?.frames ?? []
  const monitorPictures = program.parts.flatMap((part): MonitorPicture[] => {
    const info = part.track.track.info.tracks.find((track) => track.kind === 'video')
    return info
      ? [{
          trackId: part.track.track.id,
          representation: part.track.track.representation,
          start: part.start,
          end: part.end,
          codec: info.codec,
          width: info.width,
          height: info.height,
        }]
      : []
  })

  return {
    url: primary.url,
    bytes,
    frameSize: { width: declared?.width ?? 0, height: declared?.height ?? 0 },
    frames,
    editFrames: FrameTable.of(selectedFrames),
    monitor: { pictures: monitorPictures },
    openConsumer,
    release: () => {
      for (const consumer of [...consumers]) consumer.release()
    },
  }
}

/**
 * The file the editor plays.
 *
 * Assembled by the export plan and the clip writer — the same two the Export button uses, over the
 * whole of the material instead of a range of it. That is the point of it being this way round: a
 * preview built by some other muxer would be a second container with second rules, and a frame
 * that looked right in the tab would say nothing about the file on disk. Here it says everything.
 *
 * The gaps are closed by the plan, so the file is continuous and playback has nothing to jump.
 * Where a hole could not be closed — the picture stopped and the sound did not — the frame in
 * front of the seam simply lasts longer, which is what the recording actually contained.
 */
export async function buildPreview(
  reader: SnapshotReader,
  material: Material,
): Promise<Preview | null> {
  const picture = material.video
  if (!picture?.span) return null

  const program = pictureProgram(material)
  const pictureTracks = new Set(program.parts.map((part) => part.track.track.id))
  if (pictureTracks.size > 1) {
    const composite = await compositeMonitorPreview(reader, material, program)
    if (composite) return composite
  }

  // Material that was never intercepted, held in the snapshot as the file it came in.
  const whole = picture.track.whole
  if (whole) return fileMaterialPreview(reader, picture.track, whole)

  const declared = picture.track.info.tracks.find((track) => track.kind === 'video')
  if (!declared || !(declared.timescale > 0)) return null

  const loaded: Loaded[] = [await load(reader, picture, 'video')]
  // A muxed init carries the sound in these very segments under a track number of its own:
  // reading them a second time would double the peak for nothing.
  if (!material.audio && picture.kinds.includes('audio')) {
    loaded.push({ ...loaded[0]!, kind: 'audio' })
  }
  if (material.audio?.span) loaded.push(await load(reader, material.audio, 'audio'))

  const source = clipSourceOf(
    loaded.map(
      (one): SourceTrackInput => ({
        kind: one.kind,
        initBytes: one.initBytes,
        segments: one.segments,
      }),
    ),
  )
  if (!source) return null

  const plan = planPreview(source)

  // One address to one buffer, ascending: a muxed track appears twice in `loaded` and names the
  // same segments both times, and bytesFrom searches this list.
  const placed = [
    ...new Map(loaded.flatMap((one) => one.segments).map((one) => [one.at.at, one])).values(),
  ].sort((a, b) => a.at.at - b.at.at)

  const file = assembleMp4(
    plan,
    bytesFrom(
      placed.map((one) => one.at),
      placed.map((one) => one.bytes),
    ),
  )
  if (!file.byteLength) return null

  const shown = plan.tracks.find((track) => track.kind === 'video')
  const frames = shown
    ? retimeToPlan(
        framesOf({
          init: loaded[0]!.initBytes,
          trackId: declared.trackId,
          timescale: declared.timescale,
          segments: loaded[0]!.segments.map((one) => ({
            bytes: one.bytes,
            source: one.at,
            ...(one.timestampOffset
              ? { decodeTimeOffset: Math.round(one.timestampOffset * declared.timescale) }
              : {}),
          })),
        }),
        shown,
      )
    : []

  return previewOf(file, frames, { width: shown?.width ?? 0, height: shown?.height ?? 0 })
}
