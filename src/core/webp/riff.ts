/**
 * Animated WebP, packed by hand.
 *
 * Animated WebP stores frames as ANMF chunks in a RIFF container, without a dependency and
 * without wasm. The frame bitstreams come from the canvas; this file writes only the container
 * around them, and it is the whole of what the format costs us.
 */

import { formatBytes } from '../../shared/format'

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))
const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
const u24 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]
const u16 = (n: number): number[] => [n & 255, (n >>> 8) & 255]

export interface RiffChunk {
  tag: string
  /** Where the payload starts, counted from the first byte of the file. */
  at: number
  size: number
}

/** Every top-level chunk of a RIFF/WEBP file. */
export function chunksOf(bytes: Uint8Array): RiffChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number): string =>
    String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)

  if (bytes.byteLength < 12 || text(0) !== 'RIFF' || text(8) !== 'WEBP') {
    throw new Error('Not a WebP file.')
  }

  const out: RiffChunk[] = []
  let at = 12
  const end = Math.min(bytes.length, 8 + view.getUint32(4, true))

  while (at + 8 <= end) {
    const size = view.getUint32(at + 4, true)
    out.push({ tag: text(at), at: at + 8, size })
    // Chunks are padded to an even length, and the padding byte is not part of the payload.
    at += 8 + size + (size & 1)
  }

  return out
}

export interface ImageChunk {
  tag: string
  body: Uint8Array
}

/**
 * The image data of a still WebP, ready to be laid inside an ANMF.
 *
 * `convertToBlob` returns one of three shapes: a bare `VP8 ` (lossy), a bare `VP8L` (lossless),
 * or a `VP8X` with an `ALPH` beside a `VP8 ` when the canvas had transparency. An ANMF carries
 * exactly the same payload, so these cross over verbatim.
 *
 * What is left behind is the per-still `VP8X` and the `ICCP` the browser attaches to every one of
 * them: 482 bytes a frame, about seven kilobytes a second at 15 fps and 6.8 per cent of the file
 * at 640×360. Dropping it is safe and was measured to be: a single-frame animation packed
 * this way has the same PSNR as the unwrapped still to four significant figures, and Chrome,
 * Firefox, ffmpeg and libwebp all draw it identically.
 */
export function imageChunksOf(bytes: Uint8Array): ImageChunk[] {
  const chunks = chunksOf(bytes)
  const keep = chunks.filter((c) => c.tag === 'VP8 ' || c.tag === 'VP8L' || c.tag === 'ALPH')
  if (!keep.some((chunk) => chunk.tag === 'VP8 ' || chunk.tag === 'VP8L')) {
    throw new Error(`No image chunk in the still; saw ${chunks.map((c) => c.tag).join(', ')}.`)
  }
  return keep.map((c) => ({ tag: c.tag, body: bytes.subarray(c.at, c.at + c.size) }))
}

/** Whether a frame carries transparency, explicitly or in its lossless bitstream header. */
function hasAlpha(image: readonly ImageChunk[]): boolean {
  if (image.some((part) => part.tag === 'ALPH')) return true
  return image.some((part) => part.tag === 'VP8L' && (part.body[4]! & 0x10) !== 0)
}

/** A payload length with the padding byte RIFF puts after an odd one. */
const padded = (size: number): number => size + (size & 1)

/** The frame rectangle, duration and flags at the head of every ANMF payload. */
const ANMF_HEAD_BYTES = 16

/** RIFF/WEBP + VP8X + ANIM around every animation: 12 + 18 + 14. */
export const ANIMATION_HEADER_BYTES = 44

/**
 * The largest file the format can say the size of: the RIFF size field is 32 bits and counts
 * from byte 8, and RFC 9649 caps it at 2³² − 10, so a whole file is at most 4 GiB less two bytes.
 */
export const WEBP_FILE_LIMIT = 2 ** 32 - 10 + 8

/**
 * What one frame lays into the animation, in bytes: its whole ANMF chunk.
 *
 * Exported so that an encoder can count the file while it is still being made — the same number
 * `packAnimation` allocates, and not an estimate of it. The payload is always even (sixteen bytes
 * of head and every inner chunk padded), so the ANMF itself needs no padding.
 */
export function anmfBytesOf(image: readonly ImageChunk[]): number {
  return 8 + ANMF_HEAD_BYTES + image.reduce((sum, part) => sum + 8 + padded(part.body.length), 0)
}

export interface AnimationFrame {
  /** A complete still .webp, as `convertToBlob` returned it. */
  bytes: Uint8Array
  /** Whole milliseconds. The format has no timescale; see `frameDurations` for why that matters. */
  durationMs: number
  x?: number
  y?: number
  blend?: boolean
  dispose?: boolean
}

/**
 * The frames as one animated file.
 *
 * The canvas may be odd-sided: 641×361 passes libwebp's own checker and is read back by ffmpeg.
 * The sub-frame offsets may not — the format stores them halved — and this program writes every
 * frame at the origin, so they are zero and the question never arises in practice. The check is
 * here because an odd offset would be written as a different rectangle, silently.
 */
export function packAnimation(options: {
  width: number
  height: number
  frames: readonly AnimationFrame[]
  /** 0 is forever. */
  loop?: number
  background?: number
}): Uint8Array {
  const images = options.frames.map((frame) => imageChunksOf(frame.bytes))
  const total = images.reduce((sum, image) => sum + anmfBytesOf(image), ANIMATION_HEADER_BYTES)

  // Counted before a byte is allocated, and refused rather than wrapped: `u32` keeps the low 32
  // bits of whatever it is given, so a file of 4.2 GB would say it was some 200 MB long and every
  // reader would stop there — a file that saves and does not open.
  if (total > WEBP_FILE_LIMIT) {
    throw new Error(
      `An animated WebP holds at most 4 GB, and these frames come to ${formatBytes(total)}.`,
    )
  }

  // One allocation, the size of the file, written front to back. Chunk by chunk and joined
  // afterwards, the same bytes were copied three times over — each image into its chunk, each
  // frame into the payload, the payload into the file — and at the end of a long clip that was
  // three copies of the animation in memory on top of the stills they came from.
  const file = new Uint8Array(total)
  let at = 0
  const put = (bytes: ArrayLike<number>): void => {
    file.set(bytes, at)
    at += bytes.length
  }
  const head = (tag: string, size: number): void => {
    put(ascii(tag))
    put(u32(size))
  }

  head('RIFF', total - 8)
  put(ascii('WEBP'))

  // The ICCP flag in particular must stay clear — the profile the browser put on every still is
  // not in this file, and claiming it would be a lie a reader acts on. Alpha is different: its
  // payload crosses into the animation, so the outer header must declare it when any frame has it.
  head('VP8X', 10)
  put([
    0x02 | (images.some(hasAlpha) ? 0x10 : 0),
    0,
    0,
    0,
    ...u24(options.width - 1),
    ...u24(options.height - 1),
  ])
  head('ANIM', 6)
  put([...u32(options.background ?? 0), ...u16(options.loop ?? 0)])

  for (const [index, frame] of options.frames.entries()) {
    const image = images[index]!
    const [width, height] = sizeOf(image)
    const x = frame.x ?? 0
    const y = frame.y ?? 0
    if (x & 1 || y & 1) throw new Error('ANMF offsets are stored halved and must be even.')

    head('ANMF', anmfBytesOf(image) - 8)
    put([
      ...u24(x >> 1),
      ...u24(y >> 1),
      ...u24(width - 1),
      ...u24(height - 1),
      ...u24(Math.max(0, Math.min(0xffffff, Math.round(frame.durationMs)))),
      // Blend off and dispose off: every frame is a whole picture, so blending would only cost
      // time and disposing would only clear what the next frame overwrites anyway.
      (frame.blend ? 0 : 2) | (frame.dispose ? 1 : 0),
    ])

    for (const part of image) {
      head(part.tag, part.body.length)
      put(part.body)
      // The padding byte is already zero: the file was allocated that way.
      at += part.body.length & 1
    }
  }

  return file
}

/** Width and height straight out of a VP8 keyframe or a VP8L header: a cross-check on the canvas. */
export function sizeOf(image: readonly ImageChunk[]): [number, number] {
  const lossy = image.find((c) => c.tag === 'VP8 ')
  if (lossy) {
    const b = lossy.body
    // Three bytes of frame tag, three of start code, then fourteen bits each of width and height.
    return [(b[6]! | (b[7]! << 8)) & 0x3fff, (b[8]! | (b[9]! << 8)) & 0x3fff]
  }

  const lossless = image.find((c) => c.tag === 'VP8L')
  if (lossless) {
    const b = lossless.body
    const bits = b[1]! | (b[2]! << 8) | (b[3]! << 16) | (b[4]! << 24)
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
  }

  throw new Error('No bitstream to read a size from.')
}
