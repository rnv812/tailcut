import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  VORBIS_OBJECT_TYPE,
  descriptorOf,
  vorbisSampleEntry,
} from '../../src/core/vorbis/mp4'
import { parseInit } from '../../src/core/webm/init'
import { parseClusters } from '../../src/core/webm/fragment'
import { boxBody, boxesIn, topLevelBoxes } from '../../src/core/iso/reader'
import { buildProgressiveMp4, type OutSample } from '../../src/core/iso/progressive'
import { decodeWarnings, probeFile, unexpectedWarnings, writeTemp } from '../support/media'

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/** VP8 and Vorbis, the pair an imageboard serves. */
const older = load('plain/watched-vp8.webm')
const vorbis = parseInit(older)!.tracks.find((track) => track.kind === 'audio')!

describe('descriptorOf', () => {
  it('writes a short body under a length of one byte', () => {
    expect(descriptorOf(0x06, Uint8Array.of(0x02))).toEqual(Uint8Array.of(0x06, 0x01, 0x02))
  })

  it('spreads a length past 127 over as many bytes as it takes', () => {
    // The MPEG-4 descriptor grammar writes a length seven bits at a time, high bit set on every
    // byte but the last. A Vorbis setup blob is kilobytes, so this is the ordinary case here and
    // not the corner: written as one byte it would state a length of 13 and cut the headers off.
    const body = new Uint8Array(3341)
    const written = descriptorOf(0x05, body)

    // 3341 is 26 sevens and 13 over: two bytes, the first with its continuation bit set. Written
    // as one byte it would state 13 and cut the codebooks off.
    expect(written.byteLength).toBe(1 + 2 + body.byteLength)
    expect([...written.subarray(0, 3)]).toEqual([0x05, 0x9a, 0x0d])
  })
})

describe('vorbisSampleEntry', () => {
  const entry = vorbisSampleEntry({
    channels: vorbis.channels!,
    sampleRate: vorbis.sampleRate!,
    setup: vorbis.codecPrivate!,
  })

  it('declares the track as mp4a with the sound the container states', () => {
    const box = topLevelBoxes(entry)[0]!
    expect(box.type).toBe('mp4a')

    const body = boxBody(entry, box)
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)

    // reserved(6) data_reference_index(2) reserved(8), and then the fields of the sound.
    expect(view.getUint16(16), 'the channel count').toBe(1)
    // samplerate is a 16.16 fixed-point number in the AudioSampleEntry, and Vorbis decodes at the
    // rate it was encoded at — unlike Opus, which is 48 kHz whatever it was fed.
    expect(view.getUint32(24) / 0x10000).toBe(22050)
  })

  it('carries the three setup headers of the container, byte for byte', () => {
    // A sample entry is not a container in the reader's sense — it states a run of fields before
    // its children — so the children are read from where that run ends: 36 bytes for a sound.
    const mp4a = topLevelBoxes(entry)[0]!
    const esds = boxesIn(entry, mp4a.start + 36, mp4a.start + mp4a.size).find(
      (box) => box.type === 'esds',
    )!
    const body = boxBody(entry, esds)

    // The setup headers are the whole of what a Vorbis decoder is configured by — identification,
    // comment and codebooks, xiph-laced into one blob — and Matroska keeps them in CodecPrivate.
    // They cross into the mp4 unaltered, exactly as the coded packets do.
    const setup = vorbis.codecPrivate!
    let found = -1
    for (let at = 0; at + setup.byteLength <= body.byteLength; at++) {
      if (body.subarray(at, at + setup.byteLength).every((byte, i) => byte === setup[i])) {
        found = at
        break
      }
    }

    expect(found, 'the setup headers are not in the esds').toBeGreaterThan(0)
    // And the byte in front of the descriptor that holds them says what they are: 0xDD, the
    // object type that means Vorbis. There is no registered one — see the module.
    expect(body).toContain(VORBIS_OBJECT_TYPE)
  })

  it('describes a file ffmpeg reads as Vorbis and decodes without a word', () => {
    const frames = parseClusters(older)
      .flatMap((cluster) => cluster.frames)
      .filter((frame) => frame.trackNumber === vorbis.trackId)
      .sort((a, b) => a.timestamp - b.timestamp)

    // Ticks of the Matroska timestamps, which is a millisecond apiece: what matters here is the
    // description of the track and not the arithmetic of the times, which core/export/matroska.ts
    // does properly.
    const samples: OutSample[] = frames.map((frame, index) => ({
      bytes: frame.data,
      duration: (frames[index + 1]?.timestamp ?? frame.timestamp + 23) - frame.timestamp,
      cts: 0,
      sync: true,
    }))

    const file = writeTemp(
      'vorbis-entry.mp4',
      buildProgressiveMp4([
        {
          trackId: 1,
          kind: 'audio',
          timescale: 1000,
          sampleEntry: entry,
          width: 0,
          height: 0,
          samples,
          skipTicks: 0,
        },
      ]),
    )

    const probed = probeFile(file)
    expect(probed.status, probed.stderr).toBe(0)
    expect(probed.stderr).toBe('')

    const stream = probed.probed!.streams[0]!
    expect(stream.codec_name).toBe('vorbis')
    // Every packet read back but one: -count_frames counts what the decoder hands out, and the
    // first packet of a Vorbis stream hands out nothing — the transform is lapped, so the first
    // window has no window before it to overlap with. The source webm counts the same 862 for
    // the same 863 packets, which is how we know the number is the codec's and not ours.
    expect(Number(stream.nb_read_frames)).toBe(frames.length - 1)
    expect(unexpectedWarnings(decodeWarnings(file))).toEqual([])
  })
})
