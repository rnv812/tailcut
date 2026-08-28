import { describe, it, expect, vi } from 'vitest'
import { planSnapshot, type SnapshotSource } from '../../src/core/snapshot/build'
import { SnapshotReader, type ReadRange } from '../../src/core/snapshot/read'
import { concatBytes } from '../../src/core/iso/writer'
import { FOOTER_BYTES } from '../../src/core/snapshot/format'

const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill)

const source: SnapshotSource = {
  page: {
    sessionKey: 'k',
    url: 'https://site.example/watch',
    title: 'Clip',
    createdAt: 1,
    lastSeenAt: 2,
    refusedTracks: true,
  },
  tracks: [
    {
      id: 't0',
      bufferId: 'sb-1',
      representation: 'video:avc1:640x480',
      kinds: ['video'],
      info: { tracks: [{ trackId: 1, kind: 'video', timescale: 12_288, codec: 'avc1', width: 640, height: 480 }] },
      initBytes: bytes(64, 0x11),
      chunks: [0, 1, 2, 3].map((n) => ({ start: n * 2, end: n * 2 + 2, bytes: bytes(128, 0x20 + n) })),
    },
  ],
}

const plan = planSnapshot(source, { id: 'abc', capturedAt: 5, producer: 'tailcut test' })
const file = concatBytes(plan.parts)

/** Reads a range out of a buffer and counts how many times it was asked. */
function ranges(buffer: Uint8Array): { read: ReadRange; calls: () => number } {
  const read = vi.fn(async (at: number, length: number) => buffer.slice(at, at + length))
  return { read, calls: () => read.mock.calls.length }
}

describe('SnapshotReader.open', () => {
  it('opens a finished snapshot and hands back its index', async () => {
    const { read } = ranges(file)
    const reader = await SnapshotReader.open(read, file.byteLength)

    expect(reader).not.toBeNull()
    expect(reader!.index).toEqual(plan.index)
  })

  it('reads the footer and the index only, not the whole file', async () => {
    const { read, calls } = ranges(file)
    await SnapshotReader.open(read, file.byteLength)

    expect(calls()).toBe(2)
  })

  it('answers a truncated file with null rather than an exception', async () => {
    const cut = file.subarray(0, file.byteLength - 10)
    const { read } = ranges(cut)
    await expect(SnapshotReader.open(read, cut.byteLength)).resolves.toBeNull()
  })

  it('answers a file shorter than the footer with null', async () => {
    const tiny = file.subarray(0, FOOTER_BYTES - 1)
    const { read } = ranges(tiny)
    await expect(SnapshotReader.open(read, tiny.byteLength)).resolves.toBeNull()
  })

  it('catches a spoiled index on the checksum', async () => {
    const spoiled = file.slice()
    // One byte inside the index: the footer is intact, the sizes add up, and the JSON very
    // likely still parses.
    const at = plan.bytes - FOOTER_BYTES - 5
    spoiled[at] = spoiled[at]! ^ 0xff
    const { read } = ranges(spoiled)

    await expect(SnapshotReader.open(read, spoiled.byteLength)).resolves.toBeNull()
  })

  it('turns a file that has gone away into a refusal, not a crash', async () => {
    const read: ReadRange = async () => {
      throw new DOMException('file gone', 'NotFoundError')
    }
    await expect(SnapshotReader.open(read, 1_000)).resolves.toBeNull()
  })
})

describe('SnapshotReader.bytesOf', () => {
  it('gives back exactly the bytes that were put in', async () => {
    const { read } = ranges(file)
    const reader = (await SnapshotReader.open(read, file.byteLength))!

    const chunk = reader.index.tracks[0]!.chunks[2]!
    const got = await reader.bytesOf(chunk.data)

    expect(got.byteLength).toBe(128)
    expect([...new Set(got)]).toEqual([0x22])
  })

  it('reads an init segment the same way', async () => {
    const { read } = ranges(file)
    const reader = (await SnapshotReader.open(read, file.byteLength))!

    const init = await reader.bytesOf(reader.index.tracks[0]!.init)
    expect([...new Set(init)]).toEqual([0x11])
  })
})

describe('SnapshotReader.bytesOfMany', () => {
  it('merges neighbouring ranges into one read', async () => {
    const { read, calls } = ranges(file)
    const reader = (await SnapshotReader.open(read, file.byteLength))!
    const before = calls()

    const locs = reader.index.tracks[0]!.chunks.map((c) => c.data)
    const got = await reader.bytesOfMany(locs)

    expect(got).toHaveLength(4)
    expect(calls() - before, 'four chunks lying next to each other should be one read').toBe(1)
    expect([...new Set(got[3]!)]).toEqual([0x23])
  })

  it('reads ranges that do not touch separately', async () => {
    const { read, calls } = ranges(file)
    const reader = (await SnapshotReader.open(read, file.byteLength))!
    const chunks = reader.index.tracks[0]!.chunks
    const before = calls()

    await reader.bytesOfMany([chunks[0]!.data, chunks[3]!.data])

    expect(calls() - before).toBe(2)
  })

  it('answers in the order asked, not in the order of the file', async () => {
    const { read } = ranges(file)
    const reader = (await SnapshotReader.open(read, file.byteLength))!
    const chunks = reader.index.tracks[0]!.chunks

    const got = await reader.bytesOfMany([chunks[3]!.data, chunks[0]!.data, chunks[2]!.data])

    expect(got.map((b) => b[0])).toEqual([0x23, 0x20, 0x22])
  })

  it('answers an empty request with nothing and reads nothing', async () => {
    const { read, calls } = ranges(file)
    const reader = (await SnapshotReader.open(read, file.byteLength))!
    const before = calls()

    await expect(reader.bytesOfMany([])).resolves.toEqual([])
    expect(calls() - before).toBe(0)
  })
})
