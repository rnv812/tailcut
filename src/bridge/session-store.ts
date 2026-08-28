import { parseFragment } from '../core/iso/fragment'
import {
  encryptedMedia,
  ingestInit,
  type IngestedInit,
  type SegmentConverter,
} from '../core/container'
import { SegmentStream } from '../core/stream'
import { PtsMap } from '../core/timeline/map'
import { durationToken, normalizeUrl, sessionKey } from '../core/session-key'
import { cutPlain, type OpenedFile, type PlainFile, type Span } from '../core/export/plain'
import type { ExportPlan } from '../core/export/plan'
import type { RangeReader } from '../core/iso/locate'
import type { MuxTrack } from '../core/mux'
import type { Omission } from '../shared/protocol'
import type { Chunk, InitInfo, TrackKind } from '../shared/types'

/**
 * What the init segment of one SourceBuffer declared: everything needed to read the segments
 * that follow it. MSE hands video and audio to separate buffers, so in the usual case a header
 * here describes exactly one media track; a muxed init puts several ISO tracks into one buffer,
 * and then one header carries both kinds — the segments of such a buffer are shared by them
 * anyway.
 *
 * A header is also a representation in the sense of the design (§6.2): a new init on the same
 * buffer with different codecs or a different frame size opens one of its own instead of
 * spoiling the material already collected under the previous one.
 *
 * It lives on the media source and not only on the session it feeds, because it is not material:
 * a verdict decides whether what a stream carries is kept, and a stream whose header is gone is
 * not readable at all. Sites give out their init segments in the first second of playback and
 * never repeat them, so a header thrown away is a buffer whose every later segment lands nowhere.
 */
interface TrackHeader {
  /** SourceBuffer the stream came from. Unique inside its media source, not across the page. */
  bufferId: string
  /** Identity of the representation inside the session — see representationOf(). */
  representation: string
  /** Media kinds this buffer carries: one of them normally, both for a muxed init. */
  kinds: TrackKind[]
  /** ftyp and moov of the track, in ISO BMFF whatever container the page delivered it in. */
  initBytes: Uint8Array
  info: InitInfo
  /**
   * Set on a track that did not arrive in ISO BMFF: turns each of its media segments into one.
   * Handed over by ingestInit, which is the one place a second container is spoken of. Absent on
   * an mp4 track, whose segments are already what a file is built of.
   */
  convert?: SegmentConverter
}

/** A header of a stream together with the material collected under it inside one session. */
export interface Track extends TrackHeader {
  map: PtsMap
}

/**
 * One video from one media source. Tracks live inside it; merging by key (§6.1) makes a reload,
 * a second tab and a return to the same video a day later fill in one session rather than breed
 * duplicates.
 */
export interface Session {
  key: string
  url: string
  title: string
  tracks: Track[]
  createdAt: number
  lastSeenAt: number
  /**
   * A buffer of this video declared a track the ingest boundary would not take — a container or
   * a codec that cannot be written out. No track was opened and nothing of that stream was
   * collected, so the session itself shows no sign of it; the flag is that sign, and without it
   * a file that is sound alone would be promised as if it were the whole video.
   */
  refusedTracks: boolean
  /**
   * The material stayed in the file it came from, and this is where to read it.
   *
   * The other kind of session, and the only field that tells the two apart. A capture out of MSE
   * holds its material as `tracks`, segment by segment, because the bytes went past once and
   * would never come again; an ordinary file was never intercepted at all — the browser fetched
   * it and the extension saw nothing — so what is held is an index of it and the reader that
   * fetches by that index (§5.6, src/core/export/plain.ts).
   *
   * Everything else about the session is the same thing: the same registry, the same merge key,
   * the same triage, the same eviction, the same summary in the popup and the same button. What
   * differs is one branch in planSave and one in the writer, and it is one branch because both
   * kinds end at the same cut and the same file.
   */
  plain?: PlainMaterial
}

/** An ordinary file behind a session: what it holds, how to read it, and how much has arrived. */
export interface PlainMaterial {
  /** The address of the file, as the element resolved it. */
  url: string
  file: PlainFile
  read: RangeReader
  /**
   * Stretches of media time the element holds, in seconds — its own `buffered`, less whatever
   * eviction has taken off the front. This is what a save may take from, and the popup states
   * the length of the longest of them; see the note at the head of core/export/plain.ts for why
   * it is this and not the whole file.
   */
  buffered: Span[]
}

/** Bookkeeping of the registry itself: consumers of a session never need it. */
interface StoredSession extends Session {
  /** Media sources feeding this session right now: a reload and a second tab add their own. */
  sources: Set<string>
  /** Triage has granted the session its life: a later rejection freezes it instead of erasing. */
  confirmed: boolean
}

/** What the registry remembers about one MediaSource. */
interface SourceState {
  /** Key of the session this source currently feeds. */
  key: string
  /** Normalised address of the video this source is playing right now. */
  url: string
  /** bufferId of a SourceBuffer → representation its stream currently belongs to. */
  buffers: Map<string, string>
  /**
   * Every representation this source has opened → the init that declared it. Reading the stream
   * of a buffer depends on nothing else, and no verdict takes any of it away — see TrackHeader.
   */
  headers: Map<string, TrackHeader>
  /**
   * Every codec this source has ever opened, in the order they appeared. The merge key is built
   * of all of them, so it describes the video as a whole and not the init that came last.
   */
  codecs: string[]
  /**
   * Full length of what this source is playing, in seconds, as the page itself stated it;
   * `Infinity` while nothing has been stated — a live stream and an unread manifest say the same
   * thing here. The third component of the merge key: see setDuration.
   */
  durationSeconds: number
  /**
   * One of this source's buffers declared a track that could not be taken in. Remembered on the
   * source because the refusal usually comes before there is a session to remember it on: the
   * picture buffer opens first and the sound buffer, the one that ends up creating the session,
   * a moment later.
   */
  refused: boolean
}

/**
 * The material of a source whose rejection has not been settled yet: taken out of the registry
 * and kept out of sight, and given back whole the moment the verdict turns.
 *
 * This is the probation buffer of the design (§5.4). A rejection of a source that has not earned
 * its life yet is a doubt and not a freeze: what is at stake is the whole recording, because the
 * verdict may be the misreading of a single moment — the player element standing above the
 * viewport for one poll while the page lays itself out. Erasing on the spot answers a doubt with
 * the heaviest loss there is, so the material waits here instead, out of every list and out of
 * every save, until triage says which it was.
 *
 * A confirmed session is a different matter and does not come here: it has nothing to lose, and
 * a rejection of it is the freeze of §5.5 — a pause, a hidden tab, an element off the screen are
 * not recorded at all.
 */
interface Probation {
  url: string
  title: string
  createdAt: number
  lastSeenAt: number
  /**
   * representation → its header and the segments collected under it, in the order they arrived.
   * The header travels with the material rather than being looked up again on the way out: it is
   * what the segments were read through, and what a saved file would need in front of them.
   */
  material: Map<string, HeldTrack>
  /** Weight of what has arrived since the rejection: what the review is measured against. */
  bytes: number
}

/** One stream's worth of what a source set aside: what it is, and what was collected of it. */
interface HeldTrack {
  header: TrackHeader
  chunks: Chunk[]
}

/**
 * Largest amount of material set aside for a source whose rejection is under review.
 *
 * A cap and not a budget: a verdict that is going to turn turns within a poll or two of the
 * watcher, half a second apart, and the couple of segments that arrive meanwhile are far below
 * this. What it stops is the other case — a banner, a hover preview, a page whose material is
 * refused for DRM — from being held for as long as the page is open. Material that outlasts the
 * review is not the misreading of a moment: the rejection stands, and the source goes back to
 * costing nothing at all.
 */
export const MAX_PROBATION_BYTES = 8 * 1024 * 1024

/** Where the page stood when material arrived: what a session opened for it is signed with. */
interface PageContext {
  url: string
  title: string
  now: number
}

export interface AppendInput {
  sourceId: string
  /** Which SourceBuffer of that source the bytes were appended to. */
  bufferId: string
  url: string
  title: string
  bytes: Uint8Array
  now: number
  /**
   * The type that SourceBuffer was opened with, as the page spelled it. Only the ingest boundary
   * reads it, and only for a container that does not describe its own tracks fully — a WebM
   * picture track is declared by the codec string and by nothing else the page sends.
   */
  mime?: string
}

/**
 * Identity of a representation inside a session: what the init declares about its tracks. Two
 * inits with the same signature describe the same stream, so their material belongs on one map —
 * that is what makes a reload land on top of the previous visit instead of beside it.
 *
 * The frame size is part of the signature on purpose: a switch of quality through ABR keeps the
 * codec but changes the size, and mixing two sizes in one map produces a file that announces one
 * resolution and contains frames of another.
 */
function representationOf(info: InitInfo): string {
  return info.tracks.map((t) => `${t.kind}:${t.codec}:${t.width}x${t.height}`).join('+')
}

/** Media kinds an init declares, each once. */
function kindsOf(info: InitInfo): TrackKind[] {
  const kinds: TrackKind[] = []
  for (const track of info.tracks) if (!kinds.includes(track.kind)) kinds.push(track.kind)
  return kinds
}

/**
 * The pairs of `HTMLMediaElement.buffered` as spans, cut off at the earliest time on offer.
 *
 * Read from a page and therefore not trusted: a range of no length, a range the wrong way round
 * and a number that is not one all reach this, and every one of them would become a clip planned
 * over nonsense. The order is the element's, which is ascending; the sort is here because
 * nothing in the platform promises it.
 */
function spansOf(pairs: ReadonlyArray<readonly [number, number]>, floor: number): Span[] {
  const spans: Span[] = []

  for (const [start, end] of pairs) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (!(end > start)) continue
    spans.push({ start, end })
  }

  return clampSpans(spans.sort((a, b) => a.start - b.start), floor)
}

/** The same spans with everything before `floor` taken off; see PlainState.floor. */
function clampSpans(spans: readonly Span[], floor: number): Span[] {
  const kept: Span[] = []

  for (const span of spans) {
    const start = Math.max(span.start, floor)
    if (span.end > start) kept.push({ start, end: span.end })
  }

  return kept
}

/** Common part of two sorted lists of disjoint spans. */
function intersectSpans(a: Span[], b: Span[]): Span[] {
  const common: Span[] = []
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start, b[j]!.start)
    const end = Math.min(a[i]!.end, b[j]!.end)
    if (end > start) common.push({ start, end })
    if (a[i]!.end < b[j]!.end) i++
    else j++
  }

  return common
}

/**
 * One track per media kind — the one holding the most of it.
 *
 * A switch of quality opens a second representation of the same kind (§6.2), and both of them in
 * one file would give it two video streams of different frame size where a player expects one.
 * Which of them to take is a question for the editor, where the zones are drawn on the timeline
 * and the user is asked; the button that saves everything answers it by weight of material.
 *
 * The picture comes first: stream zero of a file is the one a player shows.
 */
function mainTracks(session: Session): Track[] {
  const chosen: Track[] = []
  const kinds: TrackKind[] = ['video', 'audio']

  for (const kind of kinds) {
    let best: Track | undefined
    for (const track of session.tracks) {
      if (!track.kinds.includes(kind)) continue
      if (!best || track.map.duration() > best.map.duration()) best = track
    }
    // A muxed init carries both kinds on one track: chosen for either of them, taken once.
    if (best && !chosen.includes(best)) chosen.push(best)
  }

  return chosen
}

/**
 * The stretches of time where every chosen track has material at once, in order.
 *
 * The intersection and not the sum: a clip is cut out of what can be shown, and past the end of
 * the sound there is picture with silence under it. A kind that has an init but not a single
 * fragment yet leaves the list empty, and that is honest too — it lasts as long as the gap
 * between the init of the second buffer and its first segment.
 */
function commonStretches(chosen: Track[]): Span[] {
  let common: Span[] | null = null

  for (const track of chosen) {
    const runs = track.map.runs().map((run) => ({ start: run.start, end: run.end }))
    common = common === null ? runs : intersectSpans(common, runs)
  }

  return common ?? []
}

/** The longest of the stretches; undefined — there are none. */
function longestOf(spans: Span[]): Span | undefined {
  let longest: Span | undefined
  for (const span of spans) {
    if (!longest || span.end - span.start > longest.end - longest.start) longest = span
  }
  return longest
}

/**
 * Whether the clip holds most of a segment: at least as much of it as it leaves outside.
 *
 * The question only arises at the two edges. Segments reach the file whole — a fragment is
 * written into it byte for byte, and cutting one would mean rewriting the sample table that
 * describes it — so a segment straddling an edge either comes in with its overhang or stays out
 * with the material it holds inside.
 *
 * Which of the two is right turns on how much of it is overhang, and the honest measure of that
 * is the segment itself. The tracks of a video are cut into pieces of different length: a site
 * packages its sound in five- and ten-second pieces where its picture goes in two- and four-
 * second ones, and it downloads the sound further ahead. The last piece of sound then begins
 * inside the picture and ends well past it. Taken whole, it is the tail of a clip that shows
 * nothing — the file runs half again as long as the popup promised, with a frozen frame under
 * the sound. Left out, the clip loses the fraction of a second of sound that did lie inside it.
 *
 * Measured against the segment and not against the clip: a two-second piece of picture reaching
 * a tenth of a second past the sound is the rounding this licence exists for, and it is the same
 * tenth of a second whether the clip is ten seconds long or ten minutes.
 */
function mostlyInside(chunk: Chunk, span: Span): boolean {
  const inside = Math.min(chunk.end, span.end) - Math.max(chunk.start, span.start)
  return inside * 2 >= chunk.end - chunk.start
}

/**
 * Segments of the track the clip is made of. Whole ones: nothing is cut here.
 *
 * A track all of whose segments hang over an edge keeps them: that happens when one segment
 * covers the whole clip and more, and a file short of a whole kind of media is a worse answer
 * than one that runs long.
 */
function chunksIn(track: Track, span: Span): Chunk[] {
  const kept: Chunk[] = []
  const reaching: Chunk[] = []

  for (const run of track.map.runs()) {
    for (const chunk of run.chunks) {
      if (!(chunk.end > span.start && chunk.start < span.end)) continue
      reaching.push(chunk)
      if (mostlyInside(chunk, span)) kept.push(chunk)
    }
  }

  return kept.length ? kept : reaching
}

/** Where a track's chosen segments begin and end; null when it has none. */
function extentOf(chunks: Chunk[]): Span | null {
  const first = chunks[0]
  if (!first) return null

  let start = first.start
  let end = first.end
  for (const chunk of chunks) {
    if (chunk.start < start) start = chunk.start
    if (chunk.end > end) end = chunk.end
  }

  return { start, end }
}

/**
 * What of the session the file will not hold, the heaviest loss first.
 *
 * Ordered because the popup has one line for this and the interface is minimal by design: the
 * first of these is the one that changes the file most. A missing kind of media is a file that
 * plays without a picture; a rendition and a gap only shorten it, and the length in the summary
 * has already counted them.
 */
function omissionsOf(losses: {
  refusedTracks: boolean
  rendition: boolean
  alternate: boolean
  stretches: number
}): Omission[] {
  const omitted: Omission[] = []

  if (losses.refusedTracks) omitted.push('track')
  if (losses.rendition) omitted.push('rendition')
  if (losses.alternate) omitted.push('alternate')
  if (losses.stretches > 1) omitted.push('gap')

  return omitted
}

/**
 * What a save is made of, and where its bytes are.
 *
 * The two kinds of material meet here and nowhere else above it: the popup, the badge, the frame
 * addressing and the protocol all read the three numbers beside this and never look inside it.
 *
 * - `captured` — segments already in this frame's memory, copied into a fragmented file whole.
 * - `plain` — a cut planned over a file that is still on somebody's server, to be assembled once
 *   the ranges it names have been read (src/bridge/write.ts).
 */
export type SaveSource =
  | { kind: 'captured'; tracks: MuxTrack[] }
  | { kind: 'plain'; read: RangeReader; plan: ExportPlan }

/** What a save of this session would write, and what it would leave behind. */
export interface SavePlan {
  source: SaveSource
  /** Length of the clip in seconds: the stretch its material was chosen over. */
  duration: number
  /**
   * Weight of the media data that goes into it; the boxes around it are a kilobyte or two.
   *
   * Zero means there is nothing to write, and it means that for both kinds: a captured session of
   * init segments alone, or a file whose element holds not one whole frame yet.
   */
  bytes: number
  /** What the file will not hold of what the session has; empty when it holds all of it. */
  omitted: Omission[]
}

/**
 * One computation for two questions that must never disagree: the popup asks how much there is
 * to save, and the button asks what to write. Answered apart they agree by convention alone, and
 * the convention has broken twice — a summary that summed the tracks promised fifty seconds of a
 * file that held sound only, and a summary that united the renditions promised the material of
 * two qualities where a file carries one. So the summary is not written to resemble the
 * selection: both are read off this.
 *
 * What comes out is one continuous clip — the tracks the file will hold, the stretch of time it
 * will cover, the weight of the media data going into it, and what stayed behind. Material of
 * nothing means there is nothing to cut: a session of init segments alone, or one whose second
 * buffer has not brought a fragment yet.
 */
export function planSave(session: Session): SavePlan {
  return session.plain ? planPlainSave(session, session.plain) : planCapturedSave(session)
}

/**
 * The same three questions asked of a file that is still on a server.
 *
 * The material is not here to be weighed, so the cut is planned instead — and it is the very cut
 * the editor uses (`planClip`), over the very index the editor walks, ending in the very writer
 * that writes an exported clip. Nothing about a plain save is written twice: what is different
 * about it is where the bytes come from, and that is a reader handed to the writer.
 */
function planPlainSave(session: Session, material: PlainMaterial): SavePlan {
  const cut = cutPlain(material.file, material.buffered)
  const nothing: SavePlan = {
    source: { kind: 'plain', read: material.read, plan: { tracks: [], duration: 0, bytes: 0 } },
    duration: 0,
    bytes: 0,
    omitted: [],
  }

  if (!cut) return nothing

  return {
    source: { kind: 'plain', read: material.read, plan: cut.plan },
    duration: cut.plan.duration,
    bytes: cut.plan.bytes,
    omitted: omissionsOf({
      refusedTracks: session.refusedTracks || material.file.refusedTracks,
      // A file states its tracks once and for all, so a second one of a kind in it is other
      // material rather than the same material at another quality: see PlainCut.alternate.
      rendition: false,
      alternate: cut.alternate,
      stretches: cut.stretches,
    }),
  }
}

function planCapturedSave(session: Session): SavePlan {
  const chosen = mainTracks(session)
  const stretches = commonStretches(chosen)
  const longest = longestOf(stretches)

  // Every chosen track covers the whole of that stretch — it is their common part — so none of
  // them comes out of this with nothing, and no track reaches the file as an empty stream.
  const picked = longest ? chosen.map((track) => chunksIn(track, longest)) : []

  const material: MuxTrack[] = picked.map((chunks, index) => ({
    initBytes: chosen[index]!.initBytes,
    segments: chunks.map((chunk) => chunk.bytes),
  }))

  let bytes = 0
  for (const track of material) for (const segment of track.segments) bytes += segment.byteLength

  return {
    source: { kind: 'captured', tracks: material },
    duration: longest ? lengthOf(picked, longest) : 0,
    bytes,
    omitted: omissionsOf({
      refusedTracks: session.refusedTracks,
      // Only a rendition that holds something is a loss. A second init with no fragment under it
      // costs the file nothing, and warning about it would be a warning about every quality
      // switch the moment it happens.
      rendition: session.tracks.some((t) => !chosen.includes(t) && t.map.duration() > 0),
      // Nothing captured is an alternate. A stream out of MediaSource is opened by an init, and a
      // second init of a kind on one page is the page switching quality (§6.2) — two languages
      // would be two sessions, because the codecs are part of the merge key.
      alternate: false,
      stretches: stretches.length,
    }),
  }
}

/**
 * How long the clip is: the part of the stretch that every chosen track really covers.
 *
 * Not the stretch itself. A segment left out at an edge (see chunksIn) shortens the track it
 * belonged to, and the number the popup shows has to be the one the file delivers with all of
 * its tracks present — a promise of more than is there is the failure this whole computation
 * exists to prevent. Whole segments then carry the file a rounding past this number at the other
 * edge, and running a moment longer than promised is not the same kind of lie.
 */
function lengthOf(picked: Chunk[][], stretch: Span): number {
  let start = stretch.start
  let end = stretch.end

  for (const chunks of picked) {
    const extent = extentOf(chunks)
    // A chosen track with no segment at all: nothing of the clip can be shown, so it is of no
    // length. chunksIn does not produce this — every chosen track has material in the stretch —
    // and the guard is here so that a future caller of it cannot make the number a lie.
    if (!extent) return 0
    if (extent.start > start) start = extent.start
    if (extent.end < end) end = extent.end
  }

  return Math.max(0, end - start)
}

/**
 * What the session amounts to for the popup and the badge: the file the button would write,
 * described in the two numbers the interface has room for and a word about what is missing from
 * it. Every one of them comes off the plan — see planSave for why the summary is not computed
 * beside the selection but out of it.
 *
 * Whole segments reach the file, so it can run a fraction longer at its edges than the stretch
 * they were chosen over. The summary keeps to the stretch: a clip that turns out slightly longer
 * than promised is not the failure a clip that turns out shorter is.
 */
export function summarize(session: Session): {
  duration: number
  bytes: number
  omits?: Omission
} {
  const plan = planSave(session)
  const summary: { duration: number; bytes: number; omits?: Omission } = {
    duration: plan.duration,
    bytes: plan.bytes,
  }

  // The field is left off rather than set to nothing: it travels through postMessage into the
  // popup, and a key that is always there says less than one that appears when there is a loss.
  const [heaviest] = plan.omitted
  if (heaviest) summary.omits = heaviest

  return summary
}

/**
 * The captured segments a saved file is built out of; empty for a session whose material never
 * passed through this frame at all. See planSave: what a save is made of is a SaveSource, and
 * this is the one kind of it that is a list of buffers.
 */
export function selectMaterial(session: Session): MuxTrack[] {
  const plan = planSave(session)
  return plan.source.kind === 'captured' ? plan.source.tracks : []
}

/**
 * A chunk out of an ISO BMFF media segment. The bytes travel on as they arrived: a captured
 * segment is already what a saved file is assembled from.
 */
function isoChunk(track: TrackHeader, bytes: Uint8Array): Chunk | null {
  // The tracks of the init go with the bytes: a fragment may state nothing about how long its
  // samples last, and then the `trex` this init was read for is the only thing that does.
  const fragment = parseFragment(bytes, track.info.tracks)
  if (!fragment) return null

  // Tracks inside a moof are marked with the trackId from the init; on a single-track stream
  // players occasionally put something of their own there, hence the fallback to the first
  // track of this very buffer. The choice is made among the tracks of the buffer the bytes came
  // from, so the timescale is always the one these ticks were counted in.
  const declared =
    track.info.tracks.find((t) => t.trackId === fragment.trackId) ?? track.info.tracks[0]
  if (!declared) return null

  // Ticks are turned into seconds by dividing by the timescale, and a broken init sometimes has
  // it at zero. Substituting one for the zero would invent times (ticks would go into seconds
  // one to one), and counting as is would put a chunk with NaN boundaries on the map: it counts
  // as neither empty nor overlapping, and the NaN would spread from there across the whole
  // popup summary. Such a fragment has no time at all.
  if (!(declared.timescale > 0)) return null

  const start = fragment.baseMediaDecodeTime / declared.timescale
  return { start, end: start + fragment.duration / declared.timescale, bytes }
}

/**
 * A chunk out of a segment in another container: rewritten as ISO BMFF on the way in, and it is
 * the rewriting that carries the times — the converter has already worked out, in seconds, where
 * the fragment it wrote begins and ends. What lands on the map is the converted bytes; the ones
 * the page appended are of no further use to anybody and are not kept.
 */
function convertedChunk(convert: SegmentConverter, bytes: Uint8Array): Chunk | null {
  const converted = convert(bytes)
  if (!converted) return null

  return { start: converted.start, end: converted.end, bytes: converted.bytes }
}

/** What the page has said about one ordinary file, and what came back when it was opened. */
export interface PlainInput {
  sourceId: string
  /** The address of the file, exactly as it will have to be fetched. */
  url: string
  /** Where the page stands: what a session opened for this file is signed with and shown as. */
  pageUrl: string
  title: string
  /** How long the whole file is as the element states it; zero while it states nothing. */
  durationSeconds: number
  buffered: Array<[number, number]>
  now: number
}

/**
 * Reads the tables of an ordinary file.
 *
 * Handed in rather than reached for, because it is the one thing in this registry that touches
 * the network, and because a test of the registry has no business making requests. Absent — every
 * plain source is noted, judged and never opened, which is what a build with no reader would do.
 */
export type PlainOpener = (url: string) => Promise<OpenedFile | null>

export interface StoreOptions {
  openPlain?: PlainOpener
  /**
   * Called when a read of a file's tables has finished, whatever it found.
   *
   * Reading a file is the one step of this registry that is not immediate: everything else has
   * happened by the time the call that set it going returns, and a caller that wants to know what
   * changed can simply look. A session that came out of a read cannot be seen that way — it
   * appears two turns after the promotion that asked for it — and the one thing that has to hear
   * of it is the badge, which is told when this frame has something and not asked (see
   * FrameRecording). Without this, a small file watched to the end would be recorded, offered in
   * the popup, and never counted on the button.
   */
  onFileRead?: () => void
}

/** Everything the registry keeps about one ordinary file the page is playing. */
interface PlainState {
  sourceId: string
  /** The address to fetch from, as the element resolved it. */
  url: string
  /** The same, normalised: the first component of the merge key. */
  keyUrl: string
  durationSeconds: number
  buffered: Span[]
  /**
   * Earliest media time still on offer, in seconds. Raised by eviction and never by a report:
   * a page goes on saying it holds the whole file, and a stretch that has been evicted is gone
   * whatever the page says next.
   */
  floor: number
  page: PageContext
  /**
   * The page as it stood when this file first became a session: what it is signed with.
   *
   * Kept apart from `page`, which moves with the page. A session taken out of the registry by a
   * rejection and put back when the verdict turns has to come back as the session it was, under
   * the address and the name the popup was already showing for it.
   */
  signature?: PageContext
  /** The tables, once they have been read; absent until triage promotes the source. */
  opened?: OpenedFile
  /** A read of the tables is on its way. */
  reading: boolean
  /** The tables could not be read at all, and no later poll will change that. */
  unreadable: boolean
  /** Key of the session this file currently feeds; empty while it feeds none. */
  key: string
}

export class SessionStore {
  private sessions = new Map<string, StoredSession>()
  /** What each MediaSource of the page feeds, and where. */
  private sources = new Map<string, SourceState>()
  /** sourceId and bufferId → the byte stream that SourceBuffer is being fed, half-read. */
  private streams = new Map<string, SegmentStream>()
  /** Rejected sources: what they carry is not offered while the verdict stands. */
  private rejected = new Set<string>()
  /** Triage has granted these sources their life, whether or not they have a session yet. */
  private promoted = new Set<string>()
  /** sourceId → the material set aside while its rejection is under review; see Probation. */
  private probation = new Map<string, Probation>()
  /** Sources whose rejection outlasted the review: nothing of them is kept any more. */
  private screenedOut = new Set<string>()
  /**
   * sourceId → the length its page stated for it, kept apart from the source itself.
   *
   * A player states the duration inside `sourceopen`, which on the measured sites comes before it
   * appends a single byte — so the word about it regularly arrives before there is a source to
   * write it on.
   */
  private declaredDurations = new Map<string, number>()
  /** Encrypted media was seen on this page: see refuseEncrypted. Once set, it is never cleared. */
  private encryptedSeen = false
  /** sourceId → the ordinary file that source is playing; see plain(). */
  private plainSources = new Map<string, PlainState>()
  /** Reads of the tables now in flight: what settled() waits on. */
  private reads = new Set<Promise<void>>()
  private readonly openPlain?: PlainOpener
  private readonly onFileRead?: () => void

  constructor(options: StoreOptions = {}) {
    this.openPlain = options.openPlain
    this.onFileRead = options.onFileRead
  }

  /**
   * Waits for every read of a file's tables that is on its way.
   *
   * For tests and for nothing else. Opening a file is the one thing in this registry that is not
   * immediate, and a test that checked the list a tick after promoting a source would be racing
   * a fetch. Loops rather than awaiting once: opening a file can start another, and the point is
   * to come back when the registry has stopped moving.
   */
  async settled(): Promise<void> {
    while (this.reads.size > 0) await Promise.all([...this.reads])
  }

  /**
   * Whether this page played protected media. Read by the bridge, which owes the popup the
   * difference between the two silences: a page with nothing worth recording on it, and a page
   * that may not be recorded at all.
   */
  get encrypted(): boolean {
    return this.encryptedSeen
  }

  /**
   * Whether a file this page was watching turned out to be one the extension cannot read.
   *
   * Another silence the popup owes a sentence for. A file is opened only after triage has said
   * somebody is really watching it, so this means exactly one thing: a video was watched and
   * there is nothing to offer for it. Measured live on an imageboard thread, where the material
   * is webm and has no movie box to walk to, and on addresses that had expired between the
   * element fetching them and the save. Without it the popup answers such a page with "nothing
   * recorded yet" — the words for a page that holds no video at all.
   */
  get unreadableFile(): boolean {
    for (const state of this.plainSources.values()) if (state.unreadable) return true
    return false
  }

  /**
   * Takes what a page appended to one of its SourceBuffers and works out for itself what it is.
   * The store is fed from a foreign page, so no parse here is allowed to throw: a piece it cannot
   * make sense of is dropped silently.
   *
   * What arrives is a piece of a byte stream and not necessarily a segment — see
   * src/core/stream.ts — so the segments are recovered first, and only whole ones are read.
   */
  append(input: AppendInput): void {
    // Nothing of a protected page is read at all — not even to keep a reader in its place. This
    // is the one refusal that never turns (see refuseEncrypted), so there is no later verdict for
    // a reader to be ready for, and parsing on would only be a way of holding on to the material.
    if (this.encryptedSeen) return

    // Every append is read, whatever verdict stands over its source: a verdict decides whether
    // material is kept, not whether it is parsed. MSE gives a SourceBuffer a byte stream and not
    // a list of segments, so a reader that skipped the rejected stretch of one would come back
    // inside a segment and have to find its place again by the next header — and by then the
    // init segment of that buffer is long past. Where the material goes is settled below, once
    // there is a whole segment to place.
    for (const unit of this.streamOf(input).push(input.bytes)) {
      // Protection, read out of the segment itself. It is asked before anything else is, because
      // the answer is about the page and not about this stream: what has already been collected
      // in the clear goes too, and nothing more is taken in.
      if (encryptedMedia(unit)) {
        this.refuseEncrypted()
        return
      }

      if (unit.kind === 'init') {
        // An init in a container or a codec the ingest boundary will not take opens no track, and
        // the segments behind it then land nowhere. Better that than a track that cannot be saved
        // — but the loss is written down, because a file short of a whole kind of media must not
        // be offered as if it were the video.
        const opened = ingestInit(unit.bytes, input.mime)
        if (opened) this.openTrack(input, opened)
        else this.refuse(input)
        continue
      }

      this.take(input, unit.bytes)
    }
  }

  /**
   * A media element of the page is playing an ordinary file, and this is everything the page can
   * say about it: where it is, how long it is, and how much of it the browser holds (§5.6).
   *
   * No material comes with it and none ever will: the browser fetched the file itself and this
   * extension saw not one byte of it. What arrives instead is an address, and what is done with
   * an address is nothing at all until triage has promoted the source. Ten of the eighteen
   * measured pages that deliver a plain file hold nothing but muted looping previews and
   * three-second animations, and a page of them would otherwise cost a request apiece for
   * material that would be refused a moment later.
   *
   * Said again whenever any of the three changes — the metadata arriving, the download making
   * headway — and silent while none does, so this is called a handful of times per file rather
   * than twice a second.
   */
  plain(input: PlainInput): void {
    if (this.encryptedSeen) return

    let state = this.plainSources.get(input.sourceId)
    if (!state) {
      state = {
        sourceId: input.sourceId,
        url: input.url,
        keyUrl: normalizeUrl(input.url),
        durationSeconds: input.durationSeconds,
        buffered: [],
        floor: 0,
        page: { url: input.pageUrl, title: input.title, now: input.now },
        reading: false,
        unreadable: false,
        key: '',
      }
      this.plainSources.set(input.sourceId, state)
    }

    state.durationSeconds = input.durationSeconds
    state.buffered = spansOf(input.buffered, state.floor)
    // The page as it stands now. A session already opened keeps the address and the name it was
    // opened with — pageIsAt corrects the name the ordinary way — and this is what a session
    // opened later will be signed with.
    state.page = { url: input.pageUrl, title: input.title, now: input.now }

    this.readPlain(state)
    this.syncPlain(state)
  }

  /**
   * Reads the tables of a file, once, and only for a source that has earned it.
   *
   * The whole cost of a plain source is here: two ranged requests of a few kilobytes, made after
   * triage has said the element is a real player being really watched. A rejected source, a
   * source still serving its probation, and a source on a page with no reader at all make no
   * request whatever.
   */
  private readPlain(state: PlainState): void {
    if (!this.openPlain || state.opened || state.reading || state.unreadable) return
    if (!this.promoted.has(state.sourceId)) return

    state.reading = true
    const read = this.openPlain(state.url)
      .then((opened) => {
        state.reading = false
        if (this.encryptedSeen) return

        // A file whose tables could not be read at all: an address that is gone, a server that
        // will not range, bytes that are not an mp4. It is refused for good — nothing about the
        // file will be different on the next poll — rather than retried twice a second.
        if (!opened) {
          state.unreadable = true
          return
        }

        // Protection found in the file's own boxes. It is the page that is refused and not this
        // source: §5.4 makes encryption a property of the material, and the refusal never turns.
        if (opened.file.encrypted) {
          this.refuseEncrypted()
          return
        }

        state.opened = opened
        this.syncPlain(state)
      })
      .catch(() => {
        state.reading = false
        state.unreadable = true
      })
      .finally(() => {
        this.reads.delete(read)
        this.onFileRead?.()
      })

    this.reads.add(read)
  }

  /**
   * Puts the file into the registry as a session, or takes it out again.
   *
   * A plain session is a view over what is known about the source, and that is what makes the
   * probation of §5.4 free here: the captured path has to carry its material out of the registry
   * and back in again, because the bytes exist nowhere else, while this holds an index that never
   * left the source. A rejection removes the session; the verdict turning puts it back whole.
   */
  private syncPlain(state: PlainState): void {
    const opened = state.opened
    if (!opened || this.encryptedSeen) return

    const key = sessionKey({
      url: state.keyUrl,
      codecs: opened.file.codecs,
      // What the page states, and what the file itself says where the page has stated nothing.
      durationSeconds: state.durationSeconds || opened.file.durationSeconds,
    })

    // The key moved — the metadata arrived and gave the file a length it did not have. The
    // session moves with it rather than leaving a twin behind under the old one.
    if (state.key && state.key !== key) this.dropPlainSession(state)
    state.key = key

    const standing = this.sessions.get(key)
    // A rejection that the session has not outgrown: out of every list and out of every save. A
    // confirmed session is the freeze of §5.5 instead — it stays exactly as it is, and the
    // stretch it offers stops growing because nothing here is updated under a rejection.
    if (this.rejected.has(state.sourceId) && !standing?.confirmed) {
      this.dropPlainSession(state)
      return
    }
    if (this.rejected.has(state.sourceId)) return

    state.signature ??= state.page
    const session = standing ?? this.createSession(key, state.signature)
    session.plain = {
      url: state.url,
      file: opened.file,
      read: opened.read,
      buffered: state.buffered,
    }
    session.sources.add(state.sourceId)
    if (this.promoted.has(state.sourceId)) session.confirmed = true
    if (state.page.now > session.lastSeenAt) session.lastSeenAt = state.page.now
    this.sessions.set(key, session)
  }

  /** Takes the session this file feeds out of the registry; the file itself is not touched. */
  private dropPlainSession(state: PlainState): void {
    const session = this.sessions.get(state.key)
    if (!session) return

    session.sources.delete(state.sourceId)
    // A session another source is also feeding stays: the key is built from the address of the
    // material, so this only happens where two elements really are playing the same file.
    if (session.sources.size === 0) this.sessions.delete(state.key)
  }

  /**
   * One media segment onto the map of the track it belongs to. Which container it is written in
   * was settled when the init of its buffer arrived: the header is found first and the bytes read
   * second, through whichever reading its own buffer was opened with.
   *
   * A segment before its init is a normal thing: the page may have started playing before the
   * bridge stood up. There is nowhere to put it, and that is not an error.
   */
  private take(input: AppendInput, bytes: Uint8Array): void {
    const source = this.sources.get(input.sourceId)
    // A buffer whose init never arrived: a second player on the page whose beginning we missed,
    // or a stream in a container the parser does not read. Dumping its segments into a
    // neighbouring track would mix two streams into one map.
    const representation = source?.buffers.get(input.bufferId)
    const header = representation === undefined ? undefined : source?.headers.get(representation)
    if (!source || !header) return

    const chunk = header.convert ? convertedChunk(header.convert, bytes) : isoChunk(header, bytes)
    if (!chunk) return

    if (this.rejected.has(input.sourceId)) {
      // A rejection of a confirmed session is a freeze and nothing is recorded under it (§5.5);
      // a rejection of a source that has not earned its life yet is a doubt, and the material
      // waits for it to be settled instead of being thrown away — see Probation.
      if (!this.sessions.get(source.key)?.confirmed) this.setAside(input, header, chunk)
      return
    }

    const session = this.sessionOf(source, input)
    // The map is per buffer, so the deduplication rule of PtsMap ("the same start means the same
    // piece") compares only segments of one stream, as it was meant to. Inside one buffer two
    // appends with the same start really are one segment appended twice: a muxed segment carries
    // all of its tracks in one call.
    this.trackFor(session, header).map.insert(chunk)
    session.lastSeenAt = input.now
  }

  /**
   * The session this source feeds, opened here when it has none. An init segment that arrived
   * under a rejection opened no session, and the material that comes once the verdict has turned
   * has to find one anyway — waiting for the next init would mean waiting for one that, on the
   * sites this was measured on, never comes.
   */
  private sessionOf(source: SourceState, input: AppendInput): StoredSession {
    return this.sessions.get(source.key) ?? this.bind(source, input.sourceId, input)
  }

  /** The track of the session this header's material belongs on; opened there if it has none. */
  private trackFor(session: StoredSession, header: TrackHeader): Track {
    const existing = session.tracks.find((t) => t.representation === header.representation)
    if (existing) return existing

    const track: Track = { ...header, map: new PtsMap() }
    session.tracks.push(track)
    return track
  }

  /**
   * A segment of a source whose rejection is under review: set aside instead of collected, and
   * out of sight until triage settles which kind of rejection it was.
   *
   * Nothing of what is set aside can be listed or saved. What it costs is bounded — see
   * MAX_PROBATION_BYTES: material that outlasts the review is dropped for good, and the source
   * keeps nothing more while the verdict stands.
   */
  private setAside(input: AppendInput, header: TrackHeader, chunk: Chunk): void {
    if (this.screenedOut.has(input.sourceId)) return

    let held = this.probation.get(input.sourceId)
    if (!held) {
      held = {
        url: input.url,
        title: input.title,
        createdAt: input.now,
        lastSeenAt: input.now,
        material: new Map(),
        bytes: 0,
      }
      this.probation.set(input.sourceId, held)
    }

    held.bytes += chunk.bytes.byteLength
    if (held.bytes > MAX_PROBATION_BYTES) {
      this.probation.delete(input.sourceId)
      this.screenedOut.add(input.sourceId)
      return
    }

    const under = held.material.get(header.representation)
    if (under) under.chunks.push(chunk)
    else held.material.set(header.representation, { header, chunks: [chunk] })
    held.lastSeenAt = input.now
  }

  /**
   * A buffer of this source declared a track that cannot be written out. Nothing of that stream
   * is collected, so the session shows no trace of it — the note is kept instead, and travels to
   * whatever session the source ends up feeding: the refusal usually comes before there is one,
   * the picture buffer being opened first and refused while the sound buffer opens the session a
   * moment later.
   */
  private refuse(input: AppendInput): void {
    const source = this.sourceFor(input)
    source.refused = true

    const session = this.sessions.get(source.key)
    if (session) session.refusedTracks = true
  }

  /** The reassembly of one SourceBuffer's byte stream; opened the first time it is fed. */
  private streamOf(input: AppendInput): SegmentStream {
    const key = `${input.sourceId}\u0000${input.bufferId}`
    let stream = this.streams.get(key)
    if (!stream) {
      stream = new SegmentStream()
      this.streams.set(key, stream)
    }
    return stream
  }

  get(key: string): Session | undefined {
    return this.sessions.get(key)
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /**
   * Whether this registry holds a session at all.
   *
   * The same question `list()` answers, asked where the answer has to cost nothing: the bridge
   * asks it on the arrival of every segment, to tell the badge that this frame has something (see
   * FrameRecording). A copy and a sort of the map on that path would be work done for nothing on
   * a page that plays for an hour.
   */
  get recording(): boolean {
    return this.sessions.size > 0
  }

  /**
   * The page says where it stands. Two things follow from it, and both are corrections of a
   * signature that was written before the page had finished saying it.
   *
   * The title. A session is signed with the title of the moment its first init segment arrived,
   * and on a single-page application that moment comes before the title does: recording starts at
   * document_start, where <head> is not parsed yet, and the next video of the feed is loaded
   * without a navigation at all. Without this the file would be saved under the name of nothing.
   * Only sessions at that very address take it, compared the way the merge key compares an
   * address — through the referral marks. A page that has moved on keeps the previous video
   * titled as it was: the material is that video's, and so is its name.
   *
   * The address. See followTo: the page can move after the material of the video it is moving to
   * has already gone by.
   */
  pageIsAt(url: string, title: string): void {
    this.followTo(url, title)

    // An empty title is not news but the absence of it: a page that has not filled in its <title>
    // yet, or a frame that never will. Erasing a name we already have for it would be a loss.
    if (!title) return

    const normalized = normalizeUrl(url)
    for (const session of this.sessions.values()) {
      if (normalizeUrl(session.url) === normalized) session.title = title
    }
  }

  /**
   * The recording the page was feeding when it moved goes with it.
   *
   * A session is signed with the address the page showed when its first segment arrived, and on a
   * feed of short clips that is not yet the address of what the segment holds. Measured on
   * youtube.com/shorts: the arrow key opens the MediaSource of the next short and puts its first
   * bytes through appendBuffer 6 to 156 milliseconds before `location.href` becomes that short's
   * address — and in one run a whole short of 18.5 seconds arrived in a burst of eight calls
   * spanning six milliseconds, with nothing appended afterwards to carry a corrected address. Two
   * of four shorts were signed with the short above them: two rows of one name in the popup, and
   * a file saved under the name of a stranger.
   *
   * The correction is the page's own word and not a guess about the bytes, and four things bound
   * what it may take.
   *
   * The freshest session and no other. What the page is moving to is what it has just been fed,
   * and material that arrived earlier belongs to what was on the screen earlier.
   *
   * A session with something in it. A stream that has announced itself and delivered nothing has
   * no claim on any address yet — it will be signed the ordinary way when its first segment
   * arrives. This is what keeps a second player, opened on the page the moment it moved, from
   * swallowing the player that was already there.
   *
   * A session triage has not confirmed. A confirmed one has been watched playing, in view, for
   * the whole grace period; its identity is settled, and a page that then moves on — to the feed,
   * to the next article, leaving the player running in a corner — says nothing about it.
   *
   * An address nothing else stands at. A session already keyed there was opened by material of
   * its own, and that video is accounted for: this stream is not it.
   */
  private followTo(url: string, title: string): void {
    let freshest: StoredSession | undefined
    for (const session of this.sessions.values()) {
      if (!freshest || session.lastSeenAt > freshest.lastSeenAt) freshest = session
    }

    if (!freshest || freshest.confirmed) return
    if (normalizeUrl(freshest.url) === normalizeUrl(url)) return
    if (!freshest.tracks.some((track) => track.map.runs().length > 0)) return

    const source = this.sources.get([...freshest.sources][0] ?? '')
    if (!source) return

    const key = sessionKey({
      url,
      codecs: source.codecs,
      durationSeconds: source.durationSeconds,
    })
    if (this.sessions.has(key)) return

    this.sessions.delete(freshest.key)
    freshest.key = key
    freshest.url = url
    freshest.title = title
    this.sessions.set(key, freshest)

    // The sources move with it, or the next init at the new address would read as a move to
    // another video and clear the headers of a stream that never stopped (see sourceFor).
    const normalized = normalizeUrl(url)
    for (const sourceId of freshest.sources) {
      const feeding = this.sources.get(sourceId)
      if (!feeding) continue
      feeding.key = key
      feeding.url = normalized
    }
  }

  evictAll(windowSeconds: number, currentTime: number): void {
    for (const session of this.sessions.values()) {
      for (const track of session.tracks) track.map.evict(windowSeconds, currentTime)
    }

    // The same rule over the other kind of material: what lies further back than the buffer
    // reaches is no longer on offer. There is nothing to free by it — a plain session holds an
    // index and not the material — so what it does is keep the promise the same on both kinds:
    // the popup offers as far back as the setting says and no further, whichever way the video
    // arrived. A captured map drops whole segments because a segment is what it holds; here the
    // unit is a sample, so the stretch is cut at the line rather than at the segment before it.
    for (const state of this.plainSources.values()) {
      const floor = currentTime - windowSeconds
      if (floor > state.floor) state.floor = floor
      state.buffered = clampSpans(state.buffered, state.floor)

      // Written onto the session rather than left to syncPlain, because eviction reaches a frozen
      // session too. A rejection stops a recording growing (§5.5); it does not exempt what has
      // already been gathered from the buffer length, and the captured maps next door are evicted
      // frozen or not.
      const session = this.sessions.get(state.key)
      if (session?.plain) session.plain.buffered = state.buffered
    }
  }

  /**
   * This page plays encrypted media: nothing of it is kept, and nothing more is taken in. §5.4 of
   * the design refuses DRM before a single byte is copied, and §2 promises the user that a
   * protected page is answered plainly instead of half-recorded.
   *
   * It is not a verdict and does not travel with one. A verdict is about an element — the watcher
   * measures a <video> and speaks about the stream that element is playing — while protection is
   * a property of the material, and on a page whose player sits inside a shadow root no verdict
   * is ever spoken at all. Measured on tv.apple.com: the DRM of that page was reported four
   * times, a verdict not once, and the registry offered 149.6 MB of it for saving. So the refusal
   * comes in by itself and covers the whole page, sessions, sources, probation and all; the
   * watcher rejecting the elements it can reach is a second line and not the first.
   *
   * It is final, and it is deliberately hard to set off. Two things reach it, and both are the
   * stream speaking rather than the page: encryption in the boxes we parse anyway (see
   * encryptedMedia), and the `encrypted` event a media element fires when the material it is
   * being fed carries protection. What does not reach it is the page asking the browser about key
   * systems — measured on a news article as sixteen probes, three of them granted, over a video
   * that was in the clear throughout. Asking is not playing, and a page that asks and then plays
   * in the clear is recorded like any other.
   */
  refuseEncrypted(): void {
    this.encryptedSeen = true

    // Everything, and not only what is listed: material under review is out of the list already
    // (see Probation), and a verdict turning would hand it straight back.
    this.sessions.clear()
    this.sources.clear()
    this.streams.clear()
    // The files too, index and all. A read already on its way finds encryptedSeen set when it
    // lands and puts nothing back.
    this.plainSources.clear()
    this.probation.clear()
    this.rejected.clear()
    this.promoted.clear()
    this.screenedOut.clear()
    this.declaredDurations.clear()
  }

  /**
   * The page has stated how long what this source plays actually is.
   *
   * This is the third component of the merge key (§6.1), and the registry used to leave it unsaid:
   * every session was keyed as if the length were unknown, so two videos were told apart by their
   * address and their codecs alone. On a feed the address does not change from one video to the
   * next and the codecs are the codecs of the feed — measured on tiktok.com/foryou, where seven
   * clips, a MediaSource each, came out as one session and one file with eighteen backward jumps
   * of DTS in it, which Chromium stopped playing at 2.28 seconds. The same collision, half hidden
   * behind an address that lagged a video behind, turned four YouTube shorts into three sessions.
   *
   * What is taken is what the page states and never what the browser infers. Left unset, MSE grows
   * the duration to the end of whatever has been buffered, so a length read off the media element
   * would climb with every segment and move the session to a new key on every poll; a length out
   * of a manifest is stated once and describes the whole video, which is what a key needs.
   *
   * It may arrive before the first init segment or long after the session opened, so the session
   * is re-keyed on the spot — bind() moves it and everything it has collected to the key it will
   * be looked up by from now on, exactly as it does when a second buffer widens the codec list.
   */
  setDuration(sourceId: string, seconds: number): void {
    // A page that played protected media keeps nothing and takes nothing in; a length about it is
    // as much a part of that nothing as a segment would be.
    if (this.encryptedSeen) return
    // Infinity is a live stream, NaN is a duration the player has cleared, and zero is a video of
    // no length: none of the three says anything a key could be built on, and all three mean the
    // same as never having been told.
    if (!Number.isFinite(seconds) || seconds <= 0) return

    this.declaredDurations.set(sourceId, seconds)

    const source = this.sources.get(sourceId)
    // Nothing of this source has been parsed yet. The length waits above for the init segment
    // that opens it, and the source is born knowing it.
    if (!source) return

    // Compared the way the key spells it: a manifest restated on every update, and a live edge
    // refined by milliseconds, are not news, and answering them would move the session about for
    // nothing.
    if (durationToken(source.durationSeconds) === durationToken(seconds)) return
    source.durationSeconds = seconds

    const session = this.sessions.get(source.key)
    // No session under the old key: the source is under a rejection, or its init has not arrived.
    // The length sits on the source, and whatever session it opens next is keyed with it.
    if (!session) return

    this.bind(source, sourceId, { url: session.url, title: session.title, now: session.createdAt })
  }

  /**
   * Triage: the source is deemed junk. Its session leaves the registry unless it has been
   * confirmed or someone else is still feeding it; a confirmed session survives the rejection —
   * recording simply freezes (a pause, a hidden tab, the element leaving the screen) and what has
   * been collected stays.
   *
   * Leaving the registry is not being destroyed. An unconfirmed session goes into the probation
   * of its source, where nothing can list it and nothing can save it, and comes back whole if the
   * verdict turns — the rejection may be the misreading of a single moment, and on the sites this
   * was measured on it usually is. What the source has parsed of its stream is not touched at
   * all: the reader keeps its place and the headers of its buffers keep theirs, because losing
   * either would mean losing every segment of the video that follows, verdict or no verdict.
   */
  dropPending(sourceId: string): void {
    if (this.encryptedSeen) return
    this.rejected.add(sourceId)

    // An ordinary file: nothing is held here, so nothing has to be set aside. The session is
    // simply taken out of the registry, and the verdict turning puts it back whole.
    const plain = this.plainSources.get(sourceId)
    if (plain) {
      this.syncPlain(plain)
      return
    }

    const source = this.sources.get(sourceId)
    if (!source) return

    const session = this.sessions.get(source.key)
    if (!session || session.confirmed) return

    // The verdict is addressed: a session that a neighbouring source is also feeding stays. The
    // key is built from the page address and the codecs, so a banner and the real player next to
    // it may well share one, and taking the session away would kill the neighbour's recording.
    session.sources.delete(sourceId)
    if (session.sources.size > 0) return

    this.sessions.delete(session.key)
    this.probation.set(sourceId, probationOf(session))
  }

  /** Probation served: a rejection of this source no longer takes its session away. */
  promotePending(sourceId: string): void {
    // The watcher goes on measuring the elements it can reach, and one of them may well deserve
    // its life. On a page that played encrypted media none of them gets it: see refuseEncrypted.
    if (this.encryptedSeen) return

    this.promoted.add(sourceId)
    this.rejected.delete(sourceId)
    this.screenedOut.delete(sourceId)

    // The moment an ordinary file has earned its life, and the first moment anything is fetched
    // for it: the tables are read now and not when the page first mentioned the address.
    const plain = this.plainSources.get(sourceId)
    if (plain) {
      this.readPlain(plain)
      this.syncPlain(plain)
      return
    }

    // Remembered on the source and not on the session alone: a source promoted before its first
    // init has no session yet, and the one it opens later is confirmed from the start.
    const session = this.release(sourceId)
    if (session) session.confirmed = true
  }

  /** A hold after a rejection: the source is recorded again but has not earned its life yet. */
  resumePending(sourceId: string): void {
    if (this.encryptedSeen) return

    this.rejected.delete(sourceId)
    this.screenedOut.delete(sourceId)

    const plain = this.plainSources.get(sourceId)
    if (plain) {
      this.syncPlain(plain)
      return
    }

    this.release(sourceId)
  }

  /**
   * The verdict has turned: what was set aside goes back into the registry, on the maps of the
   * very tracks it was collected under, and the session it belonged to is the session it becomes
   * again. Gives back the session this source feeds, if it has one at all.
   */
  private release(sourceId: string): StoredSession | undefined {
    const source = this.sources.get(sourceId)
    if (!source) return undefined

    const held = this.probation.get(sourceId)
    if (!held) {
      // Nothing was set aside — the rejection came before the first segment, or outlasted the
      // review. The source simply takes its place in whatever session it was feeding again.
      const current = this.sessions.get(source.key)
      if (current) this.join(current, sourceId)
      return current
    }

    this.probation.delete(sourceId)
    const session = this.bind(source, sourceId, {
      url: held.url,
      title: held.title,
      now: held.lastSeenAt,
    })
    if (source.refused) session.refusedTracks = true

    for (const { header, chunks } of held.material.values()) {
      const track = this.trackFor(session, header)
      for (const chunk of chunks) track.map.insert(chunk)
    }

    // The session is no younger for the time it spent out of sight: it was opened when its first
    // material arrived, and the popup shows it under the address and the name of that moment.
    if (held.createdAt < session.createdAt) {
      session.createdAt = held.createdAt
      session.url = held.url
      session.title = held.title
    }
    session.lastSeenAt = Math.max(session.lastSeenAt, held.lastSeenAt)

    return session
  }

  /**
   * An init segment: the buffer it came from starts feeding a track. A second init of the same
   * source adds a track to its session instead of opening a session of its own — video and audio
   * of one video arrive in two SourceBuffers and are one session with two tracks.
   */
  private openTrack(input: AppendInput, opened: IngestedInit): void {
    const { info } = opened
    const source = this.sourceFor(input)
    const representation = representationOf(info)

    source.buffers.set(input.bufferId, representation)
    for (const track of info.tracks) {
      if (!source.codecs.includes(track.codec)) source.codecs.push(track.codec)
    }

    // The representation may be known already: a reload, a return to the previous quality or
    // simply a repeated init. The header stays the one the stream was first read with — the
    // material already collected was read through it.
    if (!source.headers.has(representation)) {
      source.headers.set(representation, {
        bufferId: input.bufferId,
        representation,
        kinds: kindsOf(info),
        initBytes: opened.initBytes,
        info,
        convert: opened.convert ?? undefined,
      })
    }

    // A rejected source opens no session: what it collects is set aside until the verdict is
    // settled (see Probation), and the header above is kept whatever that verdict turns out to
    // be. The session and the material come together again in release().
    if (this.rejected.has(input.sourceId)) return

    const session = this.bind(source, input.sourceId, input)
    session.lastSeenAt = input.now
    // A buffer refused before this one was opened: the loss is the session's from the moment it
    // has one.
    if (source.refused) session.refusedTracks = true

    this.trackFor(session, source.headers.get(representation)!)
  }

  /**
   * What the registry knows about the source these bytes came from, up to date about which video
   * it is playing.
   *
   * The page moved on to another video without letting go of its MediaSource — a feed of short
   * clips does exactly that. What the source collected belongs to the previous video and stays in
   * its session; here the source starts from scratch, refusals and all.
   */
  private sourceFor(input: AppendInput): SourceState {
    let source = this.sources.get(input.sourceId)
    if (!source) {
      source = {
        key: '',
        url: '',
        buffers: new Map(),
        headers: new Map(),
        codecs: [],
        durationSeconds: this.declaredDurations.get(input.sourceId) ?? Infinity,
        refused: false,
      }
      this.sources.set(input.sourceId, source)
    }

    const url = normalizeUrl(input.url)
    if (source.url !== url) {
      source.url = url
      source.key = ''
      source.codecs = []
      source.buffers.clear()
      source.headers.clear()
      source.refused = false
      // Everything triage worked out about the previous video goes with it, the material set
      // aside under a rejection included: it was collected under headers this source no longer
      // has, and the video it belonged to is one the page has scrolled past.
      this.promoted.delete(input.sourceId)
      this.screenedOut.delete(input.sourceId)
      this.probation.delete(input.sourceId)

      // The stated length stays, alone of everything here. A page that reuses one MediaSource for
      // its next video states the length of that one too, and it arrives when it arrives;
      // clearing would open a window in which the key calls a video of known length a live
      // stream. The address has moved anyway, and that already tells the two apart.
    }

    return source
  }

  /**
   * Puts the source under the key its tracks add up to, and returns the session it now feeds.
   * The key is recomputed on every init, because a source learns about its own tracks one at a
   * time: the video buffer opens first and the audio one a moment later, and only together do
   * they describe the video.
   */
  private bind(source: SourceState, sourceId: string, context: PageContext): StoredSession {
    const key = sessionKey({
      url: context.url,
      codecs: source.codecs,
      durationSeconds: source.durationSeconds,
    })

    const previous = this.sessions.get(source.key)
    if (previous && previous.key === key) {
      this.join(previous, sourceId)
      return previous
    }

    source.key = key
    previous?.sources.delete(sourceId)
    // Nobody else is feeding the old session: it does not split, it simply becomes known under
    // the wider key together with everything it has collected.
    const alone = previous !== undefined && previous.sources.size === 0

    const target = this.sessions.get(key)

    if (!target) {
      if (previous && alone) {
        this.sessions.delete(previous.key)
        previous.key = key
        this.join(previous, sourceId)
        this.sessions.set(key, previous)
        return previous
      }

      const created = this.createSession(key, context)
      if (previous) this.carryTracks(created, source)
      this.join(created, sourceId)
      this.sessions.set(key, created)
      return created
    }

    this.join(target, sourceId)
    if (previous && alone) {
      absorb(target, previous)
      this.sessions.delete(previous.key)
    } else if (previous) {
      this.carryTracks(target, source)
    }
    return target
  }

  /**
   * The source starts feeding this session. A source triage has already promoted confirms it on
   * the spot: the life was granted to the element, and the session it feeds — this one now — is
   * what the grant was about.
   */
  private join(session: StoredSession, sourceId: string): void {
    session.sources.add(sourceId)
    if (this.promoted.has(sourceId)) session.confirmed = true
  }

  /**
   * The source has moved to another session while the old one lives on with other sources: their
   * material is common and cannot be untangled, so it stays where it is and the source starts
   * collecting the same representations anew. Only the headers travel — without them the buffers
   * whose init has already passed would have nowhere to append until the next one.
   */
  private carryTracks(session: StoredSession, source: SourceState): void {
    for (const representation of source.buffers.values()) {
      const header = source.headers.get(representation)
      if (header) this.trackFor(session, header)
    }
  }

  private createSession(key: string, context: PageContext): StoredSession {
    return {
      key,
      url: context.url,
      title: context.title,
      tracks: [],
      createdAt: context.now,
      lastSeenAt: context.now,
      refusedTracks: false,
      sources: new Set(),
      confirmed: false,
    }
  }
}

/** A session taken out of the registry, in the form its source holds it while under review. */
function probationOf(session: StoredSession): Probation {
  const material = new Map<string, HeldTrack>()

  for (const track of session.tracks) {
    // The map stays behind with the session that is leaving; what goes aside is the header and
    // the segments themselves, and they are put on a map again when the verdict turns.
    const { map, ...header } = track
    const chunks: Chunk[] = []
    for (const run of map.runs()) chunks.push(...run.chunks)
    // A track with nothing under it is nothing to set aside: its header is on the source that
    // opened it, and it is from there that a track of it is opened again.
    if (chunks.length) material.set(header.representation, { header, chunks })
  }

  return {
    url: session.url,
    title: session.title,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    material,
    // The review is measured on what arrives under the verdict, not on what was collected before
    // it: the cap is there to bound how long a page can keep appending to a rejection that is
    // never going to turn.
    bytes: 0,
  }
}

/**
 * Moves everything the absorbed session has collected into the surviving one. Tracks are matched
 * by representation, so the video of the second visit lands on the map of the video of the first.
 */
function absorb(target: StoredSession, absorbed: StoredSession): void {
  for (const track of absorbed.tracks) {
    const existing = target.tracks.find((t) => t.representation === track.representation)
    if (!existing) {
      target.tracks.push(track)
      continue
    }
    for (const run of track.map.runs()) for (const chunk of run.chunks) existing.map.insert(chunk)
  }

  // The session stays the one it was opened as: the address and the title of the earlier visit
  // are what the popup already shows, and a rewind mark in the address of the second visit is no
  // reason to change them.
  if (absorbed.createdAt < target.createdAt) {
    target.createdAt = absorbed.createdAt
    target.url = absorbed.url
    target.title = absorbed.title
  }
  target.lastSeenAt = Math.max(target.lastSeenAt, absorbed.lastSeenAt)
  target.confirmed = target.confirmed || absorbed.confirmed
  // A track refused on either visit is a track missing from the file either way.
  target.refusedTracks = target.refusedTracks || absorbed.refusedTracks
  for (const sourceId of absorbed.sources) target.sources.add(sourceId)
}
