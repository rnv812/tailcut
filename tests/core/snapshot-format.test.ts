import { describe, it, expect } from 'vitest'
import {
  adler32,
  decodeFooter,
  decodeIndex,
  encodeFooter,
  encodeIndex,
  FOOTER_BYTES,
  SNAPSHOT_VERSION,
  type SnapshotIndex,
} from '../../src/core/snapshot/format'

const index: SnapshotIndex = {
  format: 'tailcut/snapshot',
  version: SNAPSHOT_VERSION,
  id: '0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31',
  capturedAt: 1_756_022_400_000,
  producer: 'tailcut 0.1.0',
  page: {
    sessionKey: 'https://site.example/watch|avc1.640028,mp4a.40.2|inf',
    url: 'https://site.example/watch?v=abc',
    title: 'Clip — site.example',
    createdAt: 1_756_022_100_000,
    lastSeenAt: 1_756_022_399_000,
    refusedTracks: false,
  },
  stores: [{ kind: 'inline' }],
  tracks: [
    {
      id: 't0',
      bufferId: 'sb-1',
      representation: 'video:avc1.640028:1920x1080',
      kinds: ['video'],
      init: { at: 0, length: 892 },
      info: {
        tracks: [
          {
            trackId: 1,
            kind: 'video',
            timescale: 90_000,
            codec: 'avc1.640028',
            width: 1920,
            height: 1080,
          },
        ],
      },
      chunks: [
        { start: 0, end: 2.002, data: { at: 892, length: 412_300 } },
        { start: 2.002, end: 4.004, data: { at: 413_192, length: 398_110 } },
      ],
    },
  ],
}

describe('adler32', () => {
  it('matches the canonical vector of the standard', () => {
    // "Wikipedia" is the check vector from the description of the algorithm: 0x11E60398.
    expect(adler32(new TextEncoder().encode('Wikipedia'))).toBe(0x11e60398)
  })

  it('is one on an empty input, and never zero', () => {
    // Nothing produces a zero, so a zero in the footer means the checksum was never computed
    // rather than that the index was empty.
    expect(adler32(new Uint8Array(0))).toBe(1)
  })

  it('notices a reordering that a modular sum would miss', () => {
    expect(adler32(new Uint8Array([1, 2, 3]))).not.toBe(adler32(new Uint8Array([3, 2, 1])))
  })

  it('does not overflow on a long input', () => {
    const long = new Uint8Array(200_000).fill(0xff)
    const sum = adler32(long)
    expect(Number.isInteger(sum)).toBe(true)
    expect(sum).toBeGreaterThanOrEqual(0)
    expect(sum).toBeLessThanOrEqual(0xffff_ffff)
  })
})

describe('the index', () => {
  it('survives encoding and decoding word for word', () => {
    expect(decodeIndex(encodeIndex(index))).toEqual(index)
  })

  it("leaves the codec's private bytes out instead of turning them into an object", () => {
    // The one field that cannot survive JSON. Left in, it would come back as {"0":1,"1":2} typed
    // as a Uint8Array, and the first reader to trust the type would get an object with no
    // `byteLength`. The init segment is in the snapshot whole, so nothing is lost.
    const first = index.tracks[0]!
    const withPrivate: SnapshotIndex = {
      ...index,
      tracks: [
        {
          ...first,
          info: {
            tracks: [{ ...first.info.tracks[0]!, codecPrivate: new Uint8Array([1, 2, 3]) }],
          },
        },
      ],
    }

    const back = decodeIndex(encodeIndex(withPrivate))
    expect(back!.tracks[0]!.info.tracks[0]!.codecPrivate).toBeUndefined()
    expect(back!.tracks[0]!.info.tracks[0]!.codec).toBe('avc1.640028')
  })

  it('lets an unknown field through: the reader may be older than the writer', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...index, peaks: [{ trackId: 't0' }] }),
    )
    const parsed = decodeIndex(bytes)
    expect(parsed).not.toBeNull()
    expect(parsed!.tracks).toHaveLength(1)
  })

  it('refuses a version from the future instead of guessing at it', () => {
    const bytes = encodeIndex({ ...index, version: SNAPSHOT_VERSION + 1 })
    expect(decodeIndex(bytes)).toBeNull()
  })

  it('refuses bytes that name another format', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...index, format: 'something/else' }))
    expect(decodeIndex(bytes)).toBeNull()
  })

  it('throws on neither rubbish nor truncated JSON', () => {
    expect(decodeIndex(new Uint8Array([0xff, 0x00, 0x7f]))).toBeNull()
    expect(decodeIndex(encodeIndex(index).subarray(0, 40))).toBeNull()
    expect(decodeIndex(new Uint8Array(0))).toBeNull()
  })

  it('refuses an index with no tracks: that is not a snapshot', () => {
    expect(decodeIndex(encodeIndex({ ...index, tracks: [] }))).toBeNull()
  })

  it('refuses a track that does not say where its init segment is', () => {
    const broken = JSON.parse(JSON.stringify(index))
    delete broken.tracks[0].init
    expect(decodeIndex(new TextEncoder().encode(JSON.stringify(broken)))).toBeNull()
  })
})

describe('the footer', () => {
  const place = { at: 1_000, length: 250 }
  const size = place.at + place.length + FOOTER_BYTES

  it('takes exactly thirty-two bytes', () => {
    expect(encodeFooter(place, 0xdead_beef).byteLength).toBe(FOOTER_BYTES)
  })

  it('gives back the place of the index and its checksum', () => {
    expect(decodeFooter(encodeFooter(place, 0xdead_beef), size)).toEqual({
      index: place,
      checksum: 0xdead_beef,
    })
  })

  it('insists the file is the size the footer promises', () => {
    // An interrupted write leaves a valid-looking trailer from an earlier attempt: the
    // signatures are there and the bytes are fewer. The size is the only thing that tells them
    // apart.
    expect(decodeFooter(encodeFooter(place, 1), size - 1)).toBeNull()
    expect(decodeFooter(encodeFooter(place, 1), size + 1)).toBeNull()
  })

  it('checks both signatures, the leading one and the trailing one', () => {
    for (const at of [0, FOOTER_BYTES - 4]) {
      const spoiled = encodeFooter(place, 1)
      spoiled[at] = 0x00
      expect(decodeFooter(spoiled, size), `the signature at ${at} is not checked`).toBeNull()
    }
  })

  it('refuses a future version in the footer before parsing anything', () => {
    const future = encodeFooter(place, 1)
    new DataView(future.buffer).setUint32(4, SNAPSHOT_VERSION + 1, true)
    expect(decodeFooter(future, size)).toBeNull()
  })

  it('refuses a tail shorter than the footer instead of reading past it', () => {
    expect(decodeFooter(new Uint8Array(10), 10)).toBeNull()
  })

  it('refuses an index of no length: the writer never got that far', () => {
    const empty = { at: 1_000, length: 0 }
    expect(decodeFooter(encodeFooter(empty, 1), empty.at + FOOTER_BYTES)).toBeNull()
  })
})
