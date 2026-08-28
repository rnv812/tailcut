import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { locateSegment, MATROSKA_MAGIC, PROBE_BYTES } from '../../src/core/webm/locate'
import { parseInit } from '../../src/core/webm/init'
import { ID, childElements, topLevelElements } from '../../src/core/webm/reader'
import type { RangeRead } from '../../src/core/iso/locate'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/** VP9 and Opus in a complete Matroska: ebml, segment, seekHead, info, tracks, tags, clusters, cues. */
const whole = read('tests/fixtures/plain/watched.webm')
/** VP8 and Vorbis, the pair an imageboard serves. Its Tracks is 3.4 kB of Vorbis setup headers. */
const older = read('tests/fixtures/plain/watched-vp8.webm')
/** An ordinary mp4, which this locator has to refuse rather than misread. */
const notMatroska = read('tests/fixtures/plain/whole.mp4')

interface Server {
  read: (at: number, length: number) => Promise<RangeRead>
  /** Every range asked for, in order: [first byte, count]. */
  asked: Array<[number, number]>
  bytes: number
}

/**
 * A file behind ranged reads, and a tally of what was asked of it — the same server the mp4
 * locator is measured against (tests/core/locate.test.ts), so the two costs can be compared in
 * the same units.
 */
function serve(file: Uint8Array, options: { states?: boolean } = {}): Server {
  const server: Server = {
    asked: [],
    bytes: 0,
    read: async (at, length) => {
      server.asked.push([at, length])
      const bytes = file.subarray(
        Math.min(at, file.byteLength),
        Math.min(at + length, file.byteLength),
      )
      server.bytes += bytes.byteLength
      return { bytes, total: options.states === false ? 0 : file.byteLength }
    },
  }

  return server
}

/** Where the first Cluster of a file lies, read out of the whole of it. */
function firstClusterAt(file: Uint8Array): number {
  const segment = topLevelElements(file).find((e) => e.id === ID.segment)!
  return childElements(file, segment).find((e) => e.id === ID.cluster)!.start
}

describe('locateSegment', () => {
  it('finds the head of a whole Matroska in one request and reads no cluster', async () => {
    const server = serve(whole)

    const found = await locateSegment(server.read)

    expect(found, 'the head of a whole Matroska was not found').not.toBeNull()
    // The head of both fixtures is a few kilobytes, so one probe holds all of it. That is not
    // luck: a Matroska states its Tracks before its material because a player needs them before
    // the first frame, and the only thing that can push them past a probe is an attachment.
    expect(server.asked).toEqual([[0, PROBE_BYTES]])
    expect(found!.clustersAt).toBe(firstClusterAt(whole))
    expect(found!.head.byteLength).toBe(found!.clustersAt)
    expect(server.bytes, 'more than the front of the file was read').toBeLessThan(PROBE_BYTES + 1)
  })

  it('hands back a head the track reader can read without the file behind it', async () => {
    const server = serve(whole)

    const found = await locateSegment(server.read)
    const info = parseInit(found!.head)

    expect(info!.tracks.map((track) => track.codec)).toEqual(['V_VP9', 'A_OPUS'])
    // One TimestampScale governs the whole segment, and the head is where it is stated: a
    // millisecond a tick, which is what every muxer writes.
    expect(info!.tracks.every((track) => track.timescale === 1000)).toBe(true)
  })

  it('reads the same head off a file whose Tracks carries kilobytes of setup', async () => {
    // Vorbis puts its three setup headers in CodecPrivate, so this file's Tracks alone is 3.4 kB
    // — an order of magnitude past the VP9 one, and still inside a single probe.
    const server = serve(older)

    const found = await locateSegment(server.read)

    expect(server.asked).toEqual([[0, PROBE_BYTES]])
    expect(parseInit(found!.head)!.tracks.map((track) => track.codec)).toEqual([
      'V_VP8',
      'A_VORBIS',
    ])
  })

  it('states where the segment body begins and where it ends', async () => {
    const server = serve(whole)

    const found = await locateSegment(server.read)
    const segment = topLevelElements(whole).find((e) => e.id === ID.segment)!

    // A Cue position and a SeekHead position are both counted from the first byte of the segment
    // body rather than from the first byte of the file, so this is the number they are read
    // against.
    expect(found!.bodyAt).toBe(segment.start + segment.headerSize)
    expect(found!.segmentEnd).toBe(segment.start + segment.size)
    expect(found!.total).toBe(whole.byteLength)
  })

  it('reaches the head of a file whose front takes more than one read', async () => {
    // A probe narrower than the Tracks element: the walk has to come back for the rest of the
    // head instead of giving up on what one window happened to hold.
    const server = serve(older)

    const found = await locateSegment(server.read, { window: 512 })

    expect(found!.clustersAt).toBe(firstClusterAt(older))
    expect(found!.head.byteLength).toBe(found!.clustersAt)
    expect(parseInit(found!.head)!.tracks).toHaveLength(2)
    expect(server.asked.length, 'the walk cost more requests than the head is windows').toBeLessThan(
      Math.ceil(found!.clustersAt / 512) + 4,
    )
  })

  it('finds the head off a server that states no length', async () => {
    // No Content-Range means no shortcut to the end of the file. Nothing in the head needs one:
    // every element in front of the first cluster states its own size.
    const server = serve(whole, { states: false })

    const found = await locateSegment(server.read)

    expect(found!.clustersAt).toBe(firstClusterAt(whole))
    expect(found!.total).toBe(0)
  })

  it('gives nothing for a file that is not Matroska', async () => {
    const server = serve(notMatroska)

    expect(await locateSegment(server.read)).toBeNull()
    // And it says so off the first four bytes rather than by walking: an mp4 begins with a box
    // header, and every byte read past that is a byte spent on a file this reader will not take.
    expect(server.asked).toHaveLength(1)
  })

  it('refuses bytes that begin like a Matroska and are not one', async () => {
    const nonsense = new Uint8Array(4096)
    nonsense.set(MATROSKA_MAGIC, 0)

    expect(await locateSegment(serve(nonsense).read)).toBeNull()
  })

  it('refuses a document type this reader does not know', async () => {
    // The EBML grammar carries more than Matroska. A DocType of anything else is a file whose
    // elements mean something different, and reading it as video would be reading noise.
    const other = new Uint8Array(whole)
    const docType = /* "webm" inside the EBML header */ indexOfAscii(other, 'webm', 0, 64)
    other.set(new TextEncoder().encode('wbfs'), docType)

    expect(await locateSegment(serve(other).read)).toBeNull()
  })

  it('refuses a head it is not willing to hold', async () => {
    // The Vorbis file's head is four kilobytes, nearly all of it setup headers. Held to one, the
    // reader stops instead of fetching what it was told not to.
    expect(await locateSegment(serve(older).read, { headLimit: 1024 })).toBeNull()
    expect(await locateSegment(serve(older).read)).not.toBeNull()
  })

  it('refuses a segment whose length is unknown and whose file states none either', async () => {
    // A Matroska written to a pipe states neither, and nothing then says where its material
    // stops. Refused rather than read to a guessed end: a walk with no bound is a walk over
    // whatever the host feels like sending.
    const streamed = withUnknownSegmentSize(whole)

    expect(await locateSegment(serve(streamed, { states: false }).read)).toBeNull()
    // With the length of the file stated there is a bound, and the same file reads.
    expect(await locateSegment(serve(streamed).read)).not.toBeNull()
  })

  it('gives nothing rather than walking for ever over elements that lead nowhere', async () => {
    // Every element of this file states a size of zero, so a walk that stepped by the stated size
    // would never move. The reader refuses instead of turning.
    const still = new Uint8Array(4096)
    still.set(MATROSKA_MAGIC, 0)
    still[4] = 0x80 // an EBML header of no body at all

    const server = serve(still)
    expect(await locateSegment(server.read)).toBeNull()
    expect(server.asked.length).toBeLessThan(16)
  })
})

/** Where an ASCII word lies in a buffer; −1 when it is not in the stretch searched. */
function indexOfAscii(data: Uint8Array, word: string, from: number, to: number): number {
  const wanted = new TextEncoder().encode(word)
  for (let at = from; at + wanted.byteLength <= to; at++) {
    let same = true
    for (let i = 0; i < wanted.byteLength; i++) same &&= data[at + i] === wanted[i]
    if (same) return at
  }
  return -1
}

/**
 * The same file with its Segment's length written as the reserved "unknown" — what a muxer
 * writing to a pipe produces, because it cannot seek back to fill the number in.
 */
function withUnknownSegmentSize(file: Uint8Array): Uint8Array {
  const segment = topLevelElements(file).find((e) => e.id === ID.segment)!
  const copy = new Uint8Array(file)
  const sizeAt = segment.start + 4

  // The size occupies segment.headerSize − 4 bytes. All ones in the data bits, with the width
  // marker kept, is "runs until something ends it".
  const width = segment.headerSize - 4
  copy[sizeAt] = 0xff >> (width - 1)
  for (let i = 1; i < width; i++) copy[sizeAt + i] = 0xff

  return copy
}
