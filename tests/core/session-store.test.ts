import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  MAX_PROBATION_BYTES,
  SessionStore,
  selectMaterial,
  summarize,
  type Session,
} from '../../src/bridge/session-store'
import { sessionKey } from '../../src/core/session-key'
import { parseInit } from '../../src/core/iso/init'
import { parseFragment } from '../../src/core/iso/fragment'
import type { MuxTrack } from '../../src/core/mux'
import type { Chunk } from '../../src/shared/types'

const init = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const seg1 = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))
const seg2 = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00002.m4s'))
/** Audio of the same stream: its own init with its own codec (mp4a) and its own timescale. */
const audioInit = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream1.m4s'))
/** The same clip in another codec: this is what a switch of representation looks like. */
const vp9Init = new Uint8Array(readFileSync('tests/fixtures/vp9/init-stream0.m4s'))
const vp9Seg = new Uint8Array(readFileSync('tests/fixtures/vp9/chunk-stream0-00001.m4s'))
/** Second segment of the vp9 fixture: 2…4 seconds, the same timescale of 12288. */
const vp9Seg2 = new Uint8Array(readFileSync('tests/fixtures/vp9/chunk-stream0-00002.m4s'))
/**
 * The header of a Common Encryption stream: `encv` in place of `avc1`, with `sinf`, `schm` and
 * `tenc` inside it. The same picture as the h264 set and from the same source — the difference
 * between the two is protection and nothing else.
 */
const cencInit = new Uint8Array(readFileSync('tests/fixtures/cenc/init-stream0.m4s'))

/**
 * The same clip delivered in the other container: an Opus track in WebM, which is what a real
 * site serves its sound as. Four media segments running 0…6.001 seconds.
 */
const webmAudioInit = new Uint8Array(readFileSync('tests/fixtures/webm/init-stream1.webm'))
const webmAudioSegs = [1, 2, 3, 4].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/webm/chunk-stream1-0000${n}.webm`)),
)
/** A WebM video track: the case the ingest boundary refuses rather than half-supports. */
const webmVideoInit = new Uint8Array(readFileSync('tests/fixtures/webm/init-stream0.webm'))
const webmVideoSeg = new Uint8Array(readFileSync('tests/fixtures/webm/chunk-stream0-00001.webm'))

/**
 * A clip whose two tracks are cut into segments of different length: the picture into six-second
 * ones, the sound into five-second ones. That is the ordinary shape of a real site — YouTube
 * packages its sound in longer pieces than its picture and downloads it further ahead — and the
 * only shape in which one buffer's last segment can reach far past where the other's material
 * ends.
 */
const aheadVideoInit = new Uint8Array(readFileSync('tests/fixtures/minute/init-stream0.m4s'))
/** Two segments of six seconds: 0…12. */
const aheadVideoSegs = [1, 2].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/minute/chunk-stream0-0000${n}.m4s`)),
)
const aheadAudioInit = new Uint8Array(readFileSync('tests/fixtures/minute/init-stream1.m4s'))
/** Three segments of five seconds: 0…15.0465, the last of them mostly past the picture. */
const aheadAudioSegs = [1, 2, 3].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/minute/chunk-stream1-0000${n}.m4s`)),
)

/** Video track of the h264 fixture: timescale 12288, three segments of two seconds each. */
const videoSegs = [1, 2, 3].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/h264/chunk-stream0-0000${n}.m4s`)),
)
/** Audio track of the same clip: timescale 44100, four segments up to 6.0232 seconds. */
const audioSegs = [1, 2, 3, 4].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/h264/chunk-stream1-0000${n}.m4s`)),
)

const page = {
  sourceId: 's1',
  bufferId: 'b1',
  url: 'https://site.example/watch?v=abc',
  title: 'Clip',
  now: 1000,
}

/** The one track of a single-track session — most of the set works with exactly that. */
const only = (session: Session) => session.tracks[0]!

/**
 * A chunk in a form a failing assertion can print: comparing whole segments of tens of kilobytes
 * costs nothing while they match, but printing the difference between two of them takes minutes.
 * The byte lengths of the fixtures differ, so they name the segment just as precisely.
 */
const shapeOf = (chunk: Chunk) => [chunk.start, chunk.end, chunk.bytes.byteLength]

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i])

/** Codecs a session holds, whatever track they sit on. */
const codecsOf = (session: Session) =>
  session.tracks.flatMap((t) => t.info.tracks.map((iso) => iso.codec)).sort()

// --- Building synthetic segments ---
// The ffmpeg fixtures are single-track, so choosing a track for a fragment (and the fallback
// when the trackId matches nothing) has to be assembled by hand. A muxed fMP4 — one video track
// and one audio track in a shared init — is a perfectly ordinary layout.

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

const chars = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))
const zeros = (count: number): number[] => new Array<number>(count).fill(0)

/** A box: four bytes of size, four bytes of type, body. */
function box(type: string, ...parts: number[][]): number[] {
  const body = parts.flat()
  return [...u32(8 + body.length), ...chars(type), ...body]
}

/**
 * A media segment of a protected stream: a track fragment with a `senc` beside its `trun`.
 *
 * Built here because no fixture holds one — ffmpeg writes the samples of a fragmented file
 * encrypted and leaves the `senc` out, so a real file would be evidence of nothing. What is under
 * test is the recognition of the box, and nothing here is decrypted or has to be.
 */
const sencFragment = Uint8Array.from([
  ...box('styp', chars('msdh'), u32(0)),
  ...box(
    'moof',
    box('mfhd', u32(0), u32(1)),
    box('traf', box('tfhd', u32(0), u32(1)), box('senc', u32(0), u32(0))),
  ),
  ...box('mdat', zeros(8)),
])

/** A trak with its fields at exactly the offsets parseInit reads them from. */
function trak(
  trackId: number,
  timescale: number,
  handler: string,
  codec: string,
  width = 320,
  height = 240,
): number[] {
  return box(
    'trak',
    // tkhd v0: version+flags, times, track_id, tail up to matrix, matrix, width, height
    box('tkhd', zeros(12), u32(trackId), zeros(24), zeros(36), u32(width * 65536), u32(height * 65536)),
    box(
      'mdia',
      // mdhd v0: version+flags, times, timescale, duration+language+pre_defined
      box('mdhd', zeros(12), u32(timescale), zeros(8)),
      // hdlr: version+flags, pre_defined, handler_type, reserved
      box('hdlr', zeros(8), chars(handler), zeros(12)),
      // stsd: version+flags, entry_count, sample entry — its type is the codec
      box('minf', box('stbl', box('stsd', zeros(4), u32(1), box(codec, zeros(8))))),
    ),
  )
}

/** A muxed init: video with one timescale, audio with another. */
const muxedInit = new Uint8Array(
  box('moov', ...[trak(1, 1000, 'vide', 'avc1'), trak(2, 8000, 'soun', 'mp4a')]),
)
const muxedPage = { ...page, url: 'https://site.example/watch?v=muxed' }

/**
 * The same picture at two qualities: one codec, two frame sizes, two timescales. This is what an
 * ABR switch delivers, and the timescales differ so that a fragment read against the wrong init
 * gives itself away by its times rather than by its bytes.
 */
const sdInit = new Uint8Array(box('moov', trak(1, 1000, 'vide', 'avc1', 640, 360)))
const hdInit = new Uint8Array(box('moov', trak(1, 90_000, 'vide', 'avc1', 1280, 720)))
const abrPage = { ...page, url: 'https://site.example/watch?v=abr' }

/** The same init with a harmless tail: same codecs, other bytes — a swap would show. */
const initWithTail = new Uint8Array([...init, ...box('free', zeros(4))])

/**
 * A media segment whose duration sits in tfhd: trun only gives the number of samples.
 *
 * The mdat behind the moof is what makes it a segment rather than a header: a stream is read as
 * the byte stream it is, and a moof closes nothing — the mdat its samples live in does.
 */
function moof(trackId: number, baseTime: number, samples: number, sampleDuration: number) {
  return new Uint8Array([
    ...box(
      'moof',
      box(
        'traf',
        // tfhd with the default_sample_duration flag (0x08)
        box('tfhd', u32(0x08), u32(trackId), u32(sampleDuration)),
        box('tfdt', u32(0), u32(baseTime)),
        box('trun', u32(0), u32(samples)),
      ),
    ),
    ...box('mdat', zeros(16)),
  ])
}

describe('SessionStore', () => {
  it('opens a session on an init segment', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).info.tracks[0]!.codec).toBe('avc1')
  })

  it('puts fragments on the map by media time', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })
    store.append({ ...page, bytes: seg2 })

    const track = only(store.list()[0]!)
    expect(track.map.runs()).toHaveLength(1)
    expect(track.map.duration()).toBeGreaterThan(3)
  })

  it('ignores a fragment without an init instead of breaking the parse', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: seg1 })
    expect(store.list()).toHaveLength(0)
  })

  it('merges a page reload into the same session', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    // A new source, the same address with a rewind mark
    store.append({ ...page, sourceId: 's2', url: page.url + '&t=30', bytes: init, now: 2000 })
    store.append({ ...page, sourceId: 's2', bytes: seg2, now: 2000 })

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks).toHaveLength(2)
  })

  it('opens a separate session for another video', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({
      ...page,
      sourceId: 's2',
      url: 'https://site.example/watch?v=other',
      bytes: init,
    })

    expect(store.list()).toHaveLength(2)
  })

  it('lists the freshest session first', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init, now: 1000 })
    store.append({
      ...page,
      sourceId: 's2',
      url: 'https://site.example/watch?v=b',
      bytes: init,
      now: 5000,
    })

    expect(store.list()[0]!.url).toContain('v=b')
  })
})

describe('SessionStore: what ends up in a session', () => {
  it('remembers the init segment whole: without it there is nothing to build a file from', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    expect(only(store.list()[0]!).initBytes).toEqual(init)
  })

  it('does not put the init itself on the map', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // An init is the header of a track, not a stretch of time: on the map it would take up room
    // and go into the file a second time.
    expect(only(store.list()[0]!).map.runs()).toEqual([])
    expect(only(store.list()[0]!).map.totalBytes()).toBe(0)
  })

  it('carries the address and the title of the page into the session', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // The popup signs sessions with these two strings, and they are taken from the page that
    // sent the bytes.
    expect(store.list()[0]).toMatchObject({ url: page.url, title: 'Clip' })
  })

  it('takes on the page title that arrived after the session had opened', () => {
    const store = new SessionStore()
    // Recording starts at document_start, where <head> is not parsed yet, and a single-page
    // application fills its <title> in later still. The session opens nameless, and on YouTube
    // that is the ordinary case rather than the exception.
    store.append({ ...page, title: '', bytes: init })
    expect(store.list()[0]!.title).toBe('')

    store.retitle(page.url, 'Real title')

    // Without this the popup signs the session "Untitled" and the saved file is named after
    // nothing, though the page has been telling its title all along.
    expect(store.list()[0]!.title).toBe('Real title')
  })

  it('recognises the address of a retitled session through the referral marks', () => {
    const store = new SessionStore()
    store.append({ ...page, title: '', bytes: init })

    // The address the title arrives with carries a rewind mark the address of the first segment
    // did not. Compare the two literally and the session stays nameless on every rewind.
    store.retitle(`${page.url}&t=42`, 'Real title')

    expect(store.list()[0]!.title).toBe('Real title')
  })

  it('leaves the title of another video alone', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // A feed of short clips moves on without a navigation: the title that comes now belongs to
    // the next video, while the material of this session belongs to the previous one.
    store.retitle('https://site.example/watch?v=next', 'Next clip')

    expect(store.list()[0]!.title).toBe('Clip')
  })

  it('does not erase a known title with an empty one', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // Between two videos a player blanks its <title> for a moment. Taking that at face value
    // would cost the session the name it already had.
    store.retitle(page.url, '')

    expect(store.list()[0]!.title).toBe('Clip')
  })

  it('puts the bytes of a fragment and its times in seconds on the map', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })
    store.append({ ...page, bytes: seg2 })

    // Fixture: timescale 12288, 24576 ticks per fragment — exactly two seconds each. Exact
    // times rather than "greater than zero": a missing division by the timescale would slip by.
    expect(only(store.list()[0]!).map.runs()).toEqual([
      {
        start: 0,
        end: 4,
        chunks: [
          { start: 0, end: 2, bytes: seg1 },
          { start: 2, end: 4, bytes: seg2 },
        ],
      },
    ])
  })

  it('does not round fractional times to whole seconds', () => {
    const store = new SessionStore()
    store.append({ ...muxedPage, bytes: muxedInit })

    // The video track of the muxed init runs at timescale 1000: tick 500 is half a second, and
    // three samples of 100 ticks are three tenths. The ffmpeg fixtures divide by their timescale
    // exactly, so on them rounding to whole seconds is indistinguishable from real division; in
    // a live stream almost nothing divides exactly.
    store.append({ ...muxedPage, bytes: moof(1, 500, 3, 100) })

    expect(only(store.list()[0]!).map.runs()).toEqual([
      { start: 0.5, end: 0.8, chunks: [{ start: 0.5, end: 0.8, bytes: expect.any(Uint8Array) }] },
    ])
  })

  it('keeps adjacent segments of fractional duration in one run', () => {
    const store = new SessionStore()
    const cmaf = { ...page, url: 'https://site.example/watch?v=cmaf' }
    // An ordinary CMAF layout: timescale 90000 and segments of 172683 ticks, that is 1.9187
    // seconds each — not one boundary falls on a whole second.
    store.append({ ...cmaf, bytes: new Uint8Array(box('moov', trak(1, 90_000, 'vide', 'avc1'))) })
    for (const at of [0, 172_683, 345_366]) {
      store.append({ ...cmaf, bytes: moof(1, at, 1, 172_683) })
    }

    // This is how an error in converting ticks shows on a live site: round the start down and
    // the pieces overlap, making a continuous buffer look ragged; round both values and the cut
    // boundaries drift by fractions of a second away from what is really on the map.
    expect(only(store.list()[0]!).map.runs()).toHaveLength(1)
    expect(only(store.list()[0]!).map.span()).toEqual({ start: 0, end: 5.7561 })
    expect(only(store.list()[0]!).map.duration()).toBe(5.7561)
  })

  it('keys the session exactly as sessionKey does', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // The duration is unknown at this stage, so the key says "live": the session is glued
    // together by the address and the codecs.
    const expected = sessionKey({ url: page.url, codecs: ['avc1'], durationSeconds: Infinity })
    expect(store.list()[0]!.key).toBe(expected)
    expect(store.get(expected)).toBe(store.list()[0])
  })

  it('does not invent a session for an unknown key', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    expect(store.get('no such key')).toBeUndefined()
  })

  it('takes the codecs of every track into the key, not only of the first', () => {
    const store = new SessionStore()
    store.append({ ...muxedPage, bytes: muxedInit })

    // A muxed init: video and audio in one representation. Cut the list down to the first codec
    // and a video-only avc1 from the same address would get the same key as avc1+mp4a: two
    // different representations would pile up on one map, and no file could be built from it.
    expect(store.list()[0]!.key).toBe(
      sessionKey({ url: muxedPage.url, codecs: ['avc1', 'mp4a'], durationSeconds: Infinity }),
    )
  })

  it('opens a session by the moov of an init glued to the first fragment', () => {
    const store = new SessionStore()

    // A self-initialising segment: moov and the first moof in one appendBuffer. The buffer is
    // read as the byte stream it is, so both come out of it — the init opens the session and the
    // fragment behind it lands on the map, without the moov being carried along into it.
    store.append({ ...page, bytes: new Uint8Array([...init, ...seg1]) })

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).info.tracks[0]!.codec).toBe('avc1')
    expect(only(store.list()[0]!).map.runs().map((r) => [r.start, r.end])).toEqual([[0, 2]])
    // The fragment alone: the moov is in initBytes already, and a file built with it twice over
    // is not a file.
    expect(only(store.list()[0]!).map.runs()[0]!.chunks.map(shapeOf)).toEqual([
      [0, 2, seg1.byteLength],
    ])
  })

  it('opens a separate session for another media source at the same address', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, sourceId: 's2', bytes: audioInit })

    // Two MediaSource objects are two players, whatever they play. The key is built from the
    // address and the codecs of one source, and here the sets differ: the sessions are separate.
    // The two tracks of one video look different — same sourceId, different bufferId.
    expect(store.list()).toHaveLength(2)
    expect(store.list().flatMap(codecsOf).sort()).toEqual(['avc1', 'mp4a'])
  })
})

/**
 * The third component of the merge key (§6.1), and the one the registry used to leave unsaid.
 *
 * The address and the codecs alone tell two videos apart only where the address changes from one
 * to the next. On a feed it does not: measured on tiktok.com/foryou, where location.href stays
 * «https://www.tiktok.com/foryou» through the whole scroll, seven clips — a MediaSource each —
 * came out as ONE session under the key «…/foryou|avc1,mp4a|live», their fragments piled onto one
 * map, and the saved file held 2441 packets with 18 backward jumps of DTS; Chromium stopped on it
 * at 2.28 seconds without drawing a frame. The same collision, half hidden behind a stale address,
 * turned four YouTube shorts into three sessions.
 *
 * What the page states about the length is the thing that differs between two clips of one feed
 * and stays put across a reload of one clip, so that is what goes into the key.
 */
describe('SessionStore: the length of the video in the merge key', () => {
  const feed = 'https://feed.example/foryou'
  const clip = { ...page, url: feed }

  it('does not merge two clips of a feed that the address cannot tell apart', () => {
    const store = new SessionStore()

    store.append({ ...clip, bytes: init })
    store.setDuration('s1', 6.845)
    store.append({ ...clip, bytes: seg1 })

    store.append({ ...clip, sourceId: 's2', bytes: init })
    store.setDuration('s2', 60.0)
    store.append({ ...clip, sourceId: 's2', bytes: seg1 })

    expect(store.list(), 'two clips of the feed collapsed into one session').toHaveLength(2)
  })

  it('keeps the fragments of the two clips on maps of their own', () => {
    const store = new SessionStore()

    store.append({ ...clip, bytes: init })
    store.setDuration('s1', 6.845)
    store.append({ ...clip, bytes: seg1 })

    store.append({ ...clip, sourceId: 's2', bytes: init })
    store.setDuration('s2', 60.0)
    // The second clip starts from zero as every clip does. On one map its first fragment lands
    // beside the first fragment of the other and the muxer writes them one after another — that
    // is the backward jump of DTS the file was measured to hold.
    store.append({ ...clip, sourceId: 's2', bytes: seg1 })

    expect(store.list().map((s) => only(s).map.runs().flatMap((r) => r.chunks.map(shapeOf)))).toEqual(
      [
        [[0, 2, seg1.byteLength]],
        [[0, 2, seg1.byteLength]],
      ],
    )
  })

  it('takes the length into the key exactly as sessionKey spells it', () => {
    const store = new SessionStore()
    store.append({ ...clip, bytes: init })
    store.setDuration('s1', 6.845)

    expect(store.list()[0]!.key).toBe(
      sessionKey({ url: feed, codecs: ['avc1'], durationSeconds: 6.845 }),
    )
    expect(store.get(store.list()[0]!.key)).toBe(store.list()[0])
  })

  it('re-keys a session opened before the page stated the length', () => {
    const store = new SessionStore()
    store.append({ ...clip, bytes: init })
    store.append({ ...clip, bytes: seg1 })

    // A player states the duration when it has read its manifest, which may be after the first
    // init segment has already opened the session. The material stays where it is; only the key
    // it will be asked for from now on changes.
    store.setDuration('s1', 6.845)

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.key).toBe(
      sessionKey({ url: feed, codecs: ['avc1'], durationSeconds: 6.845 }),
    )
    expect(only(store.list()[0]!).map.runs()[0]!.chunks.map(shapeOf)).toEqual([
      [0, 2, seg1.byteLength],
    ])
  })

  it('keeps a length stated before the first init segment', () => {
    const store = new SessionStore()
    // The player sets the duration inside `sourceopen`, which on the sites this was measured on
    // comes before it appends anything at all.
    store.setDuration('s1', 6.845)
    store.append({ ...clip, bytes: init })

    expect(store.list()[0]!.key).toBe(
      sessionKey({ url: feed, codecs: ['avc1'], durationSeconds: 6.845 }),
    )
  })

  it('merges a reload of the same clip, which is what the key exists for', () => {
    const store = new SessionStore()
    store.append({ ...clip, bytes: init })
    store.setDuration('s1', 6.845)
    store.append({ ...clip, bytes: seg1 })

    // The same video seen again: a new MediaSource, a rewind mark in the address, the same length.
    store.append({ ...clip, sourceId: 's2', url: `${feed}?t=3`, bytes: init, now: 2000 })
    store.setDuration('s2', 6.845)
    store.append({ ...clip, sourceId: 's2', url: `${feed}?t=3`, bytes: seg2, now: 2000 })

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks).toHaveLength(2)
  })

  it('does not split a session over a length restated within the same second', () => {
    const store = new SessionStore()
    store.append({ ...clip, bytes: init })
    store.setDuration('s1', 6.845)
    store.append({ ...clip, bytes: seg1 })

    // dash.js restates the duration on every manifest update, and a live-edge refinement moves it
    // by milliseconds. The key rounds to whole seconds, so nothing here is news.
    const key = store.list()[0]!.key
    store.setDuration('s1', 6.851)
    store.append({ ...clip, bytes: seg2 })

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.key).toBe(key)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks).toHaveLength(2)
  })

  it('says nothing of a length that says nothing: a live stream and an unread manifest', () => {
    const store = new SessionStore()
    store.append({ ...clip, bytes: init })
    const live = store.list()[0]!.key

    store.setDuration('s1', Infinity)
    store.setDuration('s1', NaN)
    store.setDuration('s1', 0)

    expect(store.list()[0]!.key).toBe(live)
    expect(live).toBe(sessionKey({ url: feed, codecs: ['avc1'], durationSeconds: Infinity }))
  })

  it('keys the session by a length stated while the source was under a rejection', () => {
    const store = new SessionStore()
    store.append({ ...clip, bytes: init })
    store.dropPending('s1')
    store.append({ ...clip, bytes: seg1 })

    // The verdict took the session out of the registry, so there was none to re-key at the time.
    // The length stays on the source, and the session it is given back gets it.
    store.setDuration('s1', 6.845)
    store.promotePending('s1')

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.key).toBe(
      sessionKey({ url: feed, codecs: ['avc1'], durationSeconds: 6.845 }),
    )
    expect(only(store.list()[0]!).map.runs()[0]!.chunks.map(shapeOf)).toEqual([
      [0, 2, seg1.byteLength],
    ])
  })

  it('breaks nothing on a length stated about a source nobody has heard of', () => {
    const store = new SessionStore()
    expect(() => store.setDuration('nobody', 12)).not.toThrow()
    expect(store.list()).toEqual([])
  })

  it('takes no length from a page that played protected media', () => {
    const store = new SessionStore()
    store.append({ ...clip, bytes: init })
    store.refuseEncrypted()

    store.setDuration('s1', 6.845)
    store.append({ ...clip, bytes: seg1 })

    expect(store.list()).toEqual([])
  })
})

describe('SessionStore: a stream appended in slices', () => {
  /**
   * What YouTube does: a SourceBuffer is handed the download as it arrives rather than a segment
   * at a time, and the pieces are sixteen kilobytes each. Read piece by piece, the picture keeps
   * the few appends that happen to begin with a moof — in half, without the mdat their samples
   * live in — and the sound, whose WebM init is cut in two, opens no track at all.
   */
  const slices = (data: Uint8Array, size: number): Uint8Array[] => {
    const out: Uint8Array[] = []
    for (let at = 0; at < data.byteLength; at += size) {
      out.push(data.subarray(at, Math.min(at + size, data.byteLength)))
    }
    return out
  }

  const feed = (store: SessionStore, where: typeof page, parts: Uint8Array[], size: number) => {
    for (const part of parts) {
      for (const slice of slices(part, size)) store.append({ ...where, bytes: slice })
    }
  }

  it('collects the same material as the same stream appended whole', () => {
    const whole = new SessionStore()
    feed(whole, page, [init, ...videoSegs], Number.MAX_SAFE_INTEGER)

    const sliced = new SessionStore()
    feed(sliced, page, [init, ...videoSegs], 16 * 1024)

    const runs = (store: SessionStore) =>
      only(store.list()[0]!).map.runs().flatMap((r) => r.chunks.map(shapeOf))

    expect(runs(sliced)).toEqual(runs(whole))
    expect(runs(sliced)).toEqual([[0, 2, videoSegs[0]!.byteLength],
      [2, 4, videoSegs[1]!.byteLength], [4, 6, videoSegs[2]!.byteLength]])
  })

  it('opens a WebM track whose init was cut across two appends', () => {
    const store = new SessionStore()
    // The init of YouTube's Opus stream is a couple of hundred bytes, and the boundary of the
    // download falls inside it as readily as anywhere else.
    feed(store, page, [webmAudioInit, ...webmAudioSegs], 64)

    const session = store.list()[0]!
    expect(session.tracks.map((t) => t.kinds)).toEqual([['audio']])
    expect(only(session).map.runs()).toHaveLength(1)
    expect(only(session).map.duration()).toBeGreaterThan(5.9)
  })

  it('gathers both tracks of a page that slices each of them', () => {
    const store = new SessionStore()
    const video = { ...page, bufferId: 'b1' }
    const audio = { ...page, bufferId: 'b2' }

    feed(store, video, [init, ...videoSegs], 4096)
    feed(store, audio, [webmAudioInit, ...webmAudioSegs], 4096)

    const session = store.list()[0]!
    expect(session.tracks.map((t) => t.kinds)).toEqual([['video'], ['audio']])
    // Every kind is there over the whole of the shared stretch, which is what a saved file is.
    expect(summarize(session).duration).toBeGreaterThan(5.9)
    expect(selectMaterial(session).map((m) => m.segments.length)).toEqual([3, 4])
  })
})

describe('SessionStore: foreign and broken data', () => {
  it('lands a fragment from an unknown source nowhere', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // A source whose init never arrived: a second player on the page whose beginning we missed.
    // Dumping its segments into the only open session would mix two streams.
    store.append({ ...page, sourceId: 's2', bytes: seg1 })

    expect(only(store.list()[0]!).map.runs()).toEqual([])
  })

  it('lands a fragment from an unknown buffer of a known source nowhere', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // The same media source, a buffer whose init never arrived: WebM audio, for instance, which
    // the parser does not read. Its bytes have no track and no timescale of their own, and the
    // neighbouring track would scatter them across a timeline of a foreign timescale.
    store.append({ ...page, bufferId: 'b2', bytes: seg1 })

    expect(only(store.list()[0]!).map.runs()).toEqual([])
  })

  const junk: [string, Uint8Array][] = [
    ['an empty buffer', new Uint8Array(0)],
    ['a scrap of a header', new Uint8Array([0, 0, 0, 4])],
    ['text instead of boxes', new Uint8Array(chars('<!doctype html><title>404'))],
    ['a box promising more than was sent', new Uint8Array([...u32(4096), ...chars('moov')])],
  ]

  it.each(junk)('%s neither breaks the parse nor opens a session', (_name, bytes) => {
    const store = new SessionStore()

    // The bytes come from an arbitrary site: the parse is obliged to drop the unintelligible.
    expect(() => store.append({ ...page, bytes })).not.toThrow()
    expect(store.list()).toEqual([])
  })

  it('does not put a fragment of zero duration on the map', () => {
    const store = new SessionStore()
    store.append({ ...muxedPage, bytes: muxedInit })

    // Zero duration means it could not be read out of the moof: trun has none and tfhd returned
    // zero (in DASH it often sits in trex, where the parse does not look). Such a fragment has
    // no stretch of time, and a hair of zero width is no substitute: the run would promise
    // material it does not hold. The price is the lost bytes of the segment.
    store.append({ ...muxedPage, bytes: moof(1, 5_000, 4, 0) })

    expect(only(store.list()[0]!).map.runs()).toEqual([])
    expect(only(store.list()[0]!).map.totalBytes()).toBe(0)
  })

  it('lets no fragment onto the map of an init with zero timescale', () => {
    const store = new SessionStore()
    const broken = { ...page, url: 'https://site.example/watch?v=broken' }
    // A broken init: the timescale of the track is zero. It comes from an arbitrary site, so
    // inventing a one for it is out of the question — on ticks that would give times in the
    // thousands of seconds.
    store.append({ ...broken, bytes: new Uint8Array(box('moov', trak(1, 0, 'vide', 'avc1'))) })
    store.append({ ...broken, bytes: moof(1, 0, 4, 1_000) })

    // There is nothing to convert ticks into seconds with, so the fragment has no stretch of
    // time. On the map its boundaries would be NaN: such a chunk counts as neither empty nor
    // overlapping, and the NaN would travel into the popup summary and its bytes into the volume.
    const track = only(store.list()[0]!)
    expect(track.map.runs()).toEqual([])
    expect(track.map.totalBytes()).toBe(0)
    expect(track.map.duration()).toBe(0)
    expect(track.map.span()).toBeNull()
  })

  it('does not let junk spoil a session that is already open', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })
    store.append({ ...page, bytes: new Uint8Array([...u32(12), ...chars('free'), 0, 0, 0, 0]) })
    store.append({ ...page, bytes: seg2 })

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks).toHaveLength(2)
  })
})

describe('SessionStore: choosing the track for a fragment', () => {
  it('uses the timescale of the fragment own track, not of the first one around', () => {
    const store = new SessionStore()
    store.append({ ...muxedPage, bytes: muxedInit })
    // The audio track: trackId 2, timescale 8000. By the video track (timescale 1000) the same
    // fragment would land on the 16th second instead of the 2nd.
    store.append({ ...muxedPage, bytes: moof(2, 16_000, 2, 4_000) })

    expect(only(store.list()[0]!).map.runs()).toEqual([
      { start: 2, end: 3, chunks: [{ start: 2, end: 3, bytes: expect.any(Uint8Array) }] },
    ])
  })

  it('lands a fragment with an unknown trackId on the first track instead of dropping it', () => {
    const store = new SessionStore()
    store.append({ ...muxedPage, bytes: muxedInit })
    // Some packagers number the tracks in a moof their own way. Dropping such a fragment would
    // lose the whole stream; the first track of the same buffer is a reasonable approximation.
    store.append({ ...muxedPage, bytes: moof(7, 3_000, 1, 1_000) })

    expect(only(store.list()[0]!).map.span()).toEqual({ start: 3, end: 4 })
  })
})

describe('SessionStore: session lifetime', () => {
  it('lifts a session in the list on a fresh fragment', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init, now: 1000 })
    store.append({
      ...page,
      sourceId: 's2',
      url: 'https://site.example/watch?v=b',
      bytes: init,
      now: 2000,
    })
    store.append({ ...page, bytes: seg1, now: 3000 })

    // The order in the popup goes by the last byte received, not by the birth of the session:
    // the first one is being watched right now, though it was opened earlier.
    expect(store.list()[0]!.url).toContain('v=abc')
  })

  it('opens a new representation on a new init in the same buffer, not a second session', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    // A change of quality: the player appends a new init into the same SourceBuffer, and
    // everything that follows belongs to the new representation. Leave the buffer bound to the
    // old track and material of two codecs would mix on one map; open a second session and the
    // clip would split in two, though the video is the same one.
    store.append({ ...page, bytes: vp9Init })
    store.append({ ...page, bytes: vp9Seg })

    expect(store.list()).toHaveLength(1)
    const chunksByCodec = Object.fromEntries(
      store
        .list()[0]!
        .tracks.map((t) => [t.info.tracks[0]!.codec, t.map.runs().flatMap((r) => r.chunks)]),
    )
    expect(chunksByCodec).toEqual({ avc1: [expect.anything()], vp09: [expect.anything()] })
  })

  it('keeps the previous rendition whole when quality switches at the same codec', () => {
    const store = new SessionStore()
    store.append({ ...abrPage, bytes: sdInit })
    // Two seconds at the timescale of the first init.
    store.append({ ...abrPage, bytes: moof(1, 0, 1, 2000) })

    // ABR steps up: the codec stays what it was and only the frame size changes. Identify a
    // rendition by the codec alone (§6.2) and this init lands on the previous track — its own
    // init is dropped, the fragments that follow are read against the timescale of the old one,
    // and a clip spanning the switch announces one resolution while carrying frames of another.
    store.append({ ...abrPage, bytes: hdInit })
    // The same two seconds of media time, counted at the timescale of the second init.
    store.append({ ...abrPage, bytes: moof(1, 180_000, 1, 180_000) })

    // One video, so one session — the switch adds a rendition to it, it does not split the clip.
    expect(store.list()).toHaveLength(1)
    const tracks = store.list()[0]!.tracks
    expect(tracks.map((t) => [t.info.tracks[0]!.width, t.info.tracks[0]!.height])).toEqual([
      [640, 360],
      [1280, 720],
    ])

    // The first rendition keeps the init it was opened with and the material collected under it.
    expect(tracks[0]!.initBytes).toEqual(sdInit)
    expect(tracks[0]!.map.runs().flatMap((r) => r.chunks.map(shapeOf))).toEqual([[0, 2, 92]])

    // The fragments after the switch are read against the new init: at the timescale of the old
    // one the very same fragment would be laid down at 180…360 seconds.
    expect(tracks[1]!.initBytes).toEqual(hdInit)
    expect(tracks[1]!.map.runs().flatMap((r) => r.chunks.map(shapeOf))).toEqual([[2, 4, 92]])
  })

  it('starts a new session when the source moves on to another video', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    // A feed of short clips: the page changed its address without letting go of the MediaSource,
    // and the init that follows belongs to the next clip. What the previous one collected stays
    // with it — carried over into the new session it would be material of a foreign video.
    const next = { ...page, url: 'https://site.example/watch?v=next', now: 2000 }
    store.append({ ...next, bytes: init })
    store.append({ ...next, bytes: seg2 })

    const material = store
      .list()
      .map((s) => [s.url, only(s).map.runs().flatMap((r) => r.chunks.map(shapeOf))])
    expect(material).toEqual([
      [next.url, [[2, 4, seg2.byteLength]]],
      [page.url, [[0, 2, seg1.byteLength]]],
    ])
  })

  it('does not rewrite the birth time of a session on merge', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init, now: 1000 })
    store.append({ ...page, sourceId: 's2', url: page.url + '&t=30', bytes: init, now: 5000 })

    expect(store.list()[0]).toMatchObject({ createdAt: 1000, lastSeenAt: 5000 })
  })

  it('does not rewrite the address, the title and the init of a session on merge', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init, now: 1000 })
    store.append({
      ...page,
      sourceId: 's2',
      url: page.url + '&t=30',
      title: 'Clip — second visit',
      bytes: initWithTail,
      now: 5000,
    })

    // The session stays the one it was opened as. The second visit comes with its own address
    // (a rewind mark), its own title and its own init, but the video is the same: rewriting the
    // signature in the popup with them is pointless, and the init has to stay the one the
    // material on the map was collected under — otherwise a foreign track header would end up
    // with the old fragments.
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ url: page.url, title: 'Clip' })
    expect(only(store.list()[0]!).initBytes).toEqual(init)
  })

  it('trims the maps of every session in evictAll, not only of the first', () => {
    const store = new SessionStore()
    const second = { ...page, sourceId: 's2', url: 'https://site.example/watch?v=b' }

    for (const source of [page, second]) {
      store.append({ ...source, bytes: init })
      store.append({ ...source, bytes: seg1 })
      store.append({ ...source, bytes: seg2 })
    }

    // A window of one second around the fourth: the first fragment (0–2) is out, the second
    // (2–4) is not.
    store.evictAll(1, 4)

    expect(store.list().map((s) => only(s).map.span())).toEqual([
      { start: 2, end: 4 },
      { start: 2, end: 4 },
    ])
  })

  it('trims every track of a session in evictAll, not only the first', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bufferId: 'b2', bytes: audioInit })
    store.append({ ...page, bytes: videoSegs[0]! })
    store.append({ ...page, bufferId: 'b2', bytes: audioSegs[0]! })

    // The recording window is a property of the session and not of one of its tracks: trim the
    // video alone and the sound of the discarded part would stay in memory for good.
    store.evictAll(1, 4)

    expect(store.list()[0]!.tracks.map((t) => t.map.span())).toEqual([null, null])
  })
})

describe('SessionStore: triage verdicts', () => {
  it('erases a session that has not been confirmed yet on rejection', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    store.dropPending('s1')

    expect(store.list()).toEqual([])
  })

  it('does not let a session be born when the rejection came before the first bytes', () => {
    const store = new SessionStore()

    // The verdict is passed on signals from the element while the bytes travel their own way:
    // a banner rejection may well outrun its first segment. Were the store to forget about the
    // rejection, the session would be born right after it and stay in the registry for good —
    // the verdict never changed again.
    store.dropPending('s1')
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    expect(store.list()).toEqual([])
  })

  it('returns recording on a hold after a rejection', () => {
    const store = new SessionStore()

    // The element was taken off screen and brought back: the rejection turned into a hold and
    // the material accumulates again. Without this, one miss of the triage would be enough to
    // silence the stream for the rest of the page life.
    store.dropPending('s1')
    store.resumePending('s1')
    store.append({ ...page, bytes: init })

    expect(store.list()).toHaveLength(1)
  })

  it('returns recording on a promotion after a rejection too', () => {
    const store = new SessionStore()

    // A promotion can follow a rejection directly, skipping the hold: a video that came back on
    // screen may have served its probation before it left.
    store.dropPending('s1')
    store.promotePending('s1')
    store.append({ ...page, bytes: init })

    expect(store.list()).toHaveLength(1)
  })

  it('leaves a confirmed session alone on rejection', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.promotePending('s1')
    store.dropPending('s1')

    expect(store.list()).toHaveLength(1)
  })

  it('freezes recording on a rejection of a confirmed session and keeps what it collected', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })
    store.promotePending('s1')

    // A pause, a hidden tab, the element leaving the screen: no reason to record further, and
    // even less reason to throw away what is already collected. That is what the user comes for.
    store.dropPending('s1')
    store.append({ ...page, bytes: seg2 })

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks).toEqual([
      { start: 0, end: 2, bytes: seg1 },
    ])
  })

  it('does not break the binding of a source when a confirmed session freezes', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, sourceId: 's2', bytes: init })
    store.promotePending('s1')

    // The second element of the same page was taken off screen and brought back. The session is
    // confirmed by its neighbour, so the rejection did not touch it — and after the thaw the
    // material has to land there again instead of vanishing until the next init, which a live
    // player may never send.
    store.dropPending('s2')
    store.resumePending('s2')
    store.append({ ...page, sourceId: 's2', bytes: seg1 })

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks).toHaveLength(1)
  })

  it('does not touch a neighbouring source on a rejection of one', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, sourceId: 's2', url: 'https://site.example/watch?v=other', bytes: init })

    store.dropPending('s2')

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.url).toContain('v=abc')
  })

  it('does not erase a session that a second source is also feeding', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    // A banner and the real player on one page: their address is shared and the codec is the
    // same, so the session key is one. Erase it on the banner rejection and the player
    // recording would die with it, though the verdict was not addressed to it.
    store.append({ ...page, sourceId: 's2', bytes: init })

    store.dropPending('s1')
    store.append({ ...page, sourceId: 's2', bytes: seg1 })

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks).toHaveLength(1)
  })

  it('takes nothing more from a source that was screened out', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, sourceId: 's2', bytes: init })

    store.dropPending('s1')
    // The MAIN world hook knows nothing about verdicts and copies to the last: a screened-out
    // source keeps sending bytes, and with nowhere to put them they would settle in the
    // neighbouring session.
    store.append({ ...page, bytes: seg1 })

    expect(only(store.list()[0]!).map.runs()).toEqual([])
  })

  it('breaks nothing on a verdict about an unknown source', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    store.dropPending('s-unknown')
    store.promotePending('s-unknown')
    store.resumePending('s-unknown')

    expect(store.list()).toHaveLength(1)
  })

  it('keeps everything a source collected when the rejection turns back', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: videoSegs[0]! })

    // What rutube and dzen do to themselves on five loads out of seven: the element of the
    // player stands above the viewport for one poll of the watcher while the page lays itself
    // out, the verdict of that moment is a rejection, and a second later it is a hold again.
    // Between the two there is material, and past them there is the whole of the recording —
    // the init segments of both sites went by in the first second and never come again.
    store.dropPending('s1')
    store.append({ ...page, bytes: videoSegs[1]! })
    store.resumePending('s1')
    store.append({ ...page, bytes: videoSegs[2]! })
    store.promotePending('s1')

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks.map(shapeOf)).toEqual([
      [0, 2, videoSegs[0]!.byteLength],
      [2, 4, videoSegs[1]!.byteLength],
      [4, 6, videoSegs[2]!.byteLength],
    ])
  })

  it('does not take the init of a stream away with a rejection', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    store.dropPending('s1')
    store.resumePending('s1')
    // No second init: a site gives out all of them in the first second of playback, and a track
    // whose header is gone cannot be found by anything that comes after it.
    store.append({ ...page, bytes: videoSegs[0]! })

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).initBytes).toEqual(init)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks.map(shapeOf)).toEqual([
      [0, 2, videoSegs[0]!.byteLength],
    ])
  })

  it('does not lose the place of the reader in the stream over a rejection', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })

    // A segment split across the verdict, the way a player that hands over its download as it
    // arrives would deliver it. A reader that stopped at the rejection would come back in the
    // middle of a segment and have to find the next header — the half it was holding lost, and
    // with it the segment it belonged to.
    const half = Math.floor(videoSegs[0]!.byteLength / 2)
    store.append({ ...page, bytes: videoSegs[0]!.subarray(0, half) })
    store.dropPending('s1')
    store.append({ ...page, bytes: videoSegs[0]!.subarray(half) })
    store.resumePending('s1')
    store.append({ ...page, bytes: videoSegs[1]! })

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks.map(shapeOf)).toEqual([
      [0, 2, videoSegs[0]!.byteLength],
      [2, 4, videoSegs[1]!.byteLength],
    ])
  })

  it('keeps what arrived under a rejection that came before the first byte', () => {
    const store = new SessionStore()

    // The verdict travels on signals from the element while the bytes travel their own way, so a
    // rejection can outrun the whole stream — on a page that opens scrolled past its player, it
    // does. Nothing of it is offered while it stands, and everything of it is there once triage
    // has said the element was a player after all.
    store.dropPending('s1')
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: videoSegs[0]! })
    expect(store.list()).toEqual([])

    store.promotePending('s1')

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks.map(shapeOf)).toEqual([
      [0, 2, videoSegs[0]!.byteLength],
    ])
  })

  it('gives a rejected source its place in a neighbour session back', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, sourceId: 's2', bytes: init })

    // A banner and the real player under one key: the session lives on the neighbour, so it is
    // not the rejected source's to take away — and what the rejected source collects meanwhile
    // is not the neighbour's to be given either. Both hold until the verdict turns.
    store.dropPending('s1')
    store.append({ ...page, bytes: videoSegs[0]! })
    expect(only(store.list()[0]!).map.runs()).toEqual([])

    store.resumePending('s1')
    store.append({ ...page, bytes: videoSegs[1]! })

    expect(store.list()).toHaveLength(1)
    expect(only(store.list()[0]!).map.runs()[0]!.chunks.map(shapeOf)).toEqual([
      [0, 2, videoSegs[0]!.byteLength],
      [2, 4, videoSegs[1]!.byteLength],
    ])
  })

  it('offers nothing of a source while its rejection stands', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: videoSegs[0]! })

    store.dropPending('s1')
    store.append({ ...page, bytes: videoSegs[1]! })

    // Set aside is not kept: while the verdict stands there is no session, nothing to summarize
    // and nothing to save. Only a verdict that turns brings the material back.
    expect(store.list()).toEqual([])
  })

  it('keeps nothing of a rejection that stands', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.dropPending('s1')

    // The hook in the MAIN world knows nothing of verdicts and copies to the last, and a banner
    // plays for as long as the page is open. What is set aside while the verdict is under review
    // is bounded: material that outlasts the review is not the misreading of a moment, and the
    // source goes back to costing nothing.
    const enough = Math.ceil(MAX_PROBATION_BYTES / videoSegs[0]!.byteLength) + 1
    for (let i = 0; i < enough; i++) store.append({ ...page, bytes: videoSegs[0]! })

    store.resumePending('s1')
    expect(store.list()).toEqual([])

    // The material is gone; the reading of the stream is not. A source screened out for minutes
    // and brought back records from that moment on, without waiting for an init that never comes.
    store.append({ ...page, bytes: videoSegs[1]! })
    expect(only(store.list()[0]!).map.runs()[0]!.chunks.map(shapeOf)).toEqual([
      [2, 4, videoSegs[1]!.byteLength],
    ])
  })
})

describe('SessionStore: a page whose stream is encrypted', () => {
  /**
   * Protection is read out of the material and not out of the page's intentions.
   *
   * The refusal is not a verdict of triage. A verdict is about an element: the watcher measures
   * the <video> and says what its stream is worth. On a page whose element it cannot reach — one
   * playing inside a shadow root — no verdict is ever spoken at all: measured on tv.apple.com,
   * where the registry kept 149.6 MB of a protected page and offered it for saving. So the
   * refusal has its own way in, and what it promises is stronger than a rejection: not "nothing
   * more is collected" but "nothing of this page is kept at all".
   *
   * What sets it off is the one thing that cannot be feigned or merely intended — encryption in
   * the bytes themselves. The page's talk of key systems is not evidence of it: a news article
   * was measured probing sixteen of them, three granted, over a stream that was in the clear from
   * the first byte to the last.
   */
  it('refuses an init segment written in Common Encryption', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: cencInit })
    store.append({ ...page, bytes: seg1 })

    expect(store.list()).toEqual([])
  })

  it('refuses a fragment carrying per-sample initialisation vectors', () => {
    const store = new SessionStore()
    // The init went past before recording started, which is the ordinary way of joining a live
    // stream. What is left to go on is the senc of every fragment behind it.
    store.append({ ...page, bytes: sencFragment })
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    expect(store.list()).toEqual([])
  })

  it('erases everything the page had collected in the clear before it', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })
    expect(store.list(), 'setup: the material has to be in the registry first').toHaveLength(1)

    // The shape of a site that plays a free preview and then the licensed material: the second
    // player of the page opens a protected stream, and the page as a whole is refused. §2 owes
    // the user a plain refusal, and a session left in the list is an offer to save it.
    store.append({ ...page, sourceId: 's2', bytes: cencInit })

    expect(store.list()).toEqual([])
  })

  it('leaves nothing behind that a save could still reach', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })
    const key = store.list()[0]!.key

    store.refuseEncrypted()

    // The popup holds the key of a session it listed a moment ago, and a save asks the registry
    // by that key alone. A session merely hidden from the list would still be saved by it.
    expect(store.get(key)).toBeUndefined()
  })

  it('takes nothing in once the refusal stands', () => {
    const store = new SessionStore()
    store.refuseEncrypted()

    // The hook goes on copying every appendBuffer — it knows nothing of verdicts — and a
    // protected page plays for as long as it is open.
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    expect(store.list()).toEqual([])
  })

  it('covers every source of the page and not only the one that was playing', () => {
    const store = new SessionStore()
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })
    store.append({ ...page, sourceId: 's2', bytes: init })
    store.append({ ...page, sourceId: 's2', bytes: seg1 })

    // A page mixes the two as a matter of course: edition.cnn.com was measured opening two clear
    // buffers and two encrypted ones. A refusal for one source alone would keep the material of
    // the neighbouring one — of the same protected page.
    store.refuseEncrypted()

    expect(store.list()).toEqual([])
  })

  it('is not undone by a promotion', () => {
    const store = new SessionStore()
    store.refuseEncrypted()

    // The watcher goes on measuring whatever elements it can reach, and an element it can reach
    // is promoted on its merits. A promotion arriving after the refusal must not open the page up
    // again: triage decides what is worth keeping, and protection decides that nothing here may
    // be.
    store.promotePending('s1')
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    expect(store.list()).toEqual([])
  })

  it('is not undone by a hold', () => {
    const store = new SessionStore()
    store.refuseEncrypted()

    store.resumePending('s1')
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    expect(store.list()).toEqual([])
  })

  it('drops what a rejection had set aside instead of giving it back', () => {
    const store = new SessionStore()
    store.dropPending('s1')
    store.append({ ...page, bytes: init })
    store.append({ ...page, bytes: seg1 })

    // Material of a source under review waits out of sight and comes back whole when the verdict
    // turns (see Probation). The refusal has to reach it there too — a hidden store is still a
    // store, and the turn of a verdict would hand the page's material straight back.
    store.refuseEncrypted()
    store.promotePending('s1')

    expect(store.list()).toEqual([])
  })

  it('says the page was protected, so that the user can be told which silence this is', () => {
    const store = new SessionStore()
    expect(store.encrypted, 'an ordinary page must not be called protected').toBe(false)

    store.append({ ...page, bytes: cencInit })

    // An empty list has two meanings that are opposites, and the popup shows a different sentence
    // for each: nothing worth recording, or a page that may not be recorded at all.
    expect(store.encrypted).toBe(true)
  })

  it('records a clear stream in full and calls it nothing else', () => {
    const store = new SessionStore()
    for (const bytes of [init, ...videoSegs]) store.append({ ...page, bytes })
    for (const bytes of [audioInit, ...audioSegs]) {
      store.append({ ...page, bufferId: 'b2', bytes })
    }

    // The other half of the promise, and the regression this set exists for: a page that never
    // encrypted a byte keeps every one of them. Reading the containers must not turn an ordinary
    // avc1 stream into a protected one.
    expect(store.encrypted).toBe(false)
    expect(store.list()).toHaveLength(1)
    expect(codecsOf(store.list()[0]!)).toEqual(['avc1', 'mp4a'])
  })
})

describe('SessionStore: two tracks of one media source', () => {
  /**
   * The layout every MSE player uses, YouTube included: one MediaSource per <video> and one
   * SourceBuffer per track. Both buffers report the same sourceId and differ only by bufferId,
   * so bufferId is the only thing that tells the two streams apart.
   */
  const videoBuffer = { ...page, bufferId: 'b1' }
  const audioBuffer = { ...page, bufferId: 'b2' }

  /** Both inits, then the fragments interleaved the way a player appends them. */
  function feedBothTracks(store: SessionStore): void {
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioInit })
    for (let i = 0; i < 4; i++) {
      const video = videoSegs[i]
      const audio = audioSegs[i]
      if (video) store.append({ ...videoBuffer, bytes: video })
      if (audio) store.append({ ...audioBuffer, bytes: audio })
    }
  }

  it('makes one session with two tracks, not two sessions', () => {
    const store = new SessionStore()
    feedBothTracks(store)

    // One video is one session. Keying it by the codecs of the last init instead splits the
    // clip in two: the audio track lands under one key, the video track under another.
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.tracks.map((t) => t.kinds)).toEqual([['video'], ['audio']])
  })

  it('keeps the init segment of every track, not just of the last one', () => {
    const store = new SessionStore()
    feedBothTracks(store)

    // Both are needed to build a file with sound: each declares its own track.
    const [video, audio] = store.list()[0]!.tracks
    expect(video!.initBytes).toEqual(init)
    expect(audio!.initBytes).toEqual(audioInit)
  })

  it('converts fragment times with the timescale of their own buffer', () => {
    const store = new SessionStore()
    feedBothTracks(store)

    const [video, audio] = store.list()[0]!.tracks
    // Video: timescale 12288, 24576 ticks per fragment — exactly two seconds each. Divided by
    // the audio timescale of 44100 the same fragments would land on 0…0.557 instead.
    expect(video!.map.runs().map((r) => [r.start, r.end])).toEqual([[0, 6]])
    expect(video!.map.runs()[0]!.chunks.map(shapeOf)).toEqual([
      [0, 2, videoSegs[0]!.byteLength],
      [2, 4, videoSegs[1]!.byteLength],
      [4, 6, videoSegs[2]!.byteLength],
    ])
    // Audio: timescale 44100, four fragments up to 6.0232 seconds.
    expect(audio!.map.runs()).toHaveLength(1)
    expect(audio!.map.span()!.end).toBeCloseTo(6.0232, 4)
  })

  it('drops nothing when both tracks start at the same media time', () => {
    const store = new SessionStore()
    feedBothTracks(store)

    // On one shared map the deduplication rule of PtsMap ("same start, keep the longer one")
    // reads the first video fragment and the first audio fragment as one and the same segment
    // and throws away the shorter — the bytes are gone for good, not merely misplaced.
    const fed = [...videoSegs, ...audioSegs].reduce((total, b) => total + b.byteLength, 0)
    const stored = store.list()[0]!.tracks.reduce((total, t) => total + t.map.totalBytes(), 0)
    expect(stored).toBe(fed)
  })

  it('keeps feeding the buffer that opened first', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioInit })
    store.append({ ...videoBuffer, bytes: videoSegs[0]! })

    // Binding the stream to the media source alone makes the second init overwrite the first:
    // the video buffer is left orphaned and never receives a fragment again.
    expect(store.list()[0]!.tracks[0]!.map.runs()).toHaveLength(1)
  })

  it('covers every track of the source in the merge key', () => {
    const store = new SessionStore()
    feedBothTracks(store)

    expect(store.list()[0]!.key).toBe(
      sessionKey({ url: page.url, codecs: ['avc1', 'mp4a'], durationSeconds: Infinity }),
    )
  })

  it('keys the session the same however the buffers were opened', () => {
    const store = new SessionStore()
    // On real YouTube the audio SourceBuffer is created first, on the fixtures video comes
    // first. The clip is the same one, so the key has to be the same too.
    store.append({ ...audioBuffer, bytes: audioInit })
    store.append({ ...videoBuffer, bytes: init })

    expect(store.list()[0]!.key).toBe(
      sessionKey({ url: page.url, codecs: ['avc1', 'mp4a'], durationSeconds: Infinity }),
    )
  })

  it('merges a reload of a two-track page into the same session', () => {
    const store = new SessionStore()
    feedBothTracks(store)

    // Second visit: a new MediaSource with new SourceBuffers, the same clip. Its material
    // belongs on the same maps — that is what the merge key is for.
    const second = { ...page, sourceId: 's2', url: page.url + '&t=30', now: 2000 }
    store.append({ ...second, bufferId: 'b3', bytes: init })
    store.append({ ...second, bufferId: 'b4', bytes: audioInit })
    store.append({ ...second, bufferId: 'b3', bytes: videoSegs[0]! })

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.tracks).toHaveLength(2)
  })

  it('keeps the material of both visits on the same maps', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioInit })
    store.append({ ...videoBuffer, bytes: videoSegs[0]! })

    // The second visit brings its video init first and the audio one only a moment later: for
    // that moment its key is narrower than the key of the session already in the registry.
    // Whatever it collects meanwhile has to reach the first visit map once the keys meet again.
    const second = { ...page, sourceId: 's2', now: 2000 }
    store.append({ ...second, bufferId: 'b3', bytes: init })
    store.append({ ...second, bufferId: 'b3', bytes: videoSegs[1]! })
    store.append({ ...second, bufferId: 'b4', bytes: audioInit })
    store.append({ ...second, bufferId: 'b3', bytes: videoSegs[2]! })

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.tracks[0]!.map.runs()[0]!.chunks.map(shapeOf)).toEqual([
      [0, 2, videoSegs[0]!.byteLength],
      [2, 4, videoSegs[1]!.byteLength],
      [4, 6, videoSegs[2]!.byteLength],
    ])
  })

  it('takes both tracks of a rejected source with it', () => {
    const store = new SessionStore()
    feedBothTracks(store)

    // The verdict is about the element, and both buffers belong to the same one.
    store.dropPending('s1')

    expect(store.list()).toEqual([])
  })

  it('gives both tracks back when the rejection turns', () => {
    const store = new SessionStore()
    feedBothTracks(store)

    // The verdict is about the element and so is its turning: a player of picture and sound is
    // two buffers, and a moment of rejection has to cost neither of them. This is the shape
    // rutube and dzen deliver in — two SourceBuffers, every init in the first second.
    store.dropPending('s1')
    store.promotePending('s1')

    expect(store.list()).toHaveLength(1)
    expect(summarize(store.list()[0]!)).toEqual({
      duration: 6,
      bytes: [...videoSegs, ...audioSegs].reduce((total, b) => total + b.byteLength, 0),
    })
  })
})

describe('summarize', () => {
  const videoBuffer = { ...page, bufferId: 'b1' }
  const audioBuffer = { ...page, bufferId: 'b2' }

  it('reports the overlap of the tracks, not their sum', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioInit })
    for (const bytes of videoSegs) store.append({ ...videoBuffer, bytes })
    for (const bytes of audioSegs) store.append({ ...audioBuffer, bytes })

    // Video holds 0…6, audio 0…6.0232. Cutting is possible only where both are present: six
    // seconds. Summing the tracks would promise twelve, and the tail of the audio track is not
    // a clip — there is no picture under it.
    const fed = [...videoSegs, ...audioSegs].reduce((total, b) => total + b.byteLength, 0)
    expect(summarize(store.list()[0]!)).toEqual({ duration: 6, bytes: fed })
  })

  it('shrinks to the track that holds less', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioInit })
    for (const bytes of videoSegs) store.append({ ...videoBuffer, bytes })
    // The sound has only caught up to 1.95 seconds while the picture already holds six. The
    // longest of the tracks is not what can be cut: past 1.95 seconds there is no sound to go
    // under the picture.
    store.append({ ...audioBuffer, bytes: audioSegs[0]! })

    const summary = summarize(store.list()[0]!)
    expect(summary.duration).toBeCloseTo(1.9505, 4)
  })

  it('counts a gap in one track as a gap in the clip', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioInit })
    // The player skipped the middle video segment: 0…2 and 4…6 with nothing in between.
    store.append({ ...videoBuffer, bytes: videoSegs[0]! })
    store.append({ ...videoBuffer, bytes: videoSegs[2]! })
    for (const bytes of audioSegs) store.append({ ...audioBuffer, bytes })

    // Sound alone bridges no gap: two cuttable stretches of two seconds each, and a save writes
    // one continuous clip. Four seconds here would be four seconds of a two-second file.
    //
    // 1.9505 and not a round two: the sound of this clip is cut at 1.9505, and the segment after
    // that one reaches only fifty milliseconds into the stretch — it stays out, and the clip is
    // as long as the sound that is in it.
    const summary = summarize(store.list()[0]!)
    expect(summary.duration).toBeCloseTo(1.9505, 4)
    expect(summary.omits).toBe('gap')
  })

  it('reports the one representation a save takes, not the two together', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...videoBuffer, bytes: videoSegs[0]! })
    // A switch of quality in the middle of the clip: the first two seconds came in one
    // representation, the next two in another. The material is there either way — and a file
    // holds one video stream, so a save takes one of them and the popup says four seconds of a
    // two-second clip unless it says the same.
    store.append({ ...videoBuffer, bytes: vp9Init })
    store.append({ ...videoBuffer, bytes: vp9Seg2 })

    expect(summarize(store.list()[0]!)).toMatchObject({ duration: 2, omits: 'rendition' })
  })

  it('summarises a single-track session by that track', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...videoBuffer, bytes: videoSegs[0]! })
    store.append({ ...videoBuffer, bytes: videoSegs[1]! })

    expect(summarize(store.list()[0]!)).toEqual({
      duration: 4,
      bytes: videoSegs[0]!.byteLength + videoSegs[1]!.byteLength,
    })
  })

  it('has nothing to cut in a session without a single fragment', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })

    expect(summarize(store.list()[0]!)).toEqual({ duration: 0, bytes: 0 })
  })
})

describe('selectMaterial', () => {
  const videoBuffer = { ...page, bufferId: 'b1' }
  const audioBuffer = { ...page, bufferId: 'b2' }

  /**
   * Fixtures by name. Naming them says which segment went where; comparing megabytes of media
   * data would say the same thing in a diff nobody can read.
   *
   * Matched on content and not on identity: a segment reaches the store inside a run of appends
   * and comes back as the bytes cut out of that run, which is the same material in a view of its
   * own.
   */
  const names: [Uint8Array, string][] = [
    [init, 'video init'],
    [audioInit, 'audio init'],
    [vp9Init, 'vp9 init'],
    [vp9Seg, 'vp9 0…2'],
    [vp9Seg2, 'vp9 2…4'],
    ...videoSegs.map((bytes, i): [Uint8Array, string] => [bytes, `video ${i * 2}…${i * 2 + 2}`]),
    ...audioSegs.map((bytes, i): [Uint8Array, string] => [bytes, `audio ${i + 1}`]),
  ]

  const nameOf = (bytes: Uint8Array): string =>
    names.find(([fixture]) => sameBytes(fixture, bytes))?.[1] ?? 'a stranger'

  /** What the selection came back with: the init of every track it chose, then its segments. */
  const chosen = (store: SessionStore): string[][] =>
    selectMaterial(store.list()[0]!).map((track) =>
      [track.initBytes, ...track.segments].map(nameOf),
    )

  it('hands over both tracks with the init each of them was opened with', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioInit })
    for (const bytes of videoSegs) store.append({ ...videoBuffer, bytes })
    for (const bytes of audioSegs) store.append({ ...audioBuffer, bytes })

    // The picture goes first: stream zero of a file is the one a player shows, and a viewer
    // opening a clip expects to see it rather than a waveform.
    expect(chosen(store)).toEqual([
      ['video init', 'video 0…2', 'video 2…4', 'video 4…6'],
      ['audio init', 'audio 1', 'audio 2', 'audio 3', 'audio 4'],
    ])
  })

  it('puts the picture first however the buffers were opened', () => {
    const store = new SessionStore()
    // On real YouTube the audio SourceBuffer is the one created first.
    store.append({ ...audioBuffer, bytes: audioInit })
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioSegs[0]! })
    store.append({ ...videoBuffer, bytes: videoSegs[0]! })

    expect(chosen(store).map((track) => track[0])).toEqual(['video init', 'audio init'])
  })

  it('takes the longest stretch where both tracks are there at once', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioInit })
    for (const bytes of videoSegs) store.append({ ...videoBuffer, bytes })
    // The sound was loaded in two goes with a jump between them: 0…1.95 and 3.95…6.02.
    store.append({ ...audioBuffer, bytes: audioSegs[0]! })
    store.append({ ...audioBuffer, bytes: audioSegs[2]! })
    store.append({ ...audioBuffer, bytes: audioSegs[3]! })

    // Picture runs 0…6 whole, so the choice is between 0…1.95 and 3.95…6.02 — the later, longer
    // one. The video fragment 2…4 is left behind: the clip begins at 3.95 and holds fifty
    // milliseconds of it, so taking it whole would put two seconds of silent picture in front of
    // a two-second clip. The fragment 4…6 is the picture of the stretch itself.
    expect(chosen(store)).toEqual([
      ['video init', 'video 4…6'],
      ['audio init', 'audio 3', 'audio 4'],
    ])
  })

  it('takes one representation of a kind, the one holding the most', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    for (const bytes of videoSegs) store.append({ ...videoBuffer, bytes })
    // A switch of quality opens a second representation of the same kind (§6.2). Both in one
    // file would give it two video streams of different frame size where a player expects one.
    store.append({ ...videoBuffer, bytes: vp9Init })
    store.append({ ...videoBuffer, bytes: vp9Seg })

    expect(chosen(store)).toEqual([['video init', 'video 0…2', 'video 2…4', 'video 4…6']])
  })

  it('saves the longest run of a session that has only one track', () => {
    const store = new SessionStore()
    store.append({ ...audioBuffer, bytes: audioInit })
    // Runs 0…1.95 and 3.95…6.02: the second one is longer.
    store.append({ ...audioBuffer, bytes: audioSegs[0]! })
    store.append({ ...audioBuffer, bytes: audioSegs[2]! })
    store.append({ ...audioBuffer, bytes: audioSegs[3]! })

    expect(chosen(store)).toEqual([['audio init', 'audio 3', 'audio 4']])
  })

  it('has nothing to give while a kind is still without a fragment', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioInit })
    for (const bytes of videoSegs) store.append({ ...videoBuffer, bytes })

    // The gap between the init of the second buffer and its first segment lasts moments, and a
    // clip made in one of them would be a silent film. Better nothing than that.
    expect(chosen(store)).toEqual([])
  })

  it('has nothing to give from a session made of init segments alone', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })

    expect(chosen(store)).toEqual([])
  })
})

/**
 * What the popup says against what the button writes.
 *
 * The two answers come from one place on purpose (see planSave), and this set is what says so:
 * every number the popup shows is measured here out of the bytes handed to the muxer, and not
 * out of the same map the summary counted. A summary computed beside the selection agrees with
 * it only by convention, and convention is what broke — the popup promised the material of two
 * renditions while a save could take one of them.
 */
describe('the summary and the file it promises', () => {
  const videoBuffer = { ...page, bufferId: 'b1' }
  const audioBuffer = { ...page, bufferId: 'b2' }

  /** Where the segments of one track lie in seconds, read back out of their own bytes. */
  function coveredSpan(track: MuxTrack): { start: number; end: number } | null {
    const info = parseInit(track.initBytes)
    if (!info) return null

    let start = Infinity
    let end = -Infinity
    for (const segment of track.segments) {
      const fragment = parseFragment(segment)
      if (!fragment) continue
      const declared = info.tracks.find((t) => t.trackId === fragment.trackId) ?? info.tracks[0]!
      start = Math.min(start, fragment.baseMediaDecodeTime / declared.timescale)
      end = Math.max(end, (fragment.baseMediaDecodeTime + fragment.duration) / declared.timescale)
    }

    return start < end ? { start, end } : null
  }

  /** How long the saved file plays with every one of its tracks present — its useful length. */
  function savedSeconds(material: MuxTrack[]): number {
    if (!material.length) return 0

    let start = -Infinity
    let end = Infinity
    for (const track of material) {
      const span = coveredSpan(track)
      if (!span) return 0
      start = Math.max(start, span.start)
      end = Math.min(end, span.end)
    }

    return Math.max(0, end - start)
  }

  /** Weight of the media data the muxer is handed: what the file is built out of. */
  const savedBytes = (material: MuxTrack[]): number =>
    material.reduce((total, track) => total + track.segments.reduce((n, s) => n + s.byteLength, 0), 0)

  /** A session with the picture and the sound of one page, whole. */
  function bothTracks(): Session {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioInit })
    for (const bytes of videoSegs) store.append({ ...videoBuffer, bytes })
    for (const bytes of audioSegs) store.append({ ...audioBuffer, bytes })
    return store.list()[0]!
  }

  /**
   * A switch of quality: one codec, two frame sizes, two seconds under each of them. This is
   * what ABR delivers, and one file holds one of the two.
   */
  function switchedQuality(): Session {
    const store = new SessionStore()
    store.append({ ...abrPage, bytes: sdInit })
    store.append({ ...abrPage, bytes: moof(1, 0, 1, 2000) })
    store.append({ ...abrPage, bytes: hdInit })
    store.append({ ...abrPage, bytes: moof(1, 180_000, 1, 180_000) })
    return store.list()[0]!
  }

  /** A jump forward over the middle: two stretches of material with a hole between them. */
  function jumpedForward(): Session {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...videoBuffer, bytes: videoSegs[0]! })
    store.append({ ...videoBuffer, bytes: videoSegs[2]! })
    return store.list()[0]!
  }

  /** The sound taken in and the picture refused: its container names a codec we cannot write. */
  function pictureRefused(): Session {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: webmVideoInit })
    store.append({ ...audioBuffer, bytes: webmAudioInit })
    store.append({ ...videoBuffer, bytes: webmVideoSeg })
    for (const bytes of webmAudioSegs) store.append({ ...audioBuffer, bytes })
    return store.list()[0]!
  }

  /** The second buffer has its init and not one fragment yet: there is nothing to cut at all. */
  function soundNotStartedYet(): Session {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: audioInit })
    for (const bytes of videoSegs) store.append({ ...videoBuffer, bytes })
    return store.list()[0]!
  }

  /**
   * The sound downloaded further ahead than the picture, in longer segments: twelve seconds of
   * picture in two segments, fifteen of sound in three. The last segment of sound begins inside
   * the picture and runs five seconds past the end of it.
   */
  function soundBufferedAhead(): Session {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: aheadVideoInit })
    store.append({ ...audioBuffer, bytes: aheadAudioInit })
    for (const bytes of aheadVideoSegs) store.append({ ...videoBuffer, bytes })
    for (const bytes of aheadAudioSegs) store.append({ ...audioBuffer, bytes })
    return store.list()[0]!
  }

  /** The whole length of the file: from the first of its material to the last of it. */
  function fileSeconds(material: MuxTrack[]): number {
    let start = Infinity
    let end = -Infinity
    for (const track of material) {
      const span = coveredSpan(track)
      if (!span) continue
      start = Math.min(start, span.start)
      end = Math.max(end, span.end)
    }
    return end > start ? end - start : 0
  }

  const sessions: [string, () => Session][] = [
    ['both tracks whole', bothTracks],
    ['a switch of quality', switchedQuality],
    ['a jump forward over the middle', jumpedForward],
    ['the picture refused', pictureRefused],
    ['the sound not started yet', soundNotStartedYet],
    ['the sound buffered ahead of the picture', soundBufferedAhead],
  ]

  it.each(sessions)('promises no more than a save of %s writes', (_name, build) => {
    const session = build()
    const material = selectMaterial(session)

    // Whole segments reach the file, so it may run a fraction longer at the edges than the
    // stretch it was cut over — over-delivering is not the lie. Promising what will not be
    // there is, and that is what this bounds.
    expect(summarize(session).duration).toBeLessThanOrEqual(savedSeconds(material) + 1e-9)
    expect(summarize(session).bytes).toBeLessThanOrEqual(savedBytes(material))
  })

  it('promises one rendition after a switch of quality, not both', () => {
    const session = switchedQuality()

    // Two seconds at 640x360 and two more at 1280x720. A file holds one video stream, so a save
    // takes the material of one of them: the popup that adds them up promises a clip twice the
    // length of the one the button writes.
    expect(summarize(session).duration).toBe(2)
    expect(summarize(session).duration).toBe(savedSeconds(selectMaterial(session)))
  })

  it('counts the bytes of the rendition it saves, not of both', () => {
    const session = switchedQuality()

    expect(summarize(session).bytes).toBe(savedBytes(selectMaterial(session)))
  })

  it('promises the run a save takes, not the sum of the runs', () => {
    const session = jumpedForward()

    // Two seconds watched, the middle skipped, two more watched. A save writes one continuous
    // stretch, so four seconds in the popup is two seconds of file.
    expect(summarize(session).duration).toBe(2)
    expect(summarize(session).duration).toBe(savedSeconds(selectMaterial(session)))
  })

  it('promises nothing at all while there is nothing to cut', () => {
    const session = soundNotStartedYet()

    // Megabytes of picture are collected and not one of them can be saved: the sound has an init
    // and no material, and a clip with a silent track is not what the button makes. A weight
    // beside a zero length reads as a file that is nearly ready.
    expect(summarize(session)).toMatchObject({ duration: 0, bytes: 0 })
  })

  it('says a rendition will be left out', () => {
    expect(summarize(switchedQuality()).omits).toBe('rendition')
  })

  it('says the material is in pieces and one of them is saved', () => {
    expect(summarize(jumpedForward()).omits).toBe('gap')
  })

  it('says a track was refused before it says anything else', () => {
    // Nothing of the picture was collected — the codec cannot be written — and the file will be
    // sound alone. The length beside it is honest and says nothing of the missing kind.
    expect(summarize(pictureRefused()).omits).toBe('track')
  })

  it('says nothing when the file holds everything the session has', () => {
    expect(summarize(bothTracks()).omits).toBeUndefined()
  })

  /**
   * A segment that lies almost entirely past the end of the clip.
   *
   * Segments reach the file whole, and at the edges of the clip that costs a rounding: the last
   * one of a track runs a fraction past the stretch every track covers at once. The fraction is
   * the whole of the licence. A site whose sound comes in five-second pieces while its picture
   * comes in six leaves a piece of sound that begins two seconds before the picture runs out and
   * ends three seconds after it — and taken whole, that piece turns a twelve-second clip into a
   * fifteen-second one whose last three seconds are sound over a picture that has stopped.
   *
   * Seen on the real site: a save off YouTube promised twenty seconds and wrote a file of
   * twenty-nine, the last ten of them a frozen frame with sound running over it. The picture came
   * in WebM segments of about four seconds and the sound in mp4 segments of ten, and one of those
   * ten-second pieces began a sixth of a second before the picture ran out.
   */
  it('leaves out a segment the clip holds almost none of', () => {
    const material = selectMaterial(soundBufferedAhead())

    // Two segments of picture, and two of the three of sound: the third begins at 10.031 and runs
    // to 15.0465, of which the clip holds 1.97 seconds and leaves 3.05 behind.
    expect(material.map((track) => track.segments.length)).toEqual([2, 2])
  })

  it('does not write sound over a picture that has run out', () => {
    const material = selectMaterial(soundBufferedAhead())
    const [picture, sound] = material.map(coveredSpan)

    expect(picture).not.toBeNull()
    expect(sound).not.toBeNull()
    // The file may end with picture that has no sound under it — a segment of sound cannot be cut
    // to fit, and half a second of silence at the tail is not what anybody notices. It must not
    // end the other way about.
    expect(sound!.end).toBeLessThanOrEqual(picture!.end)
  })

  it('promises the stretch the file plays with both of its tracks', () => {
    const session = soundBufferedAhead()

    // Sound to 10.031, picture to 12: the file plays with both of them for the first ten seconds.
    expect(summarize(session).duration).toBeCloseTo(10.031, 3)
    expect(summarize(session).duration).toBeCloseTo(savedSeconds(selectMaterial(session)), 9)
  })

  it('keeps a segment the clip holds most of', () => {
    // The other side of the same rule. The sound of the ordinary fixture runs to 6.0232 against a
    // picture of six seconds flat, so its last segment hangs 23 milliseconds over the edge —
    // dropping that one would cost real sound to save a rounding.
    expect(selectMaterial(bothTracks()).map((track) => track.segments.length)).toEqual([3, 4])
  })

  it.each(sessions)('writes no more than a moment past what it promises for %s', (_name, build) => {
    const session = build()
    const material = selectMaterial(session)
    if (!material.length) return

    // The file may run past its promise by the tail of a segment that had material inside the
    // clip. What it must not do is run past it by a piece of the video the popup never counted:
    // half a segment is the whole of the licence, and the longest segment here is six seconds.
    expect(fileSeconds(material)).toBeLessThanOrEqual(summarize(session).duration + 3)
  })
})

describe('SessionStore: a track that did not arrive in mp4', () => {
  const videoBuffer = { ...page, bufferId: 'b1' }
  const audioBuffer = { ...page, bufferId: 'b2' }

  /** The picture in mp4 and the sound in WebM, appended the way a player appends them. */
  function feedMixedContainers(store: SessionStore): void {
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: webmAudioInit })
    for (let i = 0; i < 4; i++) {
      const video = videoSegs[i]
      const audio = webmAudioSegs[i]
      if (video) store.append({ ...videoBuffer, bytes: video })
      if (audio) store.append({ ...audioBuffer, bytes: audio })
    }
  }

  it('lands both containers in one session and on one timeline', () => {
    const store = new SessionStore()
    feedMixedContainers(store)

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.tracks.map((t) => t.kinds)).toEqual([['video'], ['audio']])
  })

  it('lays the WebM segments out in seconds, as it lays out the mp4 ones', () => {
    const store = new SessionStore()
    feedMixedContainers(store)

    const [video, audio] = store.list()[0]!.tracks
    expect(video!.map.runs().map((r) => [r.start, r.end])).toEqual([[0, 6]])
    // Matroska counts in milliseconds and the track is written at 48 kHz; either way the map
    // holds seconds, and the four segments make one unbroken run.
    expect(audio!.map.runs()).toHaveLength(1)
    expect(audio!.map.runs()[0]!.start).toBe(0)
    expect(audio!.map.runs()[0]!.end).toBeCloseTo(6.001, 6)
  })

  it('keeps the WebM track as ISO BMFF, not as the bytes the page appended', () => {
    const store = new SessionStore()
    feedMixedContainers(store)

    const audio = store.list()[0]!.tracks[1]!
    expect(audio.initBytes).not.toEqual(webmAudioInit)
    // An mp4 init opens with an ftyp; the WebM one opens with the EBML magic.
    expect([...audio.initBytes.subarray(4, 8)]).toEqual([...Uint8Array.from('ftyp', (c) => c.charCodeAt(0))])
    expect(parseInit(audio.initBytes)!.tracks[0]!.codec).toBe('Opus')

    for (const chunk of audio.map.runs()[0]!.chunks) {
      expect(parseFragment(chunk.bytes)).not.toBeNull()
      expect(webmAudioSegs).not.toContain(chunk.bytes)
    }
  })

  it('identifies the track by the codec the page declared, not by the one it writes', () => {
    const store = new SessionStore()
    feedMixedContainers(store)

    // The session key is built out of these names, and it is the page's stream being identified.
    expect(codecsOf(store.list()[0]!)).toEqual(['A_OPUS', 'avc1'])
  })

  it('reports the stretch where both containers have material at once', () => {
    const store = new SessionStore()
    feedMixedContainers(store)

    const { duration, omits } = summarize(store.list()[0]!)
    // Picture 0…6, sound 0…6.001: six seconds is what a clip can be cut out of, whole.
    expect(duration).toBeCloseTo(6, 6)
    expect(omits).toBeUndefined()
  })

  it('hands both tracks to the muxer with the init each of them is written under', () => {
    const store = new SessionStore()
    feedMixedContainers(store)

    const material = selectMaterial(store.list()[0]!)
    expect(material).toHaveLength(2)
    expect(material[0]!.segments).toEqual(videoSegs)
    expect(material[1]!.segments).toHaveLength(4)
    // Everything handed over is ISO BMFF, whichever container it arrived in.
    for (const track of material) {
      expect(parseInit(track.initBytes)).not.toBeNull()
      for (const segment of track.segments) expect(parseFragment(segment)).not.toBeNull()
    }
  })

  it('opens no track for a WebM stream in a codec it cannot write', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: webmVideoInit })
    store.append({ ...videoBuffer, bytes: webmVideoSeg })

    // Opening one would collect segments no file could hold and promise a picture in the popup
    // that the saved clip would not have.
    expect(store.list()).toEqual([])
  })

  it('keeps the sound when the picture arrives in a container it cannot write', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: webmVideoInit })
    store.append({ ...audioBuffer, bytes: webmAudioInit })
    store.append({ ...videoBuffer, bytes: webmVideoSeg })
    for (const bytes of webmAudioSegs) store.append({ ...audioBuffer, bytes })

    const session = store.list()[0]!
    expect(session.tracks.map((t) => t.kinds)).toEqual([['audio']])
    expect(summarize(session).duration).toBeCloseTo(6.001, 6)
  })

  it('remembers a track refused after the session had opened', () => {
    const store = new SessionStore()
    // The sound buffer opens first, as it does on YouTube, and the session is born on it; the
    // picture is refused a moment later, on a session that already exists.
    store.append({ ...audioBuffer, bytes: webmAudioInit })
    for (const bytes of webmAudioSegs) store.append({ ...audioBuffer, bytes })
    store.append({ ...videoBuffer, bytes: webmVideoInit })

    expect(summarize(store.list()[0]!).omits).toBe('track')
  })

  it('leaves the next video of the page unmarked by the refusal of the previous one', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: webmVideoInit })
    store.append({ ...audioBuffer, bytes: webmAudioInit })
    for (const bytes of webmAudioSegs) store.append({ ...audioBuffer, bytes })

    // A feed of short clips: the page moves on without letting go of its MediaSource, opens a
    // buffer for the next video and this time delivers it in mp4, whole. The refusal belonged to
    // the previous video — carried over, it would warn about a file that is missing nothing.
    const next = { ...page, url: 'https://site.example/watch?v=next', bufferId: 'b3', now: 2000 }
    store.append({ ...next, bytes: init })
    for (const bytes of videoSegs) store.append({ ...next, bytes })

    const [fresh, previous] = store.list()
    expect(fresh!.url).toContain('v=next')
    expect(summarize(fresh!).omits).toBeUndefined()
    // And the video it did belong to keeps it: that file really is sound alone.
    expect(summarize(previous!).omits).toBe('track')
  })

  it('drops a WebM segment that reaches the wrong buffer instead of guessing at it', () => {
    const store = new SessionStore()
    store.append({ ...videoBuffer, bytes: init })
    store.append({ ...audioBuffer, bytes: webmAudioInit })
    // The sound of the page, appended to the buffer the picture goes to.
    store.append({ ...videoBuffer, bytes: webmAudioSegs[0]! })

    expect(store.list()[0]!.tracks[0]!.map.runs()).toEqual([])
  })
})
