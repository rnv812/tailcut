import { test, expect, chromium } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { encodeToTrack } from '../../src/editor/export/encoder'
import type { liveCodecs } from '../../src/editor/export/frames'
import type { assembleEncoded } from '../../src/core/encode/assemble'
import type { decoderConfigOf } from '../../src/core/encode/decoder'
import type { movieTracksOf } from '../../src/core/export/source'
import type { planFrames, FramePlan } from '../../src/core/encode/plan'
import type { FrameSource } from '../../src/editor/export/frames'

const cases = [
  ...(['smpte170m', 'bt709'] as const).flatMap(matrix => [false, true].map(normalize => ({ matrix, normalize, containerOnly: false }))),
  { matrix: 'bt709' as const, normalize: false, containerOnly: true },
]
for (const { matrix, normalize, containerOnly } of cases) {
    test(`preserves ${matrix} pixels after a cropped MP4 export, CPU conversion ${normalize}, container colour ${containerOnly}`, async ({}, testInfo) => {
      let containerFile: number[] | null = null
      if (containerOnly) {
        const source = testInfo.outputPath('container-colour.mp4')
        const raw = Buffer.concat([Buffer.alloc(4096, 100), Buffer.alloc(1024, 100), Buffer.alloc(1024, 180)])
        // The pixel matrix is BT.709, stated only by colr. The H.264 bitstream says unspecified.
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size', '64x64',
          '-framerate', '1', '-i', 'pipe:0', '-c:v', 'libx264', '-color_primaries', 'bt709', '-color_trc', 'bt709',
          '-colorspace', 'bt709', '-x264-params', 'colorprim=undef:transfer=undef:colormatrix=undef',
          '-movflags', '+write_colr', '-y', source], { input: raw })
        containerFile = Array.from(readFileSync(source))
      }
      const browser = await chromium.launch({ channel: 'chromium', headless: true })
      try {
        const page = await browser.newPage()
        await page.route('https://tailcut.test/colour', route => route.fulfill({ body: '<!doctype html>' }))
        await page.goto('https://tailcut.test/colour')
        const bundle = await build({
          stdin: { contents: `
            import { encodeToTrack } from './src/editor/export/encoder'
            import { liveCodecs } from './src/editor/export/frames'
            import { assembleEncoded } from './src/core/encode/assemble'
            import { decoderConfigOf } from './src/core/encode/decoder'
            import { movieTracksOf } from './src/core/export/source'
            import { planFrames } from './src/core/encode/plan'
            globalThis.tcColour = { encodeToTrack, liveCodecs, assembleEncoded, decoderConfigOf, movieTracksOf, planFrames }
          `, resolveDir: resolve('.'), loader: 'ts' },
          bundle: true, write: false, format: 'iife', target: 'chrome120', logLevel: 'silent',
        })
        await page.evaluate(bundle.outputFiles[0]!.text)
        const result = await page.evaluate(async ({ matrix, normalize, containerFile }) => {
          const api = (globalThis as unknown as { tcColour: {
            encodeToTrack: typeof encodeToTrack; liveCodecs: typeof liveCodecs;
            assembleEncoded: typeof assembleEncoded; decoderConfigOf: typeof decoderConfigOf;
            movieTracksOf: typeof movieTracksOf; planFrames: typeof planFrames;
          } }).tcColour
          const colorSpace = { primaries: matrix, transfer: matrix, matrix, fullRange: false }
          const pixels = new Uint8Array(64 * 64 * 3 / 2)
          pixels.fill(100, 0, 4096)
          pixels.fill(100, 4096, 5120)
          pixels.fill(180, 5120)
          const frame = new VideoFrame(pixels, { format: 'I420', codedWidth: 64, codedHeight: 64,
            timestamp: 0, duration: 1_000_000, colorSpace })
          const canvas = new OffscreenCanvas(32, 32)
          const context = canvas.getContext('2d')!
          context.drawImage(frame, 0, 0, 32, 32)
          const before = Array.from(context.getImageData(16, 16, 1, 1).data).slice(0, 3)
          let input: Uint8Array | undefined
          let decoder: VideoDecoderConfig | undefined
          const config: VideoEncoderConfig = { codec: 'avc1.42001f', width: 64, height: 64,
            bitrate: 1_000_000, framerate: 1, hardwareAcceleration: 'prefer-software', avc: { format: 'avc' } }
          const encoder = new VideoEncoder({ output(chunk, metadata) {
            input = new Uint8Array(chunk.byteLength)
            chunk.copyTo(input)
            decoder = metadata!.decoderConfig!
          }, error(error) { throw error } })
          encoder.configure(config)
          encoder.encode(frame, { keyFrame: true })
          frame.close()
          await encoder.flush()
          encoder.close()
          let plan: FramePlan = {
            frames: [{ source: { at: 0, length: input!.length }, pts: 0, duration: 1_000_000, sync: true, keep: true }],
            kept: 1, headTicks: 0, headUs: 0, timescale: 1_000_000,
            crop: { x: 8, y: 8, width: 48, height: 48 }, decoder: decoder!, sourceFormat: 'avc1',
            geometry: { width: 48, height: 48, framerate: 1 }, audio: null, duration: 1,
          }
          let read: FrameSource['read'] = async () => input!
          if (containerFile) {
            const bytes = new Uint8Array(containerFile)
            const video = api.movieTracksOf(bytes, bytes.length).find(track => track.kind === 'video')!
            plan = api.planFrames({ video }, { in: 0, out: 1, sound: false }, plan.crop, 1)!
            read = async at => bytes.subarray(at.at, at.at + at.length)
          }
          const encoded = await api.encodeToTrack(plan,
            { kind: 'h264-sw', config: { ...config, width: 48, height: 48 }, control: 'fixed-bitrate', bitrate: 1_000_000 },
            { read, stale: () => false }, api.liveCodecs(), () => {}, normalize)
          const file = api.assembleEncoded(encoded!.video, null)
          const url = URL.createObjectURL(new Blob([file as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }))
          const video = document.createElement('video')
          try {
            await new Promise<void>((resolve, reject) => {
              video.onloadeddata = () => resolve()
              video.onerror = () => reject(new Error(video.error?.message))
              video.src = url
            })
            context.drawImage(video, 0, 0, 32, 32)
            const after = Array.from(context.getImageData(16, 16, 1, 1).data).slice(0, 3)
            return { before, after, colour: api.decoderConfigOf(encoded!.video.sampleEntry)?.colorSpace, file: Array.from(file) }
          } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url) }
        }, { matrix, normalize, containerFile })
        const saved = testInfo.outputPath('colours.mp4')
        writeFileSync(saved, new Uint8Array(result.file))
        const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', saved, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
        const ffmpeg = Array.from(decoded.subarray((24 * 48 + 24) * 3, (24 * 48 + 24) * 3 + 3))
        console.log({ matrix, normalize, before: result.before, after: result.after, ffmpeg, colour: result.colour })
        for (let channel = 0; channel < 3; channel++) {
          expect(Math.abs(result.before[channel]! - result.after[channel]!)).toBeLessThanOrEqual(3)
          // FFmpeg and Chromium round YUV-to-RGB differently, especially at low channel values.
          expect(Math.abs(result.before[channel]! - ffmpeg[channel]!)).toBeLessThanOrEqual(5)
        }
        if (!normalize) expect(result.colour?.matrix).toBe(matrix)
      } finally { await browser.close() }
    })
}
