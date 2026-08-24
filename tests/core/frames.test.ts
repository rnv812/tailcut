import { describe, it, expect } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { concatBytes } from '../../src/core/iso/writer'
import { FrameTable, framesOf, retimeToPlan, type Frame } from '../../src/core/timeline/frames'
import { parseInit as parseWebmInit } from '../../src/core/webm/init'
import { webmToIso } from '../../src/core/webm/to-iso'
import type { Located } from '../../src/shared/types'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/** Video of the fixture: 320×240, 24 fps, timescale 12288, three segments of 48 frames. */
const INIT = read('h264/init-stream0.m4s')
const SEGMENTS = [1, 2, 3].map((n) => read(`h264/chunk-stream0-0000${n}.m4s`))
const TIMESCALE = 12_288
/** Every init the fixtures hold numbers its one track 1, the converted WebM ones included. */
const TRACK_ID = 1
/** The elst of the fixture: 1024 ticks of B-frame delay the player takes back off every time. */
const EDIT_TICKS = 1_024

/**
 * The sound of the same recording: AAC at 44100, 259 packets of 1024 ticks and a last one of 408
 * where the recording stops mid-packet.
 */
const AAC_INIT = read('h264/init-stream1.m4s')
const AAC_SEGMENTS = [1, 2, 3, 4].map((n) => read(`h264/chunk-stream1-0000${n}.m4s`))
const AAC_TIMESCALE = 44_100

/**
 * The sound of the WebM fixture, converted to ISO the way the capture converts it: Opus at 48000,
 * 300 packets, the first of them 21 ms long and the other 299 of the 20 ms Opus is written in.
 *
 * The odd packet is the long one here and the short one on the AAC track above, and the picture of
 * every fixture in the repository runs at one length throughout — so these two tracks together are
 * the only material that says which end of the sort `fps` reads.
 */
const OPUS = webmToIso(parseWebmInit(read('webm/init-stream1.webm'))!)!
const OPUS_SEGMENTS = [1, 2, 3, 4].map(
  (n) => OPUS.segment(read(`webm/chunk-stream1-0000${n}.webm`))!.bytes,
)
const OPUS_TIMESCALE = 48_000

/** Where the bytes of the segments would sit in a snapshot; the table carries the places through. */
function placed(segments: Uint8Array[]): Array<{ bytes: Uint8Array; source: Located }> {
  let at = 1_000
  return segments.map((bytes) => {
    const source: Located = { at, length: bytes.byteLength }
    at += bytes.byteLength
    return { bytes, source }
  })
}

const tableOf = (init: Uint8Array, timescale: number, segments: Uint8Array[]) =>
  FrameTable.of(framesOf({ init, trackId: TRACK_ID, timescale, segments: placed(segments) }))

const table = (segments: Uint8Array[]) => tableOf(INIT, TIMESCALE, segments)

/**
 * The material as the capture saved it — the init and the segments end to end — written out so
 * that ffprobe can be asked what a reader makes of it.
 *
 * Deliberately not a file this plan's writer produced: what is under test here is that the table
 * agrees with the container the frames arrived in, and a reference built by the code under test
 * would agree with itself.
 */
function sourceFile(name: string, segments: Uint8Array[]): string {
  mkdirSync('tests/tmp', { recursive: true })
  const file = `tests/tmp/${name}`
  writeFileSync(file, concatBytes([INIT, ...segments]))
  return file
}

/**
 * Presentation time and sync flag of every packet of the picture, straight out of the container.
 *
 * Packets and not frames: ffprobe hands back a time for every packet and occasionally none for a
 * decoded frame, and what is under test here is exactly what the container says.
 */
function packets(file: string): Array<{ pts: number; sync: boolean }> {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  )

  expect(probe.error).toBeUndefined()
  expect(probe.status, probe.stderr).toBe(0)

  return probe.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pts, flags] = line.split(',')
      return { pts: Number(pts), sync: (flags ?? '').includes('K') }
    })
    .sort((a, b) => a.pts - b.pts)
}

describe('framesOf', () => {
  it('puts every frame where the container holds it', () => {
    const frames = framesOf({
      init: INIT,
      trackId: TRACK_ID,
      timescale: TIMESCALE,
      segments: placed(SEGMENTS),
    })
    const fromFile = packets(sourceFile('frames-whole.mp4', SEGMENTS))

    expect(frames).toHaveLength(144)
    expect(fromFile).toHaveLength(144)

    for (const [at, frame] of frames.entries()) {
      expect(frame.pts, `frame ${at}: time on the session clock`).toBeCloseTo(fromFile[at]!.pts, 6)
      expect(frame.sync, `frame ${at}: sync flag`).toBe(fromFile[at]!.sync)
      // Until a plan says otherwise the two clocks are the same clock: nothing has been collapsed
      // and nothing hidden.
      expect(frame.out).toBe(frame.pts)
    }
  })

  it('subtracts the edit list: without it the table sits a B-frame delay away', () => {
    const frames = framesOf({
      init: INIT,
      trackId: TRACK_ID,
      timescale: TIMESCALE,
      segments: placed(SEGMENTS),
    })

    // The raw pts of the first frame is exactly media_time, so subtracting it has to give zero.
    expect(frames[0]!.pts).toBeCloseTo(0, 9)
    expect(EDIT_TICKS / TIMESCALE).toBeCloseTo(2 / 24, 9)
  })

  it('keeps the session clock of a run that does not start the recording', () => {
    const tail = SEGMENTS.slice(1)
    const frames = framesOf({
      init: INIT,
      trackId: TRACK_ID,
      timescale: TIMESCALE,
      segments: placed(tail),
    })
    const fromFile = packets(sourceFile('frames-tail.mp4', tail))

    expect(frames).toHaveLength(96)
    expect(frames[0]!.pts, 'the frame stayed where the recording put it').toBeCloseTo(2, 6)

    for (const [at, frame] of frames.entries()) {
      expect(frame.pts, `frame ${at}`).toBeCloseTo(fromFile[at]!.pts, 6)
    }
  })

  it('takes the frame lengths from the defaults instead of inventing them', () => {
    for (const frame of table(SEGMENTS).frames()) expect(frame.duration).toBeCloseTo(1 / 24, 9)
  })

  it('has every frame remember where its bytes are in the snapshot', () => {
    const source = placed(SEGMENTS)
    const frames = framesOf({ init: INIT, trackId: TRACK_ID, timescale: TIMESCALE, segments: source })

    const first = source[0]!.source
    expect(frames[0]!.source.at).toBeGreaterThanOrEqual(first.at)
    expect(frames[0]!.source.at + frames[0]!.source.length).toBeLessThanOrEqual(first.at + first.length)

    const last = source[2]!.source
    const tail = frames[143]!.source
    expect(tail.at + tail.length).toBeLessThanOrEqual(last.at + last.length)
    expect(frames.every((frame) => frame.source.length > 0)).toBe(true)
  })

  it('does not double the frames a re-watch brought back', () => {
    const twice = framesOf({
      init: INIT,
      trackId: TRACK_ID,
      timescale: TIMESCALE,
      segments: placed([SEGMENTS[0]!, SEGMENTS[0]!]),
    })
    expect(twice).toHaveLength(48)
  })

  it('skips a track of the segment that is not the one asked for', () => {
    const frames = framesOf({
      init: INIT,
      trackId: 99,
      timescale: TIMESCALE,
      segments: placed(SEGMENTS),
    })
    expect(frames).toEqual([])
  })

  it('answers a zero timescale with an empty table rather than times of NaN', () => {
    const frames = framesOf({
      init: INIT,
      trackId: TRACK_ID,
      timescale: 0,
      segments: placed(SEGMENTS),
    })
    expect(frames).toEqual([])
  })
})

describe('FrameTable', () => {
  const whole = table(SEGMENTS)

  it('counts the frames', () => {
    expect(whole.count()).toBe(144)
  })

  it('finds the frame shown at a moment', () => {
    expect(whole.indexAt(-1)).toBe(-1)
    expect(whole.indexAt(0)).toBe(0)
    // Inside a frame it is that frame; exactly on the boundary it is already the next one.
    expect(whole.indexAt(1 / 24 - 1e-6)).toBe(0)
    expect(whole.indexAt(1 / 24)).toBe(1)
    expect(whole.indexAt(1)).toBe(24)
    expect(whole.indexAt(1_000)).toBe(143)
  })

  it('finds the nearest sync sample at or before a frame', () => {
    // A keyframe every 24 frames: that is how the fixture was made.
    expect(whole.syncBefore(0)).toBe(0)
    expect(whole.syncBefore(23)).toBe(0)
    expect(whole.syncBefore(24)).toBe(24)
    expect(whole.syncBefore(47)).toBe(24)
    expect(whole.syncBefore(1_000)).toBe(120)
  })

  it('lists the times of the keyframes', () => {
    expect([...whole.keyframeTimes()]).toHaveLength(6)
    expect(whole.keyframeTimes()[0]).toBeCloseTo(0, 9)
    expect(whole.keyframeTimes()[1]).toBeCloseTo(1, 9)
  })

  it('lists the keyframes on the session clock and not on the clock of the file', () => {
    // These are the times an entry point is chosen from, and the choice is made against a request
    // the editor states in seconds of the session — the same seconds `planClip` takes. Here the
    // preview enters two seconds into the recording: the two keyframes of the segment stand at 2
    // and 3 on that clock and at 0 and 1 in the file, so a table answering with the file's clock
    // hands the cut a key frame two seconds away from the one the user pointed at. On a table
    // where the two clocks coincide — every other one in this file — the mistake is invisible.
    const rows = table([SEGMENTS[1]!]).frames()
    const shifted = FrameTable.of(
      retimeToPlan(rows, {
        timescale: TIMESCALE,
        skipTicks: 0,
        samples: rows.map((frame) => ({ source: frame.source, duration: 512, cts: 0 })),
      }),
    )

    expect([...shifted.keyframeTimes()]).toEqual([2, 3])
    // The same two frames on the clock this question is not asked in.
    expect(shifted.frames().filter((frame) => frame.sync).map((frame) => frame.out)).toEqual([0, 1])
  })

  it('asks for the middle of a frame and not for its boundary', () => {
    // This is the whole difference between missing backwards every time and never missing.
    for (const at of [0, 1, 40, 143]) {
      const frame = whole.at(at)!
      expect(whole.seekTimeOf(at)).toBeCloseTo(frame.out + frame.duration / 2, 9)
      expect(whole.seekTimeOf(at)).toBeGreaterThan(frame.out)
      expect(whole.seekTimeOf(at)).toBeLessThan(frame.out + frame.duration)
    }
  })

  it('asks on the clock of the file and not on the clock of the session', () => {
    // The two clocks part company wherever an export plan closed a hole or hid a head, and this
    // number is a currentTime of the preview — a file that plan wrote. Here the clip enters two
    // seconds into the recording: every frame lies two seconds earlier in the file than the
    // session says, and asked for on the session clock the last of them is past the end of it.
    const rows = table([SEGMENTS[1]!, SEGMENTS[2]!]).frames()
    const shifted = FrameTable.of(
      retimeToPlan(rows, {
        timescale: TIMESCALE,
        skipTicks: 0,
        samples: rows.map((frame) => ({ source: frame.source, duration: 512, cts: 0 })),
      }),
    )

    const first = shifted.at(0)!
    expect(first.out).toBe(0)
    expect(first.pts).toBeCloseTo(2, 9)
    expect(shifted.seekTimeOf(0)).toBeCloseTo(first.duration / 2, 9)

    const end = shifted.count() - 1
    const last = shifted.at(end)!
    const fileEnds = last.out + last.duration
    expect(last.pts - last.out).toBeCloseTo(2, 9)
    expect(shifted.seekTimeOf(end)).toBeGreaterThan(last.out)
    expect(shifted.seekTimeOf(end)).toBeLessThan(fileEnds)
    // The same frame on the session clock is asked for two seconds past the end of the file,
    // where the player clamps to the end and shows a frame nobody asked for.
    expect(last.pts).toBeGreaterThan(fileEnds)
  })

  it('pulls an index off the end back onto the material instead of giving NaN', () => {
    expect(whole.seekTimeOf(-5)).toBeCloseTo(whole.seekTimeOf(0), 9)
    expect(whole.seekTimeOf(9_999)).toBeCloseTo(whole.seekTimeOf(143), 9)
  })

  it('answers every question on an empty table without falling over', () => {
    const empty = FrameTable.of([])
    expect(empty.count()).toBe(0)
    expect(empty.at(0)).toBeUndefined()
    expect(empty.indexAt(5)).toBe(-1)
    expect(empty.indexAtOut(5)).toBe(-1)
    expect(empty.syncBefore(0)).toBe(-1)
    expect(empty.seekTimeOf(0)).toBe(0)
    expect(empty.fps()).toBe(0)
  })

  it('takes the rate from the median frame length', () => {
    expect(whole.fps()).toBeCloseTo(24, 6)
  })

  it('takes the median and not the odd packet at either end of the sort', () => {
    // The picture of the fixture is 144 frames of one length, where the median, the longest and
    // the shortest are the same number and the rate above measures nothing. Both sound tracks
    // carry the odd packet the median is there to see past, and they carry it at opposite ends:
    // Opus has one of 21 ms among 299 of 20, AAC one of 9.25 ms among 259 of 23.2. Read off the
    // longest packet the Opus track answers 47.6 instead of 50 — five percent out on one packet
    // in three hundred — and read off the shortest the AAC track answers 108 instead of 43.
    const opus = tableOf(OPUS.initBytes, OPUS_TIMESCALE, OPUS_SEGMENTS)
    const aac = tableOf(AAC_INIT, AAC_TIMESCALE, AAC_SEGMENTS)
    const lengths = (rows: readonly Frame[], scale: number) =>
      [...new Set(rows.map((frame) => Math.round(frame.duration * scale)))].sort((a, b) => a - b)

    expect(opus.count()).toBe(300)
    expect(lengths(opus.frames(), OPUS_TIMESCALE)).toEqual([960, 1008])
    expect(aac.count()).toBe(260)
    expect(lengths(aac.frames(), AAC_TIMESCALE)).toEqual([408, 1024])

    expect(opus.fps()).toBeCloseTo(50, 6)
    expect(aac.fps()).toBeCloseTo(AAC_TIMESCALE / 1024, 6)
  })

  it('finds a frame by the clock of the file as well as by the clock of the session', () => {
    // The preview enters a second into the recording: on the session clock the material starts at
    // 1, in the file it starts at 0, and both questions have to be answerable.
    const shifted = FrameTable.of(
      retimeToPlan(table([SEGMENTS[1]!, SEGMENTS[2]!]).frames(), {
        timescale: TIMESCALE,
        skipTicks: 0,
        samples: table([SEGMENTS[1]!, SEGMENTS[2]!])
          .frames()
          .map((frame) => ({ source: frame.source, duration: 512, cts: 0 })),
      }),
    )

    expect(shifted.indexAtOut(0)).toBe(0)
    expect(shifted.indexAt(0), 'on the session clock there is no material at zero').toBe(-1)
    expect(shifted.indexAt(2)).toBe(0)
  })
})

describe('retimeToPlan', () => {
  const TICK = 1_000
  const rows: Frame[] = [0, 1, 2, 3].map((index) => ({
    pts: index / 25,
    out: index / 25,
    duration: 1 / 25,
    sync: index === 0,
    source: { at: index * 4, length: 4 },
  }))
  const evenly = (frames: readonly Frame[]) =>
    frames.map((frame) => ({ source: frame.source, duration: 40, cts: 0 }))

  it('gives every frame the second the planned file will show it at', () => {
    const timed = retimeToPlan(rows, { timescale: TICK, skipTicks: 0, samples: evenly(rows) })

    expect(timed.map((frame) => frame.out)).toEqual([0, 0.04, 0.08, 0.12])
    expect(timed.map((frame) => frame.pts)).toEqual(rows.map((frame) => frame.pts))
  })

  it('takes the hidden head off the file clock and leaves the session clock alone', () => {
    const timed = retimeToPlan(rows, { timescale: TICK, skipTicks: 40, samples: evenly(rows) })

    // The first frame is decoded and never shown; the second is where the presentation begins.
    expect(timed.map((frame) => frame.out)).toEqual([-0.04, 0, 0.04, 0.08])
    expect(timed[1]!.pts).toBeCloseTo(0.04, 9)
  })

  it('follows the plan across a hole the plan closed', () => {
    // Two seconds were never watched between the second frame and the third. On the session clock
    // the hole is still there — the timeline draws it — and in the file it is gone. That
    // difference is the whole reason the two clocks are separate numbers.
    const holed: Frame[] = [
      rows[0]!,
      rows[1]!,
      { ...rows[2]!, pts: 2.08, out: 2.08 },
      { ...rows[3]!, pts: 2.12, out: 2.12 },
    ]
    const timed = retimeToPlan(holed, { timescale: TICK, skipTicks: 0, samples: evenly(holed) })

    expect(timed.map((frame) => frame.out)).toEqual([0, 0.04, 0.08, 0.12])
    expect(timed.map((frame) => frame.pts)).toEqual([0, 0.04, 2.08, 2.12])
  })

  it('drops a frame the plan does not carry', () => {
    // A recording that starts mid-group: the plan enters at the first sync sample there is, and a
    // frame with no keyframe in front of it is not in the file to be stepped onto.
    const timed = retimeToPlan(rows, {
      timescale: TICK,
      skipTicks: 0,
      samples: evenly(rows.slice(2)),
    })

    expect(timed.map((frame) => frame.source.at)).toEqual([8, 12])
    expect(timed.map((frame) => frame.out)).toEqual([0, 0.04])
  })

  it('adds the composition offset the plan states', () => {
    // A uniform delay across the track is what an inherited elst compensates; the file shows every
    // frame that much later, and skipTicks is what takes it back off.
    const timed = retimeToPlan(rows.slice(0, 2), {
      timescale: TICK,
      skipTicks: 0,
      samples: rows.slice(0, 2).map((frame) => ({ source: frame.source, duration: 40, cts: 40 })),
    })

    expect(timed.map((frame) => frame.out)).toEqual([0.04, 0.08])
  })

  it('answers a plan with no timescale with nothing rather than times of NaN', () => {
    expect(retimeToPlan(rows, { timescale: 0, skipTicks: 0, samples: [] })).toEqual([])
  })
})
