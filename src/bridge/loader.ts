import { PROBE_BYTES, locateMovie, type RangeRead, type RangeReader } from '../core/iso/locate'
import { plainFileOf, type OpenedFile } from '../core/export/plain'
import { matroskaFileOf } from '../core/export/matroska'
import { mpegSoundOf } from '../core/export/mpeg'
import { beginsLikeMpegAudio, indexMpegStream, FIRST_WINDOW_BYTES } from '../core/mpeg/whole'
import { beginsLikeMatroska, locateSegment } from '../core/webm/locate'
import { indexClusters } from '../core/webm/whole'
import type { SourceTrack } from '../core/export/plan'

/**
 * Reading pieces of somebody else's file, from the one place in the extension that is allowed to.
 *
 * This has to live on the extension origin and cannot live in the page. Measured over 57 attempts
 * on 29 live pages: a ranged fetch made from the page is refused 48 times, every one of them by
 * CORS, because the media sits on a CDN of an origin the page is not. The same requests from an
 * extension page holding `host_permissions: <all_urls>` succeeded on 15 hosts of 18, each
 * answering 206 with a Content-Range; the three failures were signed URLs that had expired, and
 * they fail from curl too.
 *
 * The bridge is such a page — an invisible iframe on the extension origin, already standing in
 * every frame of every tab — so the reads are made here and the bytes never cross an origin.
 */

/**
 * How long one read may take before it is given up on.
 *
 * A CDN that never answers would otherwise hold a save open for as long as the tab lives, with
 * the popup showing "Saving…" and nothing else ever happening.
 */
const READ_TIMEOUT_MS = 20_000

/**
 * How much a fallback read may pull down when the server refuses to range at all.
 *
 * A server answering 200 to a Range request has handed over the whole file and there is no way to
 * ask for less. Where what was wanted lies near the front — the box headers, a small movie box —
 * taking the prefix and dropping the connection costs little and gets the job done. Where it does
 * not, this is the line: pulling forty megabytes of material to reach a table behind it is the
 * download this whole design exists to avoid, and it is refused instead.
 */
const MAX_PREFIX_BYTES = 4 * 1024 * 1024

export interface LoaderOptions {
  /** Injected so that a test can answer without a network; the global otherwise. */
  fetch?: typeof fetch
  timeoutMs?: number
  maxPrefixBytes?: number
}

/** A read that could not be made: the reader throws this and the caller answers for it. */
export class ReadRefused extends Error {}

/** `bytes 0-8191/18003` — the one field of a 206 worth reading. */
export function totalFromContentRange(header: string | null): number {
  if (!header) return 0
  const match = /\/\s*(\d+)\s*$/.exec(header)
  return match ? Number(match[1]) : 0
}

/**
 * A reader of one file by ranges.
 *
 * Stateful in one respect, deliberately: the address it actually reads from. A file behind a
 * redirect — archive.org answers 302 to a CDN node, measured — loses its Range header on the way
 * and the redirect target answers 200 with the whole thing. The first such answer is not taken as
 * a refusal: the address the browser ended up at is remembered and asked again, ranged, and from
 * then on every read goes straight there. One wasted request per file, and only for the files
 * that need it.
 */
export function rangeReaderFor(url: string, options: LoaderOptions = {}): RangeReader {
  const call = options.fetch ?? globalThis.fetch.bind(globalThis)
  const timeout = options.timeoutMs ?? READ_TIMEOUT_MS
  const maxPrefix = options.maxPrefixBytes ?? MAX_PREFIX_BYTES

  /** Where the reads actually go: the address handed in until a redirect names another. */
  let target = url
  /** Whether the redirect has already been chased for this file. */
  let followed = false

  const ask = async (at: number, length: number): Promise<Response> => {
    const control = new AbortController()
    const expire = setTimeout(() => control.abort(), timeout)

    try {
      return await call(target, {
        headers: { Range: `bytes=${at}-${at + length - 1}` },
        // The page's own cookies: a file behind a session is the ordinary case on a site that
        // gates its media, and this is the same request the media element itself made.
        credentials: 'include',
        // A range answer must never come out of a cache that holds the whole file under this
        // address, or the reads would each be the file.
        cache: 'no-store',
        signal: control.signal,
      })
    } finally {
      clearTimeout(expire)
    }
  }

  return async (at, length): Promise<RangeRead> => {
    for (;;) {
      let answer: Response
      try {
        answer = await ask(at, length)
      } catch (cause) {
        throw new ReadRefused(`the read of ${url} failed: ${String(cause)}`)
      }

      if (answer.status === 206) {
        return {
          bytes: new Uint8Array(await answer.arrayBuffer()),
          // Content-Range and not Accept-Ranges: the latter is not reliably present on a 206, and
          // a reader that waited for it would take the slow walk over files that range perfectly.
          total: totalFromContentRange(answer.headers.get('content-range')),
        }
      }

      if (answer.status !== 200) {
        void answer.body?.cancel()
        throw new ReadRefused(`${url} answered ${answer.status} to a ranged read`)
      }

      // A whole-file answer. Either the server does not range, or a redirect ate the header on
      // the way to the node that does — and the second is worth one more request to find out.
      if (!followed && answer.url && answer.url !== target) {
        followed = true
        target = answer.url
        void answer.body?.cancel()
        continue
      }
      followed = true

      return await prefixOf(answer, at, length, maxPrefix, url)
    }
  }
}

/**
 * The wanted stretch out of a whole-file answer, and not one byte of the file behind it.
 *
 * The body is read as a stream and dropped the moment enough of it has gone by, so a server that
 * will not range still costs only what stands in front of what was asked for. What it cannot do
 * is reach past the ceiling: see MAX_PREFIX_BYTES.
 */
async function prefixOf(
  answer: Response,
  at: number,
  length: number,
  maxPrefix: number,
  url: string,
): Promise<RangeRead> {
  const total = Number(answer.headers.get('content-length') ?? 0)
  const end = at + length

  if (end > maxPrefix) {
    void answer.body?.cancel()
    throw new ReadRefused(`${url} will not answer a ranged read, and the range is too far in`)
  }

  const reader = answer.body?.getReader()
  if (!reader) {
    const all = new Uint8Array(await answer.arrayBuffer())
    return { bytes: all.subarray(Math.min(at, all.byteLength), Math.min(end, all.byteLength)), total }
  }

  const parts: Uint8Array[] = []
  let held = 0

  while (held < end) {
    const step = await reader.read()
    if (step.done) break
    parts.push(step.value)
    held += step.value.byteLength
  }
  void reader.cancel()

  const front = new Uint8Array(held)
  let write = 0
  for (const part of parts) {
    front.set(part, write)
    write += part.byteLength
  }

  return {
    bytes: front.subarray(Math.min(at, front.byteLength), Math.min(end, front.byteLength)),
    total: total > 0 ? total : 0,
  }
}

/**
 * Opens an ordinary file, in whichever of the two containers the web delivers it in, and hands
 * back the reader its material will come through.
 *
 * Which container it is, is settled by the first four bytes of the front of the file — `1A 45 DF
 * A3` is a Matroska and anything else is tried as an mp4 — and that front is read once and lent
 * to whichever walk follows. Both walks would otherwise begin by probing the same eight kilobytes
 * they have just been handed, and an mp4 would pay a whole extra request for the privilege of
 * being told it is not a Matroska.
 *
 * What the two then cost is not the same, and the difference belongs to the containers rather
 * than to this code. An mp4 states every sample of every track in the tables of its movie box:
 * two ranged reads of a few kilobytes, and the file is indexed with no material touched. A
 * Matroska has no such table anywhere — a frame is described by the block header immediately in
 * front of it — so its clusters have to be walked, and walking them means reading them. See
 * src/core/webm/whole.ts, where that cost is bounded and stated.
 *
 * Null when the file cannot be read at all: an address that has expired, a host that refuses the
 * range and hides the tables behind the material, a Matroska past the ceiling, bytes that are
 * neither container.
 */
export async function openPlainFile(url: string, options: LoaderOptions = {}): Promise<OpenedFile | null> {
  const read = rangeReaderFor(url, options)

  try {
    const front = await read(0, PROBE_BYTES)
    const withFront = lending(read, front)

    const file = beginsLikeMatroska(front.bytes)
      ? await openMatroska(withFront, front.total)
      : await openMovie(withFront)

    return file ? { file, read } : null
  } catch {
    // Every refusal a read can answer with — an expired signed URL, a CORS answer from a host no
    // permission covers, a server that will not range. There is no half-open file: either the
    // tables are in hand or this source is one the extension cannot offer.
    return null
  }
}

/** A soundtrack opened for reading: the track it holds, and the reader its material comes by. */
export interface OpenedSound {
  track: SourceTrack
  read: RangeReader
}

/**
 * Opens the soundtrack a page is playing beside a picture that has none (`SoundApart`).
 *
 * `seconds` is how much of it can ever be used — the length of the picture it will be laid
 * against — and it is the bound on what is read as well as on what is indexed. The whole of
 * somebody's music file is never fetched: measured on the fixture, three and a half seconds of a
 * twenty-four second track is one request of fourteen kilobytes.
 *
 * Three containers are tried in the order the front of the file settles: a bare MPEG audio stream,
 * which is what the site the survey found this shape on serves; a Matroska; an mp4. The last two
 * go through the very readers an ordinary file goes through, and what is taken out of them is the
 * first sound track — an m4a beside a video is a soundtrack like any other, and there is nothing
 * about this road that is particular to mp3.
 *
 * Null when there is no sound to be had: an address that has expired, a host that will not range,
 * a file this cannot read, a protected one.
 */
export async function openSoundFile(
  url: string,
  seconds: number,
  options: LoaderOptions = {},
): Promise<OpenedSound | null> {
  const read = rangeReaderFor(url, options)

  try {
    const front = await read(0, FIRST_WINDOW_BYTES)
    const withFront = lending(read, front, FIRST_WINDOW_BYTES)

    if (beginsLikeMpegAudio(front.bytes)) {
      const walk = await indexMpegStream(withFront, seconds)
      const track = walk && mpegSoundOf(walk)
      return track ? { track, read } : null
    }

    const file = beginsLikeMatroska(front.bytes)
      ? await openMatroska(withFront, front.total)
      : await openMovie(withFront)

    if (!file || file.encrypted) return null

    const track = file.tracks.find((candidate) => candidate.kind === 'audio')
    return track ? { track, read } : null
  } catch {
    return null
  }
}

/** An mp4: the movie box, and the six tables of every track in it. */
async function openMovie(read: RangeReader): Promise<OpenedFile['file'] | null> {
  const found = await locateMovie(read)
  return found ? plainFileOf(found.moov, found.total) : null
}

/**
 * A Matroska: the head, then every frame of every cluster.
 *
 * The last read is the one that describes the picture — a vpcC is written out of the first
 * keyframe, because a Matroska says nothing about the shape of a VP8 or VP9 stream and the
 * bitstream is the only place the answer exists. One read per picture track, of one frame.
 */
async function openMatroska(read: RangeReader, total: number): Promise<OpenedFile['file'] | null> {
  const found = await locateSegment(read)
  if (!found) return null

  const frames = await indexClusters(read, found)
  if (!frames) return null

  return await matroskaFileOf(found.head, frames, found.total || total, async (at) => {
    const answer = await read(at.at, at.length)
    return answer.bytes.byteLength >= at.length ? answer.bytes : null
  })
}

/**
 * A reader with the front of the file already in hand.
 *
 * Anything that lies inside what has been read is answered out of it; everything else goes to the
 * host. The one subtlety is a file shorter than the probe: the answer came back short because
 * there is no more of it, and a request past its end must be answered with what there is rather
 * than sent to the host to be answered the same way again — which is why `asked` has to be the
 * length that was actually asked for and not a constant.
 */
function lending(read: RangeReader, front: RangeRead, asked = PROBE_BYTES): RangeReader {
  const held = front.bytes
  const complete = held.byteLength < asked

  return async (at, length) => {
    if (at >= 0 && (at + length <= held.byteLength || (complete && at <= held.byteLength))) {
      return {
        bytes: held.subarray(at, Math.min(at + length, held.byteLength)),
        total: front.total,
      }
    }

    return await read(at, length)
  }
}
