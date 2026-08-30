import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { EncodingChoice } from '../../src/core/encode/codec'
import { framesOf, laneOf, pathFor } from '../../src/core/encode/path'
import type { Clip } from '../../src/core/edit/clip'
import type { EditContext } from '../../src/core/edit/context'
import { clipSourceOf } from '../../src/core/export/source'
import type { Located } from '../../src/shared/types'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

const init = read('h264/init-stream0.m4s')
const segments = [1, 2, 3].map((n) => read(`h264/chunk-stream0-0000${n}.m4s`))
const placed: Located[] = (() => {
  let at = 0
  return segments.map((bytes) => {
    const located = { at, length: bytes.byteLength }
    at += bytes.byteLength
    return located
  })
})()

const source = clipSourceOf([
  {
    kind: 'video',
    initBytes: init,
    segments: segments.map((bytes, index) => ({ bytes, at: placed[index]! })),
  },
])!

const ctx: EditContext = {
  frames: Float64Array.from(source.video.samples.map((sample) => sample.pts / source.video.timescale)),
  keyframes: Float64Array.from([0, 1, 2, 3, 4, 5]),
  fps: 24,
  frameSize: { width: source.video.width, height: source.video.height },
  newClipFormat: 'mp4',
  runs: [{ start: 0, end: 6 }],
  zones: [
    {
      start: 0,
      end: 6,
      representation: 'h264',
      codec: 'avc1',
      width: source.video.width,
      height: source.video.height,
    },
  ],
  duration: 6,
  title: 'A clip',
}

const clip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'c1',
  name: 'One',
  in: 1,
  out: 3,
  representation: 'h264',
  sound: false,
  crop: null,
  format: 'mp4',
  mode: 'original',
  ...overrides,
})

const choice: EncodingChoice = {
  kind: 'h264-sw',
  config: {
    codec: 'avc1.640028',
    width: source.video.width,
    height: source.video.height,
    framerate: ctx.fps,
  },
  control: 'fixed-bitrate',
  bitrate: 1_000_000,
}

describe('pathFor', () => {
  it('copies an original MP4 clip without asking for an encoder', () => {
    const path = pathFor(clip(), source, ctx, null, false)

    expect(path.kind).toBe('copy')
    expect(path.kind === 'copy' && path.plan.tracks[0]?.kind).toBe('video')
  })

  it('encodes a crop even when the clip otherwise asks for original', () => {
    const cropped = clip({ crop: { x: 0, y: 0, width: 160, height: 120 } })
    const path = pathFor(cropped, source, ctx, choice, false)

    expect(path.kind).toBe('encode')
    expect(path.kind === 'encode' ? path.plan.crop : null).toEqual({
      x: 0,
      y: 0,
      width: 160,
      height: 120,
    })
    expect(path.kind === 'encode' ? path.plan.geometry : null).toEqual({
      width: 160,
      height: 120,
      framerate: 24,
    })
    expect(
      pathFor(cropped, source, ctx, { kind: 'none', tried: ['crop'] }, false),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'no-encoder',
      geometry: { width: 160, height: 120, framerate: 24 },
    })
  })

  it('encodes a clip that explicitly asks to optimize', () => {
    expect(pathFor(clip({ mode: 'optimize' }), source, ctx, choice, false).kind).toBe('encode')
  })

  it('encodes a non-keyframe head when rewriting heads is enabled', () => {
    const between = clip({ in: 1.5 })

    expect(pathFor(between, source, ctx, choice, true).kind).toBe('encode')
    expect(pathFor(between, source, ctx, choice, false).kind).toBe('copy')
    expect(pathFor(clip(), source, ctx, null, true).kind).toBe('copy')
  })

  it('takes WebP through its own path without asking for an MP4 encoder', () => {
    for (const unavailable of [null, { kind: 'none' as const, tried: ['webp'] }]) {
      expect(pathFor(clip({ format: 'webp' }), source, ctx, unavailable, false).kind).toBe('webp')
    }
  })

  it('blocks an encoded MP4 when the probe has no answer or no encoder', () => {
    const wanted = clip({ mode: 'optimize' })

    for (const unavailable of [null, { kind: 'none' as const, tried: ['one', 'two'] }]) {
      const path = pathFor(wanted, source, ctx, unavailable, false)
      expect(path).toMatchObject({
        kind: 'blocked',
        reason: 'no-encoder',
        geometry: { width: 320, height: 240, framerate: 24 },
      })
    }
  })

  it('blocks material with no picture to decode', () => {
    const empty = { video: { ...source.video, samples: [] } }

    expect(pathFor(clip({ mode: 'optimize' }), empty, ctx, choice, false)).toMatchObject({
      kind: 'blocked',
      reason: 'no-material',
    })
  })

  it('puts only copies in the copy lane', () => {
    expect(laneOf(pathFor(clip(), source, ctx, null, false))).toBe('copy')
    expect(laneOf(pathFor(clip({ mode: 'optimize' }), source, ctx, choice, false))).toBe('encode')
    expect(laneOf(pathFor(clip({ format: 'webp' }), source, ctx, null, false))).toBe('encode')
    expect(laneOf(pathFor(clip({ mode: 'optimize' }), source, ctx, null, false))).toBe('encode')
  })

  it('counts encoded frames, thinned WebP frames, and no frames for copies or blocks', () => {
    const encoded = pathFor(clip({ mode: 'optimize', in: 1.5 }), source, ctx, choice, false)
    const webp = pathFor(clip({ format: 'webp' }), source, ctx, null, false)
    const copied = pathFor(clip(), source, ctx, null, false)
    const blocked = pathFor(clip({ mode: 'optimize' }), source, ctx, null, false)

    expect(encoded.kind).toBe('encode')
    expect(encoded.kind === 'encode' && encoded.plan.kept).toBeLessThan(
      encoded.kind === 'encode' ? encoded.plan.frames.length : 0,
    )
    expect(framesOf(encoded)).toBe(encoded.kind === 'encode' ? encoded.plan.kept : -1)
    expect(webp.kind).toBe('webp')
    expect(framesOf(webp)).toBe(30)
    expect(framesOf(webp)).toBeLessThan(webp.kind === 'webp' ? webp.plan.kept : 0)
    expect(framesOf(copied)).toBeUndefined()
    expect(framesOf(blocked)).toBeUndefined()
  })
})
