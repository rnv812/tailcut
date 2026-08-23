import { parseInit as parseIsoInit } from './iso/init'
import { parseFragment as parseIsoFragment } from './iso/fragment'
import { parseInit as parseWebmInit } from './webm/init'
import { parseFragment as parseWebmFragment } from './webm/fragment'
import type { FragmentInfo, InitInfo } from '../shared/types'

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
}

export const isoParser: ContainerParser = {
  container: 'iso',
  parseInit: parseIsoInit,
  parseFragment: parseIsoFragment,
}

export const webmParser: ContainerParser = {
  container: 'webm',
  parseInit: parseWebmInit,
  parseFragment: parseWebmFragment,
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
