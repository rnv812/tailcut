import { describe, it, expect } from 'vitest'
import { boxOf, concatBytes, i64, u64 } from '../../src/core/iso/writer'
import { boxBody, topLevelBoxes } from '../../src/core/iso/reader'

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

describe('boxOf', () => {
  it('writes a box the reader reads back', () => {
    const box = boxOf('moov', bytes(1, 2, 3))
    const read = topLevelBoxes(box)

    expect(read.map((b) => [b.type, b.size, b.headerSize])).toEqual([['moov', 11, 8]])
    expect([...boxBody(box, read[0]!)]).toEqual([1, 2, 3])
  })

  it('counts the header into the size, not only the body', () => {
    // A size stated without the header sends the reader eight bytes short of the next box, and
    // from there every box after it is read out of the middle of the one before.
    expect(topLevelBoxes(concatBytes([boxOf('ftyp'), boxOf('moov')])).map((b) => b.type)).toEqual([
      'ftyp',
      'moov',
    ])
  })

  it('keeps the parts in the order they were given', () => {
    const box = boxOf('mvex', bytes(1), bytes(2, 3), bytes(4))

    expect([...boxBody(box, topLevelBoxes(box)[0]!)]).toEqual([1, 2, 3, 4])
  })
})

describe('concatBytes', () => {
  it('lays buffers end to end', () => {
    expect([...concatBytes([bytes(1, 2), bytes(), bytes(3)])]).toEqual([1, 2, 3])
  })

  it('takes the body of a view, not the buffer under it', () => {
    const backing = bytes(0xaa, 1, 2, 0xaa)

    expect([...concatBytes([backing.subarray(1, 3)])]).toEqual([1, 2])
  })

  it('gives an empty buffer for nothing at all', () => {
    expect(concatBytes([])).toHaveLength(0)
  })
})

describe('i64', () => {
  it('writes a media_time the way an elst version 1 states it', () => {
    const view = new DataView(i64(1024).buffer)
    expect(i64(0).byteLength).toBe(8)
    expect(view.getBigInt64(0)).toBe(1024n)

    // −1 is the legal way to state an empty edit: a hole at the head of the track rather than an
    // offset into the material. u64 exists and cannot say it — it clamps at zero, which would
    // turn a mistake in the caller into a silently different edit instead of a visible one.
    expect(new DataView(i64(-1).buffer).getBigInt64(0)).toBe(-1n)
    expect(new DataView(u64(-1).buffer).getBigUint64(0)).toBe(0n)
  })
})
