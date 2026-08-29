import type { Chunk, InitInfo, Located, TrackKind } from '../../shared/types'

/**
 * A place inside one piece of the history: which file, and the range in it.
 *
 * The index addresses material this way and not by a single offset, because the history of a
 * session is many files and a `Located` alone would need a store beside it every time it was
 * read. The composite address space — every piece laid end to end — is built once, when the
 * editor opens a session (src/core/history/index.ts), and lives nowhere else.
 */
export interface PlacedIn extends Located {
  file: string
}

/** One track of a session as the index remembers it: everything a reader needs before the bytes. */
export interface HistoryTrack {
  representation: string
  bufferId: string
  kinds: TrackKind[]
  info: InitInfo
  /**
   * Where the init segment of this track went. A track has exactly one, and the index names one
   * place for it.
   *
   * That is kept by the writer rather than by anything here: it claims the init of a track in the
   * same turn it cuts the batch that carries it, and gives the claim back only if that batch
   * failed to land (`HistoryWriter` in src/bridge/history-writer.ts). The claim used to be made
   * after the write instead, and a burst — two batches cut before the first had landed — sent the
   * init down twice.
   *
   * One case is left in which the same init can be placed a second time, and it is written here
   * rather than assumed away: two merge keys gathering at once and merging into one session (§6.1),
   * where each side had already claimed the init of its own tracks. Whoever fills this in keeps the
   * first place an init landed in and ignores every later one — otherwise which of the two the
   * index names would be decided by the order they landed in. The spare copy costs a few hundred
   * bytes inside a piece that is material anyway, and nothing ever reads it.
   */
  init: PlacedIn
}

/** One stretch of material inside a piece file. */
export interface HistoryPart {
  representation: string
  /** Media seconds, as the map holds them. */
  start: number
  end: number
  /** Byte range inside the piece file. */
  at: number
  length: number
}

/** One piece file, as the index remembers it. */
export interface HistoryPiece {
  file: string
  bytes: number
  /**
   * Furthest media time anything in this file reaches.
   *
   * What eviction by the buffer length compares with the floor, and it is the furthest end of
   * every part rather than the end of the last one: the parts of the picture and of the sound are
   * interleaved and one of them runs ahead. A file is dead only when nothing in it is still
   * inside the window.
   */
  until: number
  /** Wall clock. The repair tells an orphan from a file being written right now by its age. */
  writtenAt: number
  parts: HistoryPart[]
}

/** One chunk on its way to disk, with the init of its track when that has not been written yet. */
export interface BatchItem {
  representation: string
  init?: Uint8Array
  chunk: Chunk
}

export interface PlacedInit extends Located {
  representation: string
}

export interface BatchLayout {
  /** In the order they are written; the writer concatenates them once and hands them over. */
  parts: Uint8Array[]
  bytes: number
  piece: HistoryPiece
  /** Init segments this batch placed: the session row learns from it where they went. */
  inits: PlacedInit[]
}

/**
 * What one batch is made of and where each part of it lands inside its file.
 *
 * A pure pass, like planSnapshot and for the same reason: no byte is copied here. The views the
 * map holds come out in `parts`, and the one copy happens in the frame, where the result can be
 * handed to the worker by transfer.
 *
 * An init segment goes in front of the first material of its track and never again — it is the
 * one thing in a session that is written once and read by everything after it. Sites give out
 * their init segments in the first second of playback and never repeat them, so a batch that
 * failed to land has to bring the init along again; that is the writer's business (see
 * HistoryWriter), and all this function promises is that the init and the material it explains
 * are in one file.
 */
export function layoutBatch(
  file: string,
  writtenAt: number,
  items: readonly BatchItem[],
): BatchLayout {
  const parts: Uint8Array[] = []
  const inits: PlacedInit[] = []
  const placed: HistoryPart[] = []
  let at = 0
  let until = 0

  const place = (bytes: Uint8Array): Located => {
    const located = { at, length: bytes.byteLength }
    parts.push(bytes)
    at += bytes.byteLength
    return located
  }

  for (const item of items) {
    if (item.init) inits.push({ representation: item.representation, ...place(item.init) })

    placed.push({
      representation: item.representation,
      start: item.chunk.start,
      end: item.chunk.end,
      ...place(item.chunk.bytes),
    })
    if (item.chunk.end > until) until = item.chunk.end
  }

  return {
    parts,
    bytes: at,
    inits,
    piece: { file, bytes: at, until, writtenAt, parts: placed },
  }
}
