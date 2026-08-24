import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { playInBrowser } from './helpers'
import {
  buildProgressiveMp4,
  type OutSample,
  type ProgressiveTrack,
} from '../../src/core/iso/progressive'
import { editOffset, samplesInSegment, trackDefaults } from '../../src/core/iso/samples'
import { sampleEntryBytes, videoSampleEntry } from '../../src/core/iso/entry'
import { parseInit } from '../../src/core/iso/init'
import { planClip } from '../../src/core/export/plan'
import { assembleMp4 } from '../../src/core/export/assemble'
import { ByteMap, clipSourceOf } from '../../src/core/export/source'
import type { TrackKind } from '../../src/shared/types'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/** The same taking-apart the unit test does, kept here so the spec runs on its own. */
function trackOf(
  initPath: string,
  segmentPaths: string[],
  kind: TrackKind,
  trackId: number,
): ProgressiveTrack {
  const init = read(initPath)
  const defaults = trackDefaults(init)
  const declared = parseInit(init)!.tracks.find((t) => t.kind === kind)!
  const entry = kind === 'video' ? videoSampleEntry(init) : null
  const samples: OutSample[] = []

  for (const path of segmentPaths) {
    const segment = read(path)
    for (const track of samplesInSegment(segment, defaults)) {
      for (const sample of track.samples) {
        samples.push({
          bytes: segment.subarray(sample.at, sample.at + sample.size),
          duration: sample.duration,
          cts: sample.pts - sample.dts,
          sync: sample.sync,
        })
      }
    }
  }

  return {
    trackId,
    kind,
    timescale: declared.timescale,
    sampleEntry: sampleEntryBytes(init, declared.trackId)!,
    width: entry?.codedWidth ?? 0,
    height: entry?.codedHeight ?? 0,
    samples,
    skipTicks: editOffset(init, declared.trackId),
  }
}

function onDisk(name: string, bytes: Uint8Array): string {
  mkdirSync('tests/tmp', { recursive: true })
  const file = `tests/tmp/${name}`
  writeFileSync(file, bytes)
  return file
}

const video = trackOf(
  'tests/fixtures/h264/init-stream0.m4s',
  [1, 2, 3].map((n) => `tests/fixtures/h264/chunk-stream0-0000${n}.m4s`),
  'video',
  1,
)
const audio = trackOf(
  'tests/fixtures/h264/init-stream1.m4s',
  [1, 2, 3, 4].map((n) => `tests/fixtures/h264/chunk-stream1-0000${n}.m4s`),
  'audio',
  2,
)

test('a progressive file plays through in a browser, picture and sound', async () => {
  const file = onDisk('e2e-progressive.mp4', buildProgressiveMp4([video, audio]))
  const played = await playInBrowser(file)

  expect(played.error, 'the browser refused the file').toBeNull()
  expect(played.ended, 'playback did not reach the end').toBe(true)
  expect(played.duration).toBeCloseTo(6, 1)
  expect(played.reached).toBeGreaterThan(5.5)
  expect([played.frameWidth, played.frameHeight]).toEqual([320, 240])
  // A canvas of one colour is a file that opened and showed nothing: the tables addressed the
  // mdat wrongly, and ffmpeg would have recovered the frames anyway.
  expect(played.frameColours, 'the picture came out blank').toBeGreaterThan(1)
  expect(played.frameError).toBeNull()
  expect(played.audioTracks, 'the browser found no sound in the file').toBe(1)
  expect(played.videoBytes).toBeGreaterThan(0)
  expect(played.audioBytes).toBeGreaterThan(0)
})

test('a progressive file entered part-way in plays from the frame the edit list points at', async () => {
  // Three frames hidden by the elst: the browser has to start at the fourth and run 5.875 s.
  const file = onDisk(
    'e2e-progressive-skip.mp4',
    buildProgressiveMp4([{ ...video, skipTicks: 1024 + 3 * 512 }]),
  )
  const played = await playInBrowser(file)

  expect(played.error).toBeNull()
  expect(played.ended).toBe(true)
  expect(played.duration).toBeCloseTo(5.875, 2)
  expect(played.frameColours).toBeGreaterThan(1)
})

/** The three experiment clips, cut out of the same fixture the unit tests cut. */
function material(): { source: ReturnType<typeof clipSourceOf>; map: ByteMap } {
  const map = new ByteMap()
  const inputOf = (kind: 'video' | 'audio', initPath: string, paths: string[]) => ({
    kind,
    initBytes: read(initPath),
    segments: paths.map((path) => {
      const bytes = read(path)
      return { bytes, at: map.place(bytes) }
    }),
  })

  const source = clipSourceOf([
    inputOf(
      'video',
      'tests/fixtures/h264/init-stream0.m4s',
      [1, 2, 3].map((n) => `tests/fixtures/h264/chunk-stream0-0000${n}.m4s`),
    ),
    inputOf(
      'audio',
      'tests/fixtures/h264/init-stream1.m4s',
      [1, 2, 3, 4].map((n) => `tests/fixtures/h264/chunk-stream1-0000${n}.m4s`),
    ),
  ])

  return { source, map }
}

test('a clip cut out of the middle plays in a browser from the frame it was cut at', async () => {
  const { source, map } = material()
  const file = onDisk(
    'e2e-clip-middle.mp4',
    assembleMp4(planClip(source!, { in: 30 / 24, out: 100 / 24, sound: true }), (at) =>
      map.bytesOf(at),
    ),
  )
  const played = await playInBrowser(file)

  expect(played.error).toBeNull()
  expect(played.ended).toBe(true)
  // 71 frames: the 70 asked for and the one reordered frame the container cannot hide (§8.2).
  expect(played.duration).toBeCloseTo(71 / 24, 2)
  expect(played.reached).toBeGreaterThan(70 / 24)
  expect(played.frameColours).toBeGreaterThan(1)
  expect(played.audioTracks).toBe(1)
  expect(played.audioBytes).toBeGreaterThan(0)
})

test('a clip across a collapsed hole plays straight through', async () => {
  // The middle segment of both tracks is missing and the two holes are not the same length. If
  // the collapse were wrong the browser would either stall on a frame for two seconds or run the
  // sound away from the picture; what it must do is play six seconds of material in four.
  const map = new ByteMap()
  const inputOf = (kind: 'video' | 'audio', initPath: string, paths: string[]) => ({
    kind,
    initBytes: read(initPath),
    segments: paths.map((path) => {
      const bytes = read(path)
      return { bytes, at: map.place(bytes) }
    }),
  })

  const source = clipSourceOf([
    inputOf('video', 'tests/fixtures/h264/init-stream0.m4s', [
      'tests/fixtures/h264/chunk-stream0-00001.m4s',
      'tests/fixtures/h264/chunk-stream0-00003.m4s',
    ]),
    inputOf('audio', 'tests/fixtures/h264/init-stream1.m4s', [
      'tests/fixtures/h264/chunk-stream1-00001.m4s',
      'tests/fixtures/h264/chunk-stream1-00003.m4s',
      'tests/fixtures/h264/chunk-stream1-00004.m4s',
    ]),
  ])!

  const file = onDisk(
    'e2e-clip-gap.mp4',
    assembleMp4(planClip(source, { in: 0, out: 6, sound: true }), (at) => map.bytesOf(at)),
  )
  const played = await playInBrowser(file)

  expect(played.error).toBeNull()
  expect(played.ended).toBe(true)
  expect(played.duration).toBeCloseTo(4, 1)
  expect(played.frameColours).toBeGreaterThan(1)
  expect(played.audioBytes).toBeGreaterThan(0)
})
