import {
  BufferSource, BufferTarget, Conversion, CustomSource, Input, MP4, Mp4OutputFormat, Output,
  canEncodeAudio, canEncodeVideo, type DiscardedTrack, type InputVideoTrack,
} from 'mediabunny'
import { registerAacEncoder } from '@mediabunny/aac-encoder'
import { keptOriginal, type CompatibleMp4 } from '../core/export/compatible'
import { audioSampleEntry, trackIdOf, videoSampleEntry } from '../core/iso/entry'
import { boxBody, childBoxes, findBox } from '../core/iso/reader'
import { movieTracksOf } from '../core/export/source'
import { buildProgressiveMp4 } from '../core/iso/progressive'

let aacRegistered = false

/** Preserve a leading empty edit, which the capture-oriented sample index does not retain. */
function delayTicks(file: Uint8Array, id: number, timescale: number): number {
  const moov = findBox(file, ['moov'])!
  const header = boxBody(file, findBox(file, ['moov', 'mvhd'])!)
  const movie = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const movieScale = movie.getUint32(header[0] === 1 ? 20 : 12)
  for (const trak of childBoxes(file, moov).filter((box) => box.type === 'trak')) {
    const children = childBoxes(file, trak)
    const tkhd = children.find((box) => box.type === 'tkhd')!
    if (trackIdOf(file, tkhd) !== id) continue
    const edts = children.find((box) => box.type === 'edts')
    const elst = edts && childBoxes(file, edts).find((box) => box.type === 'elst')
    if (!elst) return 0
    const bytes = boxBody(file, elst)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const wide = bytes[0] === 1
    let ticks = 0
    for (let i = 0, at = 8; i < view.getUint32(4); i++, at += wide ? 20 : 12) {
      const media = wide ? view.getBigInt64(at + 8) : BigInt(view.getInt32(at + 4))
      if (media !== -1n) break
      ticks += wide ? Number(view.getBigUint64(at)) : view.getUint32(at)
    }
    return Math.round(ticks * timescale / movieScale)
  }
  return 0
}

/** Copy compatible tracks verbatim and replace only the tracks we asked the converter to encode. */
function assembleCompatible(
  original: Uint8Array,
  converted: Uint8Array,
  needed: { video: boolean; audio: boolean },
  softwareAac: boolean,
): Uint8Array {
  const convertedTracks = movieTracksOf(converted, converted.byteLength)
  return buildProgressiveMp4(movieTracksOf(original, original.byteLength).map((sourceTrack, index) => {
    const replace = needed[sourceTrack.kind]
    const track = replace ? convertedTracks.find((one) => one.kind === sourceTrack.kind) : sourceTrack
    if (!track) throw new Error(`The compatible MP4 is missing its ${sourceTrack.kind} track.`)
    const file = replace ? converted : original
    const entry = (track.kind === 'audio' ? audioSampleEntry(file) : videoSampleEntry(file))!
    // The bundled AAC encoder emits 1024 priming samples. Mediabunny uses the audio
    // sample rate as its MP4 timescale, so each decoded sample is exactly one tick.
    const priming = replace && track.kind === 'audio' && softwareAac ? 1024 : 0
    return {
      trackId: index + 1,
      kind: track.kind,
      timescale: track.timescale,
      sampleEntry: track.sampleEntry,
      width: track.width,
      height: track.height,
      samples: track.samples.map((sample) => ({
        bytes: file.subarray(sample.source.at, sample.source.at + sample.source.length),
        duration: sample.duration,
        cts: sample.pts - sample.dts,
        sync: sample.sync,
      })),
      skipTicks: Math.max(0, track.editOffset) + priming,
      delayTicks: delayTicks(file, entry.trackId, track.timescale),
    }
  }))
}

/**
 * The picture size the H.264 encoder is asked for: the square-pixel size, made even.
 *
 * H.264 in 4:2:0 codes the chroma at half the size, so an odd side cannot be encoded, and
 * mediabunny refuses an odd `avc` size outright rather than asking the browser. Odd sizes are
 * ordinary on the web: 853×481 is a 16:9 picture scaled to 481 lines, and a 640×480 picture with
 * a 4:3 pixel aspect is 853 square pixels wide, which is the size mediabunny encodes it at. Left
 * to the defaults, both were discarded as "no encodable target codec". One pixel off the odd
 * side is a scale nobody can see; the alternative was no conversion at all.
 *
 * In the space mediabunny's own `width` and `height` are in: after the rotation of the track.
 */
async function evenSize(track: InputVideoTrack): Promise<{ width: number; height: number }> {
  const turned = (await track.getRotation()) % 180 !== 0
  const across = await track.getSquarePixelWidth()
  const down = await track.getSquarePixelHeight()
  const [width, height] = turned ? [down, across] : [across, down]
  const even = (side: number): number => Math.max(2, side - (side % 2))
  return { width: even(width), height: even(height) }
}

/** Why mediabunny set a track aside, in the words the row shows. */
function discardReason(dropped: DiscardedTrack): string {
  const picture = dropped.track.type === 'video'
  switch (dropped.reason) {
    case 'undecodable_source_codec':
      return `this browser cannot decode the ${picture ? 'picture' : 'sound'}`
    case 'no_encodable_target_codec':
      return picture ? 'this browser has no H.264 encoder' : 'this browser has no AAC encoder'
    default:
      return `this browser could not convert the ${picture ? 'picture' : 'sound'} (${dropped.reason})`
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Convert only incompatible tracks. The original file never leaves this browser.
 *
 * Answers the original file with a note whenever the conversion cannot be done — no encoder, no
 * decoder, a conversion that failed half way — and null only when called off (see `keptOriginal`
 * for why a file that plays beats no file).
 *
 * All or nothing: when one track that needs converting cannot be, nothing is converted. VP9 with
 * its Opus made into AAC is still a file Premiere refuses, so converting the sound alone would
 * spend a lossy encode, and the time it takes, on a file no more importable than before — while
 * the original is the recording byte for byte. The same holds the other way round, for an H.264
 * picture made of VP9 beside a sound this browser cannot encode.
 */
export async function convertMp4(
  file: Uint8Array,
  needed: { video: boolean; audio: boolean },
  stale: () => boolean,
): Promise<CompatibleMp4 | null> {
  // MP4 edit lists already locate and trim the Opus preroll. WebCodecs also applies dOps
  // pre-skip, but leaves the decoded timestamps unadjusted. Decode the complete packets
  // so the edit list alone trims them. Replace just those two header bytes in reads,
  // leaving the original export buffer and its media data untouched.
  const dOps = needed.audio ? audioSampleEntry(file)?.children.get('dOps') : undefined
  const preSkipAt = dOps && dOps.length >= 4 ? dOps.byteOffset - file.byteOffset + 2 : null
  const source = preSkipAt === null ? new BufferSource(file) : new CustomSource({
    getSize: () => file.byteLength,
    read(start, end) {
      const bytes = file.subarray(start, end)
      if (end <= preSkipAt || start >= preSkipAt + 2) return bytes
      const patched = bytes.slice()
      for (let at = Math.max(start, preSkipAt); at < Math.min(end, preSkipAt + 2); at++) {
        patched[at - start] = 0
      }
      return patched
    },
  })
  const input = new Input({ source, formats: [MP4] })
  const target = new BufferTarget()
  const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: 'in-memory' }) })
  const kept = (why: string): CompatibleMp4 => keptOriginal(file, needed, why)
  let conversion: Conversion | undefined
  try {
    // Asked before anything is decoded, the encoder first: that is the answer on a browser built
    // without one, and the one a user can act on.
    let size: { width: number; height: number } | undefined
    if (needed.video) {
      const video = await input.getPrimaryVideoTrack()
      if (!video) return kept('this browser could not read the picture')
      size = await evenSize(video)
      if (!await canEncodeVideo('avc', size)) return kept('this browser has no H.264 encoder')
      if (stale()) return null
      if (!await video.canDecode()) return kept('this browser cannot decode the picture')
    }
    if (needed.audio) {
      const audio = await input.getPrimaryAudioTrack()
      if (!audio) return kept('this browser could not read the sound')
      const config = { sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels }
      // The bundled WebAssembly encoder stands in for a browser with no AAC encoder of its own.
      if (!aacRegistered && !await canEncodeAudio('aac', config)) {
        registerAacEncoder()
        aacRegistered = true
      }
      if (!await canEncodeAudio('aac', config)) return kept('this browser has no AAC encoder')
      if (stale()) return null
      if (!await audio.canDecode()) return kept('this browser cannot decode the sound')
    }
    if (stale()) return null
    conversion = await Conversion.init({
      input,
      output,
      trim: { start: 0 },
      // `fill`, which mediabunny insists on once both sides are given: the box differs from the
      // picture by the one pixel at most, so stretching is invisible where `contain` would
      // letterbox a line and `cover` would crop one.
      video: size ? { codec: 'avc', ...size, fit: 'fill' } : { discard: true },
      audio: needed.audio ? { codec: 'aac' } : { discard: true },
    })
    // A conversion can be "valid" after silently dropping its unsupported audio or video.
    const dropped = conversion.discardedTracks.find((track) => track.reason !== 'discarded_by_user')
    if (dropped) return kept(discardReason(dropped))
    if (!conversion.isValid) return kept('this browser could not convert it to H.264/AAC')
    if (stale()) return null
    conversion.onProgress = () => {
      if (stale() && conversion!.state === 'executing') void conversion!.cancel()
    }
    await conversion.execute()
    if (stale()) return null
    if (!target.buffer?.byteLength) return kept('the conversion to H.264/AAC came out empty')
    const converted = new Uint8Array(target.buffer)
    return { file: assembleCompatible(file, converted, needed, aacRegistered) }
  } catch (error) {
    if (stale()) return null
    // An encoder that said it could and then would not start lands here, and so does a decode
    // error half way through. The original is untouched by either.
    return kept(`the conversion to H.264/AAC failed (${messageOf(error)})`)
  } finally {
    // Closed before the run lets go of its lane: the next encode starts only after this one's
    // codecs are gone (see `startable`), and a cancel that threw must not undo that.
    if (conversion && conversion.state !== 'done' && conversion.state !== 'canceled') {
      await conversion.cancel().catch(() => undefined)
    }
    input.dispose()
  }
}
