import { boxBody, childBoxes, topLevelBoxes, type Box } from './reader'
import { trackIdOf } from './entry'
import type { SampleRef, TrackSamples } from './samples'

/**
 * Reading the sample tables of a complete file — the six boxes of an `stbl` — as against the
 * `moof` of a fragment next door in samples.ts.
 *
 * The two describe the same thing in opposite ways and both are needed, because the material
 * arrives both ways. A capture out of MSE is fragments: each carries its own decode time and its
 * own run of samples, and the movie box in front of them is empty on purpose. An ordinary file —
 * eighteen of the twenty-one live pages that delivered video at all — is the other shape: one
 * movie box holding every sample of every track in six run-length tables, and an `mdat` that says
 * nothing about itself.
 *
 * What comes out is the same `SampleRef` the fragment reader produces, addressed the same way, so
 * that everything downstream — the index a clip is cut from, the frame table the editor draws —
 * cannot tell which reader it came through. Where the two disagree about one recording, one of
 * them is wrong; tests/core/movie.test.ts indexes a file both ways and compares them field for
 * field, which is how we find out which.
 *
 * The offsets in an `stco` are counted from the first byte of the file, so the movie box can be
 * read on its own — a few kilobytes fetched out of a file that was deliberately not downloaded —
 * and every sample of it is still addressed inside that file.
 */

/**
 * Largest number of samples one track of a foreign file is allowed to claim.
 *
 * Every table here is bounded by the box that holds it, which is bound enough for the tables that
 * list their entries. The one that does not is an `stsz` stating a single size for every sample:
 * it has no table behind it, so its `sample_count` — four bytes of a file nobody vouches for —
 * is the only thing saying how many samples there are, and `0xffffffff` of them would be an
 * allocation of gigabytes before anything noticed. Where the length of the file is known it
 * bounds this far tighter; this is the ceiling for where it is not.
 *
 * Two million is past anything real: three hours of sixty-frame picture is 648 000 samples, and
 * three hours of sound at fifty packets a second is 540 000.
 */
export const MAX_SAMPLES = 2_000_000

export function samplesInMovie(data: Uint8Array, sourceLength = 0): TrackSamples[] {
  const moov = topLevelBoxes(data).find((box) => box.type === 'moov')
  if (!moov) return []

  const tracks: TrackSamples[] = []

  for (const trak of childBoxes(data, moov).filter((box) => box.type === 'trak')) {
    const parts = childBoxes(data, trak)
    const tkhd = parts.find((box) => box.type === 'tkhd')
    const mdia = parts.find((box) => box.type === 'mdia')
    if (!tkhd || !mdia || tkhd.size < tkhd.headerSize + 24) continue

    const minf = childBoxes(data, mdia).find((box) => box.type === 'minf')
    const stbl = minf && childBoxes(data, minf).find((box) => box.type === 'stbl')
    // A trak whose sample table never arrived costs itself and no more: a file half of which is
    // readable is worth the half that is.
    if (!stbl) continue

    tracks.push({
      trackId: trackIdOf(data, tkhd),
      samples: samplesInTable(data, stbl, sourceLength),
    })
  }

  return tracks
}

/**
 * A cursor over a run-length table: `stts` states a duration for a run of samples, `ctts` a
 * composition offset for another.
 *
 * Read one sample at a time rather than expanded into an array, because an hour of picture is a
 * hundred thousand samples described by one entry, and the caller wants them one by one anyway.
 * A run of zero is stepped over rather than stalled on — the specification does not forbid it and
 * a foreign file may hold one.
 */
class RunCursor {
  private entry = 0
  private used = 0

  constructor(private readonly runs: Array<{ count: number; value: number }>) {}

  next(fallback: number): number {
    while (this.entry < this.runs.length) {
      const run = this.runs[this.entry]!
      if (this.used < run.count) {
        this.used += 1
        return run.value
      }
      this.entry += 1
      this.used = 0
    }

    // The table ran out before the samples did. Zero rather than a guess: a duration invented
    // here would move every sample after it, and the tables of a whole file are the one place
    // where nothing else states the time.
    return fallback
  }
}

/** How many entries of a fixed width a box actually holds, whatever its count field promises. */
function entriesIn(body: Uint8Array, from: number, width: number, promised: number): number {
  const room = Math.max(0, Math.floor((body.byteLength - from) / width))
  return Math.min(promised, room)
}

function viewOf(body: Uint8Array): DataView {
  return new DataView(body.buffer, body.byteOffset, body.byteLength)
}

function bodyOf(data: Uint8Array, box: Box | undefined): Uint8Array | null {
  return box ? boxBody(data, box) : null
}

/** stts and ctts: version and flags, entry_count, then pairs of four bytes. */
function runsOf(body: Uint8Array | null, signed: boolean): Array<{ count: number; value: number }> {
  if (!body || body.byteLength < 8) return []

  const view = viewOf(body)
  const count = entriesIn(body, 8, 8, view.getUint32(4))
  const runs: Array<{ count: number; value: number }> = []

  for (let i = 0; i < count; i++) {
    const at = 8 + i * 8
    runs.push({
      count: view.getUint32(at),
      value: signed ? view.getInt32(at + 4) : view.getUint32(at + 4),
    })
  }

  return runs
}

/**
 * The samples a player may start from, by number counted from one; null where the box is absent.
 *
 * Absent means every sample is one, which is true of every sound track and of nothing else. Read
 * as an empty set instead, a picture track would offer no place to seek to at all.
 */
function syncSamplesOf(body: Uint8Array | null): Set<number> | null {
  if (!body || body.byteLength < 8) return null

  const view = viewOf(body)
  const count = entriesIn(body, 8, 4, view.getUint32(4))
  const numbers = new Set<number>()
  for (let i = 0; i < count; i++) numbers.add(view.getUint32(8 + i * 4))

  return numbers
}

/** stco and co64: the first byte of every chunk, counted from the first byte of the file. */
function chunkOffsetsOf(data: Uint8Array, stco?: Box, co64?: Box): number[] {
  const wide = co64 !== undefined
  const body = bodyOf(data, co64 ?? stco)
  if (!body || body.byteLength < 8) return []

  const view = viewOf(body)
  const width = wide ? 8 : 4
  const count = entriesIn(body, 8, width, view.getUint32(4))
  const offsets: number[] = []

  for (let i = 0; i < count; i++) {
    const at = 8 + i * width
    // A co64 states one number of sixty-four bits and not two of thirty-two: read as a pair, a
    // file past four gigabytes addresses every chunk of its tail at zero.
    offsets.push(wide ? Number(view.getBigUint64(at)) : view.getUint32(at))
  }

  return offsets
}

interface ChunkRun {
  firstChunk: number
  perChunk: number
}

/** stsc: from this chunk onwards, so many samples apiece, until the next entry says otherwise. */
function chunkRunsOf(body: Uint8Array | null): ChunkRun[] {
  if (!body || body.byteLength < 8) return []

  const view = viewOf(body)
  const count = entriesIn(body, 8, 12, view.getUint32(4))
  const runs: ChunkRun[] = []

  for (let i = 0; i < count; i++) {
    const at = 8 + i * 12
    runs.push({ firstChunk: view.getUint32(at), perChunk: view.getUint32(at + 4) })
  }

  return runs
}

interface SizeTable {
  count: number
  sizeOf: (index: number) => number
}

/**
 * How long each sample is, out of whichever of the two size boxes the file wrote.
 *
 * `stsz` states one size for all of them or lists them four bytes apiece; `stz2` lists them in
 * four, eight or sixteen bits, which is how a muxer keeps the table of a long recording down.
 * Every fixture in this repository is ffmpeg's work and ffmpeg writes only the listed `stsz`, so
 * the other two shapes are built by hand in the tests or they are never read at all.
 */
function sizeTableOf(
  data: Uint8Array,
  stsz: Box | undefined,
  stz2: Box | undefined,
  sourceLength: number,
): SizeTable | null {
  const compact = bodyOf(data, stz2)
  if (compact && compact.byteLength >= 12) {
    const view = viewOf(compact)
    const field = view.getUint8(7)
    if (field !== 4 && field !== 8 && field !== 16) return null

    const room = Math.max(0, compact.byteLength - 12)
    const capacity = field === 4 ? room * 2 : field === 8 ? room : Math.floor(room / 2)
    const count = Math.min(view.getUint32(8), capacity, MAX_SAMPLES)

    return {
      count,
      sizeOf: (index) => {
        if (field === 8) return view.getUint8(12 + index)
        if (field === 16) return view.getUint16(12 + index * 2)
        const byte = view.getUint8(12 + (index >> 1))
        // Two to a byte, the first in the high half.
        return index % 2 === 0 ? byte >> 4 : byte & 0x0f
      },
    }
  }

  const body = bodyOf(data, stsz)
  if (!body || body.byteLength < 12) return null

  const view = viewOf(body)
  const constant = view.getUint32(4)
  const promised = view.getUint32(8)

  if (constant !== 0) {
    // Nothing behind the field bounds this count, so the length of the file does: a sample of
    // this size that begins past the last byte there is cannot be a sample. Where the length is
    // unknown the ceiling stands in for it.
    const room = sourceLength > 0 ? Math.ceil(sourceLength / constant) : MAX_SAMPLES
    return { count: Math.min(promised, room, MAX_SAMPLES), sizeOf: () => constant }
  }

  const count = Math.min(entriesIn(body, 12, 4, promised), MAX_SAMPLES)
  return { count, sizeOf: (index) => view.getUint32(12 + index * 4) }
}

/**
 * Every sample of one track, placed chunk by chunk.
 *
 * Chunk by chunk and not sample by sample, because that is what the chunk map says: it describes
 * chunks and how many samples each holds, and a chunk no entry covers holds none. A reader that
 * walked the samples instead and asked which chunk each belonged to has to answer that question
 * for a chunk nothing describes, and the answer it reaches for is the entry before the first —
 * which is not there.
 */
function samplesInTable(data: Uint8Array, stbl: Box, sourceLength: number): SampleRef[] {
  const boxes = childBoxes(data, stbl)
  const find = (type: string): Box | undefined => boxes.find((box) => box.type === type)

  const sizes = sizeTableOf(data, find('stsz'), find('stz2'), sourceLength)
  if (!sizes) return []

  const chunks = chunkOffsetsOf(data, find('stco'), find('co64'))
  const runs = chunkRunsOf(bodyOf(data, find('stsc')))
  const times = new RunCursor(runsOf(bodyOf(data, find('stts')), false))
  // Version 1 of the ctts states the offset signed, which is how a file that composes a frame
  // before the one it was predicted from says so. Read as unsigned it comes out as four billion.
  const offsets = bodyOf(data, find('ctts'))
  const composition = new RunCursor(runsOf(offsets, offsets?.[0] === 1))
  const syncs = syncSamplesOf(bodyOf(data, find('stss')))

  const samples: SampleRef[] = []
  let dts = 0
  let index = 0
  let run = 0

  for (let chunk = 0; chunk < chunks.length && index < sizes.count; chunk++) {
    const number = chunk + 1
    while (run + 1 < runs.length && runs[run + 1]!.firstChunk <= number) run += 1
    // A first_chunk past chunk one leaves the chunks in front of it described by nothing, and
    // nothing is how many samples they hold.
    const perChunk = runs.length > 0 && runs[run]!.firstChunk <= number ? runs[run]!.perChunk : 0

    let at = chunks[chunk]!
    for (let taken = 0; taken < perChunk && index < sizes.count; taken++) {
      const size = sizes.sizeOf(index)
      const duration = times.next(0)
      const cts = composition.next(0)
      const sync = syncs ? syncs.has(index + 1) : true

      // A sample whose bytes lie past the last byte of the source is not a sample. The times
      // still move on: the table says the sample is there, and only its address is unusable.
      if (sourceLength <= 0 || at + size <= sourceLength) {
        samples.push({ dts, pts: dts + cts, duration, at, size, sync })
      }

      dts += duration
      at += size
      index += 1
    }
  }

  return samples
}
