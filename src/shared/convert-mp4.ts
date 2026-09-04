import {
  BufferSource, BufferTarget, Conversion, CustomSource, Input, MP4, Mp4OutputFormat, Output,
  canEncodeAudio,
} from 'mediabunny'
import { registerAacEncoder } from '@mediabunny/aac-encoder'
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

/** Convert only incompatible tracks. The original file never leaves this browser. */
export async function convertMp4(
  file: Uint8Array,
  needed: { video: boolean; audio: boolean },
  stale: () => boolean,
): Promise<Uint8Array | null> {
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
  let conversion: Conversion | undefined
  try {
    if (needed.audio && !aacRegistered) {
      const audio = await input.getPrimaryAudioTrack()
      if (audio && !await canEncodeAudio('aac', {
        sampleRate: audio.sampleRate,
        numberOfChannels: audio.numberOfChannels,
      })) {
        if (!aacRegistered) registerAacEncoder()
        aacRegistered = true
      }
    }
    if (stale()) return null
    conversion = await Conversion.init({
      input,
      output,
      trim: { start: 0 },
      video: needed.video ? { codec: 'avc' } : { discard: true },
      audio: needed.audio ? { codec: 'aac' } : { discard: true },
    })
    // A conversion can be "valid" after silently dropping its unsupported audio or video.
    if (!conversion.isValid || conversion.discardedTracks.some((track) => track.reason !== 'discarded_by_user')) {
      throw new Error('This browser could not convert the recording to H.264/AAC. Try updating Chrome.')
    }
    if (stale()) return null
    conversion.onProgress = () => {
      if (stale() && conversion!.state === 'executing') void conversion!.cancel()
    }
    await conversion.execute()
    if (stale()) return null
    if (!target.buffer?.byteLength) throw new Error('The compatible MP4 is empty.')
    const converted = new Uint8Array(target.buffer)
    return assembleCompatible(file, converted, needed, aacRegistered)
  } catch (error) {
    if (stale()) return null
    throw error
  } finally {
    if (conversion && conversion.state !== 'done' && conversion.state !== 'canceled') await conversion.cancel()
    input.dispose()
  }
}
