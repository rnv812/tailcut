/**
 * Where the history lies in OPFS, how big a piece of it is, and how it is named.
 *
 * A directory per session, a file per batch. The name of a file carries who wrote it and in what
 * order: two tabs playing the same video merge into one session and write into one
 * directory, and a counter of their own apiece would have them overwriting each other's pieces.
 * The sequence number is padded, so that sorting the names by string sorts the pieces by the
 * order they were written — which is the order the index reads them back in.
 */
export const HISTORY_DIR = 'history'

/** Extension of a piece: tailcut material. */
export const PIECE_SUFFIX = '.tcm'

/**
 * How much material gathers before it goes down as one piece.
 *
 * Eight mebibytes is 9.6 ms of writing (p95 11.5) and 833 MB/s — the knee of the measured curve,
 * past which a bigger batch buys throughput the extension has no use for and pays for it in the
 * loss window.
 *
 * It is a ceiling rather than the usual size of a piece, and the difference is worth knowing before
 * anybody reasons from this number. The tail closes a batch two seconds after its first chunk
 * (`HISTORY_TAIL_MS`), so this threshold decides anything only above 4 MiB/s — 33.6 Mbit/s for
 * every track of a session together, which is 4K and nothing below it. At 1080p and 6 Mbit/s a
 * piece goes down at about 1.5 MB on the tail, and the count on disk is 1800 files an hour whatever
 * this number is set to.
 *
 * So the batch is not here to spare the disk and not here for the file count either: writing
 * segment by segment costs a measured 2.4 ms apiece and the page pays none of it, and the tail sets
 * the file count on its own. It is here to put everything that arrived inside one tail into one
 * file — the tracks of a session, and the slices a site delivers one segment in, which on the bench
 * is 1798 appends landing as 17 pieces — and for the quota, which a file open for writing reserves
 * in doublings.
 *
 * It lives beside the names rather than in the writer that cuts a batch by it, because the number
 * belongs to the piece on disk and not to the single caller who cuts it. The browser sets that time
 * a write and read one back have to write a batch of the real size, and a literal 8 MiB in them,
 * under a comment saying "the batch this extension actually writes", would go on saying that after
 * the writer had chosen another number.
 */
export const HISTORY_BATCH_BYTES = 8 * 1024 * 1024

export function sessionDir(id: string): string {
  return `${HISTORY_DIR}/${id}`
}

export function pieceName(writerId: string, seq: number): string {
  return `${writerId}-${String(seq).padStart(6, '0')}${PIECE_SUFFIX}`
}

export function piecePath(id: string, file: string): string {
  return `${sessionDir(id)}/${file}`
}

/**
 * Identity of one writer, minted per frame that records.
 *
 * Eight hexadecimal characters out of crypto: the alternative is a counter in storage, which
 * would need a read before the first write of every page that plays a video.
 */
export function newWriterId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
