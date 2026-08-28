import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { vp8Config, vp8ConfigOfKeyframe, vp8SampleEntry } from '../../src/core/vp8/mp4'
import { parseInit } from '../../src/core/webm/init'
import { parseClusters } from '../../src/core/webm/fragment'
import { boxBody, boxesIn, topLevelBoxes } from '../../src/core/iso/reader'
import { buildProgressiveMp4, type OutSample } from '../../src/core/iso/progressive'
import { decodeWarnings, probeFile, unexpectedWarnings, writeTemp } from '../support/media'

const load = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

const older = load('plain/watched-vp8.webm')
const picture = parseInit(older)!.tracks.find((track) => track.kind === 'video')!
const frames = parseClusters(older)
  .flatMap((cluster) => cluster.frames)
  .filter((frame) => frame.trackNumber === picture.trackId)
  .sort((a, b) => a.timestamp - b.timestamp)

const keyframe = frames.find((frame) => frame.keyframe)!.data
const interframe = frames.find((frame) => !frame.keyframe)!.data

describe('vp8ConfigOfKeyframe', () => {
  it('reads the profile and the frame size out of a real keyframe', () => {
    const config = vp8ConfigOfKeyframe(keyframe)

    expect(config).not.toBeNull()
    // libvpx encodes at version 0 unless told otherwise, and the fixture is 256 by 144.
    expect(config!.profile).toBe(0)
    expect(config!.width).toBe(256)
    expect(config!.height).toBe(144)
    // VP8 has one bit depth and one chroma subsampling and no way to state either.
    expect(config!.bitDepth).toBe(8)
    expect(config!.chromaSubsampling).toBe(1)
  })

  it('refuses a frame that is not a keyframe', () => {
    // An inter frame carries no start code and no size: reading one as a keyframe would state a
    // picture of whatever the residual bytes happened to spell.
    expect(vp8ConfigOfKeyframe(interframe)).toBeNull()

    // And the bit is read rather than left to the start code to catch. Here is the header of a
    // real keyframe with one bit turned over — everything behind it still spells a picture of
    // 256 by 144 — and it is refused for saying what it is.
    const lying = new Uint8Array(keyframe.subarray(0, 10))
    lying[0]! |= 1

    expect(vp8ConfigOfKeyframe(lying)).toBeNull()
  })

  it('refuses bytes with no VP8 start code in them', () => {
    const broken = new Uint8Array(keyframe.subarray(0, 16))
    broken[3] = 0x00

    expect(vp8ConfigOfKeyframe(broken)).toBeNull()
    expect(vp8ConfigOfKeyframe(new Uint8Array(3))).toBeNull()
  })
})

describe('vp8SampleEntry', () => {
  const entry = vp8SampleEntry(vp8ConfigOfKeyframe(keyframe)!, picture.width, picture.height)

  it('declares the track as vp08 with a vpcC behind it', () => {
    const box = topLevelBoxes(entry)[0]!
    expect(box.type).toBe('vp08')

    // A visual sample entry states 86 bytes of fields before its children.
    const vpcc = boxesIn(entry, box.start + 86, box.start + box.size).find(
      (child) => child.type === 'vpcC',
    )!
    const body = boxBody(entry, vpcc)

    // version(1) flags(3), then profile, level, and the byte that packs bit depth, chroma
    // subsampling and the range bit.
    expect(body[4]).toBe(0)
    expect(body[6]).toBe((8 << 4) | (1 << 1))
  })

  it('states the frame size the container declared', () => {
    const body = boxBody(entry, topLevelBoxes(entry)[0]!)
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)

    expect(view.getUint16(24)).toBe(256)
    expect(view.getUint16(26)).toBe(144)
  })

  it('describes a file ffmpeg reads as VP8 and decodes without a word', () => {
    const samples: OutSample[] = frames.map((frame, index) => ({
      bytes: frame.data,
      duration: (frames[index + 1]?.timestamp ?? frame.timestamp + 100) - frame.timestamp,
      cts: 0,
      sync: frame.keyframe,
    }))

    const file = writeTemp(
      'vp8-entry.mp4',
      buildProgressiveMp4([
        {
          trackId: 1,
          kind: 'video',
          timescale: 1000,
          sampleEntry: entry,
          width: picture.width,
          height: picture.height,
          samples,
          skipTicks: 0,
        },
      ]),
    )

    const probed = probeFile(file)
    expect(probed.status, probed.stderr).toBe(0)
    expect(probed.stderr).toBe('')

    const stream = probed.probed!.streams[0]!
    expect(stream.codec_name).toBe('vp8')
    expect(Number(stream.nb_read_frames)).toBe(frames.length)
    expect(unexpectedWarnings(decodeWarnings(file))).toEqual([])
  })
})

/**
 * The same record for a track described before its first frame has arrived — which is what the
 * ingest boundary has to do with a SourceBuffer.
 */
describe('vp8Config', () => {
  it('reads the version out of the long codec string when a page writes one', () => {
    expect(vp8Config('video/webm; codecs="vp08.02.10.08"', 256, 144).profile).toBe(2)
  })

  it('states the commonest version where the page wrote the bare word, as pages do', () => {
    expect(vp8Config('video/webm; codecs="vp8"', 256, 144).profile).toBe(0)
    expect(vp8Config(undefined, 256, 144).profile).toBe(0)
    // A field that is not two digits, and one naming a version the format does not have: read as
    // no statement at all rather than written into the box.
    expect(vp8Config('video/webm; codecs="vp08.x.10.08"', 256, 144).profile).toBe(0)
    expect(vp8Config('video/webm; codecs="vp08.07.10.08"', 256, 144).profile).toBe(0)
  })

  it('says the same about the shape of the stream as a keyframe does', () => {
    // Everything but the version is fixed by the format, so the record built without a frame in
    // hand and the record read out of one cannot disagree about any of it.
    const read = vp8ConfigOfKeyframe(keyframe)!
    const declared = vp8Config('video/webm; codecs="vp8"', picture.width, picture.height)

    expect(declared).toEqual({
      profile: read.profile,
      level: read.level,
      bitDepth: read.bitDepth,
      chromaSubsampling: read.chromaSubsampling,
      fullRange: read.fullRange,
      colourPrimaries: read.colourPrimaries,
      transferCharacteristics: read.transferCharacteristics,
      matrixCoefficients: read.matrixCoefficients,
    })
  })
})
