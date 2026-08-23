import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ID,
  childElements,
  childWithId,
  childrenWithId,
  elementBody,
  findElement,
  readFloat,
  readInt,
  readString,
  readUint,
  readVint,
  topLevelElements,
} from '../../src/core/webm/reader'

const init = new Uint8Array(readFileSync('tests/fixtures/webm/init-stream1.webm'))
const seg = new Uint8Array(readFileSync('tests/fixtures/webm/chunk-stream1-00001.webm'))

// --- Synthetic buffers, for the shapes the fixtures do not contain ---

/** The id as it lies in the bytes: the marker bits are part of the number. */
function id(value: number): number[] {
  const out: number[] = []
  let rest = value
  while (rest > 0) {
    out.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  }
  return out.length ? out : [0]
}

/** A size as a variable-length integer, in `width` bytes or in the narrowest that fits. */
function size(value: number, width = 0): number[] {
  let length = width
  if (!length) {
    // All data bits set is the reserved "unknown" value, so the widest number a width can carry
    // is one below it.
    length = 1
    while (value > 2 ** (7 * length) - 2) length++
  }

  const out: number[] = []
  let rest = value
  for (let i = 0; i < length; i++) {
    out.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  }
  out[0]! |= 0x80 >> (length - 1)
  return out
}

/** The reserved "size unknown" value, in `width` bytes: the marker bit and nothing but ones after it. */
function unknown(width = 1): number[] {
  const marker = 0x80 >> (width - 1)
  const out = new Array<number>(width).fill(0xff)
  out[0] = marker | (marker - 1)
  return out
}

const element = (elementId: number, ...body: number[]): number[] =>
  [...id(elementId), ...size(body.length), ...body]

const openElement = (elementId: number, ...body: number[]): number[] =>
  [...id(elementId), ...unknown(), ...body]

const buffer = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat())

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))

const seen = (data: Uint8Array): string[] =>
  topLevelElements(data).map((e) => e.id.toString(16))

/**
 * Ceiling on the synchronous reading of one buffer. Sound code reads these in fractions of a
 * millisecond; a whole second does not catch a slow machine but does catch a scan that has
 * stopped moving forward.
 */
const PARSE_BUDGET_MS = 1000

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now()
  const value = fn()
  return { value, ms: performance.now() - start }
}

describe('topLevelElements', () => {
  it('finds the EBML header and the Segment of an init segment', () => {
    expect(topLevelElements(init).map((e) => e.id)).toEqual([ID.ebml, ID.segment])
  })

  it('finds the bare Cluster of a media segment', () => {
    // A DASH media segment is not wrapped in a Segment: the clusters lie at the top level.
    const top = topLevelElements(seg)
    expect(top.map((e) => e.id)).toEqual([ID.cluster])
    expect(top[0]!.unknownSize).toBe(false)
    expect(top[0]!.size).toBe(seg.byteLength)
  })

  it('element sizes cover the file with no holes', () => {
    const elements = topLevelElements(init)
    expect(elements.length).toBeGreaterThan(1)

    // Continuity, not just the total: a hole made up for by an overlap adds up the same while
    // the reading is already wrong.
    expect(elements[0]!.start).toBe(0)
    for (let i = 1; i < elements.length; i++) {
      const previous = elements[i - 1]!
      expect(elements[i]!.start).toBe(previous.start + previous.size)
    }
    const last = elements[elements.length - 1]!
    expect(last.start + last.size).toBe(init.byteLength)
  })

  it('reads the Segment of the fixture as an element of unknown size', () => {
    // ffmpeg writes the Segment of an init segment with the reserved unknown length, in eight
    // bytes: a live stream cannot know how long the file it is opening will turn out to be.
    const segment = topLevelElements(init).find((e) => e.id === ID.segment)!
    expect(segment.unknownSize).toBe(true)
    expect(segment.headerSize).toBe(12) // four bytes of id, eight of size
    expect(segment.start + segment.size).toBe(init.byteLength)
  })
})

describe('childElements', () => {
  it('lists the level-one elements of the Segment', () => {
    const segment = topLevelElements(init).find((e) => e.id === ID.segment)!
    const ids = childElements(init, segment).map((e) => e.id)
    expect(ids).toContain(ID.seekHead)
    expect(ids).toContain(ID.info)
    expect(ids).toContain(ID.tracks)
  })

  it('descends as far as a TrackEntry', () => {
    const entry = findElement(init, [ID.segment, ID.tracks, ID.trackEntry])!
    const ids = childElements(init, entry).map((e) => e.id)
    expect(ids).toContain(ID.trackNumber)
    expect(ids).toContain(ID.codecId)
    expect(ids).toContain(ID.audio)
  })

  it('does not read the body of a leaf as elements', () => {
    // CodecPrivate is an OpusHead: bytes that happen to look like element headers, with no
    // children in them.
    const codecPrivate = findElement(init, [
      ID.segment, ID.tracks, ID.trackEntry, ID.codecPrivate,
    ])!
    expect(codecPrivate.size).toBeGreaterThan(codecPrivate.headerSize)
    expect(childElements(init, codecPrivate)).toEqual([])

    const block = childWithId(seg, topLevelElements(seg)[0]!, ID.simpleBlock)!
    expect(block.size).toBeGreaterThan(block.headerSize)
    expect(childElements(seg, block)).toEqual([])
  })

  it('lists every child of one id, and picks the first of them', () => {
    const cluster = topLevelElements(seg)[0]!
    const blocks = childrenWithId(seg, cluster, ID.simpleBlock)
    expect(blocks.length).toBeGreaterThan(1)
    expect(childWithId(seg, cluster, ID.simpleBlock)).toEqual(blocks[0])
    expect(childWithId(seg, cluster, ID.tracks)).toBeUndefined()
  })
})

describe('findElement', () => {
  it('walks down a nested path', () => {
    const codec = findElement(init, [ID.segment, ID.tracks, ID.trackEntry, ID.codecId])!
    expect(readString(elementBody(init, codec))).toBe('A_OPUS')
  })

  it('returns null for a path that is not there', () => {
    expect(findElement(init, [ID.segment, ID.cues])).toBeNull()
  })

  it('stops at a missing link instead of falling through it', () => {
    // Tracks does live inside the Segment, and the only way to it is through the Segment: a path
    // through a container that is not there has to give null.
    expect(findElement(init, [ID.segment, ID.tracks])).not.toBeNull()
    expect(findElement(init, [ID.cues, ID.tracks])).toBeNull()
  })

  it('returns null for an empty path', () => {
    expect(topLevelElements(init).length).toBeGreaterThan(0)
    expect(findElement(init, [])).toBeNull()
  })

  it('returns the leaf of the path, not the container walked through', () => {
    const segment = topLevelElements(init).find((e) => e.id === ID.segment)!
    const tracks = findElement(init, [ID.segment, ID.tracks])!
    expect(tracks.id).toBe(ID.tracks)
    expect(tracks.start).toBeGreaterThan(segment.start)
    expect(tracks.size).toBeLessThan(segment.size)
  })

  it('takes the first of two elements of one id at one level', () => {
    const buf = buffer(
      [...id(ID.segment), ...size(0)],
      element(ID.cluster, ...element(ID.timestamp, 1)),
      element(ID.cluster, ...element(ID.timestamp, 2)),
    )
    const clusters = topLevelElements(buf).filter((e) => e.id === ID.cluster)
    expect(clusters).toHaveLength(2)

    const timestamp = findElement(buf, [ID.cluster, ID.timestamp])!
    expect(readUint(elementBody(buf, timestamp))).toBe(1)
  })
})

describe('elementBody', () => {
  it('cuts off the header and gives the body whole', () => {
    const docType = findElement(init, [ID.ebml, ID.docType])!
    expect(readString(elementBody(init, docType))).toBe('webm')
    expect(elementBody(init, docType).byteLength).toBe(docType.size - docType.headerSize)
  })

  it('a container body reads as a buffer of its own', () => {
    const segment = topLevelElements(init).find((e) => e.id === ID.segment)!
    const body = elementBody(init, segment)
    expect(body.byteOffset).toBe(segment.start + segment.headerSize)

    expect(topLevelElements(body)).toEqual(
      childElements(init, segment).map((e) => ({ ...e, start: e.start - body.byteOffset })),
    )
  })
})

describe('variable-length ids and sizes', () => {
  it.each([
    ['one byte', ID.trackNumber],
    ['two bytes', ID.trackUid],
    ['three bytes', ID.timestampScale],
    ['four bytes', ID.cluster],
  ])('reads an id of %s', (_name, value) => {
    const buf = buffer(element(value, 1, 2, 3))
    expect(topLevelElements(buf)).toEqual([
      { id: value, start: 0, size: id(value).length + 4, headerSize: id(value).length + 1, unknownSize: false },
    ])
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('reads a size written in %i bytes', (width) => {
    // The same body under a size written wider than it needs to be: a writer is free to pad, and
    // the reading may not depend on the padding.
    const body = [1, 2, 3, 4]
    const buf = buffer([...id(ID.timestamp), ...size(body.length, width), ...body])

    expect(topLevelElements(buf)).toEqual([
      { id: ID.timestamp, start: 0, size: 1 + width + 4, headerSize: 1 + width, unknownSize: false },
    ])
    expect([...elementBody(buf, topLevelElements(buf)[0]!)]).toEqual(body)
  })

  it('reads an element with an empty body', () => {
    const buf = buffer(element(ID.timestamp), element(ID.simpleBlock, 7))
    expect(topLevelElements(buf)).toEqual([
      { id: ID.timestamp, start: 0, size: 2, headerSize: 2, unknownSize: false },
      { id: ID.simpleBlock, start: 2, size: 3, headerSize: 2, unknownSize: false },
    ])
    expect(elementBody(buf, topLevelElements(buf)[0]!).byteLength).toBe(0)
  })
})

describe('elements of unknown size', () => {
  it('ends a Cluster at the next Cluster', () => {
    const first = openElement(ID.cluster, ...element(ID.timestamp, 10), ...element(ID.simpleBlock, 1))
    const second = openElement(ID.cluster, ...element(ID.timestamp, 20))
    const buf = buffer(first, second)

    const clusters = topLevelElements(buf)
    expect(clusters.map((e) => e.id)).toEqual([ID.cluster, ID.cluster])
    expect(clusters[0]!.unknownSize).toBe(true)
    expect(clusters[0]!.size).toBe(first.length)
    expect(clusters[1]!.start).toBe(first.length)
    expect(clusters[1]!.size).toBe(second.length)

    // and the children of the first stop at the boundary rather than swallowing the second
    expect(childElements(buf, clusters[0]!).map((e) => e.id)).toEqual([ID.timestamp, ID.simpleBlock])
    expect(readUint(elementBody(buf, childElements(buf, clusters[1]!)[0]!))).toBe(20)
  })

  it('ends a Cluster at a Tracks that follows it', () => {
    // Tracks sits at the same depth as a Cluster, so it closes one just as another Cluster would.
    const cluster = openElement(ID.cluster, ...element(ID.timestamp, 5))
    const tracks = element(ID.tracks, ...element(ID.trackEntry, ...element(ID.trackNumber, 1)))
    const buf = buffer(cluster, tracks)

    const top = topLevelElements(buf)
    expect(top.map((e) => e.id)).toEqual([ID.cluster, ID.tracks])
    expect(top[0]!.size).toBe(cluster.length)
  })

  it('does not end a Cluster at an element that belongs inside it', () => {
    // Timestamp and SimpleBlock sit below a Cluster: they are its children, not its successors.
    const buf = buffer(openElement(
      ID.cluster,
      ...element(ID.timestamp, 1),
      ...element(ID.simpleBlock, 0x81, 0, 0, 0x80, 9),
      ...element(ID.blockGroup, ...element(ID.block, 0x81, 0, 0, 0, 9)),
    ))

    const cluster = topLevelElements(buf)[0]!
    expect(cluster.size).toBe(buf.byteLength)
    expect(childElements(buf, cluster).map((e) => e.id))
      .toEqual([ID.timestamp, ID.simpleBlock, ID.blockGroup])
  })

  it('does not end a Cluster at a Void, which is allowed at any depth', () => {
    const buf = buffer(
      openElement(ID.cluster, ...element(ID.timestamp, 1), ...element(ID.void, 0, 0, 0)),
      element(ID.cluster, ...element(ID.timestamp, 2)),
    )

    const top = topLevelElements(buf)
    expect(top).toHaveLength(2)
    expect(childElements(buf, top[0]!).map((e) => e.id)).toEqual([ID.timestamp, ID.void])
  })

  it('runs an unknown-size element to the end of the buffer when nothing closes it', () => {
    const buf = buffer(openElement(ID.segment, ...element(ID.info, ...element(ID.timestampScale, 0x0f, 0x42, 0x40))))
    const segment = topLevelElements(buf)[0]!
    expect(segment.unknownSize).toBe(true)
    expect(segment.size).toBe(buf.byteLength)
    expect(childElements(buf, segment).map((e) => e.id)).toEqual([ID.info])
  })

  it('nests an unknown-size Cluster inside an unknown-size Segment', () => {
    // Both sizes unknown at once is the live-stream shape: the Segment is closed by the end of
    // the buffer and the Cluster by the Cluster after it.
    const clusterA = openElement(ID.cluster, ...element(ID.timestamp, 0))
    const clusterB = openElement(ID.cluster, ...element(ID.timestamp, 40))
    const segmentHeader = [...id(ID.segment), ...unknown(8)]
    const buf = buffer(segmentHeader, clusterA, clusterB)

    const segment = topLevelElements(buf)[0]!
    expect(segment.size).toBe(buf.byteLength)
    expect(segment.headerSize).toBe(12)

    const clusters = childElements(buf, segment)
    expect(clusters.map((e) => e.id)).toEqual([ID.cluster, ID.cluster])
    expect(clusters[0]!.size).toBe(clusterA.length)
    expect(clusters[1]!.size).toBe(clusterB.length)
  })

  it('ends a Segment of unknown size at the Segment after it', () => {
    const first = openElement(ID.segment, ...element(ID.tracks))
    const second = openElement(ID.segment, ...element(ID.info))
    const buf = buffer(first, second)

    const top = topLevelElements(buf)
    expect(top.map((e) => e.id)).toEqual([ID.segment, ID.segment])
    expect(top[0]!.size).toBe(first.length)
  })

  it('runs an unknown id of unknown size to the end of the range', () => {
    // Nothing is known about where such an element ends, so nothing may be claimed to follow it.
    const unknownId = 0x81
    const buf = buffer(openElement(unknownId), element(ID.cluster, ...element(ID.timestamp, 1)))

    const top = topLevelElements(buf)
    expect(top).toHaveLength(1)
    expect(top[0]!.id).toBe(unknownId)
    expect(top[0]!.size).toBe(buf.byteLength)
  })

  it('steps over a sized child rather than through its bytes', () => {
    // The Void in between is a child of the Cluster and its body holds what looks like a Cluster
    // header. Stepping over it by its stated size skips those bytes; a scan reading byte by byte
    // would end the first Cluster inside somebody else's body.
    const decoy = element(ID.void, ...id(ID.cluster), 0x84, 1, 2, 3, 4)
    const first = openElement(ID.cluster, ...element(ID.timestamp, 1))
    const buf = buffer(first, decoy, element(ID.cluster, ...element(ID.timestamp, 2)))

    const top = topLevelElements(buf)
    expect(top.map((e) => e.id)).toEqual([ID.cluster, ID.cluster])
    expect(top[0]!.size).toBe(first.length + decoy.length)
    expect(childElements(buf, top[0]!).map((e) => e.id)).toEqual([ID.timestamp, ID.void])
  })
})

describe('a Segment still arriving', () => {
  /** The fixture's Segment with a length written into it: 4 bytes of id, then 8 bytes of size. */
  const declaring = (length: number): Uint8Array => {
    const out = init.slice()
    const segment = topLevelElements(out).find((e) => e.id === ID.segment)!
    out.set(size(length, 8), segment.start + 4)
    return out
  }

  it('reads inside a Segment that states a length the arrived bytes do not reach', () => {
    // What a live stream looks like on the wire: the Segment states the length of the whole
    // recording, and the player has been handed its first few hundred bytes. Refusing the
    // element over the bytes still in flight would hide the Tracks that have arrived.
    const streaming = declaring(10_000_000)

    const segment = topLevelElements(streaming).find((e) => e.id === ID.segment)
    expect(segment).toBeDefined()
    expect(segment!.size).toBe(streaming.byteLength - segment!.start)
    expect(childElements(streaming, segment!).map((e) => e.id)).toEqual([
      ID.seekHead, ID.void, ID.info, ID.tracks, ID.tags,
    ])
  })

  it('leaves a Segment that does fit exactly as it is', () => {
    const whole = declaring(init.byteLength - 48)

    const segment = topLevelElements(whole).find((e) => e.id === ID.segment)!
    expect(segment.size).toBe(whole.byteLength - segment.start)
    expect(segment.unknownSize).toBe(false)
  })

  it('still refuses a Cluster whose body has not all arrived', () => {
    // Only the Segment wraps bytes yet to come. A Cluster states the length of material that is
    // already written, and half of one is half a frame.
    const buf = buffer([...id(ID.cluster), ...size(64)], [1, 2, 3, 4])
    expect(topLevelElements(buf)).toEqual([])
  })
})

describe('broken sizes', () => {
  it('does not give out an element whose body reaches past the buffer', () => {
    const buf = buffer([...id(ID.cluster), ...size(64)], [1, 2, 3, 4])
    expect(topLevelElements(buf)).toEqual([])
  })

  it('does not give out an element that is one byte short', () => {
    const whole = buffer(element(ID.timestamp, 1, 2, 3, 4))
    expect(topLevelElements(whole)).toHaveLength(1)

    const short = whole.subarray(0, whole.byteLength - 1)
    expect(topLevelElements(short)).toEqual([])
  })

  it('drops a child that reaches past the end of its parent', () => {
    const buf = buffer(
      [...id(ID.cluster), ...size(6)],
      [...id(ID.timestamp), ...size(32)], [1, 2, 3, 4],
      [...id(ID.void), ...size(8)], [0, 0, 0, 0, 0, 0, 0, 0],
    )

    const cluster = topLevelElements(buf)[0]!
    expect(cluster.size).toBe(11)
    // The missing bytes exist in the buffer, just past the parent, and belong to somebody else.
    expect(childElements(buf, cluster)).toEqual([])
  })

  it('stops the walk at a truncated header instead of reading past the end', () => {
    // A whole element, then an id with no size behind it: the tail of a segment still arriving.
    const buf = buffer(element(ID.timestamp, 1), id(ID.cluster))
    expect(topLevelElements(buf).map((e) => e.id)).toEqual([ID.timestamp])
  })

  it('gives nothing for a buffer of a single byte', () => {
    expect(topLevelElements(Uint8Array.of(0xa3))).toEqual([])
    expect(topLevelElements(new Uint8Array(0))).toEqual([])
  })

  it('gives nothing for an id byte of zero', () => {
    // A leading zero would mean a length marker further along than the eight bytes an id may
    // occupy. There is no element there, and no forward step to take either.
    const { value, ms } = timed(() => topLevelElements(new Uint8Array(4096)))
    expect(value).toEqual([])
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('takes a buffer of nothing but 0xff without hanging', () => {
    // Every byte reads as an id of one byte and a size of "unknown": the reading must end, and
    // end with the whole buffer inside a single element.
    const { value, ms } = timed(() => topLevelElements(new Uint8Array(4096).fill(0xff)))
    expect(value).toHaveLength(1)
    expect(value[0]!.unknownSize).toBe(true)
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('takes a long run of tiny elements without hanging', () => {
    const parts: number[][] = []
    for (let i = 0; i < 20000; i++) parts.push(element(ID.timestamp, i % 256))
    const buf = buffer(...parts)

    const { value, ms } = timed(() => topLevelElements(buf))
    expect(value).toHaveLength(20000)
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('takes a run of unknown-size Clusters without hanging', () => {
    // Every cluster has to look ahead for whatever closes it; the one after it does, at once.
    const parts: number[][] = []
    for (let i = 0; i < 2000; i++) parts.push(openElement(ID.cluster, ...element(ID.timestamp, i % 256)))
    const buf = buffer(...parts)

    const { value, ms } = timed(() => topLevelElements(buf))
    expect(value).toHaveLength(2000)
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })
})

describe('bytes that are not WebM', () => {
  it('declines a fragmented mp4 init segment', () => {
    const mp4 = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
    expect(seen(mp4)).toEqual([])
  })

  it('declines a fragmented mp4 media segment', () => {
    const mp4 = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))
    expect(seen(mp4)).toEqual([])
  })

  it('declines text', () => {
    expect(seen(buffer(ascii('<!DOCTYPE html><html><body>not a video</body></html>')))).toEqual([])
  })
})

describe('a view with a non-zero byteOffset', () => {
  // The Cluster does not sit at the start of the underlying ArrayBuffer: before it is plausible
  // rubbish that reads as elements of its own. Offsets have to be counted from the start of the
  // view, or the sizes come out of somebody else's bytes.
  const junk = element(ID.void, 1, 2, 3)
  const standalone = buffer(
    element(ID.cluster, ...element(ID.timestamp, 7), ...element(ID.simpleBlock, 0x81, 0, 0, 0x80, 1)),
  )
  const tail = element(ID.tracks, 1, 2, 3, 4)
  const whole = buffer(junk, [...standalone], tail)
  const middle = whole.subarray(junk.length, junk.length + standalone.byteLength)

  it('reads the same as the buffer standing on its own', () => {
    expect(middle.byteOffset).toBe(junk.length)
    expect([...middle]).toEqual([...standalone])
    expect(topLevelElements(middle)).toEqual(topLevelElements(standalone))
  })

  it('does not look past the end of the view', () => {
    expect(middle.byteOffset + middle.byteLength).toBeLessThan(whole.byteLength)
    expect(topLevelElements(middle).map((e) => e.id)).toEqual([ID.cluster])
  })

  it('descends inside the view', () => {
    const cluster = topLevelElements(middle)[0]!
    expect(childElements(middle, cluster).map((e) => e.id)).toEqual([ID.timestamp, ID.simpleBlock])
    expect(readUint(elementBody(middle, childElements(middle, cluster)[0]!))).toBe(7)
  })
})

describe('readVint', () => {
  it('reads the width from the leading bits', () => {
    expect(readVint(Uint8Array.of(0x81), 0)).toEqual({ value: 1, length: 1, allOnes: false })
    expect(readVint(Uint8Array.of(0x41, 0x30), 0)).toEqual({ value: 0x130, length: 2, allOnes: false })
    expect(readVint(Uint8Array.of(0x20, 0x46, 0x09), 0))
      .toEqual({ value: 0x4609, length: 3, allOnes: false })
  })

  it('marks the reserved all-ones value', () => {
    expect(readVint(Uint8Array.of(0xff), 0)).toEqual({ value: 0x7f, length: 1, allOnes: true })
    expect(readVint(Uint8Array.of(0x7f, 0xff), 0)).toEqual({ value: 0x3fff, length: 2, allOnes: true })
    // one bit short of all ones is an ordinary size, not the unknown one
    expect(readVint(Uint8Array.of(0x7f, 0xfe), 0)!.allOnes).toBe(false)
  })

  it('reads a value wider than 32 bits without wrapping', () => {
    const bytes = Uint8Array.of(0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00)
    expect(readVint(bytes, 0)).toEqual({ value: 2 ** 32, length: 8, allOnes: false })
  })

  it('declines a leading zero byte', () => {
    expect(readVint(Uint8Array.of(0x00, 0x81), 0)).toBeNull()
  })

  it('declines a number that reaches past the end', () => {
    expect(readVint(Uint8Array.of(0x41), 0)).toBeNull()
    expect(readVint(Uint8Array.of(0x41, 0x30), 0, 1)).toBeNull()
  })

  it('declines a width above the limit it was given', () => {
    const fourByte = Uint8Array.of(0x1f, 0x43, 0xb6, 0x75)
    expect(readVint(fourByte, 0)).not.toBeNull()
    expect(readVint(fourByte, 0, fourByte.byteLength, 3)).toBeNull()
  })

  it('declines an offset outside the buffer', () => {
    expect(readVint(Uint8Array.of(0x81), 1)).toBeNull()
    expect(readVint(Uint8Array.of(0x81), -1)).toBeNull()
  })
})

describe('value readers', () => {
  it('reads unsigned integers of any width', () => {
    expect(readUint(Uint8Array.of())).toBe(0)
    expect(readUint(Uint8Array.of(0x2a))).toBe(42)
    expect(readUint(Uint8Array.of(0x0f, 0x42, 0x40))).toBe(1_000_000)
    expect(readUint(Uint8Array.of(0x01, 0x00, 0x00, 0x00, 0x00))).toBe(2 ** 32)
  })

  it('reads a body wider than eight bytes as zero, not as a wrapped number', () => {
    expect(readUint(new Uint8Array(9).fill(0xff))).toBe(0)
  })

  it('reads signed integers in two’s complement over the width given', () => {
    expect(readInt(Uint8Array.of(0xff))).toBe(-1)
    expect(readInt(Uint8Array.of(0x80))).toBe(-128)
    expect(readInt(Uint8Array.of(0x7f))).toBe(127)
    expect(readInt(Uint8Array.of(0xff, 0xff))).toBe(-1)
    expect(readInt(Uint8Array.of())).toBe(0)
  })

  it('reads floats of four and of eight bytes', () => {
    const eight = new Uint8Array(8)
    new DataView(eight.buffer).setFloat64(0, 48000)
    expect(readFloat(eight)).toBe(48000)

    const four = new Uint8Array(4)
    new DataView(four.buffer).setFloat32(0, 44100)
    expect(readFloat(four)).toBe(44100)

    // An empty body is zero, and any other width is not a float at all: zero rather than a NaN
    // that would spread through the arithmetic above.
    expect(readFloat(Uint8Array.of())).toBe(0)
    expect(readFloat(Uint8Array.of(1, 2, 3))).toBe(0)
  })

  it('reads a string up to the padding zero', () => {
    expect(readString(Uint8Array.from(ascii('webm')))).toBe('webm')
    expect(readString(Uint8Array.from([...ascii('A_OPUS'), 0, 0, 0]))).toBe('A_OPUS')
    expect(readString(Uint8Array.of())).toBe('')
  })
})
