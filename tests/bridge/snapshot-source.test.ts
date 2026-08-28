import { describe, it, expect } from 'vitest'
import { snapshotSourceOf, type Session } from '../../src/bridge/session-store'
import { PtsMap } from '../../src/core/timeline/map'
import type { Chunk } from '../../src/shared/types'

const chunk = (start: number, end: number, fill: number): Chunk => ({
  start,
  end,
  bytes: new Uint8Array(16).fill(fill),
})

function session(): Session {
  const video = new PtsMap()
  // Out of order and with a repeat: the map is what puts them straight, and the source has to
  // take them from the map rather than from the order they arrived in.
  video.insert(chunk(2, 4, 0x22))
  video.insert(chunk(0, 2, 0x21))
  video.insert(chunk(0, 2, 0x21))
  video.insert(chunk(8, 10, 0x24))

  const audio = new PtsMap()
  audio.insert(chunk(0, 2, 0x31))

  return {
    key: 'https://site.example/watch|avc1|inf',
    url: 'https://site.example/watch?v=abc',
    title: 'Clip',
    createdAt: 100,
    lastSeenAt: 200,
    refusedTracks: true,
    tracks: [
      {
        bufferId: 'sb-1',
        representation: 'video:avc1:640x480',
        kinds: ['video'],
        initBytes: new Uint8Array(8).fill(0x11),
        info: { tracks: [{ trackId: 1, kind: 'video', timescale: 12_288, codec: 'avc1', width: 640, height: 480 }] },
        map: video,
      },
      {
        bufferId: 'sb-2',
        representation: 'audio:mp4a:0x0',
        kinds: ['audio'],
        initBytes: new Uint8Array(8).fill(0x12),
        info: { tracks: [{ trackId: 1, kind: 'audio', timescale: 44_100, codec: 'mp4a', width: 0, height: 0 }] },
        map: audio,
      },
    ],
  }
}

describe('snapshotSourceOf', () => {
  it('carries over everything that cannot be worked out of the material', () => {
    const source = snapshotSourceOf(session())

    expect(source.page).toEqual({
      sessionKey: 'https://site.example/watch|avc1|inf',
      url: 'https://site.example/watch?v=abc',
      title: 'Clip',
      createdAt: 100,
      lastSeenAt: 200,
      refusedTracks: true,
    })
  })

  it('takes the chunks off the map, in time order and without the repeat', () => {
    const [video] = snapshotSourceOf(session()).tracks

    expect(video!.chunks.map((c) => c.start)).toEqual([0, 2, 8])
    expect(video!.chunks.map((c) => c.bytes[0])).toEqual([0x21, 0x22, 0x24])
  })

  it('neither closes a gap in the map nor fills it', () => {
    // 4…8 was never watched. The editor works the runs out with the same PtsMap: what a
    // snapshot holds is chunks.
    const [video] = snapshotSourceOf(session()).tracks
    expect(video!.chunks[1]!.end).toBe(4)
    expect(video!.chunks[2]!.start).toBe(8)
  })

  it('gives every track a stable name inside the snapshot', () => {
    const source = snapshotSourceOf(session())
    expect(source.tracks.map((t) => t.id)).toEqual(['t0', 't1'])
    expect(source.tracks.map((t) => t.bufferId)).toEqual(['sb-1', 'sb-2'])
  })

  it('passes the init segment and the track description on as they are', () => {
    const [video, audio] = snapshotSourceOf(session()).tracks
    expect(video!.initBytes[0]).toBe(0x11)
    expect(audio!.info.tracks[0]!.timescale).toBe(44_100)
    expect(video!.representation).toBe('video:avc1:640x480')
    expect(audio!.kinds).toEqual(['audio'])
  })

  it('turns a session with no tracks into a source with no tracks, not a crash', () => {
    const empty = { ...session(), tracks: [] }
    expect(snapshotSourceOf(empty).tracks).toEqual([])
  })
})
