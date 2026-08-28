import { isoEncrypted } from '../iso/encryption'
import { parseInit } from '../iso/init'
import type { RangeReader } from '../iso/locate'
import { planClip, presentationSpan, type ExportPlan, type SourceTrack } from './plan'
import { clipSourceFrom, movieTracksOf } from './source'

/**
 * An ordinary file as a thing to save from.
 *
 * Everything here is arithmetic over an index — no bytes of material are touched and no request
 * is made — which is what lets the popup state the length and the weight of a save without
 * fetching anything, and lets the tests of both be run without a server.
 *
 * Where that index comes from is the container's business and not this module's: an mp4 states it
 * in a movie box (`plainFileOf` below), and a Matroska has none to state, so its frames are walked
 * instead (src/core/export/matroska.ts). What both hand over is the same `PlainFile`, and nothing
 * from here on asks which it was.
 *
 * ## What is offered, and why it is the buffered part
 *
 * The file is whole and reachable, so the material the viewer never watched is reachable too.
 * It is deliberately not offered. Three reasons, in the order they were weighed.
 *
 * The promise. §2 of the design puts "downloading the video over the network" out of scope, and
 * plain delivery is not a corner of the web but the norm — eighteen of the twenty-one live pages
 * that delivered any video at all. An extension that offered the whole file wherever it found one
 * would be a general-purpose downloader on most of the web, which is a different product with a
 * different standing.
 *
 * The promise the popup makes. A save must deliver what the popup said it would, and the one
 * number both can be held to is what the element actually holds: the save takes exactly the
 * samples whose presentation lies inside it.
 *
 * The cost of keeping to it, which is close to nothing. A `<video src>` fetches far ahead of the
 * play head by default, so a file watched partway through is usually held whole by the time
 * anybody opens the popup — the rule bites only where the browser really did stop early, and
 * there it is the honest answer.
 */

/** A stretch of media time, in the seconds the browser counts `buffered` in. */
export interface Span {
  start: number
  end: number
}

export interface PlainFile {
  /** Length of the file in bytes as the server stated it; zero when it stated none. */
  total: number
  /** Every track of it that could be indexed, in the order the movie box declares them. */
  tracks: SourceTrack[]
  /**
   * What it holds, in the names its own container gives them: the second component of the merge
   * key (§6.1). Four-letter sample entry codes out of an mp4, CodecID strings out of a Matroska —
   * `avc1` and `mp4a` beside `V_VP8` and `A_VORBIS`. The key only has to tell one file from
   * another under the same address, and either name does that.
   */
  codecs: string[]
  /** How long the whole file is, out of its own tables. */
  durationSeconds: number
  /** A track was declared that could not be indexed: a saved file is short of it. */
  refusedTracks: boolean
  /** The file carries protected media, and nothing of it may be recorded (§5.4). */
  encrypted: boolean
}

/** A file opened for reading: what it holds, and the reader its material comes through. */
export interface OpenedFile {
  file: PlainFile
  /**
   * The reader the tables were found with, kept for the save.
   *
   * The same one and not a fresh one, because it remembers where the file actually lives: a host
   * that redirects — archive.org to a CDN node — costs one wasted request to find that out, and
   * a save that started over would pay it again.
   */
  read: RangeReader
}

/**
 * What a movie box amounts to as a source to save from; null when it holds no track at all.
 *
 * Protection is answered before anything else is read out of it, and answered by the boxes rather
 * than by anything the page said: `encv`/`enca` with a `sinf`, a `pssh` anywhere. That is the
 * same evidence the capture refuses a stream on (src/core/container.ts), read out of the one box
 * a plain file gives us.
 */
export function plainFileOf(moov: Uint8Array, total: number): PlainFile | null {
  if (isoEncrypted(moov)) {
    return {
      total,
      tracks: [],
      codecs: [],
      durationSeconds: 0,
      refusedTracks: false,
      encrypted: true,
    }
  }

  const declared = parseInit(moov)?.tracks ?? []
  const tracks = movieTracksOf(moov, total)
  if (tracks.length === 0) return null

  let durationSeconds = 0
  for (const track of tracks) {
    const span = presentationSpan(track)
    if (span.end > durationSeconds) durationSeconds = span.end
  }

  const codecs: string[] = []
  for (const track of declared) if (!codecs.includes(track.codec)) codecs.push(track.codec)

  return {
    total,
    tracks,
    codecs,
    durationSeconds,
    // A track the movie box declares and this could not index — a timescale of zero, a sample
    // entry it could not read. Nothing of it reaches the file, and a file short of a whole kind
    // of media must not be offered as if it were the video.
    refusedTracks: tracks.length < declared.length,
    encrypted: false,
  }
}

export interface PlainCut {
  plan: ExportPlan
  /** How many separate stretches of the material the element holds; the longest is saved. */
  stretches: number
  /**
   * The file holds more than one track of a kind, and a clip carries one of each.
   *
   * An alternate and not a rendition (§6.2): a file on somebody's server states its tracks once
   * and for all, and a second one of a kind in it is other material — a dub beside the original,
   * a commentary beside the film — rather than the same material recorded over again at another
   * quality. Measured on w3schools' mov_bbb.mp4: one picture, two soundtracks.
   */
  alternate: boolean
}

/**
 * The clip a save would write out of what the element holds.
 *
 * `buffered` is the element's own account of the material, clamped to what the tables actually
 * describe: a browser is free to report a range a hair past the last frame, and a clip must not
 * be planned over material that is not there. Of the stretches that survive, the longest is
 * taken — the same rule the captured path uses for the longest run of its map.
 */
export function cutPlain(file: PlainFile, buffered: readonly Span[]): PlainCut | null {
  const source = clipSourceFrom(file.tracks)
  if (!source) return null

  const cover = presentationSpan(source.video)
  let longest: Span | undefined
  let stretches = 0

  for (const span of buffered) {
    const held = { start: Math.max(span.start, cover.start), end: Math.min(span.end, cover.end) }
    if (!(held.end > held.start)) continue
    stretches += 1
    if (!longest || held.end - held.start > longest.end - longest.start) longest = held
  }

  if (!longest) return null

  const plan = planClip(source, {
    in: longest.start,
    out: longest.end,
    sound: source.audio !== undefined,
  })
  if (plan.tracks.length === 0) return null

  const of = (kind: 'video' | 'audio'): number =>
    file.tracks.filter((track) => track.kind === kind).length

  return { plan, stretches, alternate: of('video') > 1 || of('audio') > 1 }
}
