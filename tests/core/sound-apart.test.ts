import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { locateMovie, type RangeRead, type RangeReader } from '../../src/core/iso/locate'
import { assembleMp4 } from '../../src/core/export/assemble'
import { planRanges, readsFor } from '../../src/core/export/ranges'
import { bytesFrom } from '../../src/core/export/source'
import { cutPlain, plainFileOf, pairedReader, soundBaseOf } from '../../src/core/export/plain'
import { mpegSoundOf } from '../../src/core/export/mpeg'
import { id3Length, walkMpegFrames } from '../../src/core/mpeg/frames'
import { MPEG1_OBJECT_TYPE, mpegSampleEntry } from '../../src/core/mpeg/mp4'
import { audioDecoderConfig } from '../../src/core/codec/audio'
import { sampleEntryOf } from '../../src/core/iso/entry'
import { topLevelBoxes } from '../../src/core/iso/reader'
import { probeFile, writeTemp } from '../support/media'
import { spawnSync } from 'node:child_process'
import type { SourceTrack } from '../../src/core/export/plan'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/**
 * The shape of page this whole module exists for (§5.6), as two files of the repository.
 *
 * `loop.mp4` is the picture: three and a half seconds of H.264 with no sound track in it at all.
 * `track.mp3` is the soundtrack playing underneath it: twenty-four and a half seconds of MPEG-1
 * Layer III, seven times as long. Both loop on the page, each on its own cycle.
 */
const picture = read('plain/loop.mp4')
const soundtrack = read('plain/track.mp3')

/** A file behind ranged reads, keeping the tally of what was asked of it. */
function serve(file: Uint8Array) {
  const asked: Array<[number, number]> = []

  const reader: RangeReader = async (at, length): Promise<RangeRead> => {
    asked.push([at, length])
    return {
      bytes: file.subarray(Math.min(at, file.byteLength), Math.min(at + length, file.byteLength)),
      total: file.byteLength,
    }
  }

  return { asked, read: reader }
}

/** The picture, indexed the way the bridge indexes an ordinary file. */
async function openPicture() {
  const server = serve(picture)
  const found = await locateMovie(server.read)
  return { server, file: plainFileOf(found!.moov, found!.total)! }
}

/** The head of the soundtrack, indexed as far as `seconds` reach. */
function openSound(seconds = Infinity): SourceTrack {
  const walk = walkMpegFrames(soundtrack, id3Length(soundtrack), 0)
  const kept =
    seconds === Infinity
      ? walk
      : { ...walk, frames: walk.frames.slice(0, Math.ceil((seconds * walk.sampleRate) / 1152)) }

  return mpegSoundOf(kept)!
}

describe('mpegSampleEntry', () => {
  it('declares the stream as MPEG-1 audio inside an mp4a', () => {
    const entry = mpegSampleEntry({ version: 1, channels: 2, sampleRate: 44100 })
    const box = topLevelBoxes(entry)[0]!

    // mp4a and not a four-letter code of its own: MPEG-1 audio has no sample entry in ISO BMFF
    // and is declared as an elementary stream whose object type says which codec it is.
    expect(box.type).toBe('mp4a')

    const read = sampleEntryOf(mp4aInMovie(entry), 1)
    expect(read?.channels).toBe(2)
    expect(read?.sampleRate).toBe(44100)
  })

  it.each([
    ['MPEG-1', 1, MPEG1_OBJECT_TYPE],
    ['MPEG-2', 2, 0x69],
    ['MPEG-2.5', 25, 0x69],
  ] as const)('names the object type of %s audio', (_name, version, objectType) => {
    const entry = mpegSampleEntry({ version, channels: 2, sampleRate: 44100 })
    const esds = sampleEntryOf(mp4aInMovie(entry), 1)?.children.get('esds')

    // The one byte that says which codec this is. Wrong, a decoder is handed MP3 and told to
    // expect AAC — and Chromium answers that by playing nothing at all.
    expect(esds).toBeDefined()
    expect(objectTypeOf(esds!)).toBe(objectType)
  })

  it('carries no decoder-specific information, because an MP3 frame needs none', () => {
    const entry = mpegSampleEntry({ version: 1, channels: 2, sampleRate: 44100 })
    const read = sampleEntryOf(mp4aInMovie(entry), 1)

    // Every field a decoder needs is in the header of every frame, so there is nothing to set it
    // up with — unlike AAC, whose AudioSpecificConfig is the difference between sound and rubbish.
    // What the decoder is told is the object type and the shape of the stream, and no more; a
    // reader that insisted on setup bytes would refuse this track for the absence of a thing it
    // never has, and the editor would draw no waveform under a clip that has sound.
    expect(audioDecoderConfig(read!)).toEqual({
      codec: 'mp3',
      numberOfChannels: 2,
      sampleRate: 44100,
    })
  })
})

describe('mpegSoundOf', () => {
  it('makes one audio track of every frame the walk found', () => {
    const walk = walkMpegFrames(soundtrack, id3Length(soundtrack), 0)
    const track = mpegSoundOf(walk)!

    expect(track.kind).toBe('audio')
    // The timescale is the sampling rate itself: a frame is a whole number of samples, so the
    // times of the track come out exact and no rounding is ever done on them.
    expect(track.timescale).toBe(44100)
    expect(track.samples.length).toBe(walk.frames.length)
    // The silence the encoder left at the head, hidden rather than thrown away.
    expect(track.editOffset).toBe(walk.skipSamples)
  })

  it('lays the frames end to end in time, each as long as the samples it carries', () => {
    const track = mpegSoundOf(walkMpegFrames(soundtrack, id3Length(soundtrack), 0))!

    let expected = 0
    for (const sample of track.samples) {
      expect(sample.dts).toBe(expected)
      expect(sample.pts).toBe(expected)
      // Sound has no reordering: every frame decodes where it is shown, and every one of them
      // can be decoded on its own.
      expect(sample.sync).toBe(true)
      expected += sample.duration
    }

    expect(expected / track.timescale).toBeCloseTo(24.529, 2)
  })

  it('refuses a walk that found no frame at all', () => {
    expect(mpegSoundOf(walkMpegFrames(picture, 0, 0))).toBeNull()
  })
})

describe('cutPlain over a page that plays its sound apart', () => {
  it('leaves the picture silent when nothing is offered beside it', async () => {
    const { file } = await openPicture()
    const cut = cutPlain(file, [{ start: 0, end: file.durationSeconds }])!

    // The file itself holds one track and it is the picture: that is the whole shape of the case.
    expect(file.tracks.map((track) => track.kind)).toEqual(['video'])
    expect(cut.plan.tracks.map((track) => track.kind)).toEqual(['video'])
    expect(cut.paired).toBe(false)
  })

  it('puts the soundtrack beside the picture when one is offered', async () => {
    const { file } = await openPicture()
    const cut = cutPlain(file, [{ start: 0, end: file.durationSeconds }], { track: openSound() })!

    expect(cut.plan.tracks.map((track) => track.kind)).toEqual(['video', 'audio'])
    expect(cut.paired).toBe(true)
  })

  it('states the length of the picture and not of the soundtrack', async () => {
    const { file } = await openPicture()
    const cut = cutPlain(file, [{ start: 0, end: file.durationSeconds }], { track: openSound() })!

    // Seven times as much sound was on offer and none of it beyond the picture is taken. The
    // picture is the clip; the track is a thing playing underneath it, and a file of 24 seconds
    // of somebody's music with 3.5 seconds of picture at the front is not a clip of anything.
    expect(cut.plan.duration).toBeCloseTo(3.5, 1)
  })

  it('takes the sound from the start of the track, where the page itself pairs them', async () => {
    const { file } = await openPicture()
    const sound = openSound()
    const cut = cutPlain(file, [{ start: 0, end: file.durationSeconds }], { track: sound })!

    const audio = cut.plan.tracks.find((track) => track.kind === 'audio')!
    const base = soundBaseOf(file)
    // The first frame of the track and no other, addressed where the clip's address space puts
    // the soundtrack. Both elements begin at zero when the page loads, so this is the pairing the
    // page itself makes — and it is the only one that can be stated in media time, which is the
    // clock everything else in this program is measured on. Taken instead from wherever the sound
    // happened to have got to, two saves of one session would hold different sound.
    expect(audio.samples[0]!.source.at - base).toBe(sound.samples[0]!.source.at)
    expect(audio.samples[0]!.source.length).toBe(sound.samples[0]!.source.length)
    // And the clip begins at the track's own zero and not at the first byte of it: the 1105
    // samples of encoder and decoder delay are decoded and hidden by the edit list, exactly as an
    // mp4 hides AAC priming.
    expect(audio.skipTicks).toBe(1105)
  })

  it('lets the sound end early when the track is shorter than the picture', async () => {
    const { file } = await openPicture()
    // One second of soundtrack under three and a half seconds of picture: a jingle rather than a
    // song. The clip is still the picture's length, and its sound stops when the track does —
    // looping it round to fill the rest would be composing something the page never played.
    const cut = cutPlain(file, [{ start: 0, end: file.durationSeconds }], {
      track: openSound(1),
    })!

    const audio = cut.plan.tracks.find((track) => track.kind === 'audio')!
    let sounded = 0
    for (const sample of audio.samples) sounded += sample.duration

    expect(cut.plan.duration).toBeCloseTo(3.5, 1)
    expect(sounded / audio.timescale).toBeLessThan(1.2)
    expect(cut.soundShort).toBe(true)
  })

  it('does not pair a file that has sound of its own', async () => {
    const server = serve(read('plain/whole.mp4'))
    const found = await locateMovie(server.read)
    const file = plainFileOf(found!.moov, found!.total)!

    const cut = cutPlain(file, [{ start: 0, end: file.durationSeconds }], { track: openSound() })!

    // The file's own sound wins outright. A track offered from outside is an answer to a picture
    // that has none, and putting a second one in would be composing rather than clipping.
    expect(cut.plan.tracks.length).toBe(2)
    expect(cut.paired).toBe(false)
  })
})

describe('the address space of a clip made of two files', () => {
  it('keeps the two files far enough apart that no read bridges them', async () => {
    const { file } = await openPicture()
    const base = soundBaseOf(file)
    const cut = cutPlain(file, [{ start: 0, end: file.durationSeconds }], { track: openSound() })!

    const reads = readsFor(planRanges(cut.plan))
    // Ranges close together are merged into one read rather than fetched apiece
    // (core/export/ranges.ts), and two files laid end to end in one address space would be merged
    // across the seam — one request asking a host for bytes that live on another.
    for (const at of reads) {
      expect(at.at < base && at.at + at.length > base).toBe(false)
    }
  })

  it('sends every read to the file it belongs to', async () => {
    const { file } = await openPicture()
    const pictures = serve(picture)
    const sounds = serve(soundtrack)
    const base = soundBaseOf(file)

    const paired = pairedReader(pictures.read, sounds.read, base)
    const head = await paired(0, 8)
    const inSound = await paired(base + 0, 8)

    expect([...head.bytes]).toEqual([...picture.subarray(0, 8)])
    expect([...inSound.bytes]).toEqual([...soundtrack.subarray(0, 8)])
    expect(sounds.asked).toEqual([[0, 8]])
  })
})

describe('the file a paired save writes', () => {
  it('plays with both tracks, the picture whole and the sound under it', async () => {
    const { file } = await openPicture()
    const sound = openSound()
    const cut = cutPlain(file, [{ start: 0, end: file.durationSeconds }], { track: sound })!
    const base = soundBaseOf(file)

    const paired = pairedReader(serve(picture).read, serve(soundtrack).read, base)
    const reads = readsFor(planRanges(cut.plan))
    const buffers: Uint8Array[] = []
    for (const at of reads) buffers.push((await paired(at.at, at.length)).bytes)

    const written = assembleMp4(cut.plan, bytesFrom(reads, buffers))
    const probed = probeFile(writeTemp('sound-apart.mp4', written))

    expect(probed.stderr, 'ffmpeg complains about reading the paired file').toBe('')
    expect(probed.probed?.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
      ['video', 'h264'],
      ['audio', 'mp3'],
    ])

    // Both tracks run the length of the picture: 35 frames of picture at ten a second, and as
    // many frames of sound as cover the same three and a half seconds.
    const [video, audio] = probed.probed!.streams
    expect(Number(video!.nb_read_frames)).toBe(35)
    expect(Number(audio!.duration)).toBeCloseTo(3.5, 1)
  })

  it('holds the head of the soundtrack, sample for sample, in step with it', async () => {
    const { file } = await openPicture()
    const cut = cutPlain(file, [{ start: 0, end: file.durationSeconds }], { track: openSound() })!
    const base = soundBaseOf(file)

    const paired = pairedReader(serve(picture).read, serve(soundtrack).read, base)
    const reads = readsFor(planRanges(cut.plan))
    const buffers: Uint8Array[] = []
    for (const at of reads) buffers.push((await paired(at.at, at.length)).bytes)

    const written = writeTemp('sound-apart-aligned.mp4', assembleMp4(cut.plan, bytesFrom(reads, buffers)))
    const head = writeTemp('sound-apart-head.mp3', soundtrack)

    // The claim of this whole module in one measurement: the sound of the clip is the sound the
    // page was playing, from the start of the track, at the same instant. Cross-correlated
    // against ffmpeg's own decode of the same file, the best alignment is zero samples — the same
    // comparison read 1105 samples of lead before the encoder delay was hidden by the edit list.
    expect(alignment(pcmOf(written), pcmOf(head, 3.5))).toBe(0)
  })
})

/** One channel of a file decoded to signed 16-bit samples at 44.1 kHz. */
function pcmOf(file: string, seconds?: number): Int16Array {
  const run = spawnSync(
    'ffmpeg',
    [
      '-v', 'error',
      ...(seconds ? ['-t', String(seconds)] : []),
      '-i', file,
      '-map', '0:a',
      '-f', 's16le', '-ac', '1', '-ar', '44100',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 1 << 28 },
  )

  expect(run.status, String(run.stderr)).toBe(0)
  const bytes = run.stdout
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
}

/**
 * How many samples the first signal leads the second by, at the offset they agree best on.
 *
 * A plain cross-correlation over the first fraction of a second, searched a few thousand samples
 * either way — far more than any delay this code could introduce, and cheap: the material is a
 * tone and the peak is unambiguous.
 */
function alignment(a: Int16Array, b: Int16Array): number {
  const window = 20_000
  const reach = 3_000

  let best = 0
  let strongest = -Infinity

  for (let shift = -reach; shift <= reach; shift++) {
    let sum = 0
    let counted = 0
    for (let i = 0; i < window; i++) {
      const left = a[i + Math.max(0, shift)]
      const right = b[i + Math.max(0, -shift)]
      if (left === undefined || right === undefined) break
      sum += left * right
      counted++
    }

    const score = counted ? sum / counted : -Infinity
    if (score > strongest) {
      strongest = score
      best = shift
    }
  }

  return best
}

/**
 * The objectTypeIndication out of the body of an esds.
 *
 * Four bytes of version and flags, then the ES descriptor: a tag, a length written seven bits to
 * a byte, two bytes of ES_ID and one of flags. Behind that stands the decoder configuration, and
 * its very first byte is the one being read.
 */
function objectTypeOf(esds: Uint8Array): number {
  const skipLength = (at: number): number => {
    let cursor = at
    while ((esds[cursor] ?? 0) & 0x80) cursor++
    return cursor + 1
  }

  const stream = skipLength(4 + 1) + 3
  return esds[skipLength(stream + 1)] ?? 0
}

/** A sample entry wrapped in just enough movie box for sampleEntryOf to find it. */
function mp4aInMovie(entry: Uint8Array): Uint8Array {
  const boxes = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(8 + body.byteLength)
    new DataView(out.buffer).setUint32(0, out.byteLength)
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
    out.set(body, 8)
    return out
  }

  const stsd = new Uint8Array(8 + entry.byteLength)
  new DataView(stsd.buffer).setUint32(4, 1) // version and flags, then entry_count
  stsd.set(entry, 8)

  const tkhd = new Uint8Array(84)
  new DataView(tkhd.buffer).setUint32(12, 1) // track_id, at version 0

  const hdlr = new Uint8Array(24)
  for (const [i, letter] of [...'soun'].entries()) hdlr[8 + i] = letter.charCodeAt(0)

  const mdhd = new Uint8Array(24)
  new DataView(mdhd.buffer).setUint32(12, 44100)

  return boxes(
    'moov',
    boxes(
      'trak',
      concat([
        boxes('tkhd', tkhd),
        boxes(
          'mdia',
          concat([
            boxes('mdhd', mdhd),
            boxes('hdlr', hdlr),
            boxes('minf', boxes('stbl', boxes('stsd', stsd))),
          ]),
        ),
      ]),
    ),
  )
}

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0
  for (const part of parts) size += part.byteLength
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}
