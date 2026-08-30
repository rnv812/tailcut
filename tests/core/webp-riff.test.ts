import { describe, expect, it } from 'vitest'
import {
  chunksOf,
  imageChunksOf,
  packAnimation,
  sizeOf,
  type AnimationFrame,
  type ImageChunk,
} from '../../src/core/webp/riff'

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0))
const u32 = (value: number): number[] => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
]

function chunk(tag: string, body: readonly number[]): number[] {
  return [...ascii(tag), ...u32(body.length), ...body, ...(body.length & 1 ? [0] : [])]
}

function webp(chunks: readonly number[][]): Uint8Array {
  const payload = chunks.flat()
  return Uint8Array.of(...ascii('RIFF'), ...u32(payload.length + 4), ...ascii('WEBP'), ...payload)
}

function vp8(width: number, height: number): number[] {
  return [0x10, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, width >>> 8, height & 0xff, height >>> 8]
}

function vp8l(width: number, height: number): number[] {
  const bits = (width - 1) | ((height - 1) << 14)
  return [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]
}

const lossyStill = (width = 320, height = 240): Uint8Array =>
  webp([chunk('VP8 ', vp8(width, height))])

const frame = (bytes: Uint8Array, over: Partial<AnimationFrame> = {}): AnimationFrame => ({
  bytes,
  durationMs: 67,
  ...over,
})

describe('chunksOf', () => {
  it('rejects a file without the RIFF signature', () => {
    expect(() => chunksOf(Uint8Array.of(...ascii('NOPE'), 4, 0, 0, 0, ...ascii('WEBP')))).toThrow(
      'Not a WebP file.',
    )
  })

  it('rejects bytes that are not a RIFF WebP file', () => {
    expect(() => chunksOf(Uint8Array.of(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')))).toThrow(
      'Not a WebP file.',
    )
  })

  it('reads every top-level chunk with its payload address and size', () => {
    const bytes = webp([
      chunk('VP8X', [2, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      chunk('ICCP', [1, 2, 3, 4]),
      chunk('VP8 ', vp8(320, 240)),
    ])

    expect(chunksOf(bytes)).toEqual([
      { tag: 'VP8X', at: 20, size: 10 },
      { tag: 'ICCP', at: 38, size: 4 },
      { tag: 'VP8 ', at: 50, size: 10 },
    ])
  })

  it('skips the padding byte after an odd-sized chunk', () => {
    const bytes = webp([chunk('ICCP', [1, 2, 3]), chunk('VP8 ', vp8(17, 19))])
    expect(chunksOf(bytes)).toEqual([
      { tag: 'ICCP', at: 20, size: 3 },
      { tag: 'VP8 ', at: 32, size: 10 },
    ])
  })

  it('stops at the byte length declared by the RIFF header', () => {
    const declared = webp([chunk('VP8 ', vp8(17, 19))])
    const bytes = Uint8Array.from([...declared, ...chunk('ICCP', [1, 2])])

    expect(chunksOf(bytes).map(({ tag }) => tag)).toEqual(['VP8 '])
  })
})

describe('imageChunksOf', () => {
  it('drops the extended header and colour profile from a lossy still', () => {
    const body = vp8(40, 30)
    const bytes = webp([
      chunk('VP8X', [0x20, 0, 0, 0, 39, 0, 0, 29, 0, 0]),
      chunk('ICCP', [4, 3, 2, 1]),
      chunk('VP8 ', body),
    ])

    expect(imageChunksOf(bytes)).toEqual([{ tag: 'VP8 ', body: Uint8Array.from(body) }])
  })

  it('keeps both alpha and picture payloads from a transparent lossy still', () => {
    const alpha = [9, 8, 7]
    const picture = vp8(80, 45)
    const bytes = webp([
      chunk('VP8X', [0x10, 0, 0, 0, 79, 0, 0, 44, 0, 0]),
      chunk('ALPH', alpha),
      chunk('VP8 ', picture),
    ])

    expect(imageChunksOf(bytes)).toEqual([
      { tag: 'ALPH', body: Uint8Array.from(alpha) },
      { tag: 'VP8 ', body: Uint8Array.from(picture) },
    ])
  })

  it('keeps a bare lossless picture payload', () => {
    const body = vp8l(41, 31)
    expect(imageChunksOf(webp([chunk('VP8L', body)]))).toEqual([
      { tag: 'VP8L', body: Uint8Array.from(body) },
    ])
  })

  it('rejects a still with no picture and names the chunks it saw', () => {
    const bytes = webp([chunk('VP8X', [0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]), chunk('ALPH', [1])])
    expect(() => imageChunksOf(bytes)).toThrow('No image chunk in the still; saw VP8X, ALPH.')
  })
})

describe('packAnimation', () => {
  it('writes a complete RIFF animation with one ANMF per frame', () => {
    const bytes = packAnimation({
      width: 320,
      height: 240,
      loop: 3,
      frames: [frame(lossyStill(), { durationMs: 67 }), frame(lossyStill(), { durationMs: 66 })],
    })
    const chunks = chunksOf(bytes)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8)
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WEBP')
    expect(chunks.map(({ tag }) => tag)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF'])

    const vp8x = chunks[0]!
    expect([...bytes.subarray(vp8x.at + 4, vp8x.at + 10)]).toEqual([0x3f, 0x01, 0, 0xef, 0, 0])
    const anim = chunks[1]!
    expect(view.getUint16(anim.at + 4, true)).toBe(3)
    expect(view.getUint32(chunks[2]!.at + 12, true) & 0x00ff_ffff).toBe(67)
    expect(view.getUint32(chunks[3]!.at + 12, true) & 0x00ff_ffff).toBe(66)
  })

  it('does not carry a per-frame ICCP or claim its flag in the file header', () => {
    const still = webp([
      chunk('VP8X', [0x20, 0, 0, 0, 39, 0, 0, 29, 0, 0]),
      chunk('ICCP', [1, 2, 3, 4]),
      chunk('VP8 ', vp8(40, 30)),
    ])
    const bytes = packAnimation({ width: 40, height: 30, frames: [frame(still)] })
    const vp8x = chunksOf(bytes)[0]!

    expect(bytes[vp8x.at]).toBe(0x02)
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('ICCP')
  })

  it('declares alpha when a frame carries an alpha payload', () => {
    const still = webp([
      chunk('VP8X', [0x10, 0, 0, 0, 39, 0, 0, 29, 0, 0]),
      chunk('ALPH', [0, 255, 255, 0]),
      chunk('VP8 ', vp8(40, 30)),
    ])
    const bytes = packAnimation({ width: 40, height: 30, frames: [frame(still)] })
    const vp8x = chunksOf(bytes)[0]!

    expect(bytes[vp8x.at]).toBe(0x12)

    const lossless = vp8l(40, 30)
    lossless[4] = lossless[4]! | 0x10
    const losslessBytes = packAnimation({
      width: 40,
      height: 30,
      frames: [frame(webp([chunk('VP8L', lossless)]))],
    })
    const losslessVp8x = chunksOf(losslessBytes)[0]!
    expect(losslessBytes[losslessVp8x.at]).toBe(0x12)
  })

  it('writes the frame rectangle, payload, background and rendering flags', () => {
    const picture = vp8(40, 30)
    const bytes = packAnimation({
      width: 101,
      height: 81,
      background: 0xaabb_ccdd,
      frames: [
        frame(webp([chunk('VP8 ', picture)]), {
          x: 4,
          y: 6,
          durationMs: 12.4,
          blend: true,
          dispose: true,
        }),
      ],
    })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const top = chunksOf(bytes)
    const anim = top.find(({ tag }) => tag === 'ANIM')!
    const anmf = top.find(({ tag }) => tag === 'ANMF')!
    const u24At = (at: number): number =>
      bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)

    expect(view.getUint32(anim.at, true)).toBe(0xaabb_ccdd)
    expect([u24At(anmf.at), u24At(anmf.at + 3)]).toEqual([2, 3])
    expect([u24At(anmf.at + 6), u24At(anmf.at + 9)]).toEqual([39, 29])
    expect(u24At(anmf.at + 12)).toBe(12)
    expect(bytes[anmf.at + 15]).toBe(1)
    expect(new TextDecoder().decode(bytes.subarray(anmf.at + 16, anmf.at + 20))).toBe('VP8 ')
    expect(view.getUint32(anmf.at + 20, true)).toBe(picture.length)
    expect([...bytes.subarray(anmf.at + 24, anmf.at + 24 + picture.length)]).toEqual(picture)
  })

  it('rounds each duration into the unsigned 24-bit field', () => {
    const bytes = packAnimation({
      width: 320,
      height: 240,
      frames: [
        frame(lossyStill(), { durationMs: -10 }),
        frame(lossyStill(), { durationMs: 1.6 }),
        frame(lossyStill(), { durationMs: 0x100_0000 }),
      ],
    })
    const durations = chunksOf(bytes)
      .filter(({ tag }) => tag === 'ANMF')
      .map(({ at }) => bytes[at + 12]! | (bytes[at + 13]! << 8) | (bytes[at + 14]! << 16))

    expect(durations).toEqual([0, 2, 0xff_ffff])
  })

  it('rejects odd frame offsets but accepts an odd canvas', () => {
    expect(() =>
      packAnimation({ width: 321, height: 241, frames: [frame(lossyStill(), { x: 1 })] }),
    ).toThrow('ANMF offsets are stored halved and must be even.')
    expect(() =>
      packAnimation({ width: 321, height: 241, frames: [frame(lossyStill(), { y: 3 })] }),
    ).toThrow('ANMF offsets are stored halved and must be even.')

    const bytes = packAnimation({ width: 321, height: 241, frames: [frame(lossyStill())] })
    const vp8x = chunksOf(bytes)[0]!
    expect([...bytes.subarray(vp8x.at + 4, vp8x.at + 10)]).toEqual([0x40, 0x01, 0, 0xf0, 0, 0])
  })
})

describe('sizeOf', () => {
  it('reads a VP8 keyframe size', () => {
    expect(sizeOf([{ tag: 'VP8 ', body: Uint8Array.from(vp8(641, 361)) }])).toEqual([641, 361])
  })

  it('reads a VP8L header size', () => {
    const image: ImageChunk[] = [{ tag: 'VP8L', body: Uint8Array.from(vp8l(639, 359)) }]
    expect(sizeOf(image)).toEqual([639, 359])
  })
})
