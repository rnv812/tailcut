import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { locateSegment } from '../../src/core/webm/locate'
import { indexClusters, type WebmFrame } from '../../src/core/webm/whole'
import { parseClusters } from '../../src/core/webm/fragment'
import type { RangeRead } from '../../src/core/iso/locate'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/** VP9 and Opus, twenty seconds, ten clusters. Its last Opus packet sits in a BlockGroup. */
const whole = read('tests/fixtures/plain/watched.webm')
/** VP8 and Vorbis, the imageboard pair: fewer clusters and a Vorbis packet rate of its own. */
const older = read('tests/fixtures/plain/watched-vp8.webm')

interface Server {
  read: (at: number, length: number) => Promise<RangeRead>
  asked: Array<[number, number]>
  bytes: number
}

function serve(file: Uint8Array): Server {
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
      return { bytes, total: file.byteLength }
    },
  }

  return server
}

/**
 * The same frames read the other way: the whole file in memory, walked by the parser the captured
 * path uses on a media segment out of MSE.
 *
 * This is the yardstick, and it is the same one the mp4 side uses (tests/core/movie.test.ts
 * indexes one file through both of its readers and compares them field for field). Where the two
 * disagree about one file, one of them is wrong — and a walk over ranges that never holds the
 * file has every opportunity to lose a frame at a window boundary.
 */
function inMemory(file: Uint8Array): Array<Omit<WebmFrame, 'source'> & { bytes: Uint8Array }> {
  return parseClusters(file)
    .flatMap((cluster) => cluster.frames)
    .map((frame) => ({
      trackNumber: frame.trackNumber,
      timestamp: frame.timestamp,
      duration: frame.duration,
      keyframe: frame.keyframe,
      bytes: frame.data,
    }))
}

/** The frames as the ranged walk found them, with the bytes each one names fetched back. */
async function indexed(file: Uint8Array, window?: number): Promise<{
  frames: WebmFrame[]
  server: Server
}> {
  const server = serve(file)
  const found = (await locateSegment(server.read))!
  const frames = await indexClusters(server.read, found, window ? { window } : {})

  expect(frames, 'the clusters could not be indexed').not.toBeNull()
  return { frames: frames!, server }
}

describe('indexClusters', () => {
  for (const [name, file] of [
    ['VP9 and Opus', whole],
    ['VP8 and Vorbis', older],
  ] as const) {
    it(`finds every frame of a ${name} file, and finds it where the parser does`, async () => {
      const { frames } = await indexed(file)
      const wanted = inMemory(file)

      expect(frames).toHaveLength(wanted.length)

      for (let i = 0; i < wanted.length; i++) {
        const got = frames[i]!
        const want = wanted[i]!

        expect(
          {
            trackNumber: got.trackNumber,
            timestamp: got.timestamp,
            duration: got.duration,
            keyframe: got.keyframe,
            length: got.source.length,
          },
          `frame ${i} came out differently from the in-memory walk`,
        ).toEqual({
          trackNumber: want.trackNumber,
          timestamp: want.timestamp,
          duration: want.duration,
          keyframe: want.keyframe,
          length: want.bytes.byteLength,
        })

        // And the address is an address: the bytes at it are the coded frame, not the block
        // header in front of it or the one after it.
        expect(
          file.subarray(got.source.at, got.source.at + got.source.length),
          `frame ${i} is addressed at the wrong place in the file`,
        ).toEqual(want.bytes)
      }
    })
  }

  it('states the keyframes of the picture and every packet of the sound', async () => {
    const { frames } = await indexed(whole)
    const picture = frames.filter((frame) => frame.trackNumber === 1)
    const sound = frames.filter((frame) => frame.trackNumber === 2)

    // Twenty seconds at ten frames a second, a key frame every two.
    expect(picture).toHaveLength(200)
    expect(picture.filter((frame) => frame.keyframe)).toHaveLength(10)
    expect(picture[0]!.keyframe).toBe(true)

    // Every Opus packet can be decoded on its own, and the container says so on every block.
    expect(sound.every((frame) => frame.keyframe)).toBe(true)
  })

  it('reads the material once and no more, in a handful of requests', async () => {
    const { server } = await indexed(whole)

    // The clusters have to be read: a Matroska describes a frame in the header immediately in
    // front of it, and there is no table anywhere else to read instead. What the walk must not do
    // is read them twice over, or read what is not material at all.
    //
    // One pass over the file, give or take the element header a window boundary cuts through —
    // the walk asks for that header again from its first byte, and the few bytes of it already
    // held are the whole of the overlap.
    expect(server.bytes).toBeLessThan(whole.byteLength + 64)
    expect(server.bytes).toBeGreaterThan(whole.byteLength / 2)
    expect(server.asked.length).toBeLessThan(6)
  })

  it('loses nothing when a block straddles the end of a window', async () => {
    // A window of 700 bytes cuts through blocks, through cluster headers and through the middle
    // of a frame. The walk has to come back for the rest rather than stop at what it holds.
    const { frames } = await indexed(whole, 700)
    const wanted = inMemory(whole)

    expect(frames).toHaveLength(wanted.length)
    expect(frames.map((frame) => frame.timestamp)).toEqual(wanted.map((frame) => frame.timestamp))
    expect(frames.map((frame) => frame.source.length)).toEqual(
      wanted.map((frame) => frame.bytes.byteLength),
    )
  })

  it('refuses a file whose material is more than it will read to index', async () => {
    const server = serve(whole)
    const found = (await locateSegment(server.read))!
    const asked = server.asked.length

    expect(await indexClusters(server.read, found, { limit: 8192, window: 4096 })).toBeNull()
    // Not one byte asked for. How much material there is, is known before any of it is read —
    // the segment states where it ends — so a file that is going to be refused is refused
    // without a request, and not discovered a window at a time on the way through it.
    expect(server.asked.length).toBe(asked)

    // A segment that claims to run far past the end of the file is weighed the same way: what
    // bounds the walk is what the file says about itself, and it says too much.
    expect(
      await indexClusters(server.read, { ...found, segmentEnd: 1e9, total: 0 }, { window: 4096 }),
    ).toBeNull()
    expect(server.asked.length).toBe(asked)
  })

  it('gives nothing for a segment with no material in it', async () => {
    const server = serve(whole)
    const found = (await locateSegment(server.read))!

    // The head, and nothing behind it: a file cut off after its Tracks.
    const empty = { ...found, segmentEnd: found.clustersAt }
    expect(await indexClusters(server.read, empty, {})).toBeNull()
  })
})
