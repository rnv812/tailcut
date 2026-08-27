import { concatBytes } from './writer'

/**
 * Finding the movie box of a file without downloading the file.
 *
 * An ordinary `<video src>` is delivered whole, and the whole of it is the last thing we want:
 * the tables that say what the file holds are a few kilobytes, and the material they describe is
 * everything else. So the front of the file is read, the top-level boxes are stepped over by the
 * lengths they state, and only the `moov` is actually fetched.
 *
 * Two layouts and two costs, both measured against tests/fixtures/plain:
 *
 * - **ftyp, moov, …** — written for streaming, so the movie box is in the first read and the
 *   whole walk is one request.
 * - **ftyp, free, mdat, moov** — where a muxer leaves it when nobody asks otherwise. The first
 *   read learns how long the `mdat` is without reading a byte of it, and the second asks for
 *   everything from its end to the end of the file. Two requests, and the material is never
 *   touched.
 *
 * The reader is handed in rather than made here: the fetch has to happen on the extension origin
 * — from the page it is refused, measured as 48 CORS refusals out of 57 — and this module has no
 * business knowing that. See src/bridge/loader.ts for the other half.
 */

/** What one ranged read answered. */
export interface RangeRead {
  /** The bytes that came back. Shorter than asked for at the end of the file. */
  bytes: Uint8Array
  /**
   * Length of the whole file, out of the `Content-Range` of a 206; zero when the answer stated
   * none.
   *
   * `Content-Range` and not `Accept-Ranges`, which is not reliably present on a 206 — measured.
   * Without it the walk loses its one shortcut and steps from box to box instead, which is
   * slower and still arrives.
   */
  total: number
}

export type RangeReader = (at: number, length: number) => Promise<RangeRead>

/**
 * How much of the front of a file the first read asks for.
 *
 * Small on purpose. Its job is the handful of box headers at the front, not the movie box: on the
 * ordinary layout every byte of it past the first forty is `mdat`, which is the material we are
 * going to all this trouble not to download. A movie box that happens to fit inside it is a bonus
 * and saves the second request; one that does not costs the same second request either way.
 */
export const PROBE_BYTES = 8192

/**
 * How many reads the walk may make before giving up.
 *
 * A file of the ordinary shape is found in two. The ceiling is for the other kind — a file whose
 * front is a long parade of small boxes, or bytes that are not a file at all and step forward
 * eight at a time. Without it a page could hold a tab in a loop of requests.
 */
const MAX_REQUESTS = 12

/**
 * Largest movie box this reader will agree to hold in memory.
 *
 * A header may claim any length at all, and fetching it is agreeing to allocate that much. Sixty-
 * four megabytes is far past any real one — a table costs a dozen bytes a sample, so this is tens
 * of hours of material — and the point is that the refusal is stated here rather than discovered
 * when the tab dies.
 */
const MAX_MOOV_BYTES = 64 * 1024 * 1024

export interface FoundMovie {
  /** Where the box begins, counted from the first byte of the file. */
  at: number
  /** The box itself, header and all. */
  moov: Uint8Array
  /** Length of the whole file where the answers stated one, and zero where they did not. */
  total: number
  /** How many ranged reads it took. */
  requests: number
}

export interface LocateOptions {
  /** How much to ask for in one speculative read; PROBE_BYTES unless a test says otherwise. */
  window?: number
  maxRequests?: number
  /** Ceiling on the size of the movie box, in bytes. */
  limit?: number
}

/** A box header, as much of it as could be read. */
interface Header {
  type: string
  /** Full length of the box, header included; zero when the header says "to the end of the file". */
  size: number
}

export async function locateMovie(
  read: RangeReader,
  options: LocateOptions = {},
): Promise<FoundMovie | null> {
  const window = Math.max(16, options.window ?? PROBE_BYTES)
  const maxRequests = options.maxRequests ?? MAX_REQUESTS
  const limit = options.limit ?? MAX_MOOV_BYTES

  let requests = 0
  let total = 0
  let held: Uint8Array = new Uint8Array(0)
  let heldAt = 0

  const fetchAt = async (from: number, length: number): Promise<Uint8Array | null> => {
    if (requests >= maxRequests) return null
    requests += 1
    const answer = await read(from, Math.max(1, length))
    if (total === 0 && answer.total > 0) total = answer.total
    return answer.bytes
  }

  /**
   * Whatever it takes to read the header at `at`.
   *
   * Sixteen bytes and not eight: a box may state its length in sixty-four of them, and a reader
   * that took the four-byte 1 for a length would step one byte forward and never arrive. Eight
   * will do only where the file is known to end within the next sixteen.
   */
  const reach = async (at: number): Promise<boolean> => {
    const has = (want: number): boolean =>
      at >= heldAt && at + want <= heldAt + held.byteLength

    if (has(16)) return true
    if (has(8) && total > 0 && at + 16 > total) return true
    if (total > 0 && at >= total) return false

    // Never more than one window at a time: the box under `at` may be a gigabyte of material, and
    // the point of this walk is that its bytes are never asked for.
    const length = total > 0 ? Math.min(total - at, window) : window
    const bytes = await fetchAt(at, length)
    if (!bytes) return false

    held = bytes
    heldAt = at
    return held.byteLength >= 8
  }

  const headerAt = (at: number): Header | null => {
    const from = at - heldAt
    const view = new DataView(held.buffer, held.byteOffset, held.byteLength)
    if (from + 8 > held.byteLength) return null

    let size = view.getUint32(from)
    const type = String.fromCharCode(
      held[from + 4]!, held[from + 5]!, held[from + 6]!, held[from + 7]!,
    )

    if (size === 1) {
      if (from + 16 > held.byteLength) return null
      size = Number(view.getBigUint64(from + 8))
      // A large header states the whole length including its own sixteen bytes.
      if (size < 16) return null
    } else if (size === 0) {
      // "To the last byte there is", legal for the final box alone. Only the stated length of the
      // file says where that is; where nothing stated one, it is settled when the box is fetched.
      size = total > 0 ? total - at : 0
    } else if (size < 8) {
      // A body of negative length. Stepping by it walks backwards, and bytes that are not a file
      // at all end up here.
      return null
    }

    return { type, size }
  }

  let at = 0

  while (await reach(at)) {
    const header = headerAt(at)
    if (!header) return null

    if (header.type === 'moov') {
      const moov = await collect(at, header.size)
      return moov ? { at, moov, total, requests } : null
    }

    // A final box of unstated length that is not the movie box: there is nothing behind it.
    if (header.size === 0) return null
    at += header.size
  }

  return null

  /** The movie box whole, fetching whatever of it is not held already. */
  async function collect(from: number, size: number): Promise<Uint8Array | null> {
    if (size > limit) return null

    const have = Math.max(0, Math.min(heldAt + held.byteLength, from + (size || limit)) - from)
    const head = held.subarray(from - heldAt, from - heldAt + have)
    // A size of zero with no stated length of the file: the box runs to the end, wherever that
    // is, so what is asked for is the ceiling and what arrives is the box.
    const want = size === 0 ? limit - have : size - have
    if (want <= 0) return head

    const rest = await fetchAt(from + have, want)
    if (!rest) return null
    if (size !== 0 && rest.byteLength < want) return null

    return concatBytes([head, rest])
  }
}
