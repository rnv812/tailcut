import { describe, it, expect } from 'vitest'
import {
  allGaps,
  cuttingLane,
  gapsBetween,
  laneOf,
  lanesOf,
  materialSpan,
} from '../../src/core/timeline/lanes'
import type { SnapshotChunkEntry, SnapshotTrack } from '../../src/core/snapshot/format'
import type { TrackInfo, TrackKind } from '../../src/shared/types'

const video = (overrides: Partial<TrackInfo> = {}): TrackInfo => ({
  trackId: 1,
  kind: 'video',
  timescale: 90_000,
  codec: 'avc1',
  width: 1280,
  height: 720,
  ...overrides,
})

const audio = (overrides: Partial<TrackInfo> = {}): TrackInfo => ({
  trackId: 2,
  kind: 'audio',
  timescale: 48_000,
  codec: 'mp4a',
  width: 0,
  height: 0,
  channels: 2,
  sampleRate: 48_000,
  ...overrides,
})

const chunk = (start: number, end: number): SnapshotChunkEntry => ({
  start,
  end,
  data: { at: 0, length: 1 },
})

/** A snapshot track, as thin as this layer needs it: the bytes never come into it. */
const track = (input: {
  id?: string
  representation?: string
  kinds?: TrackKind[]
  tracks?: TrackInfo[]
  chunks: SnapshotChunkEntry[]
}): SnapshotTrack => ({
  id: input.id ?? 'track-1',
  bufferId: 'buffer-1',
  representation: input.representation ?? '720p',
  kinds: input.kinds ?? ['video'],
  init: { at: 0, length: 0 },
  info: { tracks: input.tracks ?? [video()] },
  chunks: input.chunks,
})

describe('lanesOf', () => {
  it('builds one run out of chunks that touch', () => {
    const lanes = lanesOf([track({ chunks: [chunk(0, 2), chunk(2, 4), chunk(4, 6)] })])

    expect(lanes).toHaveLength(1)
    expect(lanes[0]!.kind).toBe('video')
    expect(lanes[0]!.runs).toEqual([{ start: 0, end: 6 }])
    expect(lanes[0]!.gaps).toEqual([])
  })

  it('a forward jump becomes a gap between two runs', () => {
    const lanes = lanesOf([track({ chunks: [chunk(0, 2), chunk(2, 4), chunk(20, 22)] })])

    expect(lanes[0]!.runs).toEqual([
      { start: 0, end: 4 },
      { start: 20, end: 22 },
    ])
    expect(lanes[0]!.gaps).toEqual([{ start: 4, end: 20 }])
  })

  it('a hole shorter than the tolerance is not a gap', () => {
    // GAP_TOLERANCE_SECONDS is 0.05: a hole of 0.04 is rounding, not a jump, and the capture
    // side already counts it that way. Two answers to the same question would show up as a
    // timeline drawing a gap where the file has none.
    const lanes = lanesOf([track({ chunks: [chunk(0, 2), chunk(2.04, 4)] })])

    expect(lanes[0]!.runs).toEqual([{ start: 0, end: 4 }])
    expect(lanes[0]!.gaps).toEqual([])
  })

  it('chunks that arrive out of order are laid in time order', () => {
    const lanes = lanesOf([track({ chunks: [chunk(4, 6), chunk(0, 2), chunk(2, 4)] })])

    expect(lanes[0]!.runs).toEqual([{ start: 0, end: 6 }])
  })

  it('overlapping chunks do not split a run', () => {
    const lanes = lanesOf([track({ chunks: [chunk(0, 4), chunk(2, 6), chunk(3, 5)] })])

    expect(lanes[0]!.runs).toEqual([{ start: 0, end: 6 }])
  })

  it('a zero-length chunk is ignored', () => {
    const lanes = lanesOf([track({ chunks: [chunk(0, 2), chunk(5, 5), chunk(2, 4)] })])

    expect(lanes[0]!.runs).toEqual([{ start: 0, end: 4 }])
  })

  it('video and audio become two lanes', () => {
    const lanes = lanesOf([
      track({ id: 'v', kinds: ['video'], tracks: [video()], chunks: [chunk(0, 6)] }),
      track({ id: 'a', kinds: ['audio'], tracks: [audio()], chunks: [chunk(0, 5.9)] }),
    ])

    expect(lanes.map((lane) => lane.kind)).toEqual(['video', 'audio'])
    expect(lanes[1]!.runs).toEqual([{ start: 0, end: 5.9 }])
  })

  it('a track that carries both kinds feeds both lanes', () => {
    // A muxed SourceBuffer is one snapshot track with two kinds; drawing it on one lane would
    // hide the sound of every site that does not split its streams.
    const lanes = lanesOf([
      track({ kinds: ['video', 'audio'], tracks: [video(), audio()], chunks: [chunk(0, 4)] }),
    ])

    expect(lanes.map((lane) => lane.kind)).toEqual(['video', 'audio'])
    expect(lanes[0]!.runs).toEqual([{ start: 0, end: 4 }])
    expect(lanes[1]!.runs).toEqual([{ start: 0, end: 4 }])
  })

  it('a change of representation splits the zones but not the run', () => {
    const lanes = lanesOf([
      track({ id: 'sd', representation: '480p', chunks: [chunk(0, 4)] }),
      track({
        id: 'hd',
        representation: '720p',
        tracks: [video({ width: 1280, height: 720 })],
        chunks: [chunk(4, 8)],
      }),
    ])

    expect(lanes[0]!.runs).toEqual([{ start: 0, end: 8 }])
    expect(lanes[0]!.zones.map((zone) => [zone.start, zone.end, zone.representation])).toEqual([
      [0, 4, '480p'],
      [4, 8, '720p'],
    ])
  })

  it('a hole inside one representation does not split the zone', () => {
    // The one that matters most: a pause in the recording is not a change of quality, and a zone
    // broken by it would forbid a clip across a gap that export is required to collapse.
    const lanes = lanesOf([track({ representation: '480p', chunks: [chunk(0, 2), chunk(4, 6)] })])

    expect(lanes[0]!.runs).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ])
    expect(lanes[0]!.gaps).toEqual([{ start: 2, end: 4 }])
    expect(lanes[0]!.zones.map((zone) => [zone.start, zone.end])).toEqual([[0, 6]])
  })

  it('representations that overlap in time still make zones that do not', () => {
    // A switch of quality is not a clean cut: the new representation is buffered over the tail of
    // the old one, and a seek back replays a stretch at whichever quality is going then. Zones
    // are read by `find` (`zoneAt`) and by distance (`homeZone`), and neither can answer sensibly
    // about two zones covering one instant — so the later one starts where the earlier one ended.
    const lanes = lanesOf([
      track({ id: 'sd', representation: '480p', chunks: [chunk(0, 6)] }),
      track({
        id: 'hd',
        representation: '720p',
        tracks: [video({ width: 1280, height: 720 })],
        chunks: [chunk(4, 10)],
      }),
    ])

    expect(lanes[0]!.zones.map((zone) => [zone.start, zone.end, zone.representation])).toEqual([
      [0, 6, '480p'],
      [6, 10, '720p'],
    ])
  })

  it('a piece swallowed whole by the zone before it makes no zone of its own', () => {
    // The same thing at its extreme: a second of 720p arrives inside a stretch of 480p that
    // already covers it. A zone of zero or negative length would break both readers above.
    const lanes = lanesOf([
      track({ id: 'sd', representation: '480p', chunks: [chunk(0, 10)] }),
      track({
        id: 'hd',
        representation: '720p',
        tracks: [video({ width: 1280, height: 720 })],
        chunks: [chunk(4, 5)],
      }),
    ])

    expect(lanes[0]!.zones.map((zone) => [zone.start, zone.end, zone.representation])).toEqual([
      [0, 10, '480p'],
    ])
  })

  it('a zone carries the codec and the size of its own init', () => {
    const lanes = lanesOf([
      track({
        representation: '1080p',
        tracks: [video({ codec: 'vp09', width: 1920, height: 1080 })],
        chunks: [chunk(0, 4)],
      }),
    ])

    expect(lanes[0]!.zones[0]).toEqual({
      start: 0,
      end: 4,
      representation: '1080p',
      codec: 'vp09',
      width: 1920,
      height: 1080,
    })
  })

  it('a track whose kind has no info is skipped', () => {
    // kinds says there is sound, the init says there is not. Trusting kinds alone would put a
    // lane on the screen with no codec and no size behind it.
    const lanes = lanesOf([
      track({ kinds: ['video', 'audio'], tracks: [video()], chunks: [chunk(0, 4)] }),
    ])

    expect(lanes.map((lane) => lane.kind)).toEqual(['video'])
  })

  it('is empty for a snapshot with no chunks at all', () => {
    expect(lanesOf([track({ chunks: [] })])).toEqual([])
  })
})

describe('materialSpan, laneOf, cuttingLane, allGaps', () => {
  const lanes = lanesOf([
    track({ id: 'v', chunks: [chunk(0, 4), chunk(10, 14)] }),
    track({
      id: 'a',
      kinds: ['audio'],
      tracks: [audio()],
      // The sound breaks before the picture and comes back before it: one break of the recording,
      // two holes a fraction of a second apart, and the earlier of the two is not the one the
      // lanes are listed in.
      chunks: [chunk(0, 3.9), chunk(9.9, 14.2)],
    }),
  ])

  it('materialSpan spans from the first run to the last', () => {
    expect(materialSpan(lanes)).toEqual({ start: 0, end: 14.2 })
  })

  it('materialSpan of nothing is null', () => {
    expect(materialSpan([])).toBeNull()
  })

  it('laneOf finds the lane by kind', () => {
    expect(laneOf(lanes, 'audio')!.runs).toHaveLength(2)
    expect(laneOf([], 'video')).toBeUndefined()
  })

  it('allGaps merges the holes of both lanes in time order', () => {
    // Time order and not lane order: the picture is the first lane and its hole is the later
    // one, so a list that merely runs the lanes end to end comes out the other way round.
    expect(allGaps(lanes)).toEqual([
      { start: 3.9, end: 9.9 },
      { start: 4, end: 10 },
    ])
  })

  it('cuttingLane names the picture, because that is what the cut follows', () => {
    // The same break of the recording shows up in both lanes; counted twice it would tell the
    // user two gaps where there is one.
    expect(cuttingLane(lanes)!.kind).toBe('video')
    expect(cuttingLane(lanes)!.gaps).toEqual([{ start: 4, end: 10 }])

    // Asked of the lanes the other way round it still names the picture. `lanesOf` happens to
    // build the video lane first, so on its output "the picture" and "the first one" are the
    // same answer and the rule is not being tested at all; here they are different answers.
    expect(cuttingLane([...lanes].reverse())!.kind).toBe('video')
  })

  it('cuttingLane falls back to the only lane there is', () => {
    const sound = lanesOf([
      track({ id: 'a', kinds: ['audio'], tracks: [audio()], chunks: [chunk(0, 4), chunk(6, 8)] }),
    ])

    expect(cuttingLane(sound)!.kind).toBe('audio')
    expect(cuttingLane([])).toBeUndefined()
  })

  it('gapsBetween returns the holes and nothing else', () => {
    expect(
      gapsBetween([
        { start: 0, end: 4 },
        { start: 10, end: 14 },
        { start: 20, end: 21 },
      ]),
    ).toEqual([
      { start: 4, end: 10 },
      { start: 14, end: 20 },
    ])
    expect(gapsBetween([{ start: 0, end: 4 }])).toEqual([])
    expect(gapsBetween([])).toEqual([])
  })
})
