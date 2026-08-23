import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MAX_PENDING_BYTES, SegmentStream, type StreamUnit } from '../../src/core/stream'
import { parseInit as parseWebmInit } from '../../src/core/webm/init'

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

const isoInit = load('h264/init-stream0.m4s')
const isoSegments = [1, 2, 3].map((n) => load(`h264/chunk-stream0-0000${n}.m4s`))

const webmInit = load('webm/init-stream1.webm')
const webmSegments = [1, 2, 3].map((n) => load(`webm/chunk-stream1-0000${n}.webm`))

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

/** The stream cut into pieces of `size` bytes, the way a player hands it to a SourceBuffer. */
function slices(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let at = 0; at < data.byteLength; at += size) {
    out.push(data.subarray(at, Math.min(at + size, data.byteLength)))
  }
  return out
}

/** Everything the stream gives back over a run of pushes. */
function pushAll(stream: SegmentStream, pieces: Uint8Array[]): StreamUnit[] {
  const units: StreamUnit[] = []
  for (const piece of pieces) units.push(...stream.push(piece))
  return units
}

const shape = (units: StreamUnit[]): string[] => units.map((u) => `${u.kind}:${u.bytes.byteLength}`)

/** Compares content rather than identity: a unit may be a view into a buffer of its own. */
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i])

/**
 * A WebM init segment runs to the end of its Tracks, and the fixture carries a Tags block behind
 * that: description of the recording, not a declaration of what it holds. So the unit is the head
 * of the stream rather than the whole of the file, and what it has to carry is every track.
 */
function isWebmInitOf(unit: Uint8Array, stream: Uint8Array): boolean {
  if (!same(unit, stream.subarray(0, unit.byteLength))) return false
  return JSON.stringify(parseWebmInit(unit)) === JSON.stringify(parseWebmInit(stream))
}

describe('a stream delivered as whole segments', () => {
  it('gives back an mp4 init and each media segment, as they came', () => {
    const stream = new SegmentStream()
    const units = pushAll(stream, [isoInit, ...isoSegments])

    expect(units.map((u) => u.kind)).toEqual(['init', 'media', 'media', 'media'])
    expect(same(units[0]!.bytes, isoInit)).toBe(true)
    for (const [i, segment] of isoSegments.entries()) {
      expect(same(units[i + 1]!.bytes, segment)).toBe(true)
    }
  })

  it('gives back a WebM init and each cluster, as they came', () => {
    const stream = new SegmentStream()
    const units = pushAll(stream, [webmInit, ...webmSegments])

    expect(units.map((u) => u.kind)).toEqual(['init', 'media', 'media', 'media'])
    expect(isWebmInitOf(units[0]!.bytes, webmInit)).toBe(true)
    for (const [i, segment] of webmSegments.entries()) {
      expect(same(units[i + 1]!.bytes, segment)).toBe(true)
    }
  })
})

describe('a stream delivered in slices', () => {
  /**
   * What YouTube does: a SourceBuffer is not handed a segment at a time but the download as it
   * arrives, in pieces of sixteen kilobytes. Every boundary of the container then falls in the
   * middle of a push, and a reader that took each push for a segment would keep the few that
   * happen to start with a header and drop the rest.
   */
  it('puts an mp4 stream cut at sixteen kilobytes back together', () => {
    const whole = concat([isoInit, ...isoSegments])
    const stream = new SegmentStream()
    const units = pushAll(stream, slices(whole, 16 * 1024))

    expect(units.map((u) => u.kind)).toEqual(['init', 'media', 'media', 'media'])
    expect(same(units[0]!.bytes, isoInit)).toBe(true)
    for (const [i, segment] of isoSegments.entries()) {
      expect(same(units[i + 1]!.bytes, segment)).toBe(true)
    }
  })

  it('puts a WebM stream cut at sixteen kilobytes back together', () => {
    const whole = concat([webmInit, ...webmSegments])
    const stream = new SegmentStream()
    const units = pushAll(stream, slices(whole, 16 * 1024))

    expect(units.map((u) => u.kind)).toEqual(['init', 'media', 'media', 'media'])
    expect(isWebmInitOf(units[0]!.bytes, webmInit)).toBe(true)
    for (const [i, segment] of webmSegments.entries()) {
      expect(same(units[i + 1]!.bytes, segment)).toBe(true)
    }
  })

  it('gives the same answer whatever the pieces are cut at', () => {
    const whole = concat([isoInit, ...isoSegments])
    const expected = shape(pushAll(new SegmentStream(), [whole]))

    for (const size of [1, 2, 7, 100, 1024, 65_536, whole.byteLength * 2]) {
      const units = pushAll(new SegmentStream(), slices(whole, size))
      expect(shape(units), `cut at ${size} bytes`).toEqual(expected)
    }
  })

  it('gives the same answer for WebM whatever the pieces are cut at', () => {
    const whole = concat([webmInit, ...webmSegments])
    const expected = shape(pushAll(new SegmentStream(), [whole]))

    for (const size of [1, 3, 64, 1024, 65_536]) {
      const units = pushAll(new SegmentStream(), slices(whole, size))
      expect(shape(units), `cut at ${size} bytes`).toEqual(expected)
    }
  })

  it('holds a segment back until the last of its bytes is in', () => {
    const stream = new SegmentStream()
    expect(stream.push(isoInit).map((u) => u.kind)).toEqual(['init'])

    const segment = isoSegments[0]!
    expect(stream.push(segment.subarray(0, segment.byteLength - 1))).toEqual([])

    const finished = stream.push(segment.subarray(segment.byteLength - 1))
    expect(finished.map((u) => u.kind)).toEqual(['media'])
    expect(same(finished[0]!.bytes, segment)).toBe(true)
  })
})

describe('a stream that says nothing yet', () => {
  it('gives nothing back for an empty push', () => {
    expect(new SegmentStream().push(new Uint8Array(0))).toEqual([])
  })

  it('gives nothing back for bytes that are neither container', () => {
    const stream = new SegmentStream()
    for (let i = 0; i < 20; i++) expect(stream.push(new Uint8Array(4096).fill(0x41))).toEqual([])
  })

  it('does not hoard bytes it can make nothing of', () => {
    const stream = new SegmentStream()
    for (let i = 0; i < 200; i++) stream.push(new Uint8Array(64 * 1024).fill(0x41))
    // A page that feeds a stream this reader cannot follow must not be able to grow the tail
    // without end: the bridge holds the material of every session on the page beside it.
    expect(stream.pendingBytes()).toBeLessThanOrEqual(MAX_PENDING_BYTES)
  })
})

describe('a stream joined in the middle', () => {
  /**
   * Bytes that begin halfway through a segment: an abort() cut the last one short, or recording
   * started while the page was already playing. There is no honest way to place them, and the
   * reader has to find its feet again on the next header rather than choke on the tail.
   */
  it('finds the next mp4 segment after a piece of one it never saw the start of', () => {
    const stream = new SegmentStream()
    const orphan = isoSegments[0]!.subarray(5000)
    const units = pushAll(stream, [orphan, isoInit, ...isoSegments])

    expect(units.map((u) => u.kind)).toEqual(['init', 'media', 'media', 'media'])
    expect(same(units[0]!.bytes, isoInit)).toBe(true)
  })

  it('finds the next cluster after a piece of one it never saw the start of', () => {
    const stream = new SegmentStream()
    const orphan = webmSegments[0]!.subarray(500)
    const units = pushAll(stream, [orphan, ...webmSegments])

    expect(units.map((u) => u.kind)).toEqual(['media', 'media', 'media'])
    expect(same(units[0]!.bytes, webmSegments[0]!)).toBe(true)
  })
})

describe('one stream, one container', () => {
  it('does not read an mp4 stream as WebM because a later push looks like EBML', () => {
    const stream = new SegmentStream()
    expect(stream.push(isoInit).map((u) => u.kind)).toEqual(['init'])
    // Bytes of a picture may spell anything, EBML magic included.
    expect(stream.push(webmInit)).toEqual([])
  })
})
