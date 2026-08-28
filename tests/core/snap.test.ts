import { describe, it, expect } from 'vitest'
import type { Zone } from '../../src/core/timeline/lanes'
import { SNAP_PRIORITY, snapSet, snapTo, type SnapInput } from '../../src/core/timeline/snap'

const zones: Zone[] = [
  { start: 0, end: 30, representation: '480p', codec: 'avc1', width: 854, height: 480 },
  { start: 30, end: 60, representation: '720p', codec: 'avc1', width: 1280, height: 720 },
]

const input = (overrides: Partial<SnapInput> = {}): SnapInput => ({
  keyframes: Float64Array.from([0, 4, 8, 12, 16]),
  zones,
  gaps: [{ start: 20, end: 24 }],
  markers: [{ id: 'm1', time: 10, label: 'Goal' }],
  clips: [{ id: 'c1', name: 'One', in: 2, out: 9 }],
  playhead: 13,
  ...overrides,
})

describe('snapSet', () => {
  it('collects the edges of gaps, zones and clips, the markers and the playhead', () => {
    const set = snapSet(input())
    const at = (time: number) => set.targets.filter((target) => target.time === time).map((t) => t.kind)

    expect(at(20)).toEqual(['gap'])
    expect(at(24)).toEqual(['gap'])
    expect(at(30)).toEqual(['zone', 'zone'])
    expect(at(10)).toEqual(['marker'])
    expect(at(2)).toEqual(['clip'])
    expect(at(9)).toEqual(['clip'])
    expect(at(13)).toEqual(['playhead'])
    expect([...set.keyframes]).toEqual([0, 4, 8, 12, 16])
  })

  it('comes out in time order', () => {
    const times = snapSet(input()).targets.map((target) => target.time)

    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('names every target so the drag can say what it caught', () => {
    const set = snapSet(input())

    expect(set.targets.find((t) => t.time === 30)!.label).toBe('480p')
    expect(set.targets.find((t) => t.kind === 'marker')!.label).toBe('Goal')
    expect(set.targets.find((t) => t.kind === 'clip')!.label).toBe('One')
    expect(set.targets.find((t) => t.kind === 'gap')!.label).toBe('gap')
  })

  it('names a zone by the picture it holds, and by its id when it holds none', () => {
    // A representation is whatever the page called the stream; the height is what the viewer
    // sees change. Sound has no height, and then the id is all there is to say.
    const picture = snapSet(input({
      zones: [{ start: 5, end: 9, representation: 'hd', codec: 'avc1', width: 1280, height: 720 }],
    }))
    const sound = snapSet(input({
      zones: [{ start: 5, end: 9, representation: 'aac', codec: 'mp4a', width: 0, height: 0 }],
    }))

    expect(picture.targets.find((t) => t.kind === 'zone')!.label).toBe('720p')
    expect(sound.targets.find((t) => t.kind === 'zone')!.label).toBe('aac')
  })

  it("marks a clip's own targets with its id", () => {
    expect(snapSet(input()).targets.find((t) => t.kind === 'clip')!.owner).toBe('c1')
  })
})

describe('snapTo', () => {
  const set = snapSet(input())

  it('catches the nearest target inside the tolerance', () => {
    const result = snapTo(20.3, set, 0.5)

    expect(result.time).toBe(20)
    expect(result.hit).toMatchObject({ kind: 'gap' })
  })

  it('catches nothing outside the tolerance', () => {
    expect(snapTo(20.3, set, 0.1)).toEqual({ time: 20.3, hit: null })
  })

  it('a tolerance of nothing is free movement', () => {
    expect(snapTo(20.001, set, 0)).toEqual({ time: 20.001, hit: null })
    // Standing exactly on a gap edge is not catching it: with snapping off there is nothing to
    // draw a line for, and a handle that reported a hit would keep the caption on the screen.
    expect(snapTo(20, set, 0)).toEqual({ time: 20, hit: null })
  })

  it('the nearer target wins whatever the two of them are', () => {
    // The playhead is the last thing on the list of priorities and the keyframe is well above
    // it; priority settles a tie and nothing else.
    const result = snapTo(12.9, set, 1.5)

    expect(result.time).toBe(13)
    expect(result.hit!.kind).toBe('playhead')
  })

  it('finds a keyframe among thousands', () => {
    const many = snapSet(input({ keyframes: Float64Array.from({ length: 5000 }, (_, i) => i * 0.5) }))
    const result = snapTo(1234.6, many, 0.5)

    expect(result.time).toBe(1234.5)
    expect(result.hit!.kind).toBe('keyframe')
  })

  it('at an equal distance the harder boundary wins', () => {
    // A gap edge and a keyframe at the same distance: material beats compression.
    const tie = snapSet(input({ keyframes: Float64Array.from([19.8]), gaps: [{ start: 20.2, end: 24 }] }))
    expect(snapTo(20, tie, 1).hit!.kind).toBe('gap')

    // And the other way about, or the order the set was built in would be passing for priority:
    // a keyframe beats a marker at the same distance.
    const other = snapSet(input({
      keyframes: Float64Array.from([19.8]),
      gaps: [],
      markers: [{ id: 'm1', time: 20.2, label: 'Goal' }],
    }))
    expect(snapTo(20, other, 1).hit!.kind).toBe('keyframe')

    expect(SNAP_PRIORITY).toEqual(['gap', 'zone', 'keyframe', 'marker', 'clip', 'playhead'])
  })

  it('leaves out the targets of the clip being dragged', () => {
    // Without this the in handle sticks to its own out and the clip collapses to nothing.
    expect(snapTo(9.05, set, 0.5, 'c1').hit).not.toMatchObject({ kind: 'clip' })
    expect(snapTo(9.05, set, 0.5).hit).toMatchObject({ kind: 'clip' })
  })

  it('is quiet when there is nothing to catch', () => {
    const bare = snapSet({
      keyframes: new Float64Array(),
      zones: [],
      gaps: [],
      markers: [],
      clips: [],
      playhead: 0,
    })

    expect(snapTo(7, bare, 1)).toEqual({ time: 7, hit: null })
  })
})
