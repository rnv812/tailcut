import { locateMovie, type RangeRead, type RangeReader } from '../core/iso/locate'
import { plainFileOf, type OpenedFile } from '../core/export/plain'

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
 * Opens an ordinary file: finds its movie box, indexes it, and hands back the reader its material
 * will come through.
 *
 * The whole cost of learning what a file holds — two ranged requests of a few kilobytes on the
 * ordinary layout, one where the movie box was written at the front. Null when the file cannot be
 * read at all: an address that has expired, a host that refuses the range and hides its tables
 * behind the material, bytes that are not an mp4.
 */
export async function openPlainFile(url: string, options: LoaderOptions = {}): Promise<OpenedFile | null> {
  const read = rangeReaderFor(url, options)

  try {
    const found = await locateMovie(read)
    if (!found) return null

    const file = plainFileOf(found.moov, found.total)
    return file ? { file, read } : null
  } catch {
    // Every refusal a read can answer with — an expired signed URL, a CORS answer from a host no
    // permission covers, a server that will not range. There is no half-open file: either the
    // tables are in hand or this source is one the extension cannot offer.
    return null
  }
}
