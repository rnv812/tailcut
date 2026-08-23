import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { SessionStore, selectMaterial, summarize } from '../../src/bridge/session-store'
import { muxFragmentedMp4 } from '../../src/core/mux'

/**
 * The whole path for a page that delivers its picture in WebM as well as its sound.
 *
 * This is what YouTube serves whenever AV1 is not on offer: video/webm; codecs="vp09…" beside
 * audio/webm; codecs="opus", two SourceBuffers and no mp4 anywhere. Which codec the site picks is
 * not the user's choice, so a clip cut from such a page has to come out whole.
 *
 * Everything under here is covered piece by piece elsewhere. What is checked here is the join, and
 * two things that only a decoder can answer: that the file reads through without a word of
 * complaint, and that seeking into it lands on the frame that belongs there — which is the sync
 * sample information, and nothing a frame count would ever notice.
 */

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/** Picture in WebM: VP9, 256x144, ten frames a second, three segments of two seconds. */
const videoInit = load('webm/init-stream0.webm')
const videoSegments = [1, 2, 3].map((n) => load(`webm/chunk-stream0-0000${n}.webm`))

/** Sound in WebM: stereo Opus at 48 kHz, four segments running to 6.001 seconds. */
const audioInit = load('webm/init-stream1.webm')
const audioSegments = [1, 2, 3, 4].map((n) => load(`webm/chunk-stream1-0000${n}.webm`))

/** 60 frames of picture at 10 a second, 300 packets of sound of 20 ms each. */
const VIDEO_FRAMES = 60
const AUDIO_PACKETS = 300

/** The frame size the fixture is coded at. */
const WIDTH = 256
const HEIGHT = 144

/**
 * The type the picture buffer is opened with. Everything a vp09 sample entry states comes out of
 * this string: Matroska carries none of it — see src/core/vp9/codec.ts.
 */
const VIDEO_TYPE = 'video/webm; codecs="vp09.00.10.08"'
const AUDIO_TYPE = 'audio/webm; codecs="opus"'

const page = {
  sourceId: 's1',
  url: 'https://site.example/watch?v=abc',
  title: 'Clip',
  now: 1000,
}

const audioBuffer = { ...page, bufferId: 'b2', mime: AUDIO_TYPE }

/** A session fed the way a player feeds one: both inits, then the segments in step. */
function recordedSession(videoType = VIDEO_TYPE): SessionStore {
  const videoBuffer = { ...page, bufferId: 'b1', mime: videoType }

  const store = new SessionStore()
  store.append({ ...videoBuffer, bytes: videoInit })
  store.append({ ...audioBuffer, bytes: audioInit })

  for (let i = 0; i < 4; i++) {
    const video = videoSegments[i]
    const audio = audioSegments[i]
    if (video) store.append({ ...videoBuffer, bytes: video })
    if (audio) store.append({ ...audioBuffer, bytes: audio })
  }

  return store
}

/** Writes the saved file out where ffmpeg can be pointed at it. */
function savedFile(videoType = VIDEO_TYPE, name = 'webm-picture.mp4'): string {
  const store = recordedSession(videoType)
  const bytes = muxFragmentedMp4(selectMaterial(store.list()[0]!))

  mkdirSync('tests/tmp', { recursive: true })
  const file = `tests/tmp/${name}`
  writeFileSync(file, bytes)
  return file
}

interface Probed {
  format: { duration: string }
  streams: Array<{
    codec_type: string
    codec_name: string
    nb_read_frames: string
    width?: number
    height?: number
    pix_fmt?: string
  }>
}

/**
 * -count_frames drives ffprobe through every frame instead of the headers alone: a track laid out
 * wrongly inside mdat leaves the boxes intact and shows up only when the frames are read — as
 * complaints in stderr, with the exit code still zero. The empty stderr is part of the check.
 */
function probe(file: string): Probed {
  const probed = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-count_frames',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,nb_read_frames,width,height,pix_fmt',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )

  expect(probed.error).toBeUndefined()
  expect(probed.status, probed.stderr).toBe(0)
  expect(probed.stderr, 'ffprobe complains about reading the file').toBe('')

  return JSON.parse(probed.stdout) as Probed
}

/** Decodes every frame of every stream and throws the result away: what is wanted is the stderr. */
function decode(file: string): void {
  const run = spawnSync('ffmpeg', ['-v', 'warning', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8',
  })

  expect(run.error).toBeUndefined()
  expect(run.status, run.stderr).toBe(0)
  expect(run.stderr, 'decoding the file produces warnings').toBe('')
}

/** One frame of the picture as raw RGB, decoded however the arguments say. */
function oneFrame(args: string[], what: string): Buffer {
  const run = spawnSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })

  expect(run.error).toBeUndefined()
  expect(run.status, `${what}: ${run.stderr.toString()}`).toBe(0)

  return run.stdout
}

/**
 * The frame at `at` seconds, reached by seeking — through the sync sample information of the
 * container and nothing else.
 */
function bySeeking(file: string, at: number): Buffer {
  return oneFrame(
    ['-v', 'error', '-ss', String(at), '-i', file,
     '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    `seeking to ${at}s`,
  )
}

/** The same frame, reached by decoding from the first frame of the file and counting forward. */
function byPlaying(file: string, at: number): Buffer {
  return oneFrame(
    ['-v', 'error', '-i', file, '-vf', `select='gte(t\\,${at})'`, '-vsync', '0',
     '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    `playing up to ${at}s`,
  )
}

describe('a clip whose picture and sound both came in WebM', () => {
  it('adds up to one session the popup can offer', () => {
    const session = recordedSession().list()[0]!
    const { duration, runs } = summarize(session)

    expect(session.tracks.map((t) => t.kinds)).toEqual([['video'], ['audio']])
    // The picture opens fourteen milliseconds in and the sound at zero; what can be cut is where
    // the two overlap.
    expect(duration).toBeCloseTo(5.987, 6)
    expect(runs).toBe(1)
  })

  it('gives ffprobe a file of two streams, picture and sound, decoding without complaint', () => {
    const probed = probe(savedFile())

    expect(probed.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
      ['video', 'vp9'],
      ['audio', 'opus'],
    ])
    expect(probed.streams.map((s) => Number(s.nb_read_frames))).toEqual([
      VIDEO_FRAMES,
      AUDIO_PACKETS,
    ])
    expect([probed.streams[0]!.width, probed.streams[0]!.height]).toEqual([WIDTH, HEIGHT])

    const seconds = Number(probed.format.duration)
    expect(seconds).toBeGreaterThan(5.9)
    expect(seconds).toBeLessThan(6.1)
  })

  it('decodes end to end without a single warning', () => {
    decode(savedFile())
  })

  it('can be seeked into, and lands on the frame that belongs there', () => {
    const file = savedFile()

    // Each of these sits inside a group of pictures — the material has a keyframe every two
    // seconds — so a seek to one of them is answered by the sample flags of the trun and by
    // nothing else. Mark every frame as a keyframe and the seek starts mid-prediction and shows a
    // smear; mark none and it finds nowhere to start and shows nothing. Both leave a file that
    // still decodes end to end, which is why the check has to be a seek.
    for (const at of [1, 3, 5]) {
      const seeked = bySeeking(file, at)
      const played = byPlaying(file, at)

      expect(played.byteLength, `nothing decodes at ${at}s at all`).toBe(WIDTH * HEIGHT * 3)
      expect(seeked.byteLength, `seeking to ${at}s found no frame to start from`).toBe(
        played.byteLength,
      )
      expect(
        seeked.equals(played),
        `the frame at ${at}s comes out differently when seeked to than when played up to`,
      ).toBe(true)
    }
  })

  it('is written just as well from the bare codec name a legacy page declares', () => {
    // video/webm; codecs="vp9" names profile 0 and nothing else, and profile 0 fixes the bit
    // depth and the subsampling on its own. A site that declares its stream that way is not
    // giving less information, only fewer words for it.
    const file = savedFile('video/webm; codecs="vp9"', 'webm-picture-legacy.mp4')
    const probed = probe(file)

    expect(probed.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
      ['video', 'vp9'],
      ['audio', 'opus'],
    ])
    expect(Number(probed.streams[0]!.nb_read_frames)).toBe(VIDEO_FRAMES)
    decode(file)
  })

  it('opens no track at all when the page never said what its picture is', () => {
    // The refusal is the whole point of describing the track at ingest: a buffer with no track
    // drops its segments where they can be seen to have been dropped, and the popup offers
    // nothing rather than offering a clip with a picture stream that decodes to nothing.
    const store = new SessionStore()
    store.append({ ...page, bufferId: 'b1', bytes: videoInit })
    for (const bytes of videoSegments) store.append({ ...page, bufferId: 'b1', bytes })

    expect(store.list()).toEqual([])
  })
})
