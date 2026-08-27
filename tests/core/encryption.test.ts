import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { encryptedMedia } from '../../src/core/container'
import { ID } from '../../src/core/webm/reader'

/** An ordinary init segment: one avc1 picture track, nothing protected about it. */
const clearInit = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
/** A media segment of that same clear stream. */
const clearSegment = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))
/**
 * The header of a Common Encryption stream: `encv` in place of `avc1`, and `sinf` with `frma`,
 * `schm` and `tenc` inside it. The shape the dash.js ClearKey sample and the protected buffers of
 * edition.cnn.com were measured to have; see tools/make-fixtures.sh for how it is made.
 */
const cencInit = new Uint8Array(readFileSync('tests/fixtures/cenc/init-stream0.m4s'))

const clearWebmInit = new Uint8Array(readFileSync('tests/fixtures/webm/init-stream0.webm'))

const init = (bytes: Uint8Array) => encryptedMedia({ kind: 'init' as const, bytes })
const media = (bytes: Uint8Array) => encryptedMedia({ kind: 'media' as const, bytes })

// --- ISO BMFF by hand, for the shapes the fixtures do not hold ---

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))

const uint32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
]

/** One box: size, type, body. */
const box = (type: string, ...body: number[]): number[] => [
  ...uint32(body.length + 8),
  ...ascii(type),
  ...body,
]

const buffer = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat())

/** One track fragment numbered `trackId`, holding whatever boxes the test puts in it. */
const traf = (trackId: number, children: number[][]): number[] =>
  box('traf', ...box('tfhd', ...uint32(0), ...uint32(trackId)), ...children.flat())

/**
 * A media segment carrying a track fragment for each of two tracks — the shape a page gets when
 * it hands one SourceBuffer both the picture and the sound.
 *
 * Two of them and not one, because the mark of protection may be in either: a stream sends the
 * picture in the clear and licenses the sound, or the other way round, and the moof is walked to
 * the end for that reason. With one traf in the segment "the traf that carries the senc" and "the
 * first traf there is" are the same box and a walk that stopped at it could not be told apart.
 */
const fragment = (first: number[][] = [], second: number[][] = []): Uint8Array =>
  buffer(
    box('styp', ...ascii('msdh'), ...uint32(0)),
    box(
      'moof',
      ...box('mfhd', ...uint32(0), ...uint32(1)),
      ...traf(1, first),
      ...traf(2, second),
    ),
    box('mdat', 1, 2, 3, 4),
  )

// --- Matroska by hand: the fixtures carry no encrypted track ---

/** An element id as it lies in the bytes: the marker bits are part of the number. */
function elementId(value: number): number[] {
  const out: number[] = []
  let rest = value
  while (rest > 0) {
    out.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  }
  return out.length ? out : [0]
}

/** A length as a variable-length integer, in the narrowest width that fits it. */
function vint(value: number): number[] {
  let length = 1
  while (value > 2 ** (7 * length) - 2) length++

  const out: number[] = []
  let rest = value
  for (let i = 0; i < length; i++) {
    out.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  }
  out[0]! |= 0x80 >> (length - 1)
  return out
}

const element = (id: number, ...body: number[]): number[] => [
  ...elementId(id),
  ...vint(body.length),
  ...body,
]

/** ContentEncryption, the id Matroska gives the description of an encrypted track. */
const CONTENT_ENCRYPTION = 0x5035
/** ContentEncodingType: 1 is encryption, 0 the compression a clear track may well use. */
const CONTENT_ENCODING_TYPE = 0x5033

/** A WebM init segment with one track, carrying whatever ContentEncoding the test hands it. */
const webmInit = (...encoding: number[][]): Uint8Array =>
  Uint8Array.from(
    element(
      ID.segment,
      ...element(ID.info, ...element(ID.timestampScale, 0x0f, 0x42, 0x40)),
      ...element(
        ID.tracks,
        ...element(
          ID.trackEntry,
          ...element(ID.trackNumber, 1),
          ...element(ID.trackType, 1),
          ...element(ID.codecId, ...ascii('V_VP9')),
          ...(encoding.length
            ? element(ID.contentEncodings, ...element(ID.contentEncoding, ...encoding.flat()))
            : []),
        ),
      ),
    ),
  )

describe('recognising encrypted media in the bytes of the stream', () => {
  it('reads protection out of an init segment written in Common Encryption', () => {
    // The most direct evidence there is: the containers are parsed anyway, and a protected stream
    // says so in its own header. No key system need ever have been mentioned on the page.
    expect(init(cencInit)).toBe(true)
  })

  it('leaves a clear init segment alone', () => {
    expect(init(clearInit)).toBe(false)
  })

  it('leaves a clear media segment alone', () => {
    expect(media(clearSegment)).toBe(false)
  })

  it('reads protection out of the senc of a media segment', () => {
    // Where recording started in the middle of a stream and the init went past unseen, the
    // fragments still carry the per-sample initialisation vectors, and nothing else does.
    const senc = box('senc', ...uint32(0), ...uint32(0))
    expect(media(fragment([senc]))).toBe(true)

    // And in the fragment of the track standing second, which is the same claim from the other
    // end: the picture of this segment is in the clear and its sound is not. A walk that stopped
    // at the first traf calls the segment clear and the page goes on being recorded.
    expect(media(fragment([], [senc]))).toBe(true)
  })

  it('reads protection out of the pair of saiz and saio', () => {
    // The other way a fragment states where its encrypted samples begin: the auxiliary
    // information the decryptor is handed, sized and located.
    const saiz = box('saiz', ...uint32(0), 0, ...uint32(0))
    const saio = box('saio', ...uint32(0), ...uint32(0))

    expect(media(fragment([saiz, saio]))).toBe(true)
    expect(media(fragment([], [saiz, saio]))).toBe(true)
  })

  it('does not call a lone saio protection', () => {
    // Auxiliary information has uses besides encryption. One box of the pair is not the shape a
    // protected fragment has, and the cost of being wrong here is the whole page's recording.
    const saio = box('saio', ...uint32(0), ...uint32(0))
    expect(media(fragment([saio]))).toBe(false)

    // The pair has to be found inside one and the same traf. One half of it in each of the two
    // is two ordinary fragments, and calling that protection would refuse the page over boxes
    // neither of its tracks carries.
    expect(media(fragment([saio], [box('saiz', ...uint32(0), 0, ...uint32(0))]))).toBe(false)
  })

  it('reads protection out of a pssh box beside the fragment', () => {
    // The header of the protection system itself: it stands at the top level of a segment, and
    // it exists for no other purpose.
    const beside = Uint8Array.from([
      ...box('pssh', ...uint32(0), ...new Array<number>(16).fill(0)),
      ...fragment(),
    ])

    expect(media(beside)).toBe(true)
  })

  it('reads protection out of a pssh inside the moov', () => {
    expect(
      init(
        buffer(
          box('ftyp', ...ascii('isom'), ...uint32(0)),
          box('moov', ...box('pssh', ...uint32(0), ...new Array<number>(16).fill(0))),
        ),
      ),
    ).toBe(true)
  })

  it('is not fooled by the payload of a fragment spelling the name of a box', () => {
    // A picture is bytes, and given enough of them it spells anything. The boxes are walked and
    // never searched for: a "senc" inside an mdat is a frame, not a declaration.
    const forged = buffer(
      box('styp', ...ascii('msdh')),
      box('moof', ...box('mfhd', ...uint32(0), ...uint32(1))),
      box('mdat', ...uint32(16), ...ascii('senc'), ...new Array<number>(8).fill(0)),
    )

    expect(media(forged)).toBe(false)
  })

  it('reads protection out of a WebM track that declares ContentEncryption', () => {
    expect(init(webmInit(element(CONTENT_ENCRYPTION, ...element(0x47e1, 5))))).toBe(true)
  })

  it('reads protection out of a WebM ContentEncodingType of encryption', () => {
    expect(init(webmInit(element(CONTENT_ENCODING_TYPE, 1)))).toBe(true)
  })

  it('leaves a WebM track whose ContentEncoding is compression alone', () => {
    // Type zero is compression, which a clear track uses as it pleases: header stripping is the
    // ordinary case in Matroska and says nothing about protection.
    expect(init(webmInit(element(CONTENT_ENCODING_TYPE, 0)))).toBe(false)
  })

  it('leaves a clear WebM init segment alone', () => {
    expect(init(clearWebmInit)).toBe(false)
    expect(init(webmInit())).toBe(false)
  })

  it('says nothing of bytes that are not media at all', () => {
    const html = '<!DOCTYPE html><html><body>not a video</body></html>'
    expect(init(Uint8Array.from(html, (c) => c.charCodeAt(0)))).toBe(false)
    expect(init(new Uint8Array(0))).toBe(false)
    expect(media(new Uint8Array(512))).toBe(false)
  })

  it('survives an encrypted init segment cut off at any length', () => {
    // Bytes arrive in pieces, and a piece is handed over as it stands. Every prefix has to end in
    // an answer rather than in a throw.
    for (let length = 0; length <= cencInit.byteLength; length++) {
      expect(() => init(cencInit.subarray(0, length))).not.toThrow()
    }
  })
})
