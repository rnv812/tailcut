import { boxOf, u16, u32, u8 } from '../iso/writer'

// H.273 code points supported by WebCodecs. Unknown values stay unspecified.
const PRIMARIES = { bt709: 1, bt470bg: 5, smpte170m: 6 } as const
const TRANSFER = { bt709: 1, smpte170m: 6, 'iec61966-2-1': 13 } as const
const MATRIX = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6 } as const

function nameOf<T extends string>(values: Record<T, number>, code: number): T | undefined {
  return (Object.keys(values) as T[]).find(name => values[name] === code)
}

/** Container colour information can be the only colour signal in the source. */
export function readColour(body: Uint8Array | undefined): VideoColorSpaceInit | undefined {
  if (!body || body.length < 10) return undefined
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const type = view.getUint32(0)
  if (type !== 0x6e636c78 && type !== 0x6e636c63) return undefined // nclx / nclc
  if (type === 0x6e636c78 && body.length < 11) return undefined
  const primaries = nameOf(PRIMARIES, view.getUint16(4))
  const transfer = nameOf(TRANSFER, view.getUint16(6))
  const matrix = nameOf(MATRIX, view.getUint16(8))
  return {
    ...(primaries === undefined ? {} : { primaries }),
    ...(transfer === undefined ? {} : { transfer }),
    ...(matrix === undefined ? {} : { matrix }),
    ...(type === 0x6e636c78 ? { fullRange: (body[10]! & 0x80) !== 0 } : {}),
  }
}

/** Describe the encoded pixels, using the encoder's metadata rather than the source's. */
export function colourBox(colour: VideoColorSpaceInit | undefined): Uint8Array {
  if (!colour || colour.fullRange == null) return new Uint8Array(0)
  return boxOf('colr', u32(0x6e636c78),
    u16(colour.primaries ? PRIMARIES[colour.primaries] ?? 2 : 2,
      colour.transfer ? TRANSFER[colour.transfer] ?? 2 : 2,
      colour.matrix ? MATRIX[colour.matrix] ?? 2 : 2),
    u8(colour.fullRange ? 0x80 : 0))
}
