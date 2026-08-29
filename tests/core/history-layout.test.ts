import { describe, it, expect } from 'vitest'
import { layoutBatch, type BatchItem } from '../../src/core/history/layout'
import type { Chunk } from '../../src/shared/types'

const chunk = (start: number, end: number, bytes: number, fill: number): Chunk => ({
  start,
  end,
  bytes: new Uint8Array(bytes).fill(fill),
})

describe('layoutBatch', () => {
  const video: BatchItem[] = [
    { representation: 'video:avc1:1920x1080', init: new Uint8Array(8).fill(9), chunk: chunk(0, 2, 100, 1) },
    { representation: 'video:avc1:1920x1080', chunk: chunk(2, 4, 120, 2) },
  ]

  it('lays the parts out end to end, in the order they were taken', () => {
    const layout = layoutBatch('aaaa-000000.tcm', 1_700_000_000_000, video)

    expect(layout.bytes).toBe(8 + 100 + 120)
    expect(layout.parts.map((part) => part.byteLength)).toEqual([8, 100, 120])
    expect(layout.piece.parts).toEqual([
      { representation: 'video:avc1:1920x1080', start: 0, end: 2, at: 8, length: 100 },
      { representation: 'video:avc1:1920x1080', start: 2, end: 4, at: 108, length: 120 },
    ])
  })

  it('places the init segment in front of the material it explains', () => {
    const layout = layoutBatch('aaaa-000000.tcm', 1, video)
    expect(layout.inits).toEqual([{ representation: 'video:avc1:1920x1080', at: 0, length: 8 }])
    // The first part starts where the init ends: nothing is written between them, so a reader
    // that has the file has the init and the material of that batch in one read.
    expect(layout.piece.parts[0]!.at).toBe(8)
  })

  it('interleaves two tracks without mixing their parts', () => {
    const layout = layoutBatch('aaaa-000001.tcm', 1, [
      { representation: 'video:avc1:1920x1080', chunk: chunk(0, 2, 100, 1) },
      { representation: 'audio:mp4a:0x0', init: new Uint8Array(4).fill(7), chunk: chunk(0, 2, 30, 3) },
      { representation: 'video:avc1:1920x1080', chunk: chunk(2, 4, 110, 4) },
    ])

    expect(layout.inits).toEqual([{ representation: 'audio:mp4a:0x0', at: 100, length: 4 }])
    expect(layout.piece.parts.map((part) => part.representation)).toEqual([
      'video:avc1:1920x1080',
      'audio:mp4a:0x0',
      'video:avc1:1920x1080',
    ])
    expect(layout.piece.parts.map((part) => part.at)).toEqual([0, 104, 134])
  })

  it('remembers the latest media time in the piece: eviction compares that with the floor', () => {
    // Not the last part's end — the parts of two tracks are interleaved and the picture may run
    // ahead of the sound. A file is dead when nothing in it is still inside the buffer window,
    // so the number that decides it is the furthest end of all of them.
    const layout = layoutBatch('aaaa-000002.tcm', 1, [
      { representation: 'video:avc1:1920x1080', chunk: chunk(4, 8, 10, 1) },
      { representation: 'audio:mp4a:0x0', chunk: chunk(4, 6, 10, 2) },
    ])
    expect(layout.piece.until).toBe(8)
  })

  it('carries the file and the moment it was written into the row', () => {
    const layout = layoutBatch('bbbb-000007.tcm', 1_700_000_000_123, video)
    expect(layout.piece.file).toBe('bbbb-000007.tcm')
    expect(layout.piece.writtenAt).toBe(1_700_000_000_123)
    expect(layout.piece.bytes).toBe(layout.bytes)
  })

  it('makes nothing of nothing', () => {
    const layout = layoutBatch('aaaa-000000.tcm', 1, [])
    expect(layout).toEqual({
      parts: [],
      bytes: 0,
      inits: [],
      piece: { file: 'aaaa-000000.tcm', bytes: 0, until: 0, writtenAt: 1, parts: [] },
    })
  })
})
