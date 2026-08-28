import type { InitInfo, Located, TrackKind } from '../../shared/types'

/** Signature at both ends of the footer: 'TCS1' in ASCII. */
export const SNAPSHOT_MAGIC = 'TCS1'

/** Version of the layout. A reader refuses anything that says more than this. */
export const SNAPSHOT_VERSION = 1

/** Length of the trailer: magic, version, place of the index, checksum, magic again. */
export const FOOTER_BYTES = 32

/**
 * Where the bytes of a track live. Stage 2 puts them all inside the snapshot; stage 3 adds
 * `{ kind: 'file', path }` for material already written out as a session, and the shape of the
 * index does not change with it — a Located simply names a different store.
 */
export type Store = { kind: 'inline' }

/** One piece of the map, laid out in the file. */
export interface SnapshotChunkEntry {
  start: number
  end: number
  data: Located
}

/** One SourceBuffer of the session: its init segment, its map, its representation. */
export interface SnapshotTrack {
  id: string
  bufferId: string
  representation: string
  kinds: TrackKind[]
  init: Located
  info: InitInfo
  /** Ascending by start, no duplicates: the PtsMap laid out across the file. */
  chunks: SnapshotChunkEntry[]
}

/** The Session minus its tracks: what cannot be worked out of the material itself. */
export interface SnapshotPage {
  sessionKey: string
  url: string
  title: string
  createdAt: number
  lastSeenAt: number
  refusedTracks: boolean
}

export interface SnapshotIndex {
  format: 'tailcut/snapshot'
  version: number
  id: string
  capturedAt: number
  producer: string
  page: SnapshotPage
  stores: Store[]
  tracks: SnapshotTrack[]
}

export interface Footer {
  index: Located
  checksum: number
}

/**
 * Adler-32 of the index bytes.
 *
 * Not a cryptographic digest and not meant to be one: the question it answers is whether the
 * writer finished, and the answer has to cost nothing on a hundred megabytes of snapshot. It runs
 * over the index alone — a few kilobytes — because that is the part a half-written file truncates
 * in the middle of.
 */
export function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0

  // 5552 is the longest block that cannot overflow the accumulators before the modulo.
  for (let at = 0; at < bytes.length; ) {
    const stop = Math.min(at + 5552, bytes.length)
    for (; at < stop; at++) {
      a += bytes[at]!
      b += a
    }
    a %= 65521
    b %= 65521
  }

  return ((b << 16) | a) >>> 0
}

/**
 * The index as JSON.
 *
 * One field is left out, and it is left out rather than encoded: `TrackInfo.codecPrivate` is a
 * `Uint8Array`, and JSON has no such thing. Written straight out it becomes `{"0":79,"1":112,…}`
 * and read back it is an object wearing the type of an array — a lie no compiler can catch,
 * because `decodeIndex` casts. Nothing in the editor reads the field: the init segment it was
 * parsed out of is in the snapshot in full, bytes and all, and that is where private data of a
 * codec belongs. Should it ever be needed here, it gets an `at` and a `length` like everything
 * else in this file.
 */
export function encodeIndex(index: SnapshotIndex): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(index, (key, value) => (key === 'codecPrivate' ? undefined : value)),
  )
}

const isLocated = (value: unknown): boolean => {
  const loc = value as { at?: unknown; length?: unknown } | null
  return (
    typeof loc === 'object' &&
    loc !== null &&
    typeof loc.at === 'number' &&
    typeof loc.length === 'number'
  )
}

const isTrack = (value: unknown): boolean => {
  const track = value as { init?: unknown; chunks?: unknown; info?: unknown } | null
  if (typeof track !== 'object' || track === null) return false
  if (!isLocated(track.init)) return false
  if (typeof track.info !== 'object' || track.info === null) return false
  if (!Array.isArray(track.chunks)) return false

  return track.chunks.every((chunk: unknown) => {
    const entry = chunk as { start?: unknown; end?: unknown; data?: unknown }
    return typeof entry.start === 'number' && typeof entry.end === 'number' && isLocated(entry.data)
  })
}

/**
 * Reads the index back.
 *
 * Two rules, and they pull in opposite directions on purpose. A field this version knows nothing
 * of passes through untouched — a snapshot written by a newer build of the same version is still
 * a snapshot, and refusing it over an extra key would strand material for no reason. A version
 * higher than ours is refused outright: past that number the reader is guessing.
 */
export function decodeIndex(bytes: Uint8Array): SnapshotIndex | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }

  const index = parsed as Partial<SnapshotIndex> | null
  if (typeof index !== 'object' || index === null) return null
  if (index.format !== 'tailcut/snapshot') return null
  if (typeof index.version !== 'number' || index.version > SNAPSHOT_VERSION) return null
  if (typeof index.page !== 'object' || index.page === null) return null
  if (!Array.isArray(index.tracks) || !index.tracks.length) return null
  if (!index.tracks.every(isTrack)) return null

  return index as SnapshotIndex
}

const writeAscii = (bytes: Uint8Array, at: number, text: string): void => {
  for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i)
}

const readAscii = (bytes: Uint8Array, at: number, length: number): string => {
  let text = ''
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[at + i] ?? 0)
  return text
}

export function encodeFooter(index: Located, checksum: number): Uint8Array {
  const footer = new Uint8Array(FOOTER_BYTES)
  const view = new DataView(footer.buffer)

  writeAscii(footer, 0, SNAPSHOT_MAGIC)
  view.setUint32(4, SNAPSHOT_VERSION, true)
  view.setBigUint64(8, BigInt(index.at), true)
  view.setBigUint64(16, BigInt(index.length), true)
  view.setUint32(24, checksum >>> 0, true)
  // The signature again at the very end: a file truncated inside the footer keeps the first one.
  writeAscii(footer, 28, SNAPSHOT_MAGIC)

  return footer
}

/**
 * The rule of a finished snapshot, and the whole of it: both signatures in place, a version this
 * build understands, and an index that ends exactly where the footer begins. A writer cut off
 * halfway fails at least the last of those, and such a file is deleted rather than read.
 */
export function decodeFooter(tail: Uint8Array, fileSize: number): Footer | null {
  if (tail.byteLength < FOOTER_BYTES) return null

  const at = tail.byteLength - FOOTER_BYTES
  if (readAscii(tail, at, 4) !== SNAPSHOT_MAGIC) return null
  if (readAscii(tail, at + 28, 4) !== SNAPSHOT_MAGIC) return null

  const view = new DataView(tail.buffer, tail.byteOffset + at, FOOTER_BYTES)
  if (view.getUint32(4, true) > SNAPSHOT_VERSION) return null

  const index = { at: Number(view.getBigUint64(8, true)), length: Number(view.getBigUint64(16, true)) }
  if (index.length <= 0 || index.at < 0) return null
  if (index.at + index.length + FOOTER_BYTES !== fileSize) return null

  return { index, checksum: view.getUint32(24, true) }
}
