import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { locateMovie, PROBE_BYTES, type RangeRead } from '../../src/core/iso/locate'
import { samplesInMovie } from '../../src/core/iso/movie'
import { topLevelBoxes } from '../../src/core/iso/reader'
import { boxOf, fullBoxOf, u32, u64, zeroes } from '../../src/core/iso/writer'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/** ftyp, free, mdat, moov — the movie box at the tail, where a muxer leaves it by default. */
const whole = read('tests/fixtures/plain/whole.mp4')
/** ftyp, moov, free, mdat — the same file written for streaming. */
const faststart = read('tests/fixtures/plain/faststart.mp4')

interface Server {
  read: (at: number, length: number) => Promise<RangeRead>
  /** Every range asked for, in order: [first byte, count]. */
  asked: Array<[number, number]>
  bytes: number
}

/**
 * A file behind ranged reads, and a tally of what was asked of it.
 *
 * The point of this module is the tally. "Find the movie box without downloading the file" is a
 * claim about requests and bytes, and a claim of that kind is worth only what is counted: this
 * server answers like the fifteen hosts of eighteen that answered 206 with a Content-Range in the
 * survey, and every test below states what the walk cost against it.
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
      // Content-Range is the one field worth reading off a 206: Accept-Ranges is not reliably
      // there and Content-Length states the length of the part. `states: false` is the answer
      // that carries neither, which a reader must survive without the tail shortcut.
      return { bytes, total: options.states === false ? 0 : file.byteLength }
    },
  }

  return server
}

const movieOf = (file: Uint8Array): { at: number; size: number } => {
  const box = topLevelBoxes(file).find((b) => b.type === 'moov')!
  return { at: box.start, size: box.size }
}

describe('locateMovie', () => {
  it('finds a streaming-ordered movie box in one request', () => {
    // ftyp then moov: the head of the file is the movie, and the first probe holds all of it.
    const server = serve(faststart)

    return locateMovie(server.read).then((found) => {
      expect(found).not.toBeNull()
      expect(found!.requests).toBe(1)
      expect(server.asked).toEqual([[0, PROBE_BYTES]])
      expect(found!.at).toBe(movieOf(faststart).at)
      expect(found!.moov).toEqual(
        faststart.subarray(found!.at, found!.at + movieOf(faststart).size),
      )
      expect(found!.total).toBe(faststart.byteLength)
    })
  })

  it('finds a tail-ordered movie box in two, and reads the mdat not at all', async () => {
    // The ordinary layout: ftyp, free, mdat, moov. The first probe reads the headers at the front
    // and learns where the mdat ends; the second asks for everything from there to the end of the
    // file, which is the movie box and whatever small boxes stand beside it. The material itself
    // is never asked for — that is the whole claim of this module.
    const server = serve(whole)
    const found = await locateMovie(server.read)

    expect(found!.requests).toBe(2)
    expect(found!.at).toBe(movieOf(whole).at)
    expect(found!.moov.byteLength).toBe(movieOf(whole).size)
    expect(found!.moov).toEqual(whole.subarray(found!.at, found!.at + movieOf(whole).size))

    const mdat = topLevelBoxes(whole).find((b) => b.type === 'mdat')!
    expect(server.asked[1]![0]).toBe(mdat.start + mdat.size)
    expect(server.bytes).toBeLessThan(whole.byteLength - mdat.size + PROBE_BYTES)
  })

  it('states the whole of the movie box even when a probe only reaches its header', async () => {
    // A moov grows by a dozen bytes a sample: an hour of picture puts hundreds of kilobytes of
    // tables in it, and no probe worth making holds that. Whatever the window, the box comes back
    // whole — the reader asks for the rest of it once, by the size the header stated.
    for (const window of [64, 200, 1024]) {
      const server = serve(faststart)
      const found = await locateMovie(server.read, { window })

      // Its own movie box and not the one of `whole`: the two files hold the same recording, but
      // faststart moves the material behind the tables and every chunk offset in them moves with
      // it — measured, 236 of the 3322 bytes differ.
      expect(found!.moov).toEqual(
        faststart.subarray(movieOf(faststart).at, movieOf(faststart).at + movieOf(faststart).size),
      )
      expect(found!.requests).toBe(2)
      expect(server.asked[0]).toEqual([0, window])
    }
  })

  it('walks the top-level boxes one at a time when the answers do not state a length', async () => {
    // Without a Content-Range there is no end of file to read back from, so the tail shortcut is
    // off and the walk steps from box to box: one request for the front, one landing on the free,
    // one on the mdat header, one on the moov, one for the rest of it.
    const server = serve(whole, { states: false })
    const found = await locateMovie(server.read, { window: 16 })

    expect(found!.total).toBe(0)
    expect(found!.at).toBe(movieOf(whole).at)
    expect(found!.moov.byteLength).toBe(movieOf(whole).size)
    expect(server.asked.map(([at]) => at)).toEqual([0, 32, 40, 14681, 14697])
  })

  it('reads a box that states its size in sixty-four bits', async () => {
    // size 1 and the real length behind the type: how a file whose material passes four gigabytes
    // states its mdat. Read as a 32-bit 1, the walk steps one byte forward and never arrives.
    const mdat = new Uint8Array(64)
    new DataView(mdat.buffer).setUint32(0, 1)
    mdat.set(Uint8Array.from('mdat', (c) => c.charCodeAt(0)), 4)
    new DataView(mdat.buffer).setBigUint64(8, 64n)

    const moov = boxOf('moov', zeroes(16))
    const file = new Uint8Array(mdat.byteLength + moov.byteLength)
    file.set(mdat, 0)
    file.set(moov, mdat.byteLength)

    const server = serve(file)
    const found = await locateMovie(server.read, { window: 16 })

    expect(found!.at).toBe(mdat.byteLength)
    expect(found!.moov).toEqual(moov)
  })

  it('reads a movie box that runs to the end of the file', async () => {
    // A size of zero means "to the last byte there is". Legal only for the final box, and the
    // only thing that says where it ends is the length the answer stated.
    const head = boxOf('ftyp', zeroes(8))
    const body = zeroes(40)
    const file = new Uint8Array(head.byteLength + 8 + body.byteLength)
    file.set(head, 0)
    const view = new DataView(file.buffer)
    view.setUint32(head.byteLength, 0)
    file.set(Uint8Array.from('moov', (c) => c.charCodeAt(0)), head.byteLength + 4)

    const found = await locateMovie(serve(file).read, { window: 24 })

    expect(found!.at).toBe(head.byteLength)
    expect(found!.moov.byteLength).toBe(file.byteLength - head.byteLength)
  })

  it('reads a movie box of unstated length off a server that states no length either', async () => {
    // A size of zero and no Content-Range: neither the box nor the answer says where the end is,
    // so the reader asks for as much as it has already agreed to hold and keeps what arrives.
    const head = boxOf('ftyp', zeroes(8))
    const file = new Uint8Array(head.byteLength + 8 + 40)
    file.set(head, 0)
    new DataView(file.buffer).setUint32(head.byteLength, 0)
    file.set(Uint8Array.from('moov', (c) => c.charCodeAt(0)), head.byteLength + 4)

    const server = serve(file, { states: false })
    const found = await locateMovie(server.read, { window: 24, limit: 4096 })

    expect(found!.at).toBe(head.byteLength)
    expect(found!.moov.byteLength).toBe(file.byteLength - head.byteLength)
    // What it asked for is the ceiling and not the world: a box of unstated length is no licence
    // to fetch the file.
    expect(server.asked.at(-1)![1]).toBeLessThanOrEqual(4096)
  })

  it('gives nothing for a file with no movie box, and asks for it a bounded number of times', async () => {
    const file = new Uint8Array(4096)
    const view = new DataView(file.buffer)
    // Sixteen boxes of 256 bytes, none of them a moov.
    for (let at = 0; at < file.byteLength; at += 256) {
      view.setUint32(at, 256)
      file.set(Uint8Array.from('free', (c) => c.charCodeAt(0)), at + 4)
    }

    const server = serve(file, { states: false })
    expect(await locateMovie(server.read, { window: 16, maxRequests: 4 })).toBeNull()
    expect(server.asked).toHaveLength(4)
  })

  it('gives nothing rather than turning for ever on a box that cannot be stepped over', async () => {
    // A size smaller than the header is a body of negative length, and stepping by it walks
    // backwards. Bytes that are not a file at all end the same way.
    const broken = new Uint8Array(64)
    new DataView(broken.buffer).setUint32(0, 3)

    expect(await locateMovie(serve(broken).read)).toBeNull()
    expect(await locateMovie(serve(new Uint8Array(0)).read)).toBeNull()
    expect(await locateMovie(serve(new Uint8Array([1, 2, 3])).read)).toBeNull()
  })

  it('hands the sample reader a movie box it can index without the file behind it', async () => {
    // The two halves of this work, joined: a few kilobytes fetched out of an eighteen-kilobyte
    // file, and every sample of both tracks addressed inside the file that was not fetched.
    const server = serve(whole)
    const found = await locateMovie(server.read)
    const tracks = samplesInMovie(found!.moov, found!.total)

    expect(tracks.map((t) => [t.trackId, t.samples.length])).toEqual([
      [1, 60],
      [2, 131],
    ])
    expect(tracks[0]!.samples[0]).toEqual({
      dts: 0,
      pts: 2048,
      duration: 1024,
      at: 48,
      size: 898,
      sync: true,
    })

    const mdat = topLevelBoxes(whole).find((b) => b.type === 'mdat')!
    expect(server.bytes).toBeLessThan(mdat.size)
  })

  it('refuses a movie box longer than it is willing to hold', async () => {
    // A header may claim any length at all. Fetching it is the reader agreeing to allocate that
    // much, so the ceiling is stated rather than discovered when the tab dies.
    const file = new Uint8Array(32)
    const view = new DataView(file.buffer)
    view.setUint32(0, 0x40000000)
    file.set(Uint8Array.from('moov', (c) => c.charCodeAt(0)), 4)

    expect(await locateMovie(serve(file).read, { limit: 1 << 20 })).toBeNull()
  })
})

describe('locateMovie, on a movie box our own writer produced', () => {
  it('finds the box our clips put at the front', async () => {
    // buildProgressiveMp4 writes ftyp, moov, mdat — a saved clip is a streaming-ordered file, and
    // the reader that opens somebody else's file opens ours in one request too.
    const file = boxOf('ftyp', zeroes(24))
    const moov = boxOf('moov', fullBoxOf('mvhd', 0, 0, u32(0, 0, 90000, 0), u64(0)))
    const mdat = boxOf('mdat', zeroes(4096))
    const bytes = new Uint8Array(file.byteLength + moov.byteLength + mdat.byteLength)
    bytes.set(file, 0)
    bytes.set(moov, file.byteLength)
    bytes.set(mdat, file.byteLength + moov.byteLength)

    const found = await locateMovie(serve(bytes).read)
    expect(found!.requests).toBe(1)
    expect(found!.moov).toEqual(moov)
  })
})
