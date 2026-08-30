import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  audioDecoderConfig,
  audioSpecificConfig,
  opusHeadOf,
} from '../../src/core/codec/audio'
import { audioSampleEntry, videoSampleEntry, type SampleEntry } from '../../src/core/iso/entry'
import { ingestInit } from '../../src/core/container'
import { buildAudioInit } from '../../src/core/iso/build'
import { parseInit as parseWebmInit } from '../../src/core/webm/init'
import { vorbisSampleEntry } from '../../src/core/vorbis/mp4'

const fixture = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/** A descriptor of the MPEG-4 kind: a tag, a length in seven-bit groups, a body. */
const descriptor = (tag: number, body: number[], longForm = false): number[] => {
  const size = longForm ? [0x80, 0x80, 0x80, body.length] : [body.length]
  return [tag, ...size, ...body]
}

/**
 * An esds around one AudioSpecificConfig. `flags` is the byte of the ES_Descriptor that says
 * which optional fields stand between it and the DecoderConfigDescriptor.
 */
const esdsOf = (config: number[], flags = 0, optional: number[] = [], longForm = false): Uint8Array => {
  const dsi = descriptor(0x05, config, longForm)
  const dcd = descriptor(0x04, [0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...dsi])
  const es = descriptor(0x03, [0, 1, flags, ...optional, ...dcd])
  // A full box: a version and three bytes of flags before the descriptor itself.
  return Uint8Array.from([0, 0, 0, 0, ...es])
}

/** AAC-LC, 44100, one channel: object type 2, frequency index 4, channel configuration 1. */
const AAC_LC = [0x12, 0x08]

describe('audioSpecificConfig', () => {
  it('reads the configuration out of a plain esds', () => {
    expect([...audioSpecificConfig(esdsOf(AAC_LC))!]).toEqual(AAC_LC)
  })

  it('steps over the optional fields of the ES_Descriptor', () => {
    // All three at once: a stream it depends on, a URL, and an OCR stream. Read as if they were
    // absent, the walk would land inside them and find no descriptor at all.
    const optional = [0, 2, 3, 0x61, 0x62, 0x63, 0, 4]
    expect([...audioSpecificConfig(esdsOf(AAC_LC, 0xe0, optional))!]).toEqual(AAC_LC)
  })

  it('reads a length written in the long form', () => {
    expect([...audioSpecificConfig(esdsOf(AAC_LC, 0, [], true))!]).toEqual(AAC_LC)
  })

  it('answers rubbish with null rather than with bytes that are not a configuration', () => {
    expect(audioSpecificConfig(new Uint8Array(0))).toBeNull()
    expect(audioSpecificConfig(Uint8Array.from([0, 0, 0, 0, 0x06, 1, 0]))).toBeNull()
    // A descriptor claiming more than the box holds.
    expect(audioSpecificConfig(Uint8Array.from([0, 0, 0, 0, 0x03, 40, 0, 1, 0]))).toBeNull()

    // The overrun that has to be caught rather than clipped: everything down to the
    // AudioSpecificConfig parses, and the configuration itself claims ten bytes where two are
    // left. Handing back the two — a truncated AudioSpecificConfig — configures a decoder with
    // half a description, which is the one thing worse than no description at all.
    const cut = [0x05, 10, ...AAC_LC]
    const overrun = Uint8Array.from([
      0, 0, 0, 0,
      ...descriptor(0x03, [0, 1, 0, ...descriptor(0x04, [0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...cut])]),
    ])
    expect(audioSpecificConfig(overrun)).toBeNull()
  })

  it('requires every descriptor in an esds to have the tag its level names', () => {
    const wrongEs = esdsOf(AAC_LC)
    wrongEs[4] = 0x06
    expect(audioSpecificConfig(wrongEs)).toBeNull()

    const wrongDecoder = esdsOf(AAC_LC)
    wrongDecoder[9] = 0x06
    expect(audioSpecificConfig(wrongDecoder)).toBeNull()

    const wrongSpecific = esdsOf(AAC_LC)
    wrongSpecific[24] = 0x06
    expect(audioSpecificConfig(wrongSpecific)).toBeNull()
    expect(audioSpecificConfig(esdsOf([]))).toBeNull()
  })
})

describe('opusHeadOf', () => {
  it('turns a dOps into the identification header WebCodecs asks for', () => {
    // dOps: version 0, two channels, pre-skip 312, 48 kHz in, gain 0, family 0 — big-endian.
    const dOps = Uint8Array.from([0, 2, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0, 0, 0])
    const head = opusHeadOf(dOps)!

    expect(head.byteLength).toBe(19)
    expect(String.fromCharCode(...head.subarray(0, 8))).toBe('OpusHead')
    // The header states version 1 where the box states 0, and its numbers are little-endian.
    expect(head[8]).toBe(1)
    expect(head[9]).toBe(2)
    expect(head[10]! | (head[11]! << 8)).toBe(312)
    expect(head[12]! | (head[13]! << 8) | (head[14]! << 16) | (head[15]! << 24)).toBe(48_000)
    expect(head[18]).toBe(0)
  })

  it('carries the channel mapping of a family that has one', () => {
    const dOps = Uint8Array.from([0, 3, 0, 0, 0, 0, 0xbb, 0x80, 0, 0, 1, 2, 1, 0, 1, 2])
    const head = opusHeadOf(dOps)!

    expect(head.byteLength).toBe(24)
    expect([...head.subarray(19)]).toEqual([2, 1, 0, 1, 2])
  })

  it('refuses a box too short to be one', () => {
    expect(opusHeadOf(Uint8Array.from([0, 2, 0]))).toBeNull()
  })
})

describe('audioDecoderConfig', () => {
  it('describes the AAC of the captured fixture', () => {
    const entry = audioSampleEntry(fixture('h264/init-stream1.m4s'))!
    const config = audioDecoderConfig(entry)!

    expect(config.codec).toBe('mp4a.40.2')
    expect(config.numberOfChannels).toBe(entry.channels)
    expect(config.sampleRate).toBe(entry.sampleRate)
    // Five bits of object type at the top of the first byte: 2 is AAC-LC.
    expect(config.description!.byteLength).toBeGreaterThan(0)
    expect(config.description![0]! >> 3).toBe(2)
  })

  it('describes the Opus that came in through WebM', () => {
    const ingested = ingestInit(fixture('webm/init-stream1.webm'), 'audio/webm; codecs="opus"')!
    const entry = audioSampleEntry(ingested.initBytes)!
    const config = audioDecoderConfig(entry)!
    const dOps = entry.children.get('dOps')!

    expect(config.codec).toBe('opus')
    // Opus always comes out at 48 kHz whatever went in, and that is what the decoder is told.
    expect(config.sampleRate).toBe(48_000)
    expect(config.numberOfChannels).toBe(entry.channels)
    expect(config.description!.byteLength).toBe(19)
    // The same pre-skip, read the other way round: the box is big-endian, the header is not.
    const skip = config.description![10]! | (config.description![11]! << 8)
    expect(skip).toBe((dOps[2]! << 8) | dOps[3]!)
  })

  it('tells the decoder 48 kHz for Opus whatever rate the entry states', () => {
    // Opus decodes at 48 kHz whatever it was fed, and the rate beside the entry is the rate that
    // went in. Handed on as it stands it makes an AudioDecoder that is wrong by a factor of
    // three. Both of our roads to an entry — our own writer and the WebM ingest — put 48 000
    // there, so a synthetic entry is the only place the rule can be caught working.
    const dOps = Uint8Array.from([0, 2, 0x01, 0x38, 0, 0, 0x3e, 0x80, 0, 0, 0])
    const entry: SampleEntry = {
      format: 'Opus',
      trackId: 1,
      codedWidth: 0,
      codedHeight: 0,
      channels: 2,
      sampleRate: 16_000,
      children: new Map([['dOps', dOps]]),
      bytes: new Uint8Array(0),
    }
    const config = audioDecoderConfig(entry)!

    expect(config.sampleRate).toBe(48_000)
    // The rate the encoder saw is not thrown away: it lives on in the header, little-endian.
    const seen = config.description!
    expect(seen[12]! | (seen[13]! << 8) | (seen[14]! << 16) | (seen[15]! << 24)).toBe(16_000)
  })

  it('describes the Vorbis of a whole Matroska', () => {
    const older = fixture('plain/watched-vp8.webm')
    const track = parseWebmInit(older)!.tracks.find((one) => one.kind === 'audio')!
    const entry = audioSampleEntry(
      buildAudioInit({
        trackId: 1,
        timescale: track.sampleRate!,
        sampleEntry: vorbisSampleEntry({
          channels: track.channels!,
          sampleRate: track.sampleRate!,
          setup: track.codecPrivate!,
        }),
      }),
    )!

    const config = audioDecoderConfig(entry)!

    // Not `mp4a.40.something`: the entry is an mp4a because Vorbis has no box of its own, and a
    // reader that stopped at the four letters would tell the decoder it was about to be handed
    // AAC and then hand it Vorbis. What settles it is the object type inside the esds.
    expect(config.codec).toBe('vorbis')
    expect(config.numberOfChannels).toBe(1)
    expect(config.sampleRate).toBe(22_050)
    // The three setup headers as the container carried them, which is the form Chromium asks for
    // — measured: `AudioDecoder.isConfigSupported` answers true for this pair and refuses the
    // same codec with no description at all.
    expect(config.description).toEqual(track.codecPrivate)
  })

  it('refuses what it cannot describe instead of guessing', () => {
    const picture = videoSampleEntry(fixture('h264/init-stream0.m4s'))!
    expect(audioDecoderConfig(picture)).toBeNull()

    const entry = audioSampleEntry(fixture('h264/init-stream1.m4s'))!
    // A guessed rate with no description is the case measured at r = 0.037: thousands of frames,
    // no error, and silence-shaped rubbish. Refusing is the whole point of the branch.
    expect(audioDecoderConfig({ ...entry, children: new Map() })).toBeNull()
    expect(audioDecoderConfig({ ...entry, channels: 0 })).toBeNull()
  })
})
