import { isoEncrypted } from '../iso/encryption'
import { parseInit } from '../iso/init'
import type { RangeReader } from '../iso/locate'
import { planClip, presentationSpan, type ClipSource, type ExportPlan, type SourceTrack } from './plan'
import { MAX_BRIDGED_GAP } from './ranges'
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
  /** The sound in this clip came from a file of its own; see SoundApart. */
  paired: boolean
  /** That sound runs out before the picture does. False when there is no paired sound. */
  soundShort: boolean
}

/**
 * A soundtrack playing beside a picture that has none of its own.
 *
 * ## What is being paired, and what a clip means when it is
 *
 * One site of the seven surveyed plays its picture and its sound as two media elements (§5.6):
 * `<video src>` of 9.48 s with no audio track in it at all, and `<audio src>` of 66.35 s, both
 * looping, each on its own cycle. There is no single piece of media on that page and there is no
 * single clock: what the viewer gets is the picture at t mod 9.48 over the sound at t mod 66.35,
 * and wall-clock t is written down nowhere either file can be read for afterwards.
 *
 * So a clip here has to be defined rather than found, and it is defined by three rules.
 *
 * **The picture is the clip, and states its length.** §8.2 already cuts the sound to the picture
 * and not the other way round; here that decides the whole question of "which of the two lengths".
 * The extra 56.9 seconds of soundtrack are not clipped and never offered: they are somebody's
 * music track, and a file of a song with a few seconds of picture at the front is not a clip of
 * anything. It would also be the general-purpose downloader §2 puts out of scope.
 *
 * **Both are taken from zero.** The pairing written into the file is the one the page itself
 * makes when it loads, with both elements at the start — and it is the only pairing that can be
 * stated in media time, which is the clock every other part of this program measures on (§6.3).
 * Taken instead from wherever the sound happened to have got to at the instant of the click, the
 * clip would be a property of that instant: two saves of one session would hold different sound,
 * and §6.1 says two saves of one session are two copies of one video.
 *
 * **There is no loop boundary, because nothing is looped.** The clip cannot outrun the picture's
 * own material, so at most one turn of the picture is ever written, and the sound needed for it
 * is at most that long. Where the track is the shorter of the two — a jingle under a long picture
 * — the file's sound ends where the track does and the rest of the clip is silent (`soundShort`).
 * Looping it round to fill the gap would be composing something the page never played.
 *
 * And it is not called the sound of the video anywhere the user can read: the popup says it came
 * from a separate track on the page, because that is what it is.
 */
export interface SoundApart {
  /**
   * The head of the track as a track to cut from, addressed inside its own file.
   *
   * Only the head: the reader indexes as far as the picture is long and no further, which is the
   * same rule stated in requests — the whole of somebody's soundtrack is never even fetched.
   */
  track: SourceTrack
}

/**
 * Where the soundtrack's bytes are addressed from, when a clip is made out of two files.
 *
 * The plan, the reads and the writer all speak one flat address space, because the material of a
 * clip has always lain in one file. Two files are put into that space by laying them apart: the
 * picture from zero, the soundtrack from here.
 *
 * The gap between them is not decoration. `readsFor` merges ranges that lie within
 * `MAX_BRIDGED_GAP` of each other into one request, on the ground that a quarter of a megabyte of
 * transfer is cheaper than a round trip — and with the two files laid end to end it would merge
 * across the seam and ask one host for bytes that live on another. So they are put further apart
 * than that merge will ever reach.
 */
export function soundBaseOf(file: PlainFile): number {
  let end = file.total
  for (const track of file.tracks) {
    for (const sample of track.samples) {
      const finish = sample.source.at + sample.source.length
      if (finish > end) end = finish
    }
  }

  return end + MAX_BRIDGED_GAP + 1
}

/**
 * One reader over the two files, dispatching by where the address falls.
 *
 * The counterpart of `soundBaseOf` and the reason the two live in one module: they are one
 * decision about one address space, and a second opinion about where the seam is would be a save
 * fetching the head of a soundtrack and writing it into the picture.
 */
export function pairedReader(picture: RangeReader, sound: RangeReader, base: number): RangeReader {
  return async (at, length) =>
    at >= base ? await sound(at - base, length) : await picture(at, length)
}

/**
 * The picture and the soundtrack as one source to cut from, or the file's own tracks unchanged.
 *
 * The offer is refused outright where the file has sound of its own: a track from outside is an
 * answer to a picture that has none, and adding a second would be composing rather than clipping.
 */
function pairedSource(file: PlainFile, sound: SoundApart | undefined): ClipSource | null {
  const own = clipSourceFrom(file.tracks)
  if (!own || !sound || own.audio || own.video.kind !== 'video') return own

  const base = soundBaseOf(file)

  return {
    video: own.video,
    audio: {
      ...sound.track,
      // Moved into the address space of the clip. The track itself is indexed in its own file and
      // knows nothing of the picture it will be laid beside — it is read once and cut many times.
      samples: sound.track.samples.map((sample) => ({
        ...sample,
        source: { at: base + sample.source.at, length: sample.source.length },
      })),
    },
  }
}

/**
 * The clip a save would write out of what the element holds.
 *
 * `buffered` is the element's own account of the material, clamped to what the tables actually
 * describe: a browser is free to report a range a hair past the last frame, and a clip must not
 * be planned over material that is not there. Of the stretches that survive, the longest is
 * taken — the same rule the captured path uses for the longest run of its map.
 */
export function cutPlain(
  file: PlainFile,
  buffered: readonly Span[],
  sound?: SoundApart,
): PlainCut | null {
  const own = clipSourceFrom(file.tracks)
  const source = pairedSource(file, sound)
  if (!source || !own) return null

  const paired = source.audio !== undefined && own.audio === undefined

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

  return {
    plan,
    stretches,
    alternate: of('video') > 1 || of('audio') > 1,
    paired,
    // The track ran out before the picture did. Measured against the clip that was actually
    // planned and not against the two files' lengths: what the user is owed a word about is the
    // silence at the end of the file they are about to be handed.
    soundShort: paired && soundEndsEarly(plan, longest),
  }
}

/**
 * Whether the sound of a planned clip stops before its picture does.
 *
 * Half a frame of slack, because the two tracks end on different grids: a frame of MPEG-1 audio
 * at 44.1 kHz is 26 ms, and the last one to begin inside the clip carries sound past its end as
 * often as not. What is being looked for is a track that is short by seconds.
 */
function soundEndsEarly(plan: ExportPlan, span: Span): boolean {
  const audio = plan.tracks.find((track) => track.kind === 'audio')
  if (!audio) return false

  let ticks = 0
  for (const sample of audio.samples) ticks += sample.duration

  const sounded = ticks / audio.timescale
  const half = audio.samples.length ? audio.samples[0]!.duration / audio.timescale / 2 : 0

  return sounded + half < span.end - span.start
}
