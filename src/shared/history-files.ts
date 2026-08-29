/**
 * Where the history lies in OPFS, how big a piece of it is, and how it is named.
 *
 * A directory per session, a file per batch. The name of a file carries who wrote it and in what
 * order: two tabs playing the same video merge into one session (§6.1) and write into one
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
 * loss window. At 1080p and 6 Mbit/s this is a file every eleven seconds.
 *
 * The batch is not here to spare the disk: measured, writing segment by segment costs 2.4 ms
 * apiece and the page pays none of it. It is here for the number of files on disk — the repair
 * walks them — and for the quota, which a file open for writing reserves in doublings.
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
