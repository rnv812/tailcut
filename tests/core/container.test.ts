import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  detectInit,
  isoParser,
  parserFor,
  parsers,
  webmParser,
  type Container,
  type ContainerParser,
} from '../../src/core/container'
import type { InitInfo, TrackKind } from '../../src/shared/types'

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

const isoInit = load('h264/init-stream0.m4s')
const isoAudioInit = load('h264/init-stream1.m4s')
const isoSegment = load('h264/chunk-stream0-00001.m4s')

const webmInit = load('webm/init-stream1.webm')
const webmVideoInit = load('webm/init-stream0.webm')
const webmSegment = load('webm/chunk-stream1-00001.webm')

describe('detectInit', () => {
  it('names the container an mp4 init segment is written in', () => {
    const found = detectInit(isoInit)!
    expect(found.container).toBe('iso')
    expect(found.info.tracks[0]!.codec).toBe('avc1')
  })

  it('names the container a WebM init segment is written in', () => {
    const found = detectInit(webmInit)!
    expect(found.container).toBe('webm')
    expect(found.info.tracks[0]!.codec).toBe('A_OPUS')
  })

  it('returns null for a media segment of either container', () => {
    expect(detectInit(isoSegment)).toBeNull()
    expect(detectInit(webmSegment)).toBeNull()
  })

  it('returns null for bytes that are not media at all', () => {
    const html = '<!DOCTYPE html><html><body>not a video</body></html>'
    expect(detectInit(Uint8Array.from(html, (c) => c.charCodeAt(0)))).toBeNull()
    expect(detectInit(new Uint8Array(0))).toBeNull()
    expect(detectInit(new Uint8Array(4096))).toBeNull()
  })
})

describe('the two grammars do not overlap', () => {
  // The order the parsers are offered bytes in is not a preference, and this is why: an init
  // segment of one container is never an init segment of the other. Should that stop being true,
  // detectInit would start answering by order of the list instead of by what the bytes are.
  it.each([
    ['an mp4 video init', isoInit],
    ['an mp4 audio init', isoAudioInit],
    ['an mp4 media segment', isoSegment],
  ] as [string, Uint8Array][])('the WebM parser declines %s', (_name, bytes) => {
    expect(webmParser.parseInit(bytes)).toBeNull()
    expect(webmParser.parseFragment(bytes)).toBeNull()
  })

  it.each([
    ['a WebM audio init', webmInit],
    ['a WebM video init', webmVideoInit],
    ['a WebM media segment', webmSegment],
  ] as [string, Uint8Array][])('the mp4 parser declines %s', (_name, bytes) => {
    expect(isoParser.parseInit(bytes)).toBeNull()
    expect(isoParser.parseFragment(bytes)).toBeNull()
  })
})

describe('parserFor', () => {
  it.each(['iso', 'webm'] as Container[])('gives the parser that reads %s', (container) => {
    expect(parserFor(container).container).toBe(container)
  })

  it('reads a media segment through the parser its init named', () => {
    for (const [init, media] of [[isoInit, isoSegment], [webmInit, webmSegment]] as const) {
      const found = detectInit(init)!
      const fragment = parserFor(found.container).parseFragment(media)!
      expect(fragment).not.toBeNull()
      expect(fragment.duration).toBeGreaterThan(0)
    }
  })
})

describe('the shape the two parsers share', () => {
  it('lists every parser exactly once, each naming its own container', () => {
    expect(parsers.map((p) => p.container)).toEqual(['iso', 'webm'])
    expect(new Set(parsers.map((p) => p.container)).size).toBe(parsers.length)
  })

  // What is worth having a common interface for: code above it works on the reading and never on
  // the container it came out of. This stands in for such a consumer.
  const summarize = (info: InitInfo): { kinds: TrackKind[]; seconds: number }[] =>
    info.tracks.map((t) => ({ kinds: [t.kind], seconds: 1 / t.timescale }))

  it.each([
    ['iso', isoParser, isoInit, isoSegment],
    ['webm', webmParser, webmInit, webmSegment],
  ] as [string, ContainerParser, Uint8Array, Uint8Array][])(
    'answers about %s in the same fields',
    (_name, parser, init, media) => {
      const info = parser.parseInit(init)!
      expect(summarize(info)).toHaveLength(1)

      for (const track of info.tracks) {
        expect(track.timescale).toBeGreaterThan(0)
        expect(track.codec).not.toBe('')
        expect(['video', 'audio']).toContain(track.kind)
      }

      const fragment = parser.parseFragment(media)!
      expect(fragment.trackId).toBeGreaterThan(0)
      expect(fragment.baseMediaDecodeTime).toBeGreaterThanOrEqual(0)

      // and the two readings meet: the ticks of the fragment are counted in the timescale of the
      // track the init opened
      const track = info.tracks.find((t) => t.trackId === fragment.trackId)!
      expect(track).toBeDefined()
      expect(fragment.duration / track.timescale).toBeCloseTo(2, 1)
    },
  )
})
