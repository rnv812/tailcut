import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { SessionStore, selectMaterial } from '../../src/bridge/session-store'
import { muxFragmentedMp4, type MuxTrack } from '../../src/core/mux'
import { saveAllMp4 } from '../../src/core/export/save'
import { boxBody, topLevelBoxes } from '../../src/core/iso/reader'

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

const page = { sourceId: 's1', url: 'https://site.example/watch', title: 'Clip', now: 1_000 }

/** A session fed the way a player feeds one: the inits first, then the segments in step. */
function recorded(
  streams: Array<{ init: Uint8Array; segments: Uint8Array[]; mime?: string }>,
): MuxTrack[] {
  const store = new SessionStore()

  for (const [at, stream] of streams.entries()) {
    store.append({ ...page, bufferId: `b${at}`, mime: stream.mime, bytes: stream.init })
  }

  const longest = Math.max(...streams.map((stream) => stream.segments.length))
  for (let i = 0; i < longest; i++) {
    for (const [at, stream] of streams.entries()) {
      const bytes = stream.segments[i]
      if (bytes) store.append({ ...page, bufferId: `b${at}`, mime: stream.mime, bytes })
    }
  }

  return selectMaterial(store.list()[0]!)
}

function onDisk(name: string, bytes: Uint8Array): string {
  mkdirSync('tests/tmp', { recursive: true })
  const file = `tests/tmp/${name}`
  writeFileSync(file, bytes)
  return file
}

interface Probed {
  format: { duration: string }
  streams: Array<{ codec_type: string; codec_name: string; nb_read_frames: string; start_time: string }>
}

function probe(file: string): Probed {
  const probed = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-count_frames',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,nb_read_frames,start_time',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )

  expect(probed.error).toBeUndefined()
  expect(probed.status, probed.stderr).toBe(0)
  // A track laid out wrongly inside mdat leaves the boxes intact and shows up only when the
  // frames are really read — as complaints here, with the exit code still zero.
  expect(probed.stderr, 'ffprobe complains about reading the file').toBe('')

  return JSON.parse(probed.stdout) as Probed
}

function decode(file: string): void {
  const run = spawnSync('ffmpeg', ['-v', 'warning', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8',
  })

  expect(run.error).toBeUndefined()
  expect(run.status, run.stderr).toBe(0)
  expect(run.stderr, 'decoding the file produces warnings').toBe('')
}

/** One frame as raw pixels, reached however the arguments say. */
function frame(args: string[], what: string): Buffer {
  const run = spawnSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })
  expect(run.error).toBeUndefined()
  expect(run.status, `${what}: ${run.stderr.toString()}`).toBe(0)
  return run.stdout
}

/**
 * Seeking lands on the frame that belongs there.
 *
 * -ss before -i is an input seek: the demuxer looks up the last sample marked as one that can be
 * decoded on its own and starts there. That is what stss is for, and it is the one thing a
 * fragmented file has no table for at all — a player builds the index by scanning instead. The
 * times are inside a group of pictures on purpose: a seek to a keyframe would come out right
 * whatever the tables said.
 */
function seekingLandsRight(file: string, times: number[]): void {
  for (const at of times) {
    const seeked = frame(
      ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      `seeking to ${at}s`,
    )
    const played = frame(
      ['-v', 'error', '-i', file, '-vf', `select='gte(t\\,${at})'`, '-vsync', '0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      `playing up to ${at}s`,
    )

    expect(played.byteLength, `nothing decodes at ${at}s at all`).toBeGreaterThan(0)
    expect(seeked.equals(played), `the frame at ${at}s differs when seeked to`).toBe(true)
  }
}

const digest = (...parts: Uint8Array[]): string => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

/** The bodies of every mdat of a file, in the order they lie in it. */
const mediaOf = (file: Uint8Array): Uint8Array[] =>
  topLevelBoxes(file)
    .filter((box) => box.type === 'mdat')
    .map((box) => boxBody(file, box))

const H264 = {
  video: { init: load('h264/init-stream0.m4s'), segments: [1, 2, 3].map((n) => load(`h264/chunk-stream0-0000${n}.m4s`)) },
  audio: { init: load('h264/init-stream1.m4s'), segments: [1, 2, 3, 4].map((n) => load(`h264/chunk-stream1-0000${n}.m4s`)) },
}

/** Every family the capture already saves. */
const FAMILIES = [
  {
    name: 'h264',
    streams: [H264.video, H264.audio],
    codecs: [
      ['video', 'h264'],
      ['audio', 'aac'],
    ],
  },
  {
    name: 'vp9',
    streams: [
      { init: load('vp9/init-stream0.m4s'), segments: [1, 2].map((n) => load(`vp9/chunk-stream0-0000${n}.m4s`)) },
    ],
    codecs: [['video', 'vp9']],
  },
  {
    name: 'av1',
    streams: [
      { init: load('av1/init-stream0.m4s'), segments: [1, 2, 3].map((n) => load(`av1/chunk-stream0-0000${n}.m4s`)) },
    ],
    codecs: [['video', 'av1']],
  },
  {
    // One buffer carrying both kinds: two traks in the moov and two trafs in every segment, which
    // is the one shape where the two inputs the writer builds stand over the very same bytes. Each
    // trak of this set states an edit list of its own — the picture hides 2048 ticks of 10240, the
    // sound 1024 of 22050 — so a file that took the edit off the wrong trak comes out audibly late.
    name: 'muxed',
    streams: [
      {
        init: load('muxed-edits/init-stream0.m4s'),
        segments: [1, 2, 3].map((n) => load(`muxed-edits/chunk-stream0-0000${n}.m4s`)),
      },
    ],
    codecs: [
      ['video', 'h264'],
      ['audio', 'aac'],
    ],
  },
  {
    // Sound and nothing else — the shape the popup has offered to save since the capture stage,
    // and the one where the lead track of the clip is not a picture at all.
    name: 'aac',
    streams: [H264.audio],
    codecs: [['audio', 'aac']],
  },
  {
    // The WebM path: the registry rewrites these segments into ISO on the way in, so the writer
    // is reading boxes our own code produced — the one place sample flags live in the trex alone.
    // The type the buffer was opened with travels with the bytes: a WebM picture track is
    // declared by the codec string and by nothing else the page sends.
    name: 'webm',
    streams: [
      {
        init: load('webm/init-stream0.webm'),
        segments: [1, 2, 3].map((n) => load(`webm/chunk-stream0-0000${n}.webm`)),
        mime: 'video/webm; codecs="vp09.00.10.08"',
      },
      {
        init: load('webm/init-stream1.webm'),
        segments: [1, 2, 3, 4].map((n) => load(`webm/chunk-stream1-0000${n}.webm`)),
        mime: 'audio/webm; codecs="opus"',
      },
    ],
    codecs: [
      ['video', 'vp9'],
      ['audio', 'opus'],
    ],
  },
] as const

/**
 * How many packets of sound the new file may be short of the old one.
 *
 * A clip's duration is measured by its picture, so sound is cut to the picture's span, and the
 * packet that straddles the last frame does not make it in. The old writer copied whole fragments
 * and so kept it. One packet is 21 ms of AAC or 20 of Opus; two is the whole of the slack this
 * allows, and it is a bound rather than a number because it depends on where the two scales fall
 * against each other in a given fixture.
 */
const SOUND_SLACK_PACKETS = 2

describe('Save all, written as an ordinary mp4', () => {
  for (const family of FAMILIES) {
    describe(family.name, () => {
      const material = (): MuxTrack[] => recorded([...family.streams])

      it('holds every stream and every frame the fragmented writer held', () => {
        const before = probe(onDisk(`save-${family.name}-old.mp4`, muxFragmentedMp4(material())))
        const after = probe(onDisk(`save-${family.name}.mp4`, saveAllMp4(material())))

        expect(after.streams.map((s) => [s.codec_type, s.codec_name])).toEqual(
          family.codecs.map((pair) => [...pair]),
        )

        // Against the writer this replaces, and not against numbers written down here: that is
        // the whole promise of the move, and the absolute counts are already pinned by the e2e
        // sets that save these same fixtures through the extension.
        for (const [at, stream] of after.streams.entries()) {
          const now = Number(stream.nb_read_frames)
          const was = Number(before.streams[at]!.nb_read_frames)

          if (stream.codec_type === 'video') {
            expect(now, `${family.name}: frames of the picture`).toBe(was)
          } else {
            expect(now, `${family.name}: packets of the sound`).toBeLessThanOrEqual(was)
            expect(now, `${family.name}: packets of the sound`).toBeGreaterThanOrEqual(
              was - SOUND_SLACK_PACKETS,
            )
          }
        }
      })

      it('starts every track at zero and states no more time than it holds', () => {
        const before = probe(onDisk(`save-${family.name}-old.mp4`, muxFragmentedMp4(material())))
        const after = probe(onDisk(`save-${family.name}.mp4`, saveAllMp4(material())))

        for (const stream of after.streams) {
          // Exactly zero, and not merely at or after it. The fragmented file leaves the priming
          // of AAC hanging in front of the clip, because ffmpeg does not read an edit list on one
          // — measured at −0.046440 for the sound of the muxed fixture — and it leaves the
          // reordering delay of the picture in front of it as well, at +0.014 on the WebM one.
          // Written as "not before zero" this passed on a file whose edit list hid neither.
          expect(Number(stream.start_time), `${stream.codec_type} does not start at zero`).toBe(0)
          expect(Number(stream.nb_read_frames)).toBeGreaterThan(0)
        }

        // Declared and real agree, which on the old file they did not: what hung in front of zero
        // was counted into the length besides. So the new file is never the longer of the two —
        // 6.000 against 6.092924 on the muxed fixture, and never a frame of material short.
        expect(Number(after.format.duration)).toBeGreaterThan(0)
        expect(Number(after.format.duration)).toBeLessThanOrEqual(Number(before.format.duration))
      })

      it('decodes end to end without a single warning', () => {
        decode(onDisk(`save-${family.name}.mp4`, saveAllMp4(material())))
      })
    })
  }

  it('answers a seek out of its own tables', () => {
    // The h264 fixture is the animated one, so a frame really tells one moment from another; the
    // times are inside groups of pictures, a second apart from the keyframes at 0, 1, 2…
    seekingLandsRight(onDisk('save-h264.mp4', saveAllMp4(recorded([H264.video, H264.audio]))), [1.3, 2.7, 4.2])
  })

  it('copies the coded bytes of a single track without touching one of them', () => {
    // Samples tile the mdat of a segment exactly — measured on every fixture — so a one-track
    // file rebuilt sample by sample comes out with the very same media data in it.
    const material = recorded([H264.video])
    const file = saveAllMp4(material)

    expect(mediaOf(file)).toHaveLength(1)
    expect(digest(...mediaOf(file))).toBe(digest(...H264.video.segments.flatMap(mediaOf)))
  })

  it('lays two tracks out one after the other, picture first', () => {
    // The writer gives each track one chunk. On a file that is opened from disk this costs
    // nothing — a player reads by range — and it is why there is a single mdat instead of one
    // per fragment. Interleaving would be a change to the writer, not to this.
    const file = saveAllMp4(recorded([H264.video, H264.audio]))
    const media = mediaOf(file)

    expect(media).toHaveLength(1)
    expect(digest(...media)).toBe(
      digest(
        ...H264.video.segments.flatMap(mediaOf),
        ...H264.audio.segments.flatMap(mediaOf),
      ),
    )
  })

  it('gives an empty buffer when there is nothing to write', () => {
    expect(saveAllMp4([]).byteLength).toBe(0)
    expect(saveAllMp4([{ initBytes: H264.video.init, segments: [] }]).byteLength).toBe(0)
    expect(saveAllMp4([{ initBytes: new Uint8Array(32), segments: [] }]).byteLength).toBe(0)
  })
})
