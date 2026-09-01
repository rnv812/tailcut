import { describe, it, expect } from 'vitest'
import { planSnapshot, type SnapshotSource } from '../../src/core/snapshot/build'
import { adler32, decodeFooter, decodeIndex, FOOTER_BYTES } from '../../src/core/snapshot/format'
import { concatBytes } from '../../src/core/iso/writer'
import type { Chunk } from '../../src/shared/types'

const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill)

const chunk = (start: number, end: number, length: number, fill: number): Chunk => ({
  start,
  end,
  bytes: bytes(length, fill),
})

const source: SnapshotSource = {
  page: {
    sessionKey: 'https://site.example/watch|avc1|inf',
    url: 'https://site.example/watch?v=abc',
    title: 'Clip',
    createdAt: 10,
    lastSeenAt: 20,
    refusedTracks: false,
  },
  tracks: [
    {
      id: 't0',
      bufferId: 'sb-1',
      representation: 'video:avc1:640x480',
      kinds: ['video'],
      info: { tracks: [{ trackId: 1, kind: 'video', timescale: 12_288, codec: 'avc1', width: 640, height: 480 }] },
      initBytes: bytes(100, 0x11),
      chunks: [chunk(0, 2, 400, 0x21), chunk(2, 4, 500, 0x22)],
    },
    {
      id: 't1',
      bufferId: 'sb-2',
      representation: 'audio:mp4a:0x0',
      kinds: ['audio'],
      info: { tracks: [{ trackId: 1, kind: 'audio', timescale: 44_100, codec: 'mp4a', width: 0, height: 0 }] },
      initBytes: bytes(80, 0x12),
      chunks: [chunk(0, 2, 300, 0x31)],
    },
  ],
}

const META = { id: 'abc', capturedAt: 1_000, producer: 'tailcut 0.1.0' }

describe('planSnapshot', () => {
  it('lays the init segment of a track before its chunks and addresses both', () => {
    const plan = planSnapshot(source, META)
    const [video, audio] = plan.index.tracks

    expect(video!.init).toEqual({ at: 0, length: 100 })
    expect(video!.chunks.map((c) => c.data)).toEqual([
      { at: 100, length: 400 },
      { at: 500, length: 500 },
    ])
    expect(audio!.init).toEqual({ at: 1_000, length: 80 })
    expect(audio!.chunks.map((c) => c.data)).toEqual([{ at: 1_080, length: 300 }])
  })

  it('carries the times of the chunks over as they are, in seconds', () => {
    const plan = planSnapshot(source, META)
    expect(plan.index.tracks[0]!.chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 2],
      [2, 4],
    ])
  })

  it('carries SourceBuffer placement metadata into the snapshot index', () => {
    const shifted: SnapshotSource = {
      ...source,
      tracks: [
        {
          ...source.tracks[0]!,
          chunks: [{ ...source.tracks[0]!.chunks[0]!, timestampOffset: 7.5 }],
        },
      ],
    }

    expect(planSnapshot(shifted, META).index.tracks[0]!.chunks[0]!.timestampOffset).toBe(7.5)
  })

  it('has every Located point at exactly the bytes that were put there', () => {
    const plan = planSnapshot(source, META)
    const file = concatBytes(plan.parts)

    const at = (loc: { at: number; length: number }) => file.subarray(loc.at, loc.at + loc.length)
    expect(at(plan.index.tracks[0]!.init)[0]).toBe(0x11)
    expect(at(plan.index.tracks[0]!.chunks[1]!.data)[0]).toBe(0x22)
    expect(at(plan.index.tracks[1]!.chunks[0]!.data)[0]).toBe(0x31)
  })

  it('ends with the index and the footer, and the footer matches the size', () => {
    const plan = planSnapshot(source, META)
    const file = concatBytes(plan.parts)

    expect(file.byteLength).toBe(plan.bytes)

    const footer = decodeFooter(file.subarray(file.byteLength - FOOTER_BYTES), file.byteLength)
    expect(footer).not.toBeNull()

    const indexBytes = file.subarray(footer!.index.at, footer!.index.at + footer!.index.length)
    expect(adler32(indexBytes)).toBe(footer!.checksum)
    expect(decodeIndex(indexBytes)).toEqual(plan.index)
  })

  it('carries the page and the metadata into the index untouched', () => {
    const plan = planSnapshot(source, META)

    expect(plan.index.id).toBe('abc')
    expect(plan.index.capturedAt).toBe(1_000)
    expect(plan.index.producer).toBe('tailcut 0.1.0')
    expect(plan.index.page).toEqual(source.page)
    expect(plan.index.stores).toEqual([{ kind: 'inline' }])
  })

  it('stores nothing that can be worked out: no runs, no gaps, no duration', () => {
    // Runs are computed by PtsMap and by nothing else: a second implementation would part
    // company with the popup over GAP_TOLERANCE_SECONDS, and the timeline would draw something
    // other than what the button promised.
    const plan = planSnapshot(source, META)
    const keys = Object.keys(plan.index.tracks[0]!)

    expect(keys).not.toContain('runs')
    expect(keys).not.toContain('duration')
    expect(keys).not.toContain('gaps')
  })

  it('keeps a track with no chunks, init segment and all', () => {
    // A buffer that opened a stream and never brought a fragment. The editor has to know that
    // stream existed: otherwise a clip missing its sound looks like a clip that had none.
    const empty: SnapshotSource = {
      ...source,
      tracks: [{ ...source.tracks[1]!, chunks: [] }],
    }
    const plan = planSnapshot(empty, META)

    expect(plan.index.tracks).toHaveLength(1)
    expect(plan.index.tracks[0]!.chunks).toEqual([])
    expect(plan.index.tracks[0]!.init.length).toBe(80)
  })

  /**
   * The other shape of material: an ordinary complete file, which has no init segment and no
   * fragments at all — one movie box describing every sample, one mdat holding them.
   */
  describe('over a whole file', () => {
    const file = bytes(2_000, 0x44)
    const whole: SnapshotSource = {
      ...source,
      tracks: [
        {
          id: 't0',
          bufferId: 'file',
          representation: 'file:avc1+mp4a',
          kinds: ['video', 'audio'],
          info: source.tracks[0]!.info,
          initBytes: file,
          // The movie box lies at the end of it, as it does in every file that was not written
          // for streaming: the place is named because it cannot be guessed.
          movie: { at: 1_500, length: 400 },
          chunks: [chunk(0, 6, 0, 0)],
        },
      ],
    }

    it('lays the file down once and names the movie box inside it', () => {
      const plan = planSnapshot(whole, META)
      const track = plan.index.tracks[0]!

      expect(plan.parts[0]).toBe(file)
      expect(track.whole).toEqual({ at: 0, length: 2_000 })
      // Not the head of the range and not the whole of it: where the tables actually are.
      expect(track.init).toEqual({ at: 1_500, length: 400 })
    })

    it('points every stretch at the file, because that is where its samples are', () => {
      const twoRuns: SnapshotSource = {
        ...whole,
        tracks: [{ ...whole.tracks[0]!, chunks: [chunk(0, 2, 0, 0), chunk(4, 6, 0, 0)] }],
      }
      const plan = planSnapshot(twoRuns, META)
      const track = plan.index.tracks[0]!

      // A chunk of such a track carries no bytes of its own — there is one mdat and every
      // stretch of media time is inside it — so nothing extra is written and nothing is placed.
      expect(track.chunks.map((one) => one.data)).toEqual([track.whole, track.whole])
      expect(track.chunks.map((one) => [one.start, one.end])).toEqual([
        [0, 2],
        [4, 6],
      ])
      // The file, the index and the footer: two stretches of media time added nothing to write.
      expect(plan.parts).toHaveLength(3)
      expect(plan.parts[0]).toBe(file)
    })

    it('says nothing of the sort about a track of captured segments', () => {
      const plan = planSnapshot(source, META)

      // The field has to be absent and not false: a reader tells the two shapes apart by it, and
      // JSON drops an undefined outright.
      expect(plan.index.tracks.every((track) => track.whole === undefined)).toBe(true)
      expect(JSON.stringify(plan.index)).not.toContain('whole')
    })

    it('survives the round trip through the index', () => {
      const plan = planSnapshot(whole, META)
      const file = concatBytes(plan.parts)
      const footer = decodeFooter(file.subarray(file.byteLength - FOOTER_BYTES), file.byteLength)!
      const index = decodeIndex(file.subarray(footer.index.at, footer.index.at + footer.index.length))

      expect(index!.tracks[0]!.whole).toEqual({ at: 0, length: 2_000 })
    })
  })

  it('copies no bytes: the parts hold the very same buffers', () => {
    // Freezing has to be cheap on a hundred megabytes. The one copy is made later, in the
    // frame, on the way into the worker.
    const plan = planSnapshot(source, META)
    expect(plan.parts).toContain(source.tracks[0]!.initBytes)
    expect(plan.parts).toContain(source.tracks[0]!.chunks[1]!.bytes)
  })
})
