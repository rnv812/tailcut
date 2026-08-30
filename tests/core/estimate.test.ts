import { describe, expect, it } from 'vitest'
import { estimateFor } from '../../src/core/encode/estimate'
import type { EncodingChoice, EncodeGeometry } from '../../src/core/encode/codec'
import type { FramePlan } from '../../src/core/encode/plan'
import type { ClipPath } from '../../src/core/encode/path'

const GEOMETRY: EncodeGeometry = { width: 1920, height: 1080, framerate: 30 }
const SOURCE_BYTES = 4_800_000

const plan = (over: Partial<FramePlan> = {}): FramePlan => ({
  frames: [],
  kept: 300,
  headTicks: 0,
  headUs: 0,
  timescale: 90_000,
  crop: null,
  decoder: { codec: 'avc1.640028' },
  sourceFormat: 'avc1',
  geometry: GEOMETRY,
  audio: null,
  duration: 10,
  ...over,
})

const hardware = (kind: 'hevc-hw' | 'h264-hw'): EncodingChoice => ({
  kind,
  config: {
    codec: kind === 'hevc-hw' ? 'hev1.1.6.L120.B0' : 'avc1.640028',
    width: GEOMETRY.width,
    height: GEOMETRY.height,
    framerate: GEOMETRY.framerate,
  },
  control: 'quantizer',
  quantizer: 27,
})

const software = (bitrate = 800_000): EncodingChoice => ({
  kind: 'h264-sw',
  config: { codec: 'avc1.640028', ...GEOMETRY },
  control: 'fixed-bitrate',
  bitrate,
})

const encodePath = (
  choice: EncodingChoice,
  sourceFormat = 'avc1',
): Extract<ClipPath, { kind: 'encode' }> => ({
  kind: 'encode',
  plan: plan({ sourceFormat }),
  choice,
})

const input = (path: ClipPath, over: Record<string, unknown> = {}) => ({
  path,
  duration: 10,
  sourceBytes: SOURCE_BYTES,
  pace: { rates: {} },
  ...over,
})

describe('encode estimate', () => {
  it('takes the exact byte count of a copied path', () => {
    const estimate = estimateFor(
      input({ kind: 'copy', plan: { tracks: [], duration: 2, bytes: 1_234 } }, { sourceBytes: 9_999 }),
    )

    expect(estimate).toEqual({ kind: 'copy', bytes: 1_234 })
  })

  it('does not invent a weight for either constant-quality hardware rung', () => {
    const pace = { rates: { mp4: GEOMETRY.width * GEOMETRY.height * 30 } }

    for (const choice of [hardware('hevc-hw'), hardware('h264-hw')]) {
      expect(estimateFor(input(encodePath(choice), { pace }))).toMatchObject({
        kind: 'encode',
        rung: choice.kind,
        geometry: GEOMETRY,
        frames: 300,
        seconds: 10,
        bytes: null,
        sourceCodec: 'avc1',
        inflates: false,
        sourceBytes: SOURCE_BYTES,
      })
    }
  })

  it('derives the software rung floor from bitrate and clip duration', () => {
    const estimate = estimateFor(
      input(encodePath(software(800_000)), { duration: 12 }),
    )

    expect(estimate).toMatchObject({ kind: 'encode', rung: 'h264-sw', bytes: 1_200_000 })
  })

  it('warns for both already efficient source codecs', () => {
    for (const codec of ['av01', 'vp09']) {
      expect(estimateFor(input(encodePath(software(), codec)))).toMatchObject({
        kind: 'encode',
        sourceCodec: codec,
        inflates: true,
      })
    }
  })

  it('does not warn for AVC or VP8 source material', () => {
    for (const codec of ['avc1', 'vp08']) {
      expect(estimateFor(input(encodePath(software(), codec)))).toMatchObject({
        kind: 'encode',
        sourceCodec: codec,
        inflates: false,
      })
    }
  })

  it('caps WebP geometry and frame rate while its measured weight is pending', () => {
    const geometry = { width: 1280, height: 720, framerate: 30 }
    const path: ClipPath = {
      kind: 'webp',
      plan: plan({
        crop: { x: 0, y: 0, width: 1280, height: 720 },
        geometry,
      }),
    }
    const webp = { width: 640, height: 360, framerate: 15 }
    const pace = { rates: { webp: webp.width * webp.height * 15 } }

    expect(estimateFor(input(path, { pace }))).toEqual({
      kind: 'webp',
      geometry: webp,
      frames: 150,
      seconds: 10,
      bytes: null,
      sourceBytes: SOURCE_BYTES,
    })
  })

  it('carries the measured WebP weight once its probe has answered', () => {
    const path: ClipPath = { kind: 'webp', plan: plan() }

    expect(estimateFor(input(path, { probedBytes: 765_432 }))).toMatchObject({
      kind: 'webp',
      bytes: 765_432,
    })
  })

  it('returns only the reason and geometry when no encoder can take the picture', () => {
    expect(
      estimateFor(input({ kind: 'blocked', reason: 'no-encoder', geometry: GEOMETRY })),
    ).toEqual({ kind: 'none', reason: 'no-encoder', geometry: GEOMETRY })
  })

  it('distinguishes a clip with no picture material from an unsupported geometry', () => {
    expect(
      estimateFor(input({ kind: 'blocked', reason: 'no-material', geometry: GEOMETRY })),
    ).toEqual({ kind: 'none', reason: 'no-material', geometry: GEOMETRY })
  })
})
