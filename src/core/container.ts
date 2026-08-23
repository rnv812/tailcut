import { parseInit as parseIsoInit } from './iso/init'
import { parseFragment as parseIsoFragment } from './iso/fragment'
import { parseInit as parseWebmInit } from './webm/init'
import { parseFragment as parseWebmFragment } from './webm/fragment'
import { webmToIso, type ConvertedSegment } from './webm/to-iso'
import { isoResync, isoUnitStartsAt, splitIso } from './iso/split'
import { webmResync, webmUnitStartsAt, splitWebm } from './webm/split'
import type { FragmentInfo, InitInfo, Split } from '../shared/types'

/**
 * The two containers a page delivers media in, behind one interface.
 *
 * A media source hands over whatever the site chose: fragmented mp4 for most of the web, and
 * WebM for the rest — YouTube serves its sound as audio/webm; codecs="opus" and its picture, more
 * often than not, as WebM too. The two are read by different code and describe the same three
 * things: what tracks the stream opens, where a segment starts, and how long it lasts.
 *
 * Everything above this line works on that description alone. The container is settled once, when
 * the init segment is recognised, and travels with the track from then on; no consumer downstream
 * asks the question again, and none of them grows a branch per format.
 */
export type Container = 'iso' | 'webm'

export interface ContainerParser {
  /** Which container this parser reads. Carried on the parser so a caller need not name it twice. */
  readonly container: Container
  /** The tracks an init segment opens, or null when these bytes are not an init of this container. */
  parseInit(bytes: Uint8Array): InitInfo | null
  /** Where a media segment sits in the time of its track, or null when it is not one. */
  parseFragment(bytes: Uint8Array): FragmentInfo | null
  /**
   * Cuts every complete segment off the front of a buffer of this container's byte stream — see
   * src/core/stream.ts for why a buffer of appends is not a segment.
   */
  split(bytes: Uint8Array): Split
  /** Whether the head of a segment stands at `at`, or bytes too few to tell yet. */
  unitStartsAt(bytes: Uint8Array, at: number): boolean
  /** The next offset from `from` where a stream of this container starts; -1 when none. */
  resync(bytes: Uint8Array, from: number): number
}

export const isoParser: ContainerParser = {
  container: 'iso',
  parseInit: parseIsoInit,
  parseFragment: parseIsoFragment,
  split: splitIso,
  unitStartsAt: isoUnitStartsAt,
  resync: isoResync,
}

export const webmParser: ContainerParser = {
  container: 'webm',
  parseInit: parseWebmInit,
  parseFragment: parseWebmFragment,
  split: splitWebm,
  unitStartsAt: webmUnitStartsAt,
  resync: webmResync,
}

/**
 * Every parser, in the order bytes are offered to them. Order is not a preference: the two
 * grammars disagree on the very first byte, so no buffer is an init segment of both.
 */
export const parsers: readonly ContainerParser[] = [isoParser, webmParser]

export function parserFor(container: Container): ContainerParser {
  return container === 'webm' ? webmParser : isoParser
}

/** An init segment recognised, together with the container it turned out to be written in. */
export interface DetectedInit {
  container: Container
  info: InitInfo
}

/**
 * Works out what an init segment is by parsing it: the first parser that makes sense of the bytes
 * names the container. Null when none of them does — a segment in a container we do not read, a
 * media segment, or bytes that are not media at all.
 */
export function detectInit(bytes: Uint8Array): DetectedInit | null {
  for (const parser of parsers) {
    const info = parser.parseInit(bytes)
    if (info) return { container: parser.container, info }
  }

  return null
}

/**
 * Turns one media segment into the ISO BMFF the rest of the program works in, and says where it
 * lies on the timeline. Null when the bytes hold nothing for the track it belongs to.
 */
export type SegmentConverter = (bytes: Uint8Array) => ConvertedSegment | null

/** An init segment taken in: whatever the page delivered, described as ISO BMFF from here on. */
export interface IngestedInit {
  container: Container
  /**
   * What the init declares — the kinds, the codecs and the frame sizes the track is identified
   * by. Named in the idiom of the container it arrived in: A_OPUS stays A_OPUS, because it is the
   * page's stream being identified and not the file being written out of it.
   */
  info: InitInfo
  /** ftyp and moov. The bytes as they arrived for an mp4; written afresh for anything else. */
  initBytes: Uint8Array
  /** How this track's media segments come across, or null when they are ISO BMFF already. */
  convert: SegmentConverter | null
}

/**
 * The ingest boundary: the one place a container other than ISO BMFF is spoken of.
 *
 * Above this line a track is a track. Below it a page delivers mp4 or WebM, and a WebM one is
 * converted here and now — while it is still a description of a few tracks rather than tens of
 * megabytes of collected material, and while there is still somewhere to refuse it. An init in a
 * codec the converter cannot write comes back null, exactly as bytes that are not an init at all
 * do: better a buffer that never opens a track than a track that can never be saved.
 */
export function ingestInit(bytes: Uint8Array): IngestedInit | null {
  const detected = detectInit(bytes)
  if (!detected) return null

  if (detected.container === 'iso') {
    return { container: 'iso', info: detected.info, initBytes: bytes, convert: null }
  }

  const converted = webmToIso(detected.info)
  if (!converted) return null

  return {
    container: detected.container,
    info: converted.info,
    initBytes: converted.initBytes,
    convert: (segment) => converted.segment(segment),
  }
}
