import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { conversionNeeded } from '../../src/core/export/compatible'
import { saveAllMp4 } from '../../src/core/export/save'
import { movieTracksOf } from '../../src/core/export/source'
import { exportTrack as track } from '../support/export-fixture'
import { decodeFile, launchWithExtension, openExtensionPage, probeFile, frameTimes } from './helpers'

for (const [name, tracks, codecs] of [
  ['vp9-opus', [track('webm', 0, 'webm'), track('webm', 1, 'webm')], ['h264', 'aac']],
  ['h264-opus', [track('h264', 0), track('webm', 1, 'webm')], ['h264', 'aac']],
  ['vp9-aac', [track('webm', 0, 'webm'), track('h264', 1)], ['h264', 'aac']],
  ['av1', [track('av1', 0)], ['h264']],
  ['vp8-vorbis', [track('webm-vp8', 0, 'webm'), track('webm-vp8', 1, 'webm')], ['h264', 'aac']],
] as const) {
  test(`exports ${name} with codecs Premiere can import`, async () => {
    test.setTimeout(60_000)
    const original = saveAllMp4(tracks)
    const { context, extensionId } = await launchWithExtension()
    try {
      const page = await openExtensionPage(context, extensionId, 'options/options.html')
      page.on('console', (message) => console.log(message.type(), message.text().slice(0, 1000)))
      page.on('pageerror', (error) => console.log('page error', error.message))
      const result = await page.evaluate(async ({ bytes, needed }) => {
        const url = chrome.runtime.getURL('shared/convert-mp4.js')
        const { convertMp4 } = await import(url)
        const started = performance.now()
        const file = await convertMp4(new Uint8Array(bytes), needed, () => false)
        return { bytes: Array.from(file as Uint8Array), ms: performance.now() - started }
      }, { bytes: Array.from(original), needed: conversionNeeded(original) })
      const path = test.info().outputPath(`${name}.mp4`)
      writeFileSync(path, new Uint8Array(result.bytes))
      const probe = probeFile(path)
      expect(probe.streams.map((s) => s.codec_name)).toEqual(codecs)
      expect(Number(probe.format.duration)).toBeCloseTo(6, 0)
      expect(frameTimes(path, 'v')[0]).toBeCloseTo(0, 2)
      decodeFile(path)
      if (name === 'h264-opus' || name === 'vp9-aac') {
        const kind = name === 'h264-opus' ? 'video' : 'audio'
        const packets = (file: Uint8Array) => movieTracksOf(file, file.length)
          .find((track) => track.kind === kind)!.samples
          .map(({ source }) => file.slice(source.at, source.at + source.length))
        expect(packets(new Uint8Array(result.bytes))).toEqual(packets(original))
      }
      console.log(`${name}: ${original.length} -> ${result.bytes.length} bytes in ${Math.round(result.ms)} ms`)
    } finally {
      await context.close()
    }
  })
}

test('keeps audio aligned when converting Opus to AAC', async () => {
  const source = test.info().outputPath('sync-source.mp4')
  const saved = test.info().outputPath('sync-saved.mp4')
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=20:duration=2',
    '-itsoffset', '0.2', '-f', 'lavfi', '-i',
    'aevalsrc=0.3*sin(2*PI*(220*t+100*t*t)):s=48000:d=1.6',
    '-c:v', 'libx264', '-c:a', 'libopus', source,
  ])
  const bytes = new Uint8Array(readFileSync(source))
  const { context, extensionId } = await launchWithExtension()
  try {
    const page = await openExtensionPage(context, extensionId, 'options/options.html')
    const result = await page.evaluate(async (bytes) => {
      const { convertMp4 } = await import(chrome.runtime.getURL('shared/convert-mp4.js'))
      return Array.from(await convertMp4(new Uint8Array(bytes), { video: false, audio: true }, () => false))
    }, Array.from(bytes))
    writeFileSync(saved, new Uint8Array(result as number[]))
    const samples = (file: string) => {
      const bytes = execFileSync('ffmpeg', [
        '-v', 'error', '-i', file, '-vn', '-af', 'aresample=async=1:first_pts=0',
        '-ar', '8000', '-ac', '1', '-f', 'f32le', '-',
      ])
      return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
    }
    const before = samples(source)
    const after = samples(saved)
    let xy = 0, xx = 0, yy = 0
    for (let i = 4000; i < 12000; i++) {
      xy += before[i]! * after[i]!
      xx += before[i]! ** 2
      yy += after[i]! ** 2
    }
    const correlation = xy / Math.sqrt(xx * yy)
    expect(correlation, 'audio moved relative to the video').toBeGreaterThan(0.98)
    console.log(`audio correlation at the original timestamps: ${correlation.toFixed(5)}`)
  } finally {
    await context.close()
  }
})
