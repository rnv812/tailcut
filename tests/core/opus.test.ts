import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { OPUS_SAMPLE_RATE, packetSamples, parseOpusHead } from '../../src/core/opus/packets'
import { opusSampleEntry } from '../../src/core/opus/mp4'
import { parseInit } from '../../src/core/webm/init'
import { parseClusters } from '../../src/core/webm/fragment'
import { boxBody, topLevelBoxes } from '../../src/core/iso/reader'

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/** CodecPrivate of the Opus track of the WebM fixture: stereo, 312 samples of pre-skip. */
const codecPrivate = parseInit(load('webm/init-stream1.webm'))!.tracks[0]!.codecPrivate!

/**
 * A TOC byte out of its three fields: the configuration number, the stereo bit and the code that
 * says how many frames follow. Written out rather than hard-coded, because what the tests below
 * are about is exactly which bits of the byte carry what.
 */
const toc = (config: number, stereo: boolean, code: number): number =>
  (config << 3) | (stereo ? 0x04 : 0) | code

const packet = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes)

describe('packetSamples', () => {
  it('reads the length of the packets of a real Opus stream', () => {
    const frames = parseClusters(load('webm/chunk-stream1-00001.webm')).flatMap((c) => c.frames)

    expect(frames.length).toBeGreaterThan(50)
    // ffmpeg encodes at the default frame length, and 20 ms of 48 kHz is 960 samples. Every
    // packet of the fixture is one such frame, whichever mode the encoder chose for it.
    expect([...new Set(frames.map((frame) => packetSamples(frame.data)))]).toEqual([960])
  })

  it.each([
    ['SILK narrowband, 10 ms', 0, 480],
    ['SILK narrowband, 60 ms', 3, 2880],
    ['SILK wideband, 20 ms', 9, 960],
    ['hybrid super-wideband, 10 ms', 12, 480],
    ['hybrid fullband, 20 ms', 15, 960],
    ['CELT narrowband, 2.5 ms', 16, 120],
    ['CELT fullband, 20 ms', 31, 960],
  ])('reads a single frame of configuration %s', (_name, config, samples) => {
    expect(packetSamples(packet(toc(config, true, 0)))).toBe(samples)
  })

  it.each([
    ['two frames of one size', 1],
    ['two frames of different sizes', 2],
  ])('doubles the length for a packet of %s', (_name, code) => {
    expect(packetSamples(packet(toc(9, true, code)))).toBe(1920)
  })

  it('reads the frame count of an arbitrary-length packet out of the byte after the TOC', () => {
    // Six frames of 20 ms: 120 ms, which is the longest a packet may be.
    expect(packetSamples(packet(toc(9, true, 3), 6))).toBe(6 * 960)
  })

  it('ignores the padding and VBR bits of the frame-count byte', () => {
    // The two top bits say the packet is padded and variable-rate; only the low six count frames.
    expect(packetSamples(packet(toc(9, true, 3), 0xc0 | 3))).toBe(3 * 960)
  })

  it.each([
    ['an empty payload', packet()],
    ['a promised frame count that never arrives', packet(toc(9, true, 3))],
    ['a frame count of zero', packet(toc(9, true, 3), 0)],
    ['a packet longer than the 120 ms the codec allows', packet(toc(3, true, 3), 3)],
  ])('gives no length at all for %s', (_name, bytes) => {
    expect(packetSamples(bytes)).toBe(0)
  })

  it('reads a packet lying inside a wider buffer, not the buffer under it', () => {
    const backing = Uint8Array.from([0xaa, 0xaa, toc(9, true, 0), 0xbb])
    expect(packetSamples(backing.subarray(2, 3))).toBe(960)
  })
})

describe('parseOpusHead', () => {
  it('reads the header of the fixture', () => {
    expect(parseOpusHead(codecPrivate)).toEqual({
      channels: 2,
      preSkip: 312,
      inputSampleRate: 48000,
      outputGain: 0,
      mappingFamily: 0,
      streamCount: 1,
      coupledCount: 1,
      channelMapping: [],
    })
  })

  it('reads the multi-byte fields little-endian, as the Ogg header writes them', () => {
    // Pre-skip 0x0138 is written 38 01, and a byte order read the other way round would make it
    // 0x3801 — fourteen thousand samples of silence cut off the front of the stream.
    expect(codecPrivate[10]).toBe(0x38)
    expect(codecPrivate[11]).toBe(0x01)
    expect(parseOpusHead(codecPrivate)!.preSkip).toBe(312)
  })

  it('reads a negative output gain as a signed number', () => {
    const bytes = Uint8Array.from(codecPrivate)
    bytes.set([0x00, 0xff], 16) // -256 in two's complement, little-endian
    expect(parseOpusHead(bytes)!.outputGain).toBe(-256)
  })

  it('reads the mapping table of a multichannel header', () => {
    const head = Uint8Array.from([
      ...[0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], // "OpusHead"
      1, // version
      4, // channels
      0, 0, // pre-skip
      0x80, 0xbb, 0x00, 0x00, // input sample rate, little-endian
      0, 0, // output gain
      1, // mapping family
      3, // stream count
      1, // coupled count
      0, 1, 2, 3, // channel mapping
    ])

    expect(parseOpusHead(head)).toMatchObject({
      channels: 4,
      mappingFamily: 1,
      streamCount: 3,
      coupledCount: 1,
      channelMapping: [0, 1, 2, 3],
    })
  })

  it.each([
    ['bytes that do not open with the magic', () => Uint8Array.from(codecPrivate).fill(0, 0, 1)],
    ['a header cut short', () => codecPrivate.subarray(0, 18)],
    ['a major version this reader does not know', () => setByte(8, 0x10)],
    ['a channel count of zero', () => setByte(9, 0)],
    ['more than two channels under mapping family zero', () => setByte(9, 3)],
    ['a mapping table the header ends before', () => Uint8Array.from([...setByte(18, 1)])],
  ])('refuses %s', (_name, make) => {
    expect(parseOpusHead(make())).toBeNull()
  })
})

/** The fixture's header with one byte replaced — the shortest way to write a broken one. */
function setByte(at: number, value: number): Uint8Array {
  const bytes = Uint8Array.from(codecPrivate)
  bytes[at] = value
  return bytes
}

describe('opusSampleEntry', () => {
  const entry = opusSampleEntry(parseOpusHead(codecPrivate)!)

  /** The one box the sample entry is built around, found where an mp4 reader would find it. */
  const dOps = (): Uint8Array => {
    const box = topLevelBoxes(entry)[0]!
    // The children of a sample entry start past the fixed AudioSampleEntry fields, and the reader
    // has no notion of that layout — hence the offset spelled out here.
    const inside = entry.subarray(box.headerSize + 28)
    return boxBody(inside, topLevelBoxes(inside)[0]!)
  }

  it('names the track by the four letters an mp4 declares Opus with', () => {
    expect(topLevelBoxes(entry)[0]!.type).toBe('Opus')
  })

  it('states the rate Opus decodes at, whatever the material was recorded at', () => {
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
    // channelcount, then samplesize, then two reserved fields, then the 16.16 sample rate.
    expect(view.getUint16(8 + 16)).toBe(2)
    expect(view.getUint32(8 + 24) / 0x10000).toBe(OPUS_SAMPLE_RATE)
  })

  it('writes the OpusHead into dOps big-endian, the way the rest of an mp4 is written', () => {
    // Version, channels, pre-skip 312, input rate 48000, gain 0, mapping family 0.
    expect([...dOps()]).toEqual([0, 2, 0x01, 0x38, 0x00, 0x00, 0xbb, 0x80, 0, 0, 0])
  })

  it('leaves the mapping table out for family zero and writes it for every other family', () => {
    expect(dOps().byteLength).toBe(11)

    const many = opusSampleEntry({
      channels: 3,
      preSkip: 0,
      inputSampleRate: 48000,
      outputGain: 0,
      mappingFamily: 1,
      streamCount: 2,
      coupledCount: 1,
      channelMapping: [0, 1, 2],
    })
    const box = topLevelBoxes(many)[0]!
    const inside = many.subarray(box.headerSize + 28)
    // Mapping family, stream count, coupled count, then one byte per output channel.
    expect([...boxBody(inside, topLevelBoxes(inside)[0]!)].slice(-6)).toEqual([1, 2, 1, 0, 1, 2])
  })

  it('holds dOps and nothing else', () => {
    const inside = entry.subarray(topLevelBoxes(entry)[0]!.headerSize + 28)
    expect(topLevelBoxes(inside).map((b) => b.type)).toEqual(['dOps'])
  })
})
