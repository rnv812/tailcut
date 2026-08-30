import { describe, it, expect } from 'vitest'
import { coveredWith, historyIndexOf, secondsOf } from '../../src/core/history/index'
import { SAME_CHUNK_TOLERANCE_SECONDS } from '../../src/core/timeline/map'
import type { HistoryPiece, HistoryTrack } from '../../src/core/history/layout'

const video: HistoryTrack = {
  representation: 'video:avc1:1920x1080',
  bufferId: 'sb-0',
  kinds: ['video'],
  info: { tracks: [{ trackId: 1, kind: 'video', timescale: 90_000, codec: 'avc1', width: 1920, height: 1080 }] },
  init: { file: 'aaaa-000000.tcm', at: 0, length: 40 },
}

const audio: HistoryTrack = {
  representation: 'audio:mp4a:0x0',
  bufferId: 'sb-1',
  kinds: ['audio'],
  info: { tracks: [{ trackId: 2, kind: 'audio', timescale: 48_000, codec: 'mp4a', width: 0, height: 0 }] },
  init: { file: 'aaaa-000000.tcm', at: 40, length: 20 },
}

const pieces: HistoryPiece[] = [
  {
    file: 'aaaa-000000.tcm',
    bytes: 260,
    until: 4,
    writtenAt: 10,
    parts: [
      { representation: 'video:avc1:1920x1080', start: 0, end: 2, at: 60, length: 100 },
      { representation: 'audio:mp4a:0x0', start: 0, end: 2, at: 160, length: 20 },
      { representation: 'video:avc1:1920x1080', start: 2, end: 4, at: 180, length: 80 },
    ],
  },
  {
    file: 'aaaa-000001.tcm',
    bytes: 90,
    until: 6,
    writtenAt: 20,
    parts: [{ representation: 'video:avc1:1920x1080', start: 4, end: 6, at: 0, length: 90 }],
  },
]

const session = {
  id: 'sess-1',
  key: 'https://site.example/watch|avc1,mp4a|live',
  url: 'https://site.example/watch',
  title: 'Clip',
  createdAt: 1,
  lastSeenAt: 2,
  tracks: [video, audio],
}

const meta = { capturedAt: 99, producer: 'tailcut 0.1.0' }

describe('coveredWith', () => {
  it('adds what a piece holds to what the session covers already', () => {
    // Four seconds of material, not six: the sound of the first two is the same two seconds, and
    // counting a stretch once per track is how the length of a session doubles.
    expect(coveredWith([], pieces[0]!.parts)).toEqual([{ start: 0, end: 4 }])
    expect(secondsOf(coveredWith(coveredWith([], pieces[0]!.parts), pieces[1]!.parts))).toBe(6)
  })

  it('counts a stretch once however many times it was written', () => {
    // Two tabs playing one video merge into one session and write overlap twice; a quality switch
    // writes the same seconds under a second representation. Neither is more
    // material, and this is the one rule that says so.
    const covered = coveredWith([], pieces[0]!.parts)
    expect(coveredWith(covered, pieces[0]!.parts)).toEqual([{ start: 0, end: 4 }])
  })

  it('keeps a gap a gap, and joins what only rounding separates', () => {
    expect(coveredWith([{ start: 0, end: 2 }], [{ start: 10, end: 12 }])).toEqual([
      { start: 0, end: 2 },
      { start: 10, end: 12 },
    ])
    // The tolerance PtsMap runs by: a hundredth of a second between two segments is arithmetic
    // on media times, not a hole in the recording.
    expect(coveredWith([{ start: 0, end: 2 }], [{ start: 2.01, end: 4 }])).toEqual([
      { start: 0, end: 4 },
    ])
  })

  it('takes what arrives out of order', () => {
    expect(coveredWith([{ start: 4, end: 6 }], [{ start: 0, end: 2 }])).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ])
  })
})

describe('secondsOf', () => {
  it('is the material and not the span: a gap is not recorded time', () => {
    expect(secondsOf([{ start: 0, end: 4 }, { start: 10, end: 12 }])).toBe(6)
    expect(secondsOf([])).toBe(0)
  })
})

describe('historyIndexOf', () => {
  it('lays the pieces end to end and addresses everything in that one space', () => {
    const composed = historyIndexOf(session, pieces, meta)

    expect(composed.stores.map((store) => store.bytes)).toEqual([260, 90])
    expect(composed.size).toBe(350)

    const track = composed.index.tracks.find((one) => one.representation === video.representation)!
    expect(track.init).toEqual({ at: 0, length: 40 })
    expect(track.chunks).toEqual([
      { start: 0, end: 2, data: { at: 60, length: 100 } },
      { start: 2, end: 4, data: { at: 180, length: 80 } },
      // The second file starts at 260, so the part at 0 inside it is at 260 here.
      { start: 4, end: 6, data: { at: 260, length: 90 } },
    ])
  })

  it('names the files as stores, in the order their bytes are laid out', () => {
    const composed = historyIndexOf(session, pieces, meta)
    expect(composed.index.stores).toEqual([
      { kind: 'file', path: 'history/sess-1/aaaa-000000.tcm', bytes: 260 },
      { kind: 'file', path: 'history/sess-1/aaaa-000001.tcm', bytes: 90 },
    ])
  })

  it('reads the pieces in the order they were written, whatever order they arrive in', () => {
    // The index gives no order back; the names carry it — a padded sequence number per writer.
    const shuffled = [pieces[1]!, pieces[0]!]
    expect(historyIndexOf(session, shuffled, meta)).toEqual(historyIndexOf(session, pieces, meta))
  })

  it('drops the repeat when two writers wrote the same stretch', () => {
    // Two tabs playing one video merge by identity and write into one directory. The
    // maps that fed them are separate, so each of them wrote its own copy of the overlap, and one
    // clip cannot be cut from a timeline where the same second is there twice.
    const twice: HistoryPiece[] = [
      ...pieces,
      {
        file: 'bbbb-000000.tcm',
        bytes: 100,
        until: 4,
        writtenAt: 30,
        parts: [{ representation: 'video:avc1:1920x1080', start: 2, end: 4, at: 0, length: 100 }],
      },
    ]

    const track = historyIndexOf(session, twice, meta).index.tracks.find(
      (one) => one.representation === video.representation,
    )!
    expect(track.chunks.map((chunk) => chunk.start)).toEqual([0, 2, 4])
    // The first one written wins: it is the one the earlier reader already knows.
    expect(track.chunks[1]!.data).toEqual({ at: 180, length: 80 })
  })

  it('drops it by the tolerance the live map inserts by, and not by a copy of that number', () => {
    // Two frames writing one video do not write the same start twice: each of them read the time
    // out of its own segment, and the two differ in the last digits. So the rule is a tolerance,
    // and the tolerance is `PtsMap`'s own — the fixture is built out of the exported constant so
    // that moving it moves both sides at once. A second copy of the number in the history would
    // hold this test just as well while it agreed, and stop agreeing with no test to say so.
    const near = SAME_CHUNK_TOLERANCE_SECONDS / 2
    const far = SAME_CHUNK_TOLERANCE_SECONDS * 2
    const written = (file: string, start: number): HistoryPiece => ({
      file,
      bytes: 100,
      until: start + 2,
      writtenAt: 30,
      parts: [{ representation: video.representation, start, end: start + 2, at: 0, length: 100 }],
    })

    const chunks = (...extra: HistoryPiece[]) =>
      historyIndexOf(session, [...pieces, ...extra], meta)
        .index.tracks.find((one) => one.representation === video.representation)!
        .chunks.map((chunk) => chunk.start)

    expect(chunks(written('bbbb-000000.tcm', 2 + near)), 'a repeat off by a rounding was kept as a second piece').toEqual([0, 2, 4])
    expect(chunks(written('bbbb-000001.tcm', 2 + far)), 'a piece of its own was dropped as a repeat').toEqual([0, 2, 2 + far, 4])
  })

  it('leaves a track with no material out instead of describing an empty one', () => {
    const composed = historyIndexOf({ ...session, tracks: [video, audio] }, [pieces[1]!], meta)
    expect(composed.index.tracks.map((one) => one.representation)).toEqual([video.representation])
  })

  it('signs the index the way a snapshot is signed, so the editor cannot tell them apart', () => {
    const composed = historyIndexOf(session, pieces, meta)
    expect(composed.index.format).toBe('tailcut/snapshot')
    expect(composed.index.id).toBe('sess-1')
    expect(composed.index.page).toEqual({
      sessionKey: session.key,
      url: session.url,
      title: session.title,
      createdAt: 1,
      lastSeenAt: 2,
      refusedTracks: false,
    })
  })
})
