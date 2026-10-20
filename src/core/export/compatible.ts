import { audioDecoderConfig } from '../codec/audio'
import { audioSampleEntry, videoSampleEntry } from '../iso/entry'
import type { ExportPlan } from './plan'

/** What the row says about a clip the encoder could only write as VP9. */
export const ENCODED_AS_VP9 =
  'Encoded as VP9 in MP4 — no H.264 encoder works in this browser, so Premiere and QuickTime cannot open it.'

/** Pictures Premiere imports out of an mp4, by the four letters of their sample entry. */
const IMPORTED_PICTURES = ['avc1', 'avc3', 'hvc1', 'hev1']

/** MP4 is a container. Premiere cannot import the VPx/AV1 and Opus tracks websites put in it. */
export function conversionNeeded(file: Uint8Array): { video: boolean; audio: boolean } {
  const video = videoSampleEntry(file)
  const audio = audioSampleEntry(file)
  const codec = audio && audioDecoderConfig(audio)?.codec
  return {
    video: video !== null && !IMPORTED_PICTURES.includes(video.format),
    // Vorbis can also be stored as mp4a: inspect the descriptor, not just the box name.
    audio: audio !== null && !(codec?.startsWith('mp4a.40.') || codec === 'mp3'),
  }
}

/**
 * Whether a copy of this plan will have its picture re-encoded on the way out.
 *
 * Asked when the clip is queued, before a byte is read, so it is answered off the sample entry
 * the plan already carries — the same four letters `conversionNeeded` reads off the file. Only
 * the picture counts: a sound alone is converted in a fraction of the time and memory, and does
 * not need the encode lane.
 */
export function convertsPicture(plan: ExportPlan): boolean {
  return plan.tracks.some((track) => {
    if (track.kind !== 'video' || track.sampleEntry.byteLength < 8) return false
    const format = String.fromCharCode(...track.sampleEntry.subarray(4, 8))
    return !IMPORTED_PICTURES.includes(format)
  })
}

/**
 * An mp4 on its way to the browser, and what the row should say about it.
 *
 * `note` is set only when the file kept codecs Premiere cannot import.
 */
export interface CompatibleMp4 {
  file: Uint8Array
  note?: string
}

const PICTURE_NAMES: Record<string, string> = { vp09: 'VP9', vp08: 'VP8', av01: 'AV1' }
const SOUND_NAMES: Record<string, string> = { opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC' }

/** The codecs that keep this file out of Premiere, in the words a person knows them by. */
function blockingCodecs(file: Uint8Array, needed: { video: boolean; audio: boolean }): string[] {
  const names: string[] = []
  const video = needed.video ? videoSampleEntry(file) : null
  if (video) names.push(PICTURE_NAMES[video.format] ?? video.format)
  const audio = needed.audio ? audioSampleEntry(file) : null
  if (audio) {
    const codec = audioDecoderConfig(audio)?.codec
    names.push((codec && SOUND_NAMES[codec]) ?? codec ?? audio.format)
  }
  return names
}

/**
 * The original file, saved as it is, with the reason it could not be made importable.
 *
 * This is what a failed conversion answers instead of an error. The user asked for a clip, and
 * the clip is right here in the codecs it was recorded in — every player opens those, and only
 * Premiere does not. Throwing it away over the conversion would trade a file that plays for no
 * file at all; Yandex Browser, built without an H.264 encoder, would lose nearly every clip of
 * YouTube that way. What the user is owed instead is the truth about it, on the row.
 */
export function keptOriginal(
  file: Uint8Array,
  needed: { video: boolean; audio: boolean },
  why: string,
): CompatibleMp4 {
  const names = blockingCodecs(file, needed)
  const what = names.length ? `the original ${names.join('/')}` : 'its original codecs'
  return { file, note: `Saved with ${what} — Premiere cannot import it: ${why}.` }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Load the converter only for files that need it, and only in extension-owned pages.
 *
 * Never rejects for want of a codec: a conversion that cannot be done answers the file it was
 * given with a note (see `keptOriginal`), and null only when the export was called off.
 */
export async function compatibleMp4(
  file: Uint8Array,
  stale: () => boolean = () => false,
): Promise<CompatibleMp4 | null> {
  if (stale()) return null
  const needed = conversionNeeded(file)
  if (!needed.video && !needed.audio) return { file }
  try {
    const moduleUrl = chrome.runtime.getURL('shared/convert-mp4.js')
    const { convertMp4 } = await import(/* @vite-ignore */ moduleUrl) as typeof import('../../shared/convert-mp4')
    if (stale()) return null
    return await convertMp4(file, needed, stale)
  } catch (error) {
    // The converter answers its own failures as a kept original; what lands here is the module
    // that would not load, or a defect in it. The same answer, for the same reason.
    if (stale()) return null
    return keptOriginal(file, needed, `the conversion to H.264/AAC failed (${messageOf(error)})`)
  }
}
