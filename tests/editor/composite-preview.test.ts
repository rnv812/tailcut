import { describe, expect, it } from 'vitest'
import {
  audioMonitorClock,
  compositeFrames,
  pictureProgram,
  type PictureFrames,
} from '../../src/editor/source/composite'
import { FrameTable, type Frame } from '../../src/core/timeline/frames'
import type { SourceTrack } from '../../src/core/export/plan'
import type { Material, MaterialTrack, PlacedChunk } from '../../src/core/snapshot/material'

const chunk = (start: number, end: number, at: number): PlacedChunk => ({
  start,
  end,
  bytes: new Uint8Array(0),
  source: { at, length: 1 },
})

function picture(id: string, spans: Array<[number, number]>, at: number): MaterialTrack {
  const chunks = spans.map(([start, end], index) => chunk(start, end, at + index))
  return {
    track: {
      id,
      bufferId: 'picture',
      representation: id,
      kinds: ['video'],
      init: { at: at + 100, length: 1 },
      info: {
        tracks: [
          { trackId: 1, kind: 'video', timescale: 1, codec: 'avc1', width: 640, height: 360 },
        ],
      },
      chunks: chunks.map((one) => ({
        start: one.start,
        end: one.end,
        data: one.source,
      })),
    },
    kinds: ['video'],
    runs: chunks.map((one) => ({ start: one.start, end: one.end, chunks: [one] })),
    duration: spans.reduce((sum, [start, end]) => sum + end - start, 0),
    bytes: chunks.length,
    span: chunks.length
      ? { start: chunks[0]!.start, end: chunks[chunks.length - 1]!.end }
      : null,
  }
}

function material(...pictures: MaterialTrack[]): Material {
  return {
    tracks: pictures,
    video: pictures[0] ?? null,
    audio: null,
    representations: pictures.map((one) => one.track.representation),
    duration: pictures.reduce((sum, one) => sum + one.duration, 0),
    bytes: pictures.reduce((sum, one) => sum + one.bytes, 0),
  }
}

function frame(track: string, pts: number, at: number): PictureFrames {
  const value: Frame = {
    pts,
    out: pts,
    duration: 1,
    sync: true,
    source: { at, length: 1 },
  }
  return { trackId: track, frames: [value] }
}

function frameTable(runs: Array<[number, number]>, step = 0.04): FrameTable {
  let source = 0
  return FrameTable.of(runs.flatMap(([start, end]) => {
    const frames: Frame[] = []
    for (let at = start; at < end - 1e-7; at += step) {
      frames.push({ pts: at, out: at, duration: step, sync: true, source: { at: source++, length: 1 } })
    }
    return frames
  }))
}

function sound(runs: Array<[number, number]>, step = 0.02): SourceTrack {
  const timescale = 1_000
  let source = 1_000
  return {
    kind: 'audio',
    timescale,
    sampleEntry: new Uint8Array(),
    width: 0,
    height: 0,
    editOffset: 0,
    dropped: 0,
    samples: runs.flatMap(([start, end]) => {
      const samples: SourceTrack['samples'] = []
      for (let at = start; at < end - 1e-7; at += step) {
        samples.push({
          dts: Math.round(at * timescale),
          pts: Math.round(at * timescale),
          duration: Math.round(step * timescale),
          sync: true,
          source: { at: source++, length: 1 },
        })
      }
      return samples
    }),
  }
}

describe('composite monitor preview', () => {
  it('follows low, high, then low again instead of joining the two low stretches', () => {
    const low = picture('low', [[0, 2], [4, 6]], 0)
    const high = picture('high', [[2, 4]], 10)

    const program = pictureProgram(material(low, high))

    expect(program.parts.map((part) => [part.track.track.id, part.start, part.end])).toEqual([
      ['low', 0, 2],
      ['high', 2, 4],
      ['low', 4, 6],
    ])
    expect(program.runs).toEqual([{ start: 0, end: 6 }])
  })

  it('keeps an ABR seam on both clocks and collapses only a real recording hole', () => {
    const low = picture('low', [[0, 2]], 0)
    const high = picture('high', [[2, 4], [6, 8]], 10)
    const program = pictureProgram(material(low, high))
    const rows = compositeFrames(program, [
      frame('low', 0, 0),
      frame('low', 1, 1),
      frame('high', 2, 10),
      frame('high', 3, 11),
      frame('high', 6, 12),
      frame('high', 7, 13),
    ]).frames()

    expect(rows.map((one) => one.pts)).toEqual([0, 1, 2, 3, 6, 7])
    expect(rows.map((one) => one.out)).toEqual([0, 1, 2, 3, 4, 5])
    expect(rows[2]!.pts - rows[1]!.pts, 'ABR switch became a source-time jump').toBe(1)
    expect(rows[2]!.out - rows[1]!.out, 'ABR switch became a playback jump').toBe(1)
    expect(rows[4]!.pts - rows[3]!.pts, 'the real hole disappeared from session time').toBe(3)
    expect(rows[4]!.out - rows[3]!.out, 'the real hole remained in monitor time').toBe(1)
  })

  it('does not join a second video whose SourceBuffer family is unrelated to the selected one', () => {
    const selected = picture('selected', [[0, 2]], 0)
    const alternate = picture('alternate', [[2, 4]], 10)
    const unrelated = picture('unrelated', [[4, 6]], 20)
    unrelated.track.bufferId = 'another-buffer'

    const program = pictureProgram(material(selected, alternate, unrelated))

    expect(program.parts.map((part) => part.track.track.id)).toEqual(['selected', 'alternate'])
    expect(program.runs).toEqual([{ start: 0, end: 4 }])
  })

  it('gives the later representation every frame in an overlapping ABR switch', () => {
    const low = picture('low', [[0, 6]], 0)
    const high = picture('high', [[5, 10]], 10)
    const program = pictureProgram(material(low, high))
    const rows = compositeFrames(program, [
      ...Array.from({ length: 6 }, (_, at) => frame('low', at, at)),
      ...Array.from({ length: 5 }, (_, at) => frame('high', at + 5, at + 10)),
    ]).frames()

    expect(program.parts.map(({ track, start, end }) => [track.track.id, start, end])).toEqual([
      ['low', 0, 5],
      ['high', 5, 10],
    ])
    expect(rows.map(({ pts, source }) => [pts, source.at])).toEqual([
      [0, 0], [1, 1], [2, 2], [3, 3], [4, 4],
      [5, 10], [6, 11], [7, 12], [8, 13], [9, 14],
    ])
  })

  it('does not mistake an earlier representation’s prebuffered tail for a later append', () => {
    const low = picture('low', [[0, 6], [6, 8]], 0)
    const high = picture('high', [[5, 10]], 10)

    const program = pictureProgram(material(low, high))

    // The low track was opened and captured first. Its second chunk starts after the high
    // track's first PTS, but it was not appended after that later representation. Track order is
    // the only preserved append ownership in the snapshot; sorting all chunks by PTS invents a
    // low return at six and drops the buffered high tail from eight to ten.
    expect(program.parts.map(({ track, start, end }) => [track.track.id, start, end])).toEqual([
      ['low', 0, 5],
      ['high', 5, 10],
    ])
  })

  it('uses the export seam policy when audio was prefetched through a picture gap', () => {
    const program: ReturnType<typeof pictureProgram> = {
      parts: [],
      runs: [{ start: 0, end: 1 }, { start: 3, end: 4 }],
    }
    const clock = audioMonitorClock(program, frameTable([[0, 1], [3, 4]]), sound([[0, 4]]))
    const retained = clock.audio.samples.map((sample) => sample.pts / clock.audio.timescale)

    expect(retained.some((time) => time >= 1 && time < 3)).toBe(false)
    expect(clock.seams).toEqual([{ from: 1, to: 3, pull: 2 }])
    expect(3 + clock.shiftAt(3)).toBeCloseTo(1, 9)
  })

  it('keeps early and late audio at the head instead of snapping either to picture zero', () => {
    const program: ReturnType<typeof pictureProgram> = {
      parts: [],
      runs: [{ start: 1, end: 2 }],
    }
    const early = audioMonitorClock(program, frameTable([[1, 2]]), sound([[0.9, 2]]))
    const late = audioMonitorClock(program, frameTable([[1, 2]]), sound([[1.1, 2]]))

    expect(0.9 + early.shiftAt(0.9)).toBeCloseTo(-0.1, 9)
    expect(1.1 + late.shiftAt(1.1)).toBeCloseTo(0.1, 9)
  })

  it('aligns a slightly late resumed audio run exactly as normal preview does', () => {
    const program: ReturnType<typeof pictureProgram> = {
      parts: [],
      runs: [{ start: 0, end: 1 }, { start: 3, end: 4 }],
    }
    const clock = audioMonitorClock(
      program,
      frameTable([[0, 1], [3, 4]], 0.04),
      sound([[0, 1], [3.04, 4.04]], 0.02),
    )
    const resumed = clock.audio.samples.find((sample) => sample.pts >= 3_000)!
    const sourceTime = resumed.pts / clock.audio.timescale

    expect(sourceTime).toBeCloseTo(3, 9)
    expect(sourceTime + clock.shiftAt(sourceTime)).toBeCloseTo(1, 9)
  })
})
