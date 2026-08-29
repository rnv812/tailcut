/**
 * Where the history lies in OPFS, and how a piece of it is named.
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
