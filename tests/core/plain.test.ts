import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { locateMovie, type RangeRead } from '../../src/core/iso/locate'
import { assembleMp4 } from '../../src/core/export/assemble'
import { planClip } from '../../src/core/export/plan'
import { planRanges, readEfficiency, readsFor } from '../../src/core/export/ranges'
import { bytesFrom, clipSourceFrom, movieTracksOf } from '../../src/core/export/source'
import { decodeWarnings, frameAt, frameByPlaying, probeFile, writeTemp } from '../support/media'
import type { Located } from '../../src/shared/types'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

/** ftyp, free, mdat, moov — the movie box at the tail, where a muxer leaves it by default. */
const whole = read('tests/fixtures/plain/whole.mp4')
/** ftyp, moov, free, mdat — the same recording written for streaming. */
const faststart = read('tests/fixtures/plain/faststart.mp4')

/**
 * A file behind ranged reads, keeping the tally of what was asked of it.
 *
 * The tally is the point of this module as much as the file is: "few and large rather than many
 * and small" is a claim about requests, and a claim of that kind is worth only what is counted.
 */
function serve(file: Uint8Array) {
  const asked: Array<[number, number]> = []
  let bytes = 0

  return {
    asked,
    get bytes(): number {
      return bytes
    },
    read: async (at: number, length: number): Promise<RangeRead> => {
      asked.push([at, length])
      const part = file.subarray(
        Math.min(at, file.byteLength),
        Math.min(at + length, file.byteLength),
      )
      bytes += part.byteLength
      return { bytes: part, total: file.byteLength }
    },
  }
}

/** Opens a file the way the bridge does: locate the movie box, index it, take it as a source. */
async function openPlain(file: Uint8Array) {
  const server = serve(file)
  const found = await locateMovie(server.read)
  const tracks = movieTracksOf(found!.moov, found!.total)
  const source = clipSourceFrom(tracks)

  return { server, found: found!, tracks, source: source! }
}

/** Cuts a clip out of a file, fetching only the ranges the plan names. */
async function cut(file: Uint8Array, from: number, to: number) {
  const { server, source } = await openPlain(file)
  const opened = server.asked.length

  const plan = planClip(source, { in: from, out: to, sound: true })
  const ranges = planRanges(plan)
  const reads = readsFor(ranges)
  const buffers: Uint8Array[] = []
  for (const at of reads) buffers.push((await server.read(at.at, at.length)).bytes)

  return {
    server,
    plan,
    ranges,
    reads,
    /** Requests the index cost, before a byte of material was asked for. */
    opened,
    bytes: assembleMp4(plan, bytesFrom(reads, buffers)),
  }
}

describe('movieTracksOf', () => {
  it('indexes both tracks of a complete file into what the cut takes in', async () => {
    const { tracks } = await openPlain(whole)

    expect(
      tracks.map((track) => ({
        kind: track.kind,
        timescale: track.timescale,
        samples: track.samples.length,
        editOffset: track.editOffset,
        width: track.width,
        height: track.height,
        dropped: track.dropped,
      })),
    ).toEqual([
      { kind: 'video', timescale: 10240, samples: 60, editOffset: 2048, width: 256, height: 144, dropped: 0 },
      { kind: 'audio', timescale: 22050, samples: 131, editOffset: 1024, width: 0, height: 0, dropped: 0 },
    ])
  })

  it('reads the same tracks out of a file whose movie box was moved to the front', async () => {
    // Same recording, same tables, different layout — and every chunk offset in them moved with
    // the material. A reader that took the offsets for positions inside the movie box, or for
    // positions inside whatever buffer it was handed, comes apart on exactly one of the two.
    const tail = await openPlain(whole)
    const front = await openPlain(faststart)

    const shape = (tracks: typeof tail.tracks) =>
      tracks.map((track) => ({
        kind: track.kind,
        timescale: track.timescale,
        times: track.samples.map((sample) => [sample.dts, sample.pts, sample.duration]),
        sizes: track.samples.map((sample) => sample.source.length),
      }))

    expect(shape(front.tracks)).toEqual(shape(tail.tracks))

    // The addresses differ by exactly the distance the material moved, and following them lands
    // on the same coded bytes.
    for (const [i, track] of front.tracks.entries()) {
      for (const [j, sample] of track.samples.entries()) {
        const other = tail.tracks[i]!.samples[j]!
        const mine = faststart.subarray(sample.source.at, sample.source.at + sample.source.length)
        const theirs = whole.subarray(other.source.at, other.source.at + other.source.length)
        expect(mine).toEqual(theirs)
      }
    }
  })

  it('gives nothing for a movie box that describes its tracks and holds no samples', () => {
    // A fragmented file has a movie box too and its tables are empty on purpose. Read as a source
    // to cut from it is nothing at all, which is the signal to go and read the fragments instead.
    expect(movieTracksOf(read('tests/fixtures/muxed-edits/init-stream0.m4s'), 0)).toEqual([])
    expect(clipSourceFrom([])).toBeNull()
  })
})

describe('readsFor', () => {
  const at = (start: number, length: number): Located => ({ at: start, length })

  it('makes one read of samples that lie end to end', () => {
    expect(readsFor([at(100, 10), at(110, 20), at(130, 5)])).toEqual([at(100, 35)])
  })

  it('sorts what it is handed and bridges the holes a third track leaves', () => {
    // The samples of two tracks arrive interleaved and out of order, with the packets of a stream
    // nobody asked for standing between them. Bridging costs those bytes; a second request would
    // cost more.
    expect(readsFor([at(400, 100), at(0, 100), at(1000, 100)], { maxGap: 1024 })).toEqual([
      at(0, 1100),
    ])
  })

  it('stops bridging where the hole costs more than a request', () => {
    expect(readsFor([at(0, 100), at(1000, 100)], { maxGap: 512 })).toEqual([
      at(0, 100),
      at(1000, 100),
    ])
  })

  it('breaks a long unbroken clip into reads a tab can hold', () => {
    expect(readsFor([at(0, 100), at(100, 100), at(200, 100)], { maxRead: 250 })).toEqual([
      at(0, 200),
      at(200, 100),
    ])
  })

  it('never splits one range across two reads, whatever the ceiling', () => {
    // A ceiling smaller than a single sample: the sample is still fetched in one piece, because
    // half of a coded frame is of no use to anybody and the writer would be handed a hole.
    expect(readsFor([at(0, 100), at(100, 100)], { maxRead: 10 })).toEqual([at(0, 100), at(100, 100)])
  })

  it('asks for a stretch once however many samples address it', () => {
    // Two samples over one range, and a range inside another: a plan is free to name either, and
    // a read that fetched the overlap twice would hold the same bytes twice over.
    expect(readsFor([at(0, 100), at(0, 100), at(20, 10)])).toEqual([at(0, 100)])
  })

  it('leaves out a range of no length rather than asking for nothing', () => {
    expect(readsFor([at(0, 0)])).toEqual([])
    expect(readsFor([])).toEqual([])
    expect(readEfficiency([], [])).toBe(1)
  })
})

describe('a clip cut out of a file that was never downloaded', () => {
  const from = 1.5
  const to = 4

  it('writes a file ffprobe reads and ffmpeg decodes without a word', async () => {
    const clip = await cut(whole, from, to)
    const file = writeTemp('plain-clip.mp4', clip.bytes)
    const probe = probeFile(file)

    expect(probe.stderr, 'ffprobe complains about reading the clip').toBe('')
    expect(probe.status).toBe(0)
    expect(decodeWarnings(file), 'the decoder complained while decoding the clip').toBe('')

    expect(probe.probed!.streams.map((stream) => stream.codec_name)).toEqual(['h264', 'aac'])
    expect(Number(probe.probed!.format.duration)).toBeCloseTo(to - from, 1)
    expect(clip.plan.duration).toBeCloseTo(to - from, 2)
  })

  it('begins at the frame the cut asked for', async () => {
    // The frame shown at 1.5 s of the source, and the first frame of the clip: the same picture.
    // Everything between the two is the cut and the writer, neither of which was written for this
    // kind of material — which is the claim being made by using them for it.
    const clip = await cut(whole, from, to)
    const file = writeTemp('plain-clip-entry.mp4', clip.bytes)
    const source = writeTemp('plain-source.mp4', whole)

    expect(frameAt(file, 0).equals(frameByPlaying(source, from))).toBe(true)
  })

  it('asks for the material in one request, and for the tables in two', async () => {
    const clip = await cut(whole, from, to)

    // The whole strategy, in three numbers. Two ranged reads find the movie box in a file whose
    // moov sits behind the material; one more brings every byte of a two-and-a-half second clip,
    // because the samples of both tracks lie interleaved in one stretch of the mdat.
    expect(clip.opened).toBe(2)
    expect(clip.reads).toHaveLength(1)
    expect(clip.reads[0]).toEqual({ at: 48, length: 10395 })

    // What the one request costs over three thousand: 7369 bytes of the clip out of 10 395
    // fetched, so 29 per cent of it is material the clip does not use. It is the sound of the
    // first second and a half — the picture has to start at the key frame before the entry point,
    // which here is the first frame of the file, so the read opens at the head of the mdat while
    // the sound only joins at the cut. Measured rather than assumed, and stated so that a merge
    // rule that started bridging what it should step around would move this number.
    expect(clip.plan.bytes).toBe(7369)
    expect(readEfficiency(clip.ranges, clip.reads)).toBeCloseTo(0.71, 2)
  })

  it('reads less of the material than it leaves alone', async () => {
    const clip = await cut(whole, from, to)
    const mdat = 14641

    // The point of the exercise: a clip of a fraction of a file costs a fraction of the material.
    // Measured against the mdat and not against the file, because the other 3362 bytes are the
    // tables, which have to be read whatever is cut — and because the 8 KiB probe that finds them
    // is most of an eighteen-kilobyte fixture and none of a real file.
    expect(clip.reads[0]!.length).toBeLessThan(mdat * 0.75)
    expect(clip.bytes.byteLength).toBeLessThan(whole.byteLength)
  })

  it('cuts the same clip out of the streaming-ordered copy in one request fewer', async () => {
    const tail = await cut(whole, from, to)
    const front = await cut(faststart, from, to)

    expect(front.opened).toBe(1)
    expect(front.reads).toHaveLength(1)

    // The two files hold the same recording, so the two clips hold the same coded frames. The
    // files are not compared byte for byte — the sound entry of the two differs in the average
    // bitrate ffmpeg computed for each — so the material is.
    const codedBytes = (clip: typeof tail) =>
      clip.plan.tracks.map((track) => track.samples.map((sample) => sample.source.length))

    expect(codedBytes(front)).toEqual(codedBytes(tail))
    expect(front.plan.duration).toBe(tail.plan.duration)
  })

  it('promises the length it delivers when the clip runs to the end of the file', async () => {
    const clip = await cut(whole, 0, 10)
    const file = writeTemp('plain-clip-all.mp4', clip.bytes)
    const probe = probeFile(file)

    expect(probe.stderr).toBe('')
    // Asked for more than there is, it gives what there is and says so: the number in the plan is
    // the number the file comes out at, and that is what the popup is allowed to promise.
    expect(Number(probe.probed!.format.duration)).toBeCloseTo(clip.plan.duration, 1)
    expect(clip.plan.duration).toBeGreaterThan(5.5)
  })
})
