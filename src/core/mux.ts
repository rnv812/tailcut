import { trafDuration } from './iso/fragment'
import { childBoxes, topLevelBoxes, type Box } from './iso/reader'
import { boxOf } from './iso/writer'

/**
 * Multiplexer: several streams into one fragmented MP4.
 *
 * A media source hands the picture and the sound to separate SourceBuffers, each with an init
 * segment of its own, a timescale of its own and a map of its own. Two init segments written one
 * after the other are not a file — a player reads the first moov and stops. The file has to be
 * built: one ftyp, one moov holding a trak per track and the matching trex boxes in the mvex, and
 * the media fragments of every track interleaved in one order of time.
 *
 * Nothing here touches the media data. Fragments move whole, byte for byte, and the work is all
 * on the boxes around them: track numbers, decode times, absolute offsets that stop being true
 * once a fragment moves. That is also why this is the place the edit list (§8.2) will be written
 * from later — by then the file is already assembled from parts, and `elst` is one more of them.
 */

/** base-data-offset-present in tfhd: sample data is addressed absolutely instead of from the moof. */
const TFHD_BASE_DATA_OFFSET = 0x000001

/** One stream to put into the file: the init segment that opened it and its media segments. */
export interface MuxTrack {
  /** ftyp + moov of the stream, exactly as the page appended them. */
  initBytes: Uint8Array
  /** Media segments. Any order: the muxer lays them out by decode time, not by arrival. */
  segments: Uint8Array[]
}

/** A moof with everything that belongs to it, marked out inside the segment it arrived in. */
interface Fragment {
  /** The captured segment. Held as it is, not copied: a saved clip is tens of megabytes. */
  segment: Uint8Array
  /** From the start of the moof to the next moof, or to the end of the segment. */
  start: number
  end: number
  /** Decode time in seconds — the one scale on which fragments of different tracks compare. */
  time: number
  /** Where the fragment runs to, in the same seconds: its samples add up to that much. */
  until: number
  /** track_id inside this stream → track_id in the file being built. */
  ids: Map<number, number>
}

/** A stretch of the timeline, in seconds. */
interface Span {
  start: number
  end: number
}

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const sliceOf = (bytes: Uint8Array, box: Box): Uint8Array =>
  bytes.slice(box.start, box.start + box.size)

const typeIn = (boxes: Box[], type: string): Box | undefined => boxes.find((b) => b.type === type)

/** Where track_id sits in a tkhd: the times before it are twice as long in version 1. */
const tkhdTrackIdAt = (data: Uint8Array, tkhd: Box): number =>
  data[tkhd.start + tkhd.headerSize] === 1
    ? tkhd.start + tkhd.headerSize + 20
    : tkhd.start + tkhd.headerSize + 12

/** Ticks per second stated by an mvhd or an mdhd: the field sits in the same place in both. */
function timescaleAt(data: Uint8Array, box: Box): number {
  const body = box.start + box.headerSize
  return viewOf(data).getUint32(data[body] === 1 ? body + 20 : body + 12)
}

/** Ticks per second of a track; null — the trak says nothing usable, and its times mean nothing. */
function timescaleOf(data: Uint8Array, trak: Box): number | null {
  const mdia = typeIn(childBoxes(data, trak), 'mdia')
  const mdhd = mdia && typeIn(childBoxes(data, mdia), 'mdhd')
  if (!mdhd) return null

  const timescale = timescaleAt(data, mdhd)
  // Zero would turn every time of this track into a division by zero: better no track at all.
  return timescale > 0 ? timescale : null
}

/** tfdt: version(1) flags(3), then the decode time — 64 bits of it in version 1. */
function decodeTicksOf(bytes: Uint8Array, tfdt: Box): number {
  const body = tfdt.start + tfdt.headerSize
  const view = viewOf(bytes)
  return bytes[body] === 1 ? Number(view.getBigUint64(body + 4)) : view.getUint32(body + 4)
}

/**
 * When the fragment starts and when it runs out, in seconds. The ticks are counted in the
 * timescale of the track and the tracks do not share one, so seconds are the only scale on which
 * fragments of two tracks can be put in one order — or measured against each other for how long
 * the clip they make up is.
 *
 * null: the fragment names a track this file does not carry, or it is missing the boxes that say
 * when it belongs. There is no honest place on the timeline for such a fragment, and guessing one
 * would drop it into the middle of a track it has nothing to do with.
 */
function spanOf(
  bytes: Uint8Array,
  ids: Map<number, number>,
  timescales: Map<number, number>,
): Span | null {
  const moof = typeIn(topLevelBoxes(bytes), 'moof')
  if (!moof) return null

  const view = viewOf(bytes)
  let start: number | null = null
  let end = 0

  for (const traf of childBoxes(bytes, moof).filter((b) => b.type === 'traf')) {
    const children = childBoxes(bytes, traf)
    const tfhd = typeIn(children, 'tfhd')
    const tfdt = typeIn(children, 'tfdt')
    if (!tfhd || !tfdt) return null

    const id = ids.get(view.getUint32(tfhd.start + tfhd.headerSize + 4))
    const timescale = id === undefined ? undefined : timescales.get(id)
    if (timescale === undefined) return null

    const from = decodeTicksOf(bytes, tfdt) / timescale
    // Zero for a packager that keeps its sample defaults in the trex: the fragment then measures
    // out as an instant, and the clip is as long as the fragments that do state their samples.
    const to = from + trafDuration(bytes, traf) / timescale
    if (start === null || from < start) start = from
    if (to > end) end = to
  }

  return start === null ? null : { start, end: Math.max(end, start) }
}

/** Fragments of one media segment, in the order they lie in it. */
function fragmentsOf(
  segment: Uint8Array,
  ids: Map<number, number>,
  timescales: Map<number, number>,
): Fragment[] {
  const boxes = topLevelBoxes(segment)
  const last = boxes[boxes.length - 1]
  if (!last) return []

  // The end of the last box the reader could make sense of, not the end of the buffer: a tail it
  // stopped on is bytes of unknown shape and has no place in the file being built.
  const end = last.start + last.size
  const starts = boxes.filter((b) => b.type === 'moof').map((b) => b.start)
  const fragments: Fragment[] = []

  for (const [index, start] of starts.entries()) {
    // Everything from the moof to the next one: its mdat, and whatever else the packager put
    // between the two. trun states where its samples are relative to the moof, so a fragment
    // survives being moved elsewhere in the file only if it moves in one piece. What comes before
    // the first moof — the styp and the sidx — describes the segment as a standalone delivery and
    // is left behind.
    const stop = starts[index + 1] ?? end
    const span = spanOf(segment.subarray(start, stop), ids, timescales)
    if (!span) continue

    fragments.push({ segment, start, end: stop, time: span.start, until: span.end, ids })
  }

  return fragments
}

/**
 * Rewrites a fragment for the place it has been given in the file: its track number, its position
 * on the shared timeline, its number in the sequence and, if the packager addressed its samples
 * absolutely, the offset they are addressed by. Works on the copy already lying in the file at
 * `at`, so the captured segment it came from is left as it was.
 */
function place(
  bytes: Uint8Array,
  fragment: Fragment,
  origin: number,
  timescales: Map<number, number>,
  sequence: number,
  at: number,
): void {
  const view = viewOf(bytes)
  const moof = typeIn(topLevelBoxes(bytes), 'moof')
  if (!moof) return

  // How far the fragment has moved from where its packager put it.
  const shift = at - fragment.start

  for (const child of childBoxes(bytes, moof)) {
    if (child.type === 'mfhd') {
      // Numbered along the file instead of each track from one: two tracks numbered 1, 2, 3 each
      // give a file whose fragments announce an order they are not in.
      view.setUint32(child.start + child.headerSize + 4, sequence)
      continue
    }
    if (child.type !== 'traf') continue

    const children = childBoxes(bytes, child)
    const tfhd = typeIn(children, 'tfhd')
    const tfdt = typeIn(children, 'tfdt')
    // Both were found once already: spanOf drops a fragment that is missing either.
    if (!tfhd || !tfdt) continue

    const body = tfhd.start + tfhd.headerSize
    const id = fragment.ids.get(view.getUint32(body + 4))
    const timescale = id === undefined ? undefined : timescales.get(id)
    if (id === undefined || timescale === undefined) continue
    view.setUint32(body + 4, id)

    if (view.getUint32(body) & TFHD_BASE_DATA_OFFSET) {
      // An absolute offset was true of the segment it arrived in and is false of the file: left
      // as it is, the fragment reads its samples out of the moov and hands the decoder noise.
      // It is stated from the start of the media segment — what the byte stream format of MSE
      // asks of a segment appended on its own — so moving the fragment is the whole correction.
      view.setBigUint64(body + 8, view.getBigUint64(body + 8) + BigInt(shift))
    }

    // Ticks of this track for the same stretch of real time every other track is moved by.
    // Rounded down, so the fragment that defines the origin lands on zero or a tick after it and
    // never before it.
    shiftDecodeTime(bytes, view, tfdt, Math.floor(origin * timescale))
  }
}

function shiftDecodeTime(bytes: Uint8Array, view: DataView, tfdt: Box, delta: number): void {
  const body = tfdt.start + tfdt.headerSize
  if (bytes[body] === 1) view.setBigUint64(body + 4, view.getBigUint64(body + 4) - BigInt(delta))
  else view.setUint32(body + 4, view.getUint32(body + 4) - delta)
}

/** Largest length a 32-bit field can hold; 0xffffffff is what a file writes for "unknown". */
const MAX_NARROW_DURATION = 0xfffffffe

/**
 * Writes a length into the box that states one. mvhd and mdhd carry the field behind the
 * timescale, tkhd behind the reserved word after its track number, and version 1 doubles every
 * time before it as well as the field itself.
 */
function writeDuration(bytes: Uint8Array, box: Box, ticks: number): void {
  const body = box.start + box.headerSize
  const wide = bytes[body] === 1
  const at = body + (box.type === 'tkhd' ? (wide ? 28 : 20) : wide ? 24 : 16)
  const view = viewOf(bytes)

  if (wide) view.setBigUint64(at, BigInt(Math.max(0, Math.round(ticks))))
  // A narrow field cannot hold more than four bytes of ticks, and 0xffffffff is spoken for: a
  // clip long enough to reach the cap is capped rather than wrapped round to a few seconds.
  else view.setUint32(at, Math.min(MAX_NARROW_DURATION, Math.max(0, Math.round(ticks))))
}

/**
 * States how long the clip is everywhere a file states it: once for the movie and twice for every
 * track of it.
 *
 * An init segment describes the whole video the fragments were cut out of, and a packager that
 * knows the length writes it there — YouTube's init says ten minutes for a clip of twenty
 * seconds. Left as it came, the file says ten minutes and a player believes it: the material runs
 * out, the timeline does not, and playback breaks off in the middle of what the file promised.
 *
 * Zero when the fragments give nothing to measure — that is what a fragmented file says for a
 * length it does not know, and a player works it out of the fragments themselves.
 */
function stateDuration(mvhd: Uint8Array | undefined, traks: Uint8Array[], seconds: number): void {
  const header = mvhd && topLevelBoxes(mvhd)[0]
  const movieTimescale = mvhd && header ? timescaleAt(mvhd, header) : 0
  if (mvhd && header) writeDuration(mvhd, header, seconds * movieTimescale)

  for (const bytes of traks) {
    const trak = topLevelBoxes(bytes)[0]
    if (!trak) continue

    const children = childBoxes(bytes, trak)
    const tkhd = typeIn(children, 'tkhd')
    // tkhd counts in the timescale of the movie. Without an mvhd the file states no such scale,
    // and the only honest length for a track is then none at all.
    if (tkhd) writeDuration(bytes, tkhd, seconds * movieTimescale)

    const mdia = typeIn(children, 'mdia')
    const mdhd = mdia && typeIn(childBoxes(bytes, mdia), 'mdhd')
    if (mdhd) writeDuration(bytes, mdhd, seconds * timescaleAt(bytes, mdhd))
  }
}

/**
 * Builds one fragmented MP4 out of the tracks given. An empty buffer comes back when there is
 * nothing to build one from: the bytes are captured from a foreign page, and material the parser
 * cannot make sense of is dropped rather than thrown about.
 */
export function muxFragmentedMp4(tracks: MuxTrack[]): Uint8Array {
  let ftyp: Uint8Array | undefined
  let mvhd: Uint8Array | undefined
  const traks: Uint8Array[] = []
  const trexs: Uint8Array[] = []
  /** track_id in the file being built → ticks per second of that track. */
  const timescales = new Map<number, number>()
  const fragments: Fragment[] = []
  let nextTrackId = 1

  for (const track of tracks) {
    // A copy of its own: renumbering patches the init in place, and the caller's bytes are the
    // material of a live session — the same init goes out again on the next save.
    const init = track.initBytes.slice()
    const view = viewOf(init)
    const boxes = topLevelBoxes(init)
    const moov = typeIn(boxes, 'moov')
    if (!moov) continue

    // One ftyp for the file, from the first init that carries one: the brands of two streams of
    // one media source describe the same container, and a second ftyp in the middle of a file is
    // not a box any player is looking for there.
    const brands = typeIn(boxes, 'ftyp')
    if (!ftyp && brands) ftyp = sliceOf(init, brands)

    const inside = childBoxes(init, moov)
    const header = typeIn(inside, 'mvhd')
    if (!mvhd && header) mvhd = sliceOf(init, header)

    /** Numbers this stream gives its tracks → the numbers they get in the file. */
    const ids = new Map<number, number>()

    for (const trak of inside.filter((b) => b.type === 'trak')) {
      const tkhd = typeIn(childBoxes(init, trak), 'tkhd')
      const timescale = timescaleOf(init, trak)
      if (!tkhd || timescale === null) continue

      // Every stream numbers its tracks from one, so two inits of one video both call their track
      // number one. Renumbered here and nowhere else: the fragments follow through this map.
      const at = tkhdTrackIdAt(init, tkhd)
      const id = nextTrackId++
      ids.set(view.getUint32(at), id)
      view.setUint32(at, id)
      timescales.set(id, timescale)
      traks.push(sliceOf(init, trak))
    }

    const mvex = typeIn(inside, 'mvex')
    for (const trex of mvex ? childBoxes(init, mvex) : []) {
      // Only the trex boxes: a mehd states the duration of the whole movie in a timescale of its
      // own, and a clip cut out of the middle of a stream makes it a lie either way.
      if (trex.type !== 'trex') continue

      const at = trex.start + trex.headerSize + 4
      const id = ids.get(view.getUint32(at))
      // Sample defaults for a track that did not make it into the file: nothing to state them for.
      if (id === undefined) continue
      view.setUint32(at, id)
      trexs.push(sliceOf(init, trex))
    }

    for (const segment of track.segments) {
      for (const fragment of fragmentsOf(segment, ids, timescales)) fragments.push(fragment)
    }
  }

  if (!traks.length) return new Uint8Array(0)

  // Sorting is stable, so fragments of one and the same decode time keep the order their tracks
  // stand in: the picture of a moment goes into the file ahead of its sound.
  fragments.sort((a, b) => a.time - b.time)

  // The clip begins where its earliest fragment does. Every track is moved back by that one
  // origin — each in its own ticks, all by the same stretch of real time — so the file starts at
  // zero and the tracks keep the offset they had against each other. Moving each track back to
  // its own first fragment instead would zero out an offset that is real: the picture and the
  // sound are cut into segments of different length and hardly ever begin at the same instant.
  const origin = fragments[0]?.time ?? 0

  // Where the last of the material runs out. Not the start of the last fragment: a fragment lasts
  // for its samples, and a clip that ended at the start of its final one would cut them off.
  let last = origin
  for (const fragment of fragments) if (fragment.until > last) last = fragment.until

  // Track numbers ran out at nextTrackId, and next_track_ID is where a file states that.
  if (mvhd) viewOf(mvhd).setUint32(mvhd.byteLength - 4, nextTrackId)

  // One length for the movie and for every track of it. The tracks of a clip cover one and the
  // same stretch of time — that is what they were selected over — and the tenths of a second they
  // differ by at the edges are not worth a length per track stated out of a different count.
  stateDuration(mvhd, traks, last - origin)

  const head: Uint8Array[] = []
  if (ftyp) head.push(ftyp)
  head.push(boxOf('moov', ...(mvhd ? [mvhd] : []), ...traks, boxOf('mvex', ...trexs)))

  // One buffer, written into once. A clip is tens of megabytes, and gathering the fragments into
  // an array of copies first would hold two of it in memory at the height of a save.
  let total = 0
  for (const part of head) total += part.byteLength
  for (const fragment of fragments) total += fragment.end - fragment.start

  const out = new Uint8Array(total)
  let at = 0
  for (const part of head) {
    out.set(part, at)
    at += part.byteLength
  }

  for (const [index, fragment] of fragments.entries()) {
    const size = fragment.end - fragment.start
    out.set(fragment.segment.subarray(fragment.start, fragment.end), at)
    place(out.subarray(at, at + size), fragment, origin, timescales, index + 1, at)
    at += size
  }

  return out
}
