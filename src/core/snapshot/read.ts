import { adler32, decodeFooter, decodeIndex, FOOTER_BYTES, type SnapshotIndex } from './format'
import type { Located } from '../../shared/types'

/**
 * Access to a stretch of the snapshot file. Injected rather than opened here: core does no
 * storage, and the editor hands over a Blob slice while the tests hand over a subarray.
 */
export type ReadRange = (at: number, length: number) => Promise<Uint8Array>

/**
 * The snapshot, opened for reading.
 *
 * The file is immutable from the moment its footer is written, and that is a requirement of the
 * format rather than a habit: the Blob a reader holds is invalidated by any modification of the
 * file underneath it. Nothing here writes, and the writer never comes back to a finished file.
 */
export class SnapshotReader {
  private constructor(
    private readonly read: ReadRange,
    readonly index: SnapshotIndex,
  ) {}

  /**
   * Reads the trailer, then the index, and nothing else — a hundred megabytes of material stay on
   * disk until a clip asks for them. null means the file is not a finished snapshot: a writer cut
   * off partway, a version from the future, or bytes that are not a snapshot at all. The caller
   * shows that state; it does not retry.
   */
  static async open(read: ReadRange, size: number): Promise<SnapshotReader | null> {
    if (size < FOOTER_BYTES) return null

    try {
      const footer = decodeFooter(await read(size - FOOTER_BYTES, FOOTER_BYTES), size)
      if (!footer) return null

      const bytes = await read(footer.index.at, footer.index.length)
      if (bytes.byteLength !== footer.index.length) return null
      if (adler32(bytes) !== footer.checksum) return null

      const index = decodeIndex(bytes)
      return index ? new SnapshotReader(read, index) : null
    } catch {
      // Storage is best-effort: the browser is within its rights to reclaim the file between the
      // tab opening and this read. A snapshot that is gone is a state of the editor, not a crash.
      return null
    }
  }

  bytesOf(loc: Located): Promise<Uint8Array> {
    return this.read(loc.at, loc.length)
  }

  /**
   * Several ranges at once, with the ones that touch merged into a single read.
   *
   * The chunks of one track lie next to each other in the file — that is how planSnapshot lays
   * them out — so a whole run comes back in one call instead of one per segment. Measured on the
   * real shape of the data: 25 segments, 4.9 MiB, two milliseconds.
   */
  async bytesOfMany(locs: Located[]): Promise<Uint8Array[]> {
    if (!locs.length) return []

    const order = locs.map((loc, index) => ({ loc, index })).sort((a, b) => a.loc.at - b.loc.at)
    const out = new Array<Uint8Array>(locs.length)

    let group: Array<{ loc: Located; index: number }> = []
    let from = 0
    let to = 0

    const flush = async () => {
      if (!group.length) return
      const bytes = await this.read(from, to - from)
      for (const { loc, index } of group) {
        out[index] = bytes.subarray(loc.at - from, loc.at - from + loc.length)
      }
      group = []
    }

    for (const entry of order) {
      const start = entry.loc.at
      const end = start + entry.loc.length
      // Touching or overlapping: one read covers both. A hole between them is not read over —
      // the hole is another track's material and can be megabytes wide.
      if (group.length && start <= to) {
        if (end > to) to = end
      } else {
        await flush()
        from = start
        to = end
      }
      group.push(entry)
    }
    await flush()

    return out
  }
}
