import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ReadRefused,
  openPlainFile,
  rangeReaderFor,
  totalFromContentRange,
} from '../../src/bridge/loader'
import { locateMovie } from '../../src/core/iso/locate'
import { topLevelBoxes } from '../../src/core/iso/reader'

const whole = new Uint8Array(readFileSync('tests/fixtures/plain/whole.mp4'))
/** The same six seconds of nothing in the other container a plain file arrives in. */
const matroska = new Uint8Array(readFileSync('tests/fixtures/plain/watched.webm'))
/** VP8 and Vorbis, which is what an imageboard hands over. */
const older = new Uint8Array(readFileSync('tests/fixtures/plain/watched-vp8.webm'))

/** A Response takes a view over a plain ArrayBuffer and not one that might be shared memory. */
const bodyOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

interface Asked {
  url: string
  range: string | null
}

/**
 * A server, in the two shapes the survey of eighteen hosts turned up and the one it warned about.
 *
 * `ranges` is what fifteen of the eighteen did: 206 with a Content-Range. `whole` is a server that
 * ignores the header and hands over the file. `redirect` is archive.org — a 302 to a CDN node,
 * with the Range lost somewhere on the way, so the first answer is the whole file under a
 * different address.
 */
function server(
  file: Uint8Array,
  mode: 'ranges' | 'whole' | 'redirect',
  options: { at?: string } = {},
) {
  const asked: Asked[] = []
  const node = options.at ?? 'https://cdn.example/node/clip.mp4'

  const call = async (url: string, init?: RequestInit): Promise<Response> => {
    const range = new Headers(init?.headers).get('range')
    asked.push({ url, range })

    const ranged = mode === 'ranges' || (mode === 'redirect' && url === node)
    if (!ranged || !range) {
      // A 200 carries the whole file. On the redirecting server the answer reports the address it
      // ended up at, which is the only clue that a second try is worth making.
      return withUrl(
        new Response(bodyOf(file), {
          status: 200,
          headers: { 'content-length': String(file.byteLength) },
        }),
        mode === 'redirect' ? node : url,
      )
    }

    const match = /bytes=(\d+)-(\d+)/.exec(range)!
    const from = Number(match[1])
    const to = Math.min(Number(match[2]), file.byteLength - 1)
    const part = file.subarray(from, to + 1)

    return withUrl(
      new Response(bodyOf(part), {
        status: 206,
        headers: {
          'content-range': `bytes ${from}-${to}/${file.byteLength}`,
          'content-length': String(part.byteLength),
        },
      }),
      url,
    )
  }

  return { asked, call: call as unknown as typeof fetch }
}

/** `Response.url` is read-only; a fake server still has to be able to say where it ended up. */
function withUrl(answer: Response, url: string): Response {
  Object.defineProperty(answer, 'url', { value: url })
  return answer
}

describe('totalFromContentRange', () => {
  it('takes the length of the file off a 206 and nothing else', () => {
    expect(totalFromContentRange('bytes 0-8191/18003')).toBe(18003)
    // A server that knows the part but not the whole: legal, and no length at all.
    expect(totalFromContentRange('bytes 0-8191/*')).toBe(0)
    expect(totalFromContentRange(null)).toBe(0)
    expect(totalFromContentRange('')).toBe(0)
  })
})

describe('rangeReaderFor', () => {
  it('asks for the range it was given and reads the length off the answer', async () => {
    const host = server(whole, 'ranges')
    const read = rangeReaderFor('https://cdn.example/clip.mp4', { fetch: host.call })

    const answer = await read(40, 16)

    expect(host.asked).toEqual([{ url: 'https://cdn.example/clip.mp4', range: 'bytes=40-55' }])
    expect(answer.total).toBe(whole.byteLength)
    expect(answer.bytes).toEqual(whole.subarray(40, 56))
  })

  it('finds the movie box of a real file over it, in two requests', async () => {
    const host = server(whole, 'ranges')
    const found = await locateMovie(rangeReaderFor('https://cdn.example/clip.mp4', { fetch: host.call }))

    expect(found!.requests).toBe(2)
    expect(found!.total).toBe(whole.byteLength)
    expect(host.asked.map((one) => one.range)).toEqual(['bytes=0-8191', 'bytes=14681-18002'])
  })

  it('chases the redirect once and ranges the address it lands on', async () => {
    // archive.org: a 302 to a CDN node, and the Range dies on the way. The whole-file answer is
    // not taken as a refusal — the address it came from is asked again, ranged, and remembered.
    const host = server(whole, 'redirect')
    const read = rangeReaderFor('https://archive.example/clip.mp4', { fetch: host.call })

    expect((await read(40, 16)).bytes).toEqual(whole.subarray(40, 56))
    expect((await read(0, 8)).bytes).toEqual(whole.subarray(0, 8))

    expect(host.asked.map((one) => one.url)).toEqual([
      'https://archive.example/clip.mp4',
      'https://cdn.example/node/clip.mp4',
      // The second read goes straight to the node: the detour is paid once per file.
      'https://cdn.example/node/clip.mp4',
    ])
  })

  it('takes the front of a whole-file answer from a server that will not range at all', async () => {
    const host = server(whole, 'whole')
    const read = rangeReaderFor('https://cdn.example/clip.mp4', { fetch: host.call })

    const answer = await read(0, 64)

    expect(answer.bytes).toEqual(whole.subarray(0, 64))
    expect(answer.total).toBe(whole.byteLength)
  })

  it('refuses to pull the material down to reach a table behind it', async () => {
    // The other half of the same case: a server that will not range, and a movie box sitting
    // behind forty megabytes of pictures. Reaching it means downloading them, which is the one
    // thing this design exists not to do.
    const host = server(whole, 'whole')
    const read = rangeReaderFor('https://cdn.example/clip.mp4', {
      fetch: host.call,
      maxPrefixBytes: 1024,
    })

    await expect(read(14681, 3322)).rejects.toBeInstanceOf(ReadRefused)
  })

  it('answers a refusal rather than a truncated file', async () => {
    const failing = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch
    const read = rangeReaderFor('https://cdn.example/clip.mp4', { fetch: failing })

    await expect(read(0, 16)).rejects.toBeInstanceOf(ReadRefused)
  })

  it('turns a network failure into the same refusal', async () => {
    const broken = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    await expect(
      rangeReaderFor('https://cdn.example/clip.mp4', { fetch: broken })(0, 16),
    ).rejects.toBeInstanceOf(ReadRefused)
  })
})

describe('openPlainFile', () => {
  const open = (file: Uint8Array, mode: 'ranges' | 'whole' = 'ranges') => {
    const host = server(file, mode)
    return {
      host,
      opened: openPlainFile('https://cdn.example/clip', { fetch: host.call }),
    }
  }

  it('opens an ordinary mp4 in the two requests it always cost', async () => {
    // The container is settled by the first four bytes of the same probe the mp4 walk needed
    // anyway, so learning that a file is not a Matroska costs nothing at all. This number is the
    // whole of that claim: a sniff of its own would have made it three.
    const { host, opened } = open(whole)

    const file = (await opened)!.file
    expect(file.tracks.map((track) => track.kind)).toEqual(['video', 'audio'])
    expect(host.asked.map((one) => one.range)).toEqual(['bytes=0-8191', 'bytes=14681-18002'])
  })

  it('opens a whole Matroska and indexes every frame of it', async () => {
    const { opened } = open(matroska)
    const file = (await opened)!.file

    expect(file.codecs).toEqual(['V_VP9', 'A_OPUS'])
    expect(file.tracks.map((track) => track.samples.length)).toEqual([200, 1001])
    expect(file.durationSeconds).toBeCloseTo(20, 1)
    expect(file.total).toBe(matroska.byteLength)
    expect(file.refusedTracks).toBe(false)
  })

  it('opens the older pair an imageboard serves', async () => {
    const file = (await open(older).opened)!.file

    expect(file.codecs).toEqual(['V_VP8', 'A_VORBIS'])
    expect(topLevelBoxes(file.tracks[0]!.sampleEntry)[0]!.type).toBe('vp08')
    expect(topLevelBoxes(file.tracks[1]!.sampleEntry)[0]!.type).toBe('mp4a')
  })

  it('hands back the reader the tables were found with, ready for the save', async () => {
    const { host, opened } = open(matroska)
    const found = (await opened)!

    const asked = host.asked.length
    const answer = await found.read(0, 4)

    expect(answer.bytes).toEqual(matroska.subarray(0, 4))
    expect(host.asked.length).toBe(asked + 1)
  })

  it('gives nothing for bytes that are neither container', async () => {
    const nonsense = new Uint8Array(4096)
    nonsense.set(new TextEncoder().encode('not a video at all'), 0)

    expect(await open(nonsense).opened).toBeNull()
  })

  it('gives nothing when the read is refused outright', async () => {
    const failing = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch

    expect(await openPlainFile('https://cdn.example/clip', { fetch: failing })).toBeNull()
  })
})
