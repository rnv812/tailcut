import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { thumbnailSourceOf } from '../../src/bridge/thumbnail-source'
import {
  planSave,
  selectMaterial,
  SessionStore,
  type Session,
} from '../../src/bridge/session-store'
import { sampleEntryFormat } from '../../src/core/encode/decoder'
import { plainFileOf } from '../../src/core/export/plain'
import type { RangeReader } from '../../src/core/iso/locate'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))
const H264_INIT = read('tests/fixtures/h264/init-stream0.m4s')
const H264_SEGMENTS = [1, 2].map((part) =>
  read(`tests/fixtures/h264/chunk-stream0-0000${part}.m4s`),
)
const VP9_INIT = read('tests/fixtures/vp9/init-stream0.m4s')
const VP9_SEGMENT = read('tests/fixtures/vp9/chunk-stream0-00001.m4s')
const PLAIN = read('tests/fixtures/plain/whole.mp4')

const page = {
  sourceId: 'source',
  bufferId: 'picture',
  url: 'https://example.test/watch',
  title: 'A recording',
  now: 1_000,
}

function emptySession(): Session {
  return {
    key: 'session',
    url: page.url,
    title: page.title,
    tracks: [],
    createdAt: page.now,
    lastSeenAt: page.now,
    refusedTracks: false,
    widthPx: 640,
  }
}

function expectedBytes(parts: readonly Uint8Array[], at: number, length: number): Uint8Array {
  let base = 0
  for (const part of parts) {
    if (at >= base && at + length <= base + part.byteLength) {
      return part.subarray(at - base, at - base + length)
    }
    base += part.byteLength
  }
  throw new Error('The sample does not belong to the selected material.')
}

describe('thumbnailSourceOf', () => {
  it('indexes the same captured video representation Save all selects', async () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: H264_INIT })
    for (const bytes of H264_SEGMENTS) store.append({ ...page, bytes })
    store.append({ ...page, bytes: VP9_INIT })
    store.append({ ...page, bytes: VP9_SEGMENT })
    const session = store.list()[0]!

    const selected = selectMaterial(session)
    expect(selected).toHaveLength(1)
    expect(selected[0]!.initBytes).toEqual(H264_INIT)

    const source = thumbnailSourceOf(session)

    expect(source).not.toBeNull()
    expect(sampleEntryFormat(source!.video.sampleEntry)).toBe('avc1')
    expect(source!.video.samples.length).toBeGreaterThan(0)
    const picture = source!.video.samples.find((sample) => sample.sync)!
    const bytes = await source!.read(picture.source)
    expect(bytes).toEqual(expectedBytes(selected[0]!.segments, picture.source.at, picture.source.length))
    await expect(
      source!.read({
        at: selected[0]!.segments.reduce((total, segment) => total + segment.byteLength, 0),
        length: 1,
      }),
    ).rejects.toThrow(RangeError)
  })

  it('uses only the watched picture samples and exact range reads for a plain file', async () => {
    const file = plainFileOf(PLAIN, PLAIN.byteLength)!
    const calls: Array<{ at: number; length: number }> = []
    const range: RangeReader = async (at, length) => {
      calls.push({ at, length })
      return {
        // Deliberately lend more than requested. ThumbnailSource must expose only its own range.
        bytes: PLAIN.subarray(at, Math.min(PLAIN.byteLength, at + length + 7)),
        total: PLAIN.byteLength,
      }
    }
    const session: Session = {
      ...emptySession(),
      plain: {
        url: 'https://cdn.example/video.mp4',
        file,
        read: range,
        buffered: [{ start: 2, end: 4 }],
      },
    }
    const save = planSave(session)
    expect(save.source.kind).toBe('plain')
    if (save.source.kind !== 'plain') throw new Error('Expected a plain save.')
    const planned = save.source.plan.tracks.find((track) => track.kind === 'video')!

    const source = thumbnailSourceOf(session)

    expect(source).not.toBeNull()
    expect(source!.video.samples.map((sample) => sample.source)).toEqual(
      planned.samples.map((sample) => sample.source),
    )
    expect(source!.video.samples.length).toBeLessThan(
      file.tracks.find((track) => track.kind === 'video')!.samples.length,
    )
    const picture = source!.video.samples.find((sample) => sample.sync)!
    const bytes = await source!.read(picture.source)
    expect(calls).toEqual([{ at: picture.source.at, length: picture.source.length }])
    expect(bytes).toEqual(PLAIN.subarray(picture.source.at, picture.source.at + picture.source.length))

    const callsBeforeRefusal = calls.length
    await expect(source!.read({ at: 0, length: 1 })).rejects.toThrow(RangeError)
    expect(calls).toHaveLength(callsBeforeRefusal)
  })

  it('answers null when the session has no saved picture material', () => {
    expect(thumbnailSourceOf(emptySession())).toBeNull()
  })
})
