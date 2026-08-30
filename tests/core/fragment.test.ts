import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseFragment } from '../../src/core/iso/fragment'
import { parseInit } from '../../src/core/iso/init'

const init = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const seg1 = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))
const seg2 = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00002.m4s'))

// --- Synthetic moof construction ---
// The ffmpeg fixtures keep durations only in tfhd (default_sample_duration),
// so the "durations are stored in trun" branch must be constructed by hand.

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function u64(n: number): number[] {
  return [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)]
}

/** A box: four size bytes, four type bytes, then the body. */
function box(type: string, body: number[]): number[] {
  return [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body]
}

/** A moof containing mfhd followed by an arbitrary set of child boxes. */
function moofWith(children: number[]): Uint8Array {
  return new Uint8Array(box('moof', [...box('mfhd', [...u32(0), ...u32(1)]), ...children]))
}

function moof(traf: number[]): Uint8Array {
  return moofWith(box('traf', traf))
}

/**
 * Upper bound for synchronously parsing one moof. Correct code takes a few milliseconds.
 * A one-second allowance accommodates a slow machine while still catching iteration over all
 * promised sample_count entries (2^32 iterations take about 19 seconds).
 */
const PARSE_BUDGET_MS = 1000

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now()
  const value = fn()
  return { value, ms: performance.now() - start }
}

describe('parseFragment', () => {
  it('reads the start and duration of the first fragment', () => {
    // The fixture is deterministic: 48 samples of 512 ticks from tfhd.
    const f = parseFragment(seg1)!
    expect(f).not.toBeNull()
    expect(f.trackId).toBe(1)
    expect(f.baseMediaDecodeTime).toBe(0)
    expect(f.duration).toBe(24576)
  })

  it('starts the second fragment where the first one ends', () => {
    const a = parseFragment(seg1)!
    const b = parseFragment(seg2)!
    expect(b.baseMediaDecodeTime).toBe(a.baseMediaDecodeTime + a.duration)
    expect(b.baseMediaDecodeTime).toBe(24576)
  })

  it('reports a duration in seconds equal to the segment length', () => {
    const timescale = parseInit(init)!.tracks[0]!.timescale
    expect(timescale).toBe(12288)
    const seconds = parseFragment(seg1)!.duration / timescale
    expect(seconds).toBe(2)
  })

  it('returns null for an init segment', () => {
    expect(parseFragment(init)).toBeNull()
  })

  it('returns null for a moof without traf', () => {
    // The moof contains only mfhd: there is nothing to parse, and a zero fragment is invalid.
    expect(parseFragment(moofWith([]))).toBeNull()
  })

  it('returns null when traf has tfhd but no tfdt', () => {
    const tfhd = box('tfhd', [...u32(0x000008), ...u32(1), ...u32(512)])
    const trun = box('trun', [...u32(0x000001), ...u32(4), ...u32(100)])
    expect(parseFragment(moof([...tfhd, ...trun]))).toBeNull()
  })

  it('returns null when traf has tfdt but no tfhd', () => {
    const tfdt = box('tfdt', [...u32(0), ...u32(1000)])
    const trun = box('trun', [...u32(0x000101), ...u32(2), ...u32(100), ...u32(50), ...u32(50)])
    expect(parseFragment(moof([...tfdt, ...trun]))).toBeNull()
  })

  it('sums sample durations from every trun', () => {
    // tfhd has no default_sample_duration, so durations must come from trun.
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(7), ...u32(0x01010000)])
    // tfdt version 0 stores time in 32 bits.
    const tfdt = box('tfdt', [...u32(0), ...u32(1000)])
    // trun: data_offset | first_sample_flags | duration | size | cts.
    const entry = (duration: number) => [...u32(duration), ...u32(500), ...u32(0)]
    const trunFlags = 0x000b05
    const trunA = box('trun', [
      ...u32(trunFlags), ...u32(3), ...u32(100), ...u32(0x02000000),
      ...entry(100), ...entry(150), ...entry(250),
    ])
    const trunB = box('trun', [
      ...u32(trunFlags), ...u32(2), ...u32(200), ...u32(0x02000000),
      ...entry(300), ...entry(400),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trunA, ...trunB]))!
    expect(f.trackId).toBe(7)
    expect(f.baseMediaDecodeTime).toBe(1000)
    expect(f.duration).toBe(1200)
  })

  it('takes duration from tfhd when trun does not carry it', () => {
    // tfhd: base_data_offset | sample_description_index | default_sample_duration.
    const tfhd = box('tfhd', [
      ...u32(0x0000000b), ...u32(3), ...u64(1234), ...u32(1), ...u32(1024),
    ])
    const tfdt = box('tfdt', [...u32(0x01000000), ...u64(4096)])
    // trun has data_offset and size, but no durations.
    const trun = box('trun', [
      ...u32(0x000201), ...u32(5), ...u32(100),
      ...u32(500), ...u32(500), ...u32(500), ...u32(500), ...u32(500),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]))!
    expect(f.trackId).toBe(3)
    expect(f.baseMediaDecodeTime).toBe(4096)
    expect(f.duration).toBe(5120)
  })

  it('reports zero duration when neither tfhd nor trun provides one', () => {
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(4), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(77)])
    const trun = box('trun', [
      ...u32(0x000201), ...u32(3), ...u32(100), ...u32(500), ...u32(500), ...u32(500),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]))!
    expect(f.baseMediaDecodeTime).toBe(77)
    expect(f.duration).toBe(0)
  })

  it('keeps the final trun entry that ends exactly at the box boundary', () => {
    // This duration-only trun uses four-byte entries and its body ends exactly at the final entry.
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(9), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(500)])
    const trun = box('trun', [
      ...u32(0x000100), ...u32(4), ...u32(10), ...u32(20), ...u32(30), ...u32(40),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]))!
    expect(f.trackId).toBe(9)
    expect(f.baseMediaDecodeTime).toBe(500)
    expect(f.duration).toBe(100)
  })

  it('does not read past a truncated trun', () => {
    // sample_count promises five entries, but the box body contains two.
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(6), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(200)])
    const trun = box('trun', [...u32(0x000100), ...u32(5), ...u32(10), ...u32(20)])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]))!
    expect(f.baseMediaDecodeTime).toBe(200)
    expect(f.duration).toBe(30)
  })

  it('drops a trun that promises 2^32 samples in an empty body without iterating over them', () => {
    // Segment bytes come from an untrusted site, so sample_count can be arbitrary. The body ends
    // immediately after the trun header, leaving nothing to read. Iteration must stop at the first
    // entry instead of attempting 4,294,967,295 iterations.
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(1), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(0)])
    const trun = box('trun', [...u32(0x000100), ...u32(0xffffffff)])

    const { value, ms } = timed(() => parseFragment(moof([...tfhd, ...tfdt, ...trun]))!)
    expect(value.trackId).toBe(1)
    expect(value.baseMediaDecodeTime).toBe(0)
    expect(value.duration).toBe(0)
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('stops a hostile trun immediately after the last readable entry', () => {
    // The same false sample_count now accompanies two real entries. Parsing must include them and
    // stop at the body boundary instead of counting through the remainder.
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(1), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(9000)])
    const trun = box('trun', [
      ...u32(0x000100), ...u32(0xffffffff), ...u32(120), ...u32(80),
    ])

    const { value, ms } = timed(() => parseFragment(moof([...tfhd, ...tfdt, ...trun]))!)
    expect(value.baseMediaDecodeTime).toBe(9000)
    expect(value.duration).toBe(200)
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('reports a truncated trun duration normally without a truncation signal', () => {
    // This behavior is intentional: sample_count promises ten entries while the body contains
    // three. parseFragment returns only the sum it could read, which is too low, and FragmentInfo
    // has no field that marks the trun as truncated. That silently shifts the next fragment in the
    // PTS map. Changing the contract is outside this test, but the behavior must stay explicit.
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(5), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(4000)])
    const trun = box('trun', [
      ...u32(0x000100), ...u32(10), ...u32(100), ...u32(100), ...u32(100),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]))!
    expect(f.duration).toBe(300)
    // These are exactly the three FragmentInfo fields; there is no truncation signal.
    expect(Object.keys(f).sort()).toEqual(['baseMediaDecodeTime', 'duration', 'trackId'])
    // A following fragment placed by this duration starts before the true end: 4300 instead of
    // the 5000 promised by sample_count.
    expect(f.baseMediaDecodeTime + f.duration).toBe(4300)
  })

  it('accounts for sample_flags width in each trun entry', () => {
    // trun stores sample_duration and sample_flags in an eight-byte entry.
    const tfhd = box('tfhd', [...u32(0x00000020), ...u32(2), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(64)])
    const entry = (duration: number) => [...u32(duration), ...u32(0x02000000)]
    const trun = box('trun', [
      ...u32(0x000500), ...u32(3), ...entry(90), ...entry(110), ...entry(300),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]))!
    expect(f.trackId).toBe(2)
    expect(f.baseMediaDecodeTime).toBe(64)
    expect(f.duration).toBe(500)
  })

  it('takes the sample duration from the trex when neither the trun nor the tfhd states one', () => {
    // dzen.ru, measured: the trun states sizes and no durations, the tfhd states no default, and
    // the length of every sample is in the trex of the init segment — 3600 ticks of 90000.
    // Without this fall-through the fragment measures out as an instant and the picture of a
    // 92-second recording collapses to the one segment that did state its samples.
    const tfhd = box('tfhd', [...u32(0x00020020), ...u32(1), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(540000)])
    const trun = box('trun', [
      ...u32(0x000201), ...u32(3), ...u32(100), ...u32(500), ...u32(500), ...u32(500),
    ])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]), [
      { trackId: 1, defaultSampleDuration: 3600 },
    ])!
    expect(f.trackId).toBe(1)
    expect(f.baseMediaDecodeTime).toBe(540000)
    expect(f.duration).toBe(10800)
  })

  it('prefers the default of the tfhd to the one of the trex', () => {
    // ISO/IEC 14496-12 section 8.8.3 gives the fragment's own value precedence over the movie's.
    const tfhd = box('tfhd', [...u32(0x00000008), ...u32(1), ...u32(1024)])
    const tfdt = box('tfdt', [...u32(0), ...u32(0)])
    const trun = box('trun', [...u32(0x000000), ...u32(4)])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]), [
      { trackId: 1, defaultSampleDuration: 3600 },
    ])!
    expect(f.duration).toBe(4096)
  })

  it('prefers the durations of the trun to every default', () => {
    const tfhd = box('tfhd', [...u32(0x00000008), ...u32(1), ...u32(1024)])
    const tfdt = box('tfdt', [...u32(0), ...u32(0)])
    const trun = box('trun', [...u32(0x000100), ...u32(3), ...u32(10), ...u32(20), ...u32(30)])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]), [
      { trackId: 1, defaultSampleDuration: 3600 },
    ])!
    expect(f.duration).toBe(60)
  })

  it('takes the default of the track the fragment names, not of the first track declared', () => {
    const tfhd = box('tfhd', [...u32(0x00020020), ...u32(2), ...u32(0x01010000)])
    const tfdt = box('tfdt', [...u32(0), ...u32(0)])
    const trun = box('trun', [...u32(0x000201), ...u32(2), ...u32(100), ...u32(500), ...u32(500)])

    const f = parseFragment(moof([...tfhd, ...tfdt, ...trun]), [
      { trackId: 1, defaultSampleDuration: 3600 },
      { trackId: 2, defaultSampleDuration: 1023 },
    ])!
    expect(f.trackId).toBe(2)
    expect(f.duration).toBe(2046)
  })

  it('uses the first traf in a muxed moof without mixing tracks', () => {
    // A fragment describes one track. Additional traf boxes are skipped rather than folded into
    // the same duration.
    const trafOf = (trackId: number, sampleDuration: number, base: number) =>
      box('traf', [
        ...box('tfhd', [...u32(0x000008), ...u32(trackId), ...u32(sampleDuration)]),
        ...box('tfdt', [...u32(0), ...u32(base)]),
        ...box('trun', [...u32(0x000001), ...u32(4), ...u32(100)]),
      ])

    const f = parseFragment(moofWith([...trafOf(1, 512, 0), ...trafOf(2, 1024, 8)]))!
    expect(f.trackId).toBe(1)
    expect(f.baseMediaDecodeTime).toBe(0)
    expect(f.duration).toBe(2048)
  })
})
