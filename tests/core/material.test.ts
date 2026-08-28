import { describe, it, expect } from 'vitest'
import { gapsBetween, materialOf } from '../../src/core/snapshot/material'
import { planSnapshot, type SnapshotSource } from '../../src/core/snapshot/build'
import type { TrackInfo, TrackKind } from '../../src/shared/types'

const bytes = (length: number): Uint8Array => new Uint8Array(length)

const info = (kind: TrackKind, codec: string): { tracks: TrackInfo[] } => ({
  tracks: [
    {
      trackId: 1,
      kind,
      timescale: kind === 'video' ? 12_288 : 44_100,
      codec,
      width: kind === 'video' ? 640 : 0,
      height: kind === 'video' ? 480 : 0,
    },
  ],
})

/** A track of the source: spans in seconds, a hundred bytes of material each. */
const track = (
  id: string,
  kind: TrackKind,
  representation: string,
  spans: Array<[number, number]>,
) => ({
  id,
  bufferId: `sb-${id}`,
  representation,
  kinds: [kind],
  info: info(kind, representation.split(':')[1]!),
  initBytes: bytes(32),
  chunks: spans.map(([start, end]) => ({ start, end, bytes: bytes(100) })),
})

const page = {
  sessionKey: 'k',
  url: 'https://site.example/watch',
  title: 'Clip',
  createdAt: 1,
  lastSeenAt: 2,
  refusedTracks: false,
}

const indexOf = (tracks: SnapshotSource['tracks']) =>
  planSnapshot({ page, tracks }, { id: 'x', capturedAt: 0, producer: 'test' }).index

describe('materialOf', () => {
  it('builds the runs with the same code the popup uses', () => {
    const index = indexOf([
      track('t0', 'video', 'video:avc1:640x480', [
        [0, 2],
        [2, 4],
        [8, 10],
      ]),
    ])
    const material = materialOf(index)

    expect(material.video!.runs.map((run) => [run.start, run.end])).toEqual([
      [0, 4],
      [8, 10],
    ])
    expect(material.video!.duration).toBe(6)
    expect(material.video!.span).toEqual({ start: 0, end: 10 })
  })

  it('has every chunk of a run remember where its bytes are in the file', () => {
    const index = indexOf([track('t0', 'video', 'video:avc1:640x480', [[0, 2]])])
    const [chunk] = materialOf(index).video!.runs[0]!.chunks

    expect(chunk!.source).toEqual(index.tracks[0]!.chunks[0]!.data)
    expect(chunk!.bytes.byteLength, 'the editor does not load bytes into the map').toBe(0)
  })

  it('finds the picture and the sound by their kinds', () => {
    const index = indexOf([
      track('t0', 'audio', 'audio:mp4a:0x0', [[0, 4]]),
      track('t1', 'video', 'video:avc1:640x480', [[0, 4]]),
    ])
    const material = materialOf(index)

    expect(material.video!.track.id).toBe('t1')
    expect(material.audio!.track.id).toBe('t0')
  })

  it('takes the representation with the most material behind it', () => {
    // A change of quality mid-watch leaves two tracks behind. A clip lives inside one
    // representation (§8.3), and the editor opens on the one that was watched longest.
    const index = indexOf([
      track('t0', 'video', 'video:avc1:640x480', [[0, 2]]),
      track('t1', 'video', 'video:avc1:1280x720', [
        [2, 4],
        [4, 6],
        [6, 8],
      ]),
    ])
    const material = materialOf(index)

    expect(material.video!.track.id).toBe('t1')
    expect(material.representations).toEqual(['video:avc1:640x480', 'video:avc1:1280x720'])
  })

  it('lets a track with no material be neither the picture nor the sound', () => {
    const index = indexOf([
      track('t0', 'video', 'video:avc1:640x480', []),
      track('t1', 'audio', 'audio:mp4a:0x0', [[0, 4]]),
    ])
    const material = materialOf(index)

    expect(material.video).toBeNull()
    expect(material.audio!.track.id).toBe('t1')
    // An empty track is not dropped from the list: that the stream existed is a fact about the
    // recording.
    expect(material.tracks).toHaveLength(2)
  })

  it('counts a muxed track as the picture and the sound at once', () => {
    const muxed = {
      ...track('t0', 'video', 'video:avc1:640x480', [[0, 4]]),
      kinds: ['video', 'audio'] as TrackKind[],
    }
    const material = materialOf(indexOf([muxed]))

    expect(material.video!.track.id).toBe('t0')
    expect(material.audio, 'a muxed track has no separate sound track').toBeNull()
  })

  it('measures the material by the picture, or by the sound where there is none', () => {
    const withPicture = materialOf(
      indexOf([
        track('t0', 'video', 'video:avc1:640x480', [[0, 4]]),
        track('t1', 'audio', 'audio:mp4a:0x0', [[0, 6]]),
      ]),
    )
    expect(withPicture.duration).toBe(4)

    const soundOnly = materialOf(indexOf([track('t1', 'audio', 'audio:mp4a:0x0', [[0, 6]])]))
    expect(soundOnly.duration).toBe(6)
  })

  it('weighs the chunks rather than the file', () => {
    const material = materialOf(
      indexOf([
        track('t0', 'video', 'video:avc1:640x480', [
          [0, 2],
          [2, 4],
        ]),
      ]),
    )
    expect(material.bytes).toBe(200)
  })
})

describe('gapsBetween', () => {
  it('names every gap between the runs', () => {
    const runs = materialOf(
      indexOf([
        track('t0', 'video', 'video:avc1:640x480', [
          [0, 2],
          [6, 8],
          [20, 22],
        ]),
      ]),
    ).video!.runs

    expect(gapsBetween(runs)).toEqual([
      { start: 2, end: 6 },
      { start: 8, end: 20 },
    ])
  })

  it('finds no gaps in continuous material', () => {
    const runs = materialOf(
      indexOf([
        track('t0', 'video', 'video:avc1:640x480', [
          [0, 2],
          [2, 4],
        ]),
      ]),
    ).video!.runs

    expect(gapsBetween(runs)).toEqual([])
  })

  it('finds no gaps in an empty list and does not fall over', () => {
    expect(gapsBetween([])).toEqual([])
  })
})
