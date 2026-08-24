#!/usr/bin/env node
// Builds the `multi` fixture set out of a fragmented, muxed mp4 that ffmpeg has already written.
//
// Every reader in src/core/iso and src/core/export that walks a list — the traks of a movie, the
// trex entries of an mvex, the trafs of a moof, the truns of a traf, the entries of an stsd — was
// only ever tested on material holding one of the thing it walks, and four rounds of mutation
// testing kept finding the same family of defect there: the first item taken for the one asked
// about. ffmpeg cannot write the material that catches it. It writes one trun per traf, one entry
// per stsd, and zeroes in every trex; it states the sample defaults in the tfhd of every fragment
// and so never exercises the fall-through to the movie.
//
// So the material is ffmpeg's and the container around it is written here: the coded frames, the
// timescales, the edit lists and the sample entries all come out of the encoder, and this script
// restates them in the shapes the format allows and no encoder produces. Nothing is invented — the
// bytes of every sample cross over untouched, and the file it all reassembles into decodes frame
// for frame the same as the one it came from, which is what tests/core/multi-track.test.ts checks
// before it checks anything else.
//
// Usage: node tools/make-multi-fixture.mjs <fragmented.mp4> <output directory>

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts', 'dinf'])

const TFHD_BASE_DATA_OFFSET = 0x000001
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010
const TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000

const TRUN_DATA_OFFSET = 0x000001
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004
const TRUN_SAMPLE_DURATION = 0x000100
const TRUN_SAMPLE_SIZE = 0x000200
const TRUN_SAMPLE_FLAGS = 0x000400
const TRUN_SAMPLE_CTS = 0x000800

/** How many runs a traf of each kind is cut into. Two different numbers, and neither is one. */
const RUNS_PER_KIND = { video: 3, audio: 2 }

/** The boxes lying end to end between two offsets. */
function boxesIn(buf, from, to) {
  const found = []
  let at = from
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at)
    let hdr = 8
    const type = buf.toString('latin1', at + 4, at + 8)
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(at + 8))
      hdr = 16
    } else if (size === 0) size = to - at
    if (size < hdr || at + size > to) break
    found.push({ type, start: at, size, hdr })
    at += size
  }
  return found
}

const find = (list, type) => list.find((box) => box.type === type)

/** A box as a tree: a container holds children, everything else holds its body verbatim. */
function parseBox(buf, box) {
  if (box.type === 'stsd') {
    // Not a container in the plain sense: a version, flags and an entry count stand in front of
    // the entries, and a reader that took them for a box header would read nonsense.
    const from = box.start + box.hdr
    return {
      type: 'stsd',
      head: buf.subarray(from, from + 8),
      entries: boxesIn(buf, from + 8, box.start + box.size).map((entry) =>
        Buffer.from(buf.subarray(entry.start, entry.start + entry.size)),
      ),
    }
  }
  if (CONTAINERS.has(box.type)) {
    return {
      type: box.type,
      children: boxesIn(buf, box.start + box.hdr, box.start + box.size).map((child) =>
        parseBox(buf, child),
      ),
    }
  }
  return { type: box.type, body: Buffer.from(buf.subarray(box.start + box.hdr, box.start + box.size)) }
}

function serialise(node) {
  let body
  if (node.children) body = Buffer.concat(node.children.map(serialise))
  else if (node.entries) {
    const head = Buffer.from(node.head)
    head.writeUInt32BE(node.entries.length, 4)
    body = Buffer.concat([head, ...node.entries])
  } else body = node.body

  const out = Buffer.alloc(8 + body.length)
  out.writeUInt32BE(out.length, 0)
  out.write(node.type, 4, 'latin1')
  body.copy(out, 8)
  return out
}

const child = (node, type) => node.children.find((c) => c.type === type)

/**
 * A second sample entry beside the one the encoder wrote.
 *
 * A byte copy of the first with the fields a reader is asked for changed, which is what a real
 * multi-entry stsd holds: the same codec described twice, differing in what the description is
 * for. Every reader in this program takes the first entry and only the first (§ entry.ts), and
 * with one entry in the box that contract cannot fail.
 */
function secondEntry(first, kind) {
  const copy = Buffer.from(first)
  if (kind === 'video') {
    // The four letters stay avc1. A second entry naming another codec is legal and is what the
    // stronger fixture would state, and ffmpeg's own demuxer answers it with "multiple fourcc not
    // supported" — the same first-entry-only rule this program holds to, said out loud. It is a
    // warning and not an error and the frames come out identical either way, but a fixture that
    // has to be checked against an allowed complaint is a fixture nobody trusts.
    copy.writeUInt16BE(128, 32) // width
    copy.writeUInt16BE(72, 34) // height
  } else {
    copy.writeUInt16BE(6, 24) // channelcount
    copy.writeUInt32BE(48000 * 0x10000, 32) // samplerate, 16.16
  }
  return copy
}

/** track_ID of a trak, out of its tkhd. */
function trackIdOf(trak) {
  const tkhd = child(trak, 'tkhd')
  return tkhd.body[0] === 1 ? tkhd.body.readUInt32BE(20) : tkhd.body.readUInt32BE(12)
}

/** 'vide' or 'soun', out of the handler of a trak. */
function kindOf(trak) {
  const hdlr = child(child(trak, 'mdia'), 'hdlr')
  return hdlr.body.toString('latin1', 8, 12) === 'vide' ? 'video' : 'audio'
}

/** Every sample of one traf, with the bytes it is made of. */
function samplesOf(buf, moof, traf, mdatPayload, mdatStart) {
  const parts = boxesIn(buf, traf.start + traf.hdr, traf.start + traf.size)
  const tfhd = find(parts, 'tfhd')
  const tfhdBody = buf.subarray(tfhd.start + tfhd.hdr, tfhd.start + tfhd.size)
  const flags = tfhdBody.readUInt32BE(0) & 0x00ffffff

  let field = 8
  let base = moof.start
  if (flags & TFHD_BASE_DATA_OFFSET) {
    base = Number(tfhdBody.readBigUInt64BE(field))
    field += 8
  }
  if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) field += 4
  const defaults = { duration: 0, size: 0, sampleFlags: 0 }
  if (flags & TFHD_DEFAULT_SAMPLE_DURATION) {
    defaults.duration = tfhdBody.readUInt32BE(field)
    field += 4
  }
  if (flags & TFHD_DEFAULT_SAMPLE_SIZE) {
    defaults.size = tfhdBody.readUInt32BE(field)
    field += 4
  }
  if (flags & TFHD_DEFAULT_SAMPLE_FLAGS) defaults.sampleFlags = tfhdBody.readUInt32BE(field)

  const runs = parts.filter((b) => b.type === 'trun')
  if (runs.length !== 1) throw new Error(`expected one trun per traf, found ${runs.length}`)

  const trun = runs[0]
  const body = buf.subarray(trun.start + trun.hdr, trun.start + trun.size)
  const version = body[0]
  const trunFlags = body.readUInt32BE(0) & 0x00ffffff
  const count = body.readUInt32BE(4)

  let read = 8
  let at = base
  if (trunFlags & TRUN_DATA_OFFSET) {
    at = base + body.readInt32BE(read)
    read += 4
  }
  let firstFlags = null
  if (trunFlags & TRUN_FIRST_SAMPLE_FLAGS) {
    firstFlags = body.readUInt32BE(read)
    read += 4
  }

  const samples = []
  for (let i = 0; i < count; i++) {
    const sample = { duration: defaults.duration, size: defaults.size, flags: defaults.sampleFlags, cts: 0 }
    if (trunFlags & TRUN_SAMPLE_DURATION) {
      sample.duration = body.readUInt32BE(read)
      read += 4
    }
    if (trunFlags & TRUN_SAMPLE_SIZE) {
      sample.size = body.readUInt32BE(read)
      read += 4
    }
    if (trunFlags & TRUN_SAMPLE_FLAGS) {
      sample.flags = body.readUInt32BE(read)
      read += 4
    }
    if (trunFlags & TRUN_SAMPLE_CTS) {
      sample.cts = version === 0 ? body.readUInt32BE(read) : body.readInt32BE(read)
      read += 4
    }
    const from = at - mdatStart - 8
    sample.bytes = Buffer.from(mdatPayload.subarray(from, from + sample.size))
    if (sample.bytes.length !== sample.size) throw new Error('a sample runs off the end of its mdat')
    at += sample.size
    samples.push(sample)
  }

  return {
    trackId: tfhdBody.readUInt32BE(4),
    tfdt: Buffer.from(buf.subarray(find(parts, 'tfdt').start, find(parts, 'tfdt').start + find(parts, 'tfdt').size)),
    version,
    perSample: trunFlags & (TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE | TRUN_SAMPLE_FLAGS | TRUN_SAMPLE_CTS),
    firstFlags,
    defaults,
    samples,
  }
}

/** `n` split into `k` runs of nearly equal length, the shorter one last. */
function partition(n, k) {
  const parts = []
  let left = n
  for (let i = 0; i < k; i++) {
    // Biased so that no two runs of a traf hold the same number of samples: equal runs let a
    // reader that took the count of the first run for all of them come out right.
    const take = Math.ceil((left + k - i - 1) / (k - i))
    parts.push(take)
    left -= take
  }
  return parts.filter((size) => size > 0)
}

function fullBox(type, version, flags, ...parts) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(((version & 0xff) << 24) | (flags & 0x00ffffff), 0)
  const body = Buffer.concat([head, ...parts])
  const out = Buffer.alloc(8 + body.length)
  out.writeUInt32BE(out.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  return out
}

function plainBox(type, ...parts) {
  const body = Buffer.concat(parts)
  const out = Buffer.alloc(8 + body.length)
  out.writeUInt32BE(out.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  return out
}

const u32 = (...values) => {
  const out = Buffer.alloc(values.length * 4)
  values.forEach((value, i) => out.writeUInt32BE(value >>> 0, i * 4))
  return out
}

/**
 * The tfhd of one traf.
 *
 * The traf standing first in a moof states nothing beyond where its samples are addressed from, so
 * what its samples last and which of them a player may seek to can be answered only out of the
 * trex of the movie. The one behind it states every optional field the box has, including the
 * sample description index no fixture in this repository writes — a field a reader has to step
 * over before it reaches the defaults behind it.
 *
 * Which track stands first alternates from fragment to fragment (see `main`), so each of the two
 * takes both roles across the set and neither path is the picture's alone.
 */
function fragmentHeader(track, states) {
  if (!states) return fullBox('tfhd', 0, TFHD_DEFAULT_BASE_IS_MOOF, u32(track.trackId))

  return fullBox(
    'tfhd',
    0,
    TFHD_DEFAULT_BASE_IS_MOOF |
      TFHD_SAMPLE_DESCRIPTION_INDEX |
      TFHD_DEFAULT_SAMPLE_DURATION |
      TFHD_DEFAULT_SAMPLE_SIZE |
      TFHD_DEFAULT_SAMPLE_FLAGS,
    u32(track.trackId, 1, track.defaults.duration, track.defaults.size, track.defaults.sampleFlags),
  )
}

/** One trun over a slice of a traf's samples, addressed at `dataOffset` from the moof. */
function trackRun(track, samples, dataOffset, first) {
  const keepFirstFlags = first && track.firstFlags !== null
  const flags = TRUN_DATA_OFFSET | (keepFirstFlags ? TRUN_FIRST_SAMPLE_FLAGS : 0) | track.perSample

  const width =
    (track.perSample & TRUN_SAMPLE_DURATION ? 4 : 0) +
    (track.perSample & TRUN_SAMPLE_SIZE ? 4 : 0) +
    (track.perSample & TRUN_SAMPLE_FLAGS ? 4 : 0) +
    (track.perSample & TRUN_SAMPLE_CTS ? 4 : 0)

  const entries = Buffer.alloc(samples.length * width)
  let at = 0
  for (const sample of samples) {
    if (track.perSample & TRUN_SAMPLE_DURATION) {
      entries.writeUInt32BE(sample.duration, at)
      at += 4
    }
    if (track.perSample & TRUN_SAMPLE_SIZE) {
      entries.writeUInt32BE(sample.size, at)
      at += 4
    }
    if (track.perSample & TRUN_SAMPLE_FLAGS) {
      entries.writeUInt32BE(sample.flags, at)
      at += 4
    }
    if (track.perSample & TRUN_SAMPLE_CTS) {
      if (track.version === 0) entries.writeUInt32BE(sample.cts, at)
      else entries.writeInt32BE(sample.cts, at)
      at += 4
    }
  }

  const head = [u32(samples.length), u32(dataOffset)]
  if (keepFirstFlags) head.push(u32(track.firstFlags))

  return fullBox('trun', track.version, flags, ...head, entries)
}

function main() {
  const [source, out] = process.argv.slice(2)
  if (!source || !out) {
    console.error('usage: node tools/make-multi-fixture.mjs <fragmented.mp4> <output directory>')
    process.exit(2)
  }

  const buf = readFileSync(source)
  const top = boxesIn(buf, 0, buf.length)
  const ftyp = find(top, 'ftyp')
  const moovBox = find(top, 'moov')
  if (!ftyp || !moovBox) throw new Error('the source is not a fragmented mp4')

  // ---- the init segment ----------------------------------------------------------------------
  const moov = parseBox(buf, moovBox)
  const traks = moov.children.filter((node) => node.type === 'trak')
  if (traks.length !== 2) throw new Error(`expected two traks, found ${traks.length}`)

  const kinds = new Map()
  for (const trak of traks) {
    const kind = kindOf(trak)
    kinds.set(trackIdOf(trak), kind)

    const stsd = child(child(child(child(trak, 'mdia'), 'minf'), 'stbl'), 'stsd')
    if (stsd.entries.length !== 1) throw new Error('the encoder already wrote more than one entry')
    stsd.entries.push(secondEntry(stsd.entries[0], kind))
  }

  // ---- the fragments -------------------------------------------------------------------------
  const moofs = top.filter((box) => box.type === 'moof')
  const mdats = top.filter((box) => box.type === 'mdat')
  if (moofs.length !== mdats.length) throw new Error('a moof without an mdat')

  /** What each track's fragments state about their samples, for the trex boxes below. */
  const stated = new Map()
  const segments = []

  for (const [index, moof] of moofs.entries()) {
    const mdat = mdats[index]
    const payload = buf.subarray(mdat.start + 8, mdat.start + mdat.size)
    const parts = boxesIn(buf, moof.start + moof.hdr, moof.start + moof.size)
    const mfhdBox = find(parts, 'mfhd')
    const trafs = parts.filter((box) => box.type === 'traf')
    if (!mfhdBox) throw new Error('a moof without an mfhd')
    if (trafs.length !== 2) throw new Error(`expected two trafs, found ${trafs.length}`)

    const mfhd = Buffer.from(buf.subarray(mfhdBox.start, mfhdBox.start + mfhdBox.size))

    const read = trafs.map((traf) => samplesOf(buf, moof, traf, payload, mdat.start))
    for (const track of read) if (!stated.has(track.trackId)) stated.set(track.trackId, track.defaults)

    // Which track stands first in the moof turns over from fragment to fragment. The order of the
    // trafs inside a moof means nothing to the format, and every packager writes the same one, so
    // "the traf of the track I was asked about" and "the traf that happens to be first" are the
    // same box on all material — including the muxed sets beside this one. Here they are not.
    const tracks = index % 2 === 1 ? [...read].reverse() : read

    // The runs, and the order their bytes lie in the mdat. Interleaved rather than laid out track
    // by track: consecutive runs of one traf are then not adjacent, and a reader that carried on
    // from the end of the previous run instead of reading the run's own data_offset reads the
    // other track's bytes. Laid out end to end the two answers are the same number, which is how
    // that defect lived through four rounds of mutation testing.
    const runs = tracks.map((track) => {
      const sizes = partition(track.samples.length, RUNS_PER_KIND[kinds.get(track.trackId)] ?? 1)
      const slices = []
      let from = 0
      for (const size of sizes) {
        slices.push(track.samples.slice(from, from + size))
        from += size
      }
      return slices
    })

    // The track with the most runs goes first at every turn, so the alternation holds to the end
    // and no two runs of one traf ever come to lie side by side.
    const byLength = runs.map((unused, t) => t).sort((a, b) => runs[b].length - runs[a].length)
    const order = []
    for (let i = 0; i < Math.max(...runs.map((slices) => slices.length)); i++) {
      for (const t of byLength) if (runs[t][i]) order.push({ track: t, run: i, samples: runs[t][i] })
    }

    /** Where every run's bytes begin, counted from the first byte of the mdat payload. */
    const placed = new Map()
    let payloadAt = 0
    const laid = []
    for (const run of order) {
      placed.set(`${run.track}:${run.run}`, payloadAt)
      for (const sample of run.samples) {
        laid.push(sample.bytes)
        payloadAt += sample.bytes.length
      }
    }

    // The traf that states nothing is measured by the trex, so what it used to state has to be
    // what the trex will say. Different numbers here would be a file stating two lengths for one
    // sample, which is not a hard case to read but a broken fixture.
    const silent = tracks[0]
    const movie = stated.get(silent.trackId)
    if (movie.duration !== silent.defaults.duration || movie.sampleFlags !== silent.defaults.sampleFlags) {
      throw new Error(`fragment ${index + 1} of track ${silent.trackId} disagrees with the movie`)
    }

    const build = (offsetOf) =>
      plainBox(
        'moof',
        mfhd,
        ...tracks.map((track, t) =>
          plainBox(
            'traf',
            fragmentHeader(track, t > 0),
            track.tfdt,
            ...runs[t].map((slice, r) => trackRun(track, slice, offsetOf(t, r), r === 0)),
          ),
        ),
      )

    // Two passes: a data offset is counted from the start of the moof, so it cannot be written
    // until the moof is as long as it is going to be. Every field is of fixed width, so the second
    // moof comes out exactly the length the first one measured.
    const measured = build(() => 0)
    const moofBytes = build((t, r) => measured.length + 8 + placed.get(`${t}:${r}`))
    if (moofBytes.length !== measured.length) throw new Error('the moof changed length between passes')

    const mdatBytes = Buffer.alloc(8 + payloadAt)
    mdatBytes.writeUInt32BE(mdatBytes.length, 0)
    mdatBytes.write('mdat', 4, 'latin1')
    Buffer.concat(laid).copy(mdatBytes, 8)

    segments.push(Buffer.concat([moofBytes, mdatBytes]))
  }

  // ---- the movie extends box -----------------------------------------------------------------
  //
  // What every fragment used to state in its own tfhd, stated once for the movie: a duration, a
  // size and a set of sample flags per track, and no two of them alike. The first track's
  // fragments now say nothing of their own and can be measured by this and by nothing else.
  const mvex = child(moov, 'mvex')
  for (const trex of mvex.children.filter((node) => node.type === 'trex')) {
    const trackId = trex.body.readUInt32BE(4)
    const defaults = stated.get(trackId)
    if (!defaults) continue
    trex.body.writeUInt32BE(1, 8) // sample_description_index
    trex.body.writeUInt32BE(defaults.duration, 12)
    trex.body.writeUInt32BE(defaults.size, 16)
    trex.body.writeUInt32BE(defaults.sampleFlags, 20)
  }

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  writeFileSync(
    `${out}/init-stream0.m4s`,
    Buffer.concat([Buffer.from(buf.subarray(ftyp.start, ftyp.start + ftyp.size)), serialise(moov)]),
  )
  for (const [i, segment] of segments.entries()) {
    writeFileSync(`${out}/chunk-stream0-${String(i + 1).padStart(5, '0')}.m4s`, segment)
  }

  console.log(
    `multi: ${segments.length} segments, tracks ${[...kinds].map(([id, kind]) => `${id}:${kind}`).join(' ')}`,
  )
}

main()
