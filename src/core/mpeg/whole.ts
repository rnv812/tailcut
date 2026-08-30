import { id3Length, walkMpegFrames, type MpegFrame, type MpegVersion, type MpegWalk } from './frames'
import type { RangeReader } from '../iso/locate'

/**
 * Indexing a soundtrack that is still on somebody's server, by ranged reads of its front.
 *
 * The same job `core/webm/whole.ts` does for a Matroska and for the same reason: the container
 * carries no table, so the only way to know where a frame lies is to walk to it. What is
 * different is how far the walk has to go, and it is the whole economy of this path — a clip of
 * a page that plays its sound apart is at most one turn of its picture long (see `SoundApart`),
 * so the head of the track is all that can ever be used and the head of the track is all that is
 * ever fetched. Measured on the fixture: three and a half seconds of a twenty-four second track
 * at 32 kbit is fourteen kilobytes, which is one request.
 *
 * This is not only an optimization. Downloading material the viewer did not watch is out of scope,
 * soundtrack is a music file: an extension that pulled the whole of one down every time it found
 * an `<audio>` beside a video would be a music downloader whatever it did with the bytes
 * afterwards.
 */

/**
 * How much the first read asks for, before anything is known about the stream.
 *
 * Thirty-two kilobytes is eight seconds at 32 kbit and one second at 256, and it is enough to
 * establish the rate the file is coded at — which is what the reads after it are sized from. A
 * fixed window would have to be wide enough for the worst case and would then fetch a quarter of
 * a megabyte of somebody's music to cut three seconds of it.
 */
export const FIRST_WINDOW_BYTES = 32 * 1024

/** The narrowest a later read may be: below this a request costs more than the bytes do. */
const MIN_WINDOW_BYTES = 16 * 1024

/** The widest, so that a stream whose bitrate reads as nonsense cannot ask for the whole file. */
const MAX_WINDOW_BYTES = 1024 * 1024

/**
 * The most this will read to index one soundtrack.
 *
 * A guard and not the working limit: what actually stops the walk is the length of the picture
 * the sound is being cut against. This is what stops a stream that states nonsense — a chain of
 * headers that never ends, a length field that never advances — from being followed for ever.
 */
export const MAX_SOUND_BYTES = 8 * 1024 * 1024

export interface SoundIndexOptions {
  windowBytes?: number
  maxBytes?: number
}

/**
 * Whether the front of a file looks like a bare MPEG audio stream rather than a container.
 *
 * An ID3 tag is decisive: nothing else on the web begins with those three letters. Failing that,
 * two frames in a row are — one header could be any two bytes with the top eleven bits set, and
 * a second one exactly where the first says the frame ends could not.
 */
export function beginsLikeMpegAudio(bytes: Uint8Array): boolean {
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true

  const walk = walkMpegFrames(bytes, 0, 0)
  return walk.frames.length + (walk.skipSamples > 0 ? 1 : 0) >= 2
}

/**
 * Walks the head of a soundtrack, as far as `seconds` of it reach.
 *
 * What comes back describes whole frames only, and it describes them where they lie in the file:
 * a save fetches them by those addresses and a byte out is a frame of somebody else's sound.
 *
 * null when the address holds no MPEG audio at all — a file that has moved, a host that answered
 * with a page of HTML, bytes in a container this does not read.
 */
export async function indexMpegStream(
  read: RangeReader,
  seconds: number,
  options: SoundIndexOptions = {},
): Promise<MpegWalk | null> {
  const fixed = options.windowBytes
  const ceiling = options.maxBytes ?? MAX_SOUND_BYTES

  const front = await read(0, Math.max(4096, fixed ?? FIRST_WINDOW_BYTES))
  if (!front.bytes.byteLength) return null

  let held = front.bytes
  let heldAt = 0
  let at = id3Length(held)

  // A tag longer than the window — an embedded cover is easily that — is stepped over rather
  // than searched through: the size it states is where the first frame stands.
  if (at >= held.byteLength) {
    const next = await read(at, Math.max(4096, fixed ?? FIRST_WINDOW_BYTES))
    if (!next.bytes.byteLength) return null
    heldAt = at
    held = next.bytes
  }

  const frames: MpegFrame[] = []
  let sampleRate = 0
  let channels = 0
  let version: MpegVersion = 1
  let skipSamples = 0
  let samples = 0
  let head = true
  /** Where the material begins, so that what has been read of it can be measured against time. */
  const from = at

  for (;;) {
    const walk = walkMpegFrames(held, at - heldAt, heldAt, { head })

    if (head) {
      if (!walk.sampleRate) return null
      sampleRate = walk.sampleRate
      channels = walk.channels
      version = walk.version
      skipSamples = walk.skipSamples
      head = false
    } else if (walk.sampleRate && (walk.sampleRate !== sampleRate || walk.channels !== channels)) {
      // The stream changed shape half way. One mp4 track states one rate and one channel count,
      // so what is kept is everything up to the change; see the same rule in walkMpegFrames.
      break
    }

    const began = at

    for (const frame of walk.frames) {
      // The clip cannot use a frame past the picture it is cut against, and a frame indexed is a
      // frame the save will fetch. Stopping here rather than at the end of the window is what
      // keeps a three-second clip from reading eighteen seconds of somebody's music.
      if (samples / sampleRate >= seconds) break
      frames.push(frame)
      samples += frame.samples
      at = frame.source.at + frame.source.length
    }

    if (samples / sampleRate >= seconds) break

    // Nothing was consumed: what stands here is not a frame of this stream, and no amount of
    // further reading will make it one. Measured against where this window began and not against
    // the running position, which the frames above have already carried to the same place.
    if (walk.at <= began) break
    at = walk.at

    if (at >= ceiling) break
    // The window reached the end of the file, and the walk stopped inside it: what is left is a
    // partial frame or a tag at the tail, and either way this is the end of the material.
    if (front.total > 0 && at >= front.total) break

    const next = await read(at, fixed ?? nextWindow(at - from, samples / sampleRate, seconds))
    if (!next.bytes.byteLength) break
    heldAt = at
    held = next.bytes
  }

  if (!frames.length) return null
  return { frames, at, sampleRate, channels, version, skipSamples }
}

/**
 * How much to ask for next, out of what the stream has cost per second so far.
 *
 * The rate is measured rather than read off a header, because a variable-rate file states one
 * nowhere and its frames differ: what is wanted is what this material actually weighs. A quarter
 * on top covers a stretch that is denser than the average, and the window it comes out to is one
 * request for the ordinary case — a fixed window would either cost several or fetch a quarter of
 * a megabyte to cut three seconds.
 */
function nextWindow(read: number, covered: number, wanted: number): number {
  const perSecond = covered > 0 ? read / covered : 0
  const left = Number.isFinite(wanted) ? Math.max(0, wanted - covered) : Infinity
  const needed = perSecond > 0 ? left * perSecond * 1.25 : Infinity

  return Math.min(MAX_WINDOW_BYTES, Math.max(MIN_WINDOW_BYTES, Math.ceil(needed)))
}
