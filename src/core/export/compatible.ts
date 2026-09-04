import { audioDecoderConfig } from '../codec/audio'
import { audioSampleEntry, videoSampleEntry } from '../iso/entry'

/** MP4 is a container. Premiere cannot import the VPx/AV1 and Opus tracks websites put in it. */
export function conversionNeeded(file: Uint8Array): { video: boolean; audio: boolean } {
  const video = videoSampleEntry(file)
  const audio = audioSampleEntry(file)
  const codec = audio && audioDecoderConfig(audio)?.codec
  return {
    video: video !== null && !['avc1', 'avc3', 'hvc1', 'hev1'].includes(video.format),
    // Vorbis can also be stored as mp4a: inspect the descriptor, not just the box name.
    audio: audio !== null && !(codec?.startsWith('mp4a.40.') || codec === 'mp3'),
  }
}

/** Load the converter only for files that need it, and only in extension-owned pages. */
export async function compatibleMp4(
  file: Uint8Array,
  stale: () => boolean = () => false,
): Promise<Uint8Array | null> {
  if (stale()) return null
  const needed = conversionNeeded(file)
  if (!needed.video && !needed.audio) return file
  const moduleUrl = chrome.runtime.getURL('shared/convert-mp4.js')
  const { convertMp4 } = await import(/* @vite-ignore */ moduleUrl) as typeof import('../../shared/convert-mp4')
  if (stale()) return null
  return convertMp4(file, needed, stale)
}
