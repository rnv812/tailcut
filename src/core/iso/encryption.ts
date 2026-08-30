import { boxBody, boxesIn, childBoxes, topLevelBoxes, type Box } from './reader'

/**
 * Whether an ISO BMFF segment carries protected media.
 *
 * The most direct evidence of DRM there is: a protected stream says so in its own boxes, and
 * those boxes are walked here rather than searched for. It needs no key system to have been
 * mentioned on the page and no CDM to have answered — a page that plays encrypted bytes is
 * refused whether or not the negotiation was ever seen, and a page that asks about DRM and then
 * plays in the clear leaves nothing here to find.
 *
 * Common Encryption (ISO/IEC 23001-7) shows itself in three places, and this reads all three:
 *
 * - the sample entry of the init segment, which is `encv` or `enca` in place of the codec's own
 *   four-letter name, with `sinf` inside it carrying `frma`, `schm` and `tenc`;
 * - `senc`, or the pair `saiz`/`saio`, in the track fragment of a media segment — the per-sample
 *   initialisation vectors, which is all a stream joined halfway through has to offer;
 * - `pssh`, the header of the protection system itself, at the top level of a segment or inside
 *   the moov.
 *
 * Measured on the dash.js ClearKey sample and on the protected buffers of edition.cnn.com: both
 * carried pssh, sinf, encv, tenc, schm and senc. The article page of the same site probed for
 * sixteen key systems and carried not one of these boxes — that stream is in the clear, and this
 * says so.
 */
export function isoEncrypted(data: Uint8Array): boolean {
  for (const box of topLevelBoxes(data)) {
    if (box.type === 'pssh') return true
    if (box.type === 'moov' && protectedMoov(data, box)) return true
    if (box.type === 'moof' && protectedMoof(data, box)) return true
  }

  return false
}

/** Common Encryption substitutes these sample entries for codecs (ISO/IEC 23001-7, clause 4.1). */
const PROTECTED_ENTRIES = new Set(['encv', 'enca', 'encs', 'enct', 'encm'])

/**
 * Fields a visual sample entry keeps in front of its child boxes, counted from the start of its
 * body: six reserved bytes and the data reference index, then the seventy of VisualSampleEntry.
 */
const VISUAL_FIELDS = 78

/** The same for a sound entry: the eight shared bytes and the twenty of AudioSampleEntry. */
const AUDIO_FIELDS = 28

/** What the QuickTime versions of a sound entry add on top of those twenty bytes. */
const AUDIO_V1_EXTRA = 16
const AUDIO_V2_EXTRA = 36

function protectedMoov(data: Uint8Array, moov: Box): boolean {
  for (const child of childBoxes(data, moov)) {
    if (child.type === 'pssh') return true
    if (child.type === 'trak' && protectedTrack(data, child)) return true
  }

  return false
}

function protectedTrack(data: Uint8Array, trak: Box): boolean {
  const mdia = childBoxes(data, trak).find((b) => b.type === 'mdia')
  if (!mdia) return false

  const hdlr = childBoxes(data, mdia).find((b) => b.type === 'hdlr')
  const minf = childBoxes(data, mdia).find((b) => b.type === 'minf')
  if (!hdlr || !minf) return false

  const stbl = childBoxes(data, minf).find((b) => b.type === 'stbl')
  const stsd = stbl ? childBoxes(data, stbl).find((b) => b.type === 'stsd') : undefined
  if (!stsd) return false

  const handler = handlerOf(data, hdlr)

  // stsd: version and flags, then the entry count, then the entries as boxes of their own.
  for (const entry of boxesIn(data, stsd.start + stsd.headerSize + 8, stsd.start + stsd.size)) {
    if (PROTECTED_ENTRIES.has(entry.type)) return true

    // An entry that kept the name of its codec and hid the scheme inside itself: not what the
    // standard asks for, and read all the same — the box that describes protection is the point,
    // not the name over it.
    const fields = entryFields(data, entry, handler)
    if (fields === null) continue

    const from = entry.start + entry.headerSize + fields
    const children = boxesIn(data, from, entry.start + entry.size)
    if (children.some((child) => child.type === 'sinf')) return true
  }

  return false
}

/** hdlr: version and flags, pre_defined, then the four letters of the handler type. */
function handlerOf(data: Uint8Array, hdlr: Box): string {
  const body = boxBody(data, hdlr)
  if (body.byteLength < 12) return ''
  return String.fromCharCode(body[8]!, body[9]!, body[10]!, body[11]!)
}

/**
 * How many bytes of fixed fields stand between the start of a sample entry's body and its child
 * boxes. Null for a track whose kind says nothing about the layout of its entries — a subtitle or
 * a metadata track, where the guess would land inside the fields rather than after them.
 */
function entryFields(data: Uint8Array, entry: Box, handler: string): number | null {
  if (handler === 'vide') return VISUAL_FIELDS
  if (handler !== 'soun') return null

  const body = boxBody(data, entry)
  if (body.byteLength < AUDIO_FIELDS) return null

  // QuickTime numbers its sound entries, and versions one and two carry extra fields. The number
  // sits where ISO BMFF has the first two of its reserved bytes.
  const version = (body[8]! << 8) | body[9]!
  if (version === 1) return AUDIO_FIELDS + AUDIO_V1_EXTRA
  if (version === 2) return AUDIO_FIELDS + AUDIO_V2_EXTRA
  return AUDIO_FIELDS
}

function protectedMoof(data: Uint8Array, moof: Box): boolean {
  for (const traf of childBoxes(data, moof)) {
    if (traf.type !== 'traf') continue

    const types = new Set(childBoxes(data, traf).map((child) => child.type))
    // The per-sample initialisation vectors: nothing but encryption puts these in a fragment.
    if (types.has('senc')) return true
    // The same information stored beside the samples instead of in a box of its own. Both halves
    // are required, because auxiliary information has uses that are not encryption and the price
    // of reading one wrong is the whole page's recording.
    if (types.has('saiz') && types.has('saio')) return true
  }

  return false
}
