import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { assembleMp4 } from '../../src/core/export/assemble'
import { planPreview } from '../../src/core/export/plan'
import { ByteMap, clipSourceOf, sourceTrackOf } from '../../src/core/export/source'
import { framesOf } from '../../src/core/timeline/frames'
import { decodeWarnings, probeFile, writeTemp } from '../support/media'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

const INIT = read('tests/fixtures/h264/init-stream0.m4s')
const TRACK_ID = 1
const TIMESCALE = 12_288

/**
 * The recording of a re-watch: the middle chunk arrived twice.
 *
 * Nothing about it is exotic. The map keeps any two chunks whose starts differ by a millisecond
 * or more (`SAME_CHUNK_TOLERANCE_SECONDS` in `core/timeline/map.ts`), and a second pass over the
 * same stretch of a video comes back with boundaries a few frames off, so both copies stay on the
 * map and both are handed to whoever indexes the material.
 *
 * The picture alone: it is where the divergence was measured, and it is the track a decoder has
 * anything to lose over. The sound of the same recording overlaps by the same rule and is read by
 * the same call.
 */
const ORDER = [1, 2, 2, 3]
const SEGMENTS = ORDER.map((n) => read(`tests/fixtures/h264/chunk-stream0-0000${n}.m4s`))
/** Four segments of forty-eight frames arrive; the overlap makes forty-eight of them a repeat. */
const ARRIVED = 192
const DISTINCT = 144

function placed() {
  const map = new ByteMap()
  const segments = SEGMENTS.map((bytes) => ({ bytes, at: map.place(bytes) }))
  return { map, segments }
}

describe('a recording that overlaps itself', () => {
  it('is the same run of samples whichever reader walks it', () => {
    // The defect this set is here for: two walks over one recording that disagreed about what is
    // in it. The frame table dropped the repeats and the export index kept them, so the editor
    // showed six seconds and wrote eight — and the eight were unplayable, because the same coded
    // frames appear twice in one decode timeline and a H.264 decoder loses its reference state.
    const { segments } = placed()

    const track = sourceTrackOf({ kind: 'video', initBytes: INIT, segments })!
    const frames = framesOf({
      init: INIT,
      trackId: TRACK_ID,
      timescale: TIMESCALE,
      segments: segments.map((segment) => ({ bytes: segment.bytes, source: segment.at })),
    })

    expect(new Set(track.samples.map((sample) => sample.dts)).size).toBe(DISTINCT)
    expect(track.samples).toHaveLength(DISTINCT)
    expect(frames).toHaveLength(DISTINCT)
    expect(frames).toHaveLength(track.samples.length)

    // And they agree in seconds as well as in count: six of them, which is what the recording is.
    const last = frames[frames.length - 1]!
    expect(last.pts + last.duration).toBeCloseTo(DISTINCT / 24, 6)
  })

  it('keeps the copy that came first and says how many it dropped', () => {
    // Dropped whole and not merged, and the first in run order is the one that stays: of two
    // copies of a frame either would decode, but a rule that picks by anything other than arrival
    // order picks differently on two readings of the same material.
    const { segments } = placed()
    const track = sourceTrackOf({ kind: 'video', initBytes: INIT, segments })!
    const repeat = segments[2]!.at

    expect(track.dropped).toBe(ARRIVED - DISTINCT)
    const inside = track.samples.filter(
      (sample) => sample.source.at >= repeat.at && sample.source.at < repeat.at + repeat.length,
    )
    expect(inside, 'a sample was taken out of the second copy of the chunk').toEqual([])
  })

  it('writes a file the decoder reads to the end', () => {
    // The measurement that named the defect: written as it arrived, the clip made ffmpeg report
    // "illegal short term buffer state detected" and "mmco: unref short failure" and decode 180
    // of the 192 frames it was handed. The file and the editor have to agree, and the file is the
    // one that has to be right.
    const { map, segments } = placed()
    const source = clipSourceOf([{ kind: 'video', initBytes: INIT, segments }])!
    const plan = planPreview(source)

    expect(plan.tracks[0]!.samples).toHaveLength(DISTINCT)
    // Six seconds of material, which is what the preview says and what the plan has to say too.
    expect(plan.duration).toBeCloseTo(DISTINCT / 24, 6)

    const file = writeTemp('overlap-rewatch.mp4', assembleMp4(plan, (at) => map.bytesOf(at)))
    const probed = probeFile(file)

    expect(probed.status, probed.stderr).toBe(0)
    expect(probed.stderr, 'the reader complained about the file').toBe('')
    expect(Number(probed.probed!.streams[0]!.nb_read_frames)).toBe(DISTINCT)
    expect(decodeWarnings(file), 'the decoder complained while decoding the file').toBe('')
  })
})
