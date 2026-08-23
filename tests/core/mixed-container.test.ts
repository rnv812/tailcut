import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { SessionStore, selectMaterial, summarize } from '../../src/bridge/session-store'
import { muxFragmentedMp4 } from '../../src/core/mux'
import { childBoxes, topLevelBoxes, type Box } from '../../src/core/iso/reader'

/**
 * The whole path for a page that delivers its two tracks in two different containers.
 *
 * This is the ordinary case on the web and not an exotic one: a site serves its picture as
 * fragmented mp4 and its sound as audio/webm; codecs="opus". The registry has to take both, the
 * timeline has to hold both in one scale, and what comes out has to be a single file a player
 * accepts — with sound.
 *
 * Everything under here is covered piece by piece elsewhere. What is checked here is the join:
 * that the pieces fitted together produce a file, and that the file is one ffmpeg reads through
 * to the end without a word of complaint.
 */

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/** Picture in mp4: 320x240, 24 frames a second, three segments of two seconds. */
const videoInit = load('h264/init-stream0.m4s')
const videoSegments = [1, 2, 3].map((n) => load(`h264/chunk-stream0-0000${n}.m4s`))

/** Sound in WebM: stereo Opus at 48 kHz, four segments running to 6.001 seconds. */
const audioInit = load('webm/init-stream1.webm')
const audioSegments = [1, 2, 3, 4].map((n) => load(`webm/chunk-stream1-0000${n}.webm`))

/** 144 frames of picture at 24 a second, 300 packets of sound of 20 ms each. */
const VIDEO_FRAMES = 144
const AUDIO_PACKETS = 300

const page = {
  sourceId: 's1',
  url: 'https://site.example/watch?v=abc',
  title: 'Clip',
  now: 1000,
}

const videoBuffer = { ...page, bufferId: 'b1' }
const audioBuffer = { ...page, bufferId: 'b2' }

/** A session fed the way a player feeds one: both inits, then the segments in step. */
function recordedSession(): SessionStore {
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

function savedFile(): Uint8Array {
  const store = recordedSession()
  return muxFragmentedMp4(selectMaterial(store.list()[0]!))
}

/** Writes the file out where ffmpeg can be pointed at it. */
function onDisk(name: string, bytes: Uint8Array): string {
  mkdirSync('tests/tmp', { recursive: true })
  const file = `tests/tmp/${name}`
  writeFileSync(file, bytes)
  return file
}

interface Probed {
  format: { duration: string }
  streams: Array<{ codec_type: string; codec_name: string; nb_read_frames: string }>
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
      '-show_entries', 'format=duration:stream=codec_type,codec_name,nb_read_frames',
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

/**
 * Presentation times of one stream, in ticks of that stream, in the order the file holds them.
 * Not sorted: the order is part of what is being looked at, and a picture track with B-frames
 * stores its frames out of the order they are shown in.
 */
function packetTimes(file: string, stream: 'v' | 'a'): number[] {
  const probed = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  )

  expect(probed.status, probed.stderr).toBe(0)
  expect(probed.stderr).toBe('')

  return probed.stdout
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line !== '')
    .map(Number)
    .filter((value) => Number.isFinite(value))
}

const typeIn = (boxes: Box[], type: string): Box | undefined => boxes.find((b) => b.type === type)

/** track_id of every fragment of the file, in the order the fragments lie in it. */
function fragmentOrder(file: Uint8Array): number[] {
  const ids: number[] = []

  for (const moof of topLevelBoxes(file).filter((b) => b.type === 'moof')) {
    const traf = typeIn(childBoxes(file, moof), 'traf')
    const tfhd = traf && typeIn(childBoxes(file, traf), 'tfhd')
    if (!tfhd) continue

    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    ids.push(view.getUint32(tfhd.start + tfhd.headerSize + 4))
  }

  return ids
}

describe('a clip whose sound came in WebM and whose picture came in mp4', () => {
  it('adds up to one session the popup can offer', () => {
    const session = recordedSession().list()[0]!
    const { duration, runs } = summarize(session)

    expect(session.tracks.map((t) => t.kinds)).toEqual([['video'], ['audio']])
    expect(duration).toBeCloseTo(6, 6)
    expect(runs).toBe(1)
  })

  it('gives ffprobe a file of two streams, picture and sound, decoding without complaint', () => {
    const probed = probe(onDisk('mixed-container.mp4', savedFile()))

    expect(probed.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
      ['video', 'h264'],
      ['audio', 'opus'],
    ])
    expect(probed.streams.map((s) => Number(s.nb_read_frames))).toEqual([
      VIDEO_FRAMES,
      AUDIO_PACKETS,
    ])

    const seconds = Number(probed.format.duration)
    expect(seconds).toBeGreaterThan(5.9)
    expect(seconds).toBeLessThan(6.1)
  })

  it('decodes end to end without a single warning', () => {
    decode(onDisk('mixed-container.mp4', savedFile()))
  })

  it('lays the two tracks out interleaved by time and not one after the other', () => {
    const file = savedFile()
    const order = fragmentOrder(file)

    // Three fragments of picture and four of sound, covering the same six seconds: a file that
    // put all of one track first would make a player read the whole clip through twice over, and
    // would hold every byte of the sound in memory before the first frame of it is played.
    expect(order).toHaveLength(7)
    expect(new Set(order).size).toBe(2)

    // The picture opens the file: stream zero is the one a player shows.
    expect(order[0]).toBe(1)

    // Nowhere in the file does one track run for more than two fragments unbroken: the segments
    // of the two are two seconds each and land on nearly the same instants.
    let unbroken = 1
    let longest = 1
    for (const [index, id] of order.slice(1).entries()) {
      unbroken = id === order[index] ? unbroken + 1 : 1
      longest = Math.max(longest, unbroken)
    }
    expect(longest).toBeLessThanOrEqual(2)
  })

  it('states the sound at 48 kHz and spaces its packets by the length of an Opus frame', () => {
    const file = onDisk('mixed-container.mp4', savedFile())
    const times = packetTimes(file, 'a')

    expect(times).toHaveLength(AUDIO_PACKETS)
    expect(times[0]).toBe(0)

    // Twenty milliseconds of 48 kHz is 960 samples, and every packet of the fixture is one such
    // frame. Matroska rounds its timestamps to whole milliseconds, so the recording carries
    // exactly one step that is not 960 — and it is the first, where the rounding of the very
    // beginning of the stream is absorbed. Anywhere else it would be a seam: a scale applied
    // with the wrong factor, or a fragment whose samples do not reach the next fragment's start,
    // moves that odd step to the boundary between two segments.
    const steps = times.slice(1).map((time, index) => time - times[index]!)
    expect(steps[0]).toBe(1008)
    expect([...new Set(steps.slice(1))]).toEqual([960])

    // And the last packet lands where six seconds of 20 ms frames put it.
    expect(Math.max(...times)).toBe(287088)
  })

  it('starts both streams together and runs them to the same end', () => {
    const file = onDisk('mixed-container.mp4', savedFile())
    const picture = packetTimes(file, 'v')
    const sound = packetTimes(file, 'a')

    expect(picture).toHaveLength(VIDEO_FRAMES)
    expect(Math.min(...picture)).toBe(0)
    expect(Math.min(...sound)).toBe(0)

    // The picture counts in 12288 ticks a second and the sound in 48000: the file is honest only
    // if the two come out at nearly the same place once each is divided by its own scale. The
    // last frame shown is taken rather than the last one stored — the picture has B-frames.
    expect(Math.max(...picture) / 12288).toBeCloseTo(5.958, 3)
    expect(Math.max(...sound) / 48000).toBeCloseTo(5.981, 3)
  })
})
