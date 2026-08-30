import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { locateSegment } from '../../src/core/webm/locate'
import { indexClusters } from '../../src/core/webm/whole'
import { matroskaFileOf } from '../../src/core/export/matroska'
import { cutPlain } from '../../src/core/export/plain'
import { assembleMp4 } from '../../src/core/export/assemble'
import { planRanges, readsFor } from '../../src/core/export/ranges'
import { bytesFrom } from '../../src/core/export/source'
import { parseClusters } from '../../src/core/webm/fragment'
import { topLevelBoxes } from '../../src/core/iso/reader'
import { decodeWarnings, probeFile, unexpectedWarnings, writeTemp } from '../support/media'
import type { PlainFile } from '../../src/core/export/plain'
import type { RangeRead } from '../../src/core/iso/locate'
import type { Located } from '../../src/shared/types'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/** VP9 and Opus: the two codecs that already crossed into an mp4 on the captured path. */
const whole = read('tests/fixtures/plain/watched.webm')
/** VP8 and Vorbis: the pair an imageboard serves, and the last two that could not. */
const older = read('tests/fixtures/plain/watched-vp8.webm')

function serve(file: Uint8Array) {
  return async (at: number, length: number): Promise<RangeRead> => ({
    bytes: file.subarray(Math.min(at, file.byteLength), Math.min(at + length, file.byteLength)),
    total: file.byteLength,
  })
}

/** Opens a Matroska the way the bridge does: the head, the clusters, and then the tracks. */
async function open(file: Uint8Array): Promise<PlainFile> {
  const reader = serve(file)
  const found = (await locateSegment(reader))!
  const frames = (await indexClusters(reader, found))!

  const opened = await matroskaFileOf(found.head, frames, found.total, async (at) =>
    file.subarray(at.at, at.at + at.length),
  )

  expect(opened, 'the file could not be opened as a source').not.toBeNull()
  return opened!
}

/** The four letters of the sample entry a track was described by. */
const entryOf = (bytes: Uint8Array): string => topLevelBoxes(bytes)[0]!.type

describe('matroskaFileOf', () => {
  it('indexes both tracks of a VP9 and Opus file into what the cut takes in', async () => {
    const file = await open(whole)

    expect(
      file.tracks.map((track) => ({
        kind: track.kind,
        timescale: track.timescale,
        samples: track.samples.length,
        entry: entryOf(track.sampleEntry),
        width: track.width,
        height: track.height,
        editOffset: track.editOffset,
        dropped: track.dropped,
      })),
    ).toEqual([
      {
        kind: 'video',
        // The Matroska ticks, kept: one TimestampScale of a millisecond governs the segment, and
        // the frame times cross over with nothing to round.
        timescale: 1000,
        samples: 200,
        entry: 'vp09',
        width: 256,
        height: 144,
        editOffset: 0,
        dropped: 0,
      },
      {
        kind: 'audio',
        // Opus decodes at 48 kHz whatever it was fed, and the mp4 mapping fixes the track there.
        timescale: 48000,
        // A thousand packets of twenty milliseconds, and one more in a BlockGroup at the end:
        // ffmpeg writes the final packet of the sound with a BlockDuration beside it, because
        // nothing else in the container would say how long it lasts.
        samples: 1001,
        entry: 'Opus',
        width: 0,
        height: 0,
        editOffset: 0,
        dropped: 0,
      },
    ])

    expect(file.codecs).toEqual(['V_VP9', 'A_OPUS'])
    expect(file.refusedTracks).toBe(false)
    expect(file.encrypted).toBe(false)
    expect(file.total).toBe(whole.byteLength)
    expect(file.durationSeconds).toBeGreaterThan(19.9)
    expect(file.durationSeconds).toBeLessThan(20.2)
  })

  it('indexes the older pair the same way', async () => {
    const file = await open(older)

    expect(file.tracks.map((track) => [track.kind, entryOf(track.sampleEntry), track.timescale]))
      .toEqual([
        ['video', 'vp08', 1000],
        // Vorbis decodes at the rate it was encoded at, and the track is timed in it.
        ['audio', 'mp4a', 22050],
      ])
    expect(file.codecs).toEqual(['V_VP8', 'A_VORBIS'])
    expect(file.refusedTracks).toBe(false)
    expect(file.tracks[0]!.samples).toHaveLength(200)
  })

  it('addresses every sample where the coded frame really lies', async () => {
    const file = await open(whole)
    const wanted = parseClusters(whole).flatMap((cluster) => cluster.frames)

    for (const track of file.tracks) {
      for (const sample of track.samples) {
        const bytes = whole.subarray(sample.source.at, sample.source.at + sample.source.length)
        // Every sample of the index is one of the frames the in-memory reader found, byte for
        // byte. A sample addressed a header out is a frame of garbage in the saved file.
        const found = wanted.find(
          (frame) =>
            frame.data.byteLength === bytes.byteLength &&
            frame.data.every((byte, i) => byte === bytes[i]),
        )
        expect(found, 'a sample points at bytes that are not a coded frame').toBeTruthy()
      }
    }
  })

  it('runs the times of both tracks over the same twenty seconds', async () => {
    const file = await open(whole)
    const [video, audio] = file.tracks

    // Decode order and presentation order are the same for every codec a Matroska carries here —
    // none of them reorders — so the two times of a sample are one number written twice.
    expect(video!.samples.every((sample) => sample.dts === sample.pts)).toBe(true)

    const spanOf = (track: (typeof file.tracks)[number]): number => {
      const last = track.samples[track.samples.length - 1]!
      return (last.pts + last.duration) / track.timescale
    }

    expect(spanOf(video!)).toBeCloseTo(20, 1)
    expect(spanOf(audio!)).toBeCloseTo(20, 1)
    // Every sample lasts as long as the distance to the next one: no hole, no overlap.
    for (const track of file.tracks) {
      for (let i = 1; i < track.samples.length; i++) {
        const before = track.samples[i - 1]!
        expect(before.dts + before.duration).toBe(track.samples[i]!.dts)
      }
    }
  })

  it('says which frames a player may seek to', async () => {
    const file = await open(whole)
    const video = file.tracks[0]!

    expect(video.samples.filter((sample) => sample.sync)).toHaveLength(10)
    expect(video.samples[0]!.sync).toBe(true)
    // Every packet of the sound is its own key: a sound track that said otherwise would have no
    // entry point for a clip to start at.
    expect(file.tracks[1]!.samples.every((sample) => sample.sync)).toBe(true)
  })

  it('leaves out a track in a codec it cannot describe, and writes the loss down', async () => {
    // The same file with one CodecID overwritten in place — same length, so every element around
    // it still states its own size truthfully. What a page may hand over is anything at all, and
    // a track this program cannot write must cost the track and not the file.
    const strange = new Uint8Array(older)
    const at = indexOfAscii(strange, 'A_VORBIS')
    strange.set(new TextEncoder().encode('A_FOOBAR'), at)

    const file = await open(strange)

    expect(file.tracks.map((track) => track.kind)).toEqual(['video'])
    expect(file.refusedTracks, 'a track was dropped and nobody was told').toBe(true)
    // The codecs of the merge key are what the file declares, refused or not: it is the same
    // material under the same address either way.
    expect(file.codecs).toEqual(['V_VP8', 'A_FOOBAR'])
  })

  it('refuses the whole of a file whose tracks are protected', async () => {
    // ContentEncryption inside a TrackEntry makes protection a property of the material,
    // and nothing of such a page is kept — not the picture, not the sound, not the length.
    const head = headWith(
      element(
        [0x6d, 0x80], // ContentEncodings
        element(
          [0x62, 0x40], // ContentEncoding
          uintElement([0x50, 0x33], 1), // ContentEncodingType: encryption
          element([0x50, 0x35]), // ContentEncryption
        ),
      ),
    )

    const file = await matroskaFileOf(head, [], 1000, async () => null)

    expect(file!.encrypted).toBe(true)
    expect(file!.tracks).toEqual([])
    expect(file!.durationSeconds).toBe(0)
  })

  it('reads a head that declares a track and no protection as ordinary', async () => {
    // The other half of the answer above: the same builder, nothing declared inside the track,
    // and a file with no frames in it is empty rather than refused.
    expect(await matroskaFileOf(headWith(), [], 1000, async () => null)).toBeNull()
  })

  it('gives nothing when there is no track it can read at all', async () => {
    const nothing = await matroskaFileOf(new Uint8Array(8), [], 0, async () => null)
    expect(nothing).toBeNull()
  })

  it('cuts a clip out of one that ffmpeg reads and decodes without a word', async () => {
    for (const [name, source] of [
      ['vp9-opus', whole],
      ['vp8-vorbis', older],
    ] as const) {
      const file = await open(source)

      // Eight seconds, the stretch the browser test watches before it opens the popup.
      const cut = cutPlain(file, [{ start: 0, end: 8 }])
      expect(cut, 'nothing could be cut out of the file').not.toBeNull()

      const reads = readsFor(planRanges(cut!.plan))
      const buffers = reads.map((at: Located) => source.subarray(at.at, at.at + at.length))
      const written = writeTemp(
        `plain-matroska-${name}.mp4`,
        assembleMp4(cut!.plan, bytesFrom(reads, buffers)),
      )

      const probed = probeFile(written)
      expect(probed.status, probed.stderr).toBe(0)
      expect(probed.stderr, `ffprobe complained about the ${name} clip`).toBe('')

      const streams = probed.probed!.streams
      expect(streams.map((stream) => stream.codec_type)).toEqual(['video', 'audio'])
      expect(streams.map((stream) => stream.codec_name)).toEqual(
        name === 'vp9-opus' ? ['vp9', 'opus'] : ['vp8', 'vorbis'],
      )

      // Every frame of the picture read back, and the length is the stretch that was asked for.
      expect(Number(streams[0]!.nb_read_frames)).toBe(80)
      expect(Number(probed.probed!.format.duration)).toBeCloseTo(8, 1)
      expect(unexpectedWarnings(decodeWarnings(written))).toEqual([])
    }
  })
})

/** Where an ASCII word lies in a buffer. */
function indexOfAscii(data: Uint8Array, word: string): number {
  const wanted = new TextEncoder().encode(word)
  for (let at = 0; at + wanted.byteLength <= data.byteLength; at++) {
    let same = true
    for (let i = 0; i < wanted.byteLength; i++) same &&= data[at + i] === wanted[i]
    if (same) return at
  }
  return -1
}

/**
 * One EBML element: the id as its bytes, a size, and the body.
 *
 * Enough of a writer to build a head by hand, which is how the shapes no fixture holds are put
 * in front of the reader. The size is written in the widest form that is always legal, so the
 * arithmetic of nesting is one addition rather than a special case per width.
 */
function element(id: number[], ...parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.byteLength

  const size = new Uint8Array(8)
  size[0] = 0x01
  let left = length
  for (let i = 7; i >= 1; i--) {
    size[i] = left % 256
    left = Math.floor(left / 256)
  }

  const out = new Uint8Array(id.length + 8 + length)
  out.set(id, 0)
  out.set(size, id.length)

  let at = id.length + 8
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }

  return out
}

/** A one-byte unsigned integer element, which is every number this test writes. */
const uintElement = (id: number[], value: number): Uint8Array =>
  element(id, Uint8Array.of(value))

const stringElement = (id: number[], text: string): Uint8Array =>
  element(id, new TextEncoder().encode(text))

/**
 * A head declaring one track, with whatever is handed in written inside its TrackEntry.
 *
 * Built rather than carved out of a fixture: ffmpeg will not produce an encrypted WebM, and
 * bending a real file into one means rewriting the size of every element that contains the change.
 */
function headWith(...inside: Uint8Array[]): Uint8Array {
  const ebml = element([0x1a, 0x45, 0xdf, 0xa3], stringElement([0x42, 0x82], 'webm'))
  const info = element([0x15, 0x49, 0xa9, 0x66], element([0x2a, 0xd7, 0xb1], Uint8Array.of(0x0f, 0x42, 0x40)))
  const tracks = element(
    [0x16, 0x54, 0xae, 0x6b],
    element(
      [0xae],
      uintElement([0xd7], 1), // TrackNumber
      uintElement([0x83], 1), // TrackType: video
      stringElement([0x86], 'V_VP9'), // CodecID
      ...inside,
    ),
  )

  return concat([ebml, element([0x18, 0x53, 0x80, 0x67], info, tracks)])
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
