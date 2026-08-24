import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  audioSampleEntry,
  sampleEntryBytes,
  sampleEntryOf,
  videoSampleEntry,
} from '../../src/core/iso/entry'
import { ingestInit } from '../../src/core/container'
import { findBox, boxBody } from '../../src/core/iso/reader'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

const h264Video = read('tests/fixtures/h264/init-stream0.m4s')
const h264Audio = read('tests/fixtures/h264/init-stream1.m4s')
const vp9 = read('tests/fixtures/vp9/init-stream0.m4s')
const av1 = read('tests/fixtures/av1/init-stream0.m4s')
const mediaSegment = read('tests/fixtures/h264/chunk-stream0-00001.m4s')

/** The same bytes inside a wider buffer: a view at a non-zero offset, not the buffer's owner. */
function viewWithOffset(bytes: Uint8Array): Uint8Array {
  const offset = 9
  const backing = new Uint8Array(offset + bytes.byteLength + 7).fill(0xaa)
  backing.set(bytes, offset)
  return backing.subarray(offset, offset + bytes.byteLength)
}

describe('videoSampleEntry', () => {
  it('reads the picture entry of the h264 fixture', () => {
    const entry = videoSampleEntry(h264Video)!
    expect(entry).not.toBeNull()
    expect(entry.format).toBe('avc1')
    expect(entry.trackId).toBe(1)
    // The coded size out of the entry itself, not out of the tkhd: the two differ whenever a
    // track is displayed at something other than the size it was coded at.
    expect(entry.codedWidth).toBe(320)
    expect(entry.codedHeight).toBe(240)
    expect(entry.channels).toBe(0)
    expect(entry.sampleRate).toBe(0)
    expect([...entry.children.keys()]).toEqual(['avcC', 'pasp', 'btrt'])
    // Bodies, without the eight bytes of box header: that is what a decoder configuration wants.
    expect(entry.children.get('avcC')!.byteLength).toBe(40)
    expect(entry.bytes.byteLength).toBe(170)
  })

  it('reads vp09 and av01 without being shaped around avc1', () => {
    const nine = videoSampleEntry(vp9)!
    expect(nine.format).toBe('vp09')
    expect([nine.codedWidth, nine.codedHeight]).toEqual([320, 240])
    expect([...nine.children.keys()]).toEqual(['vpcC', 'fiel', 'pasp', 'btrt'])
    expect(nine.children.get('vpcC')!.byteLength).toBe(12)

    const one = videoSampleEntry(av1)!
    expect(one.format).toBe('av01')
    expect([one.codedWidth, one.codedHeight]).toEqual([256, 144])
    expect(one.children.get('av1C')!.byteLength).toBe(17)
  })

  it('reads the entries the WebM converter writes', () => {
    const picture = ingestInit(
      read('tests/fixtures/webm/init-stream0.webm'),
      'video/webm; codecs="vp9"',
    )!
    const entry = videoSampleEntry(picture.initBytes)!
    expect(entry.format).toBe('vp09')
    expect([entry.codedWidth, entry.codedHeight]).toEqual([256, 144])
    expect([...entry.children.keys()]).toEqual(['vpcC'])
  })

  it('answers null for an init with no picture in it', () => {
    expect(videoSampleEntry(h264Audio)).toBeNull()
  })

  it('takes the entry out of a view with an offset of its own', () => {
    const straight = videoSampleEntry(h264Video)!
    const shifted = videoSampleEntry(viewWithOffset(h264Video))!
    expect(shifted.format).toBe(straight.format)
    expect([...shifted.bytes]).toEqual([...straight.bytes])
    expect([...shifted.children.get('avcC')!]).toEqual([...straight.children.get('avcC')!])
  })
})

describe('audioSampleEntry', () => {
  it('reads the sound entry of the h264 fixture', () => {
    const entry = audioSampleEntry(h264Audio)!
    expect(entry.format).toBe('mp4a')
    expect(entry.trackId).toBe(1)
    expect(entry.channels).toBe(2)
    expect(entry.sampleRate).toBe(44100)
    expect(entry.codedWidth).toBe(0)
    expect(entry.codedHeight).toBe(0)
    expect([...entry.children.keys()]).toEqual(['esds', 'btrt'])
    expect(entry.children.get('esds')!.byteLength).toBe(46)
    expect(entry.bytes.byteLength).toBe(110)
  })

  it('reads the Opus entry the WebM converter writes', () => {
    const sound = ingestInit(
      read('tests/fixtures/webm/init-stream1.webm'),
      'audio/webm; codecs="opus"',
    )!
    const entry = audioSampleEntry(sound.initBytes)!
    expect(entry.format).toBe('Opus')
    expect(entry.channels).toBe(2)
    expect(entry.sampleRate).toBe(48000)
    // The dOps is the OpusHead minus its magic, and it is what AudioDecoder wants as description.
    expect([...entry.children.keys()]).toEqual(['dOps'])
    expect(entry.children.get('dOps')!.byteLength).toBe(11)
  })

  it('answers null for an init with no sound in it', () => {
    expect(audioSampleEntry(h264Video)).toBeNull()
  })
})

describe('sampleEntryBytes', () => {
  it('hands back the entry exactly as the stsd holds it', () => {
    const stsd = findBox(h264Video, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!
    const body = boxBody(h264Video, stsd)
    const expected = body.subarray(8, 8 + 170)

    const bytes = sampleEntryBytes(h264Video, 1)!
    expect([...bytes]).toEqual([...expected])
    // Size and type in front, because a writer drops these bytes straight into its own stsd.
    expect(String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!)).toBe('avc1')
  })

  it('answers null for a track the init does not declare', () => {
    expect(sampleEntryBytes(h264Video, 7)).toBeNull()
    expect(sampleEntryOf(h264Video, 7)).toBeNull()
  })
})

describe('sample entries of bytes that are not an init', () => {
  it('answer null instead of throwing', () => {
    expect(videoSampleEntry(mediaSegment)).toBeNull()
    expect(audioSampleEntry(mediaSegment)).toBeNull()
    expect(videoSampleEntry(new Uint8Array(0))).toBeNull()
    expect(videoSampleEntry(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull()
    expect(sampleEntryBytes(new Uint8Array(0), 1)).toBeNull()
  })
})
