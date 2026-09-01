import { parseFragment } from '../core/iso/fragment'
import { parseInit } from '../core/iso/init'
import { topLevelBoxes } from '../core/iso/reader'
import {
  samplesInSegment,
  trackDefaults,
  type SampleDefaults,
} from '../core/iso/samples'
import {
  encryptedMedia,
  ingestInit,
  type IngestedInit,
  type SegmentConverter,
} from '../core/container'
import { SegmentStream } from '../core/stream'
import { PtsMap } from '../core/timeline/map'
import { evictionOrder, victimsFor, type Valued } from '../core/history/value'
import { durationToken, normalizeUrl, sessionKey } from '../core/session-key'
import {
  cutPlain,
  pairedReader,
  soundBaseOf,
  type OpenedFile,
  type PlainFile,
  type Span,
} from '../core/export/plain'
import type { ExportPlan } from '../core/export/plan'
import type { RangeReader } from '../core/iso/locate'
import type { MuxTrack } from '../core/mux'
import type { OpenedSound } from './loader'
import type { SourceTrack } from '../core/export/plan'
import type { Omission } from '../shared/protocol'
import type { SnapshotPage } from '../core/snapshot/format'
import type { SnapshotSource } from '../core/snapshot/build'
import type { Chunk, InitInfo, TrackKind } from '../shared/types'

/**
 * What the init segment of one SourceBuffer declared: everything needed to read the segments
 * that follow it. MSE hands video and audio to separate buffers, so in the usual case a header
 * here describes exactly one media track; a muxed init puts several ISO tracks into one buffer,
 * and then one header carries both kinds — the segments of such a buffer are shared by them
 * anyway.
 *
 * A header is also a representation: a new init on the same
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
 * One video from one media source. Tracks live inside it; merging by key makes a reload,
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
   * Largest player this session was ever watched in, in CSS pixels; 0 — never measured.
   *
   * A value signal and nothing else: nothing about a file depends on it. The largest and
   * not the latest, because a video that was watched full-screen and then put back into a corner
   * was watched full-screen — the corner says nothing about what it was worth.
   */
  widthPx: number
  /**
   * The material stayed in the file it came from, and this is where to read it.
   *
   * The other kind of session, and the only field that tells the two apart. A capture out of MSE
   * holds its material as `tracks`, segment by segment, because the bytes went past once and
   * would never come again; an ordinary file was never intercepted at all — the browser fetched
   * it and the extension saw nothing — so what is held is an index of it and the reader that
   * fetches by that index (src/core/export/plain.ts).
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
   * their joined playable length; see the note at the head of core/export/plain.ts for why it is
   * this and not the whole file.
   */
  buffered: Span[]
  /**
   * A soundtrack the page is playing beside this picture, read and ready to be laid under it.
   *
   * Only ever set where the picture has no sound of its own — see `SoundApart` in
   * core/export/plain.ts for what a clip means on such a page, and why the sound is taken from
   * the start of the track.
   */
  sound?: PairedSound
  /**
   * The page plays its sound apart and none could be used: unreadable, or more than one playing
   * at once with nothing to say which belongs to the picture.
   *
   * The clip is then silent, and the popup says so in as many words. It is not the same as a
   * picture that is simply silent — there the silence is the material, here it is a loss.
   */
  soundLost?: boolean
}

/** The soundtrack of a picture that has none of its own: the track, and where its bytes are. */
export interface PairedSound {
  url: string
  /** The head of the track, addressed inside its own file; see `SoundApart`. */
  track: SourceTrack
  read: RangeReader
}

/** Bookkeeping of the registry itself: consumers of a session never need it. */
interface StoredSession extends Session {
  /** Media sources feeding this session right now: a reload and a second tab add their own. */
  sources: Set<string>
  /** Triage has granted the session its life: a later rejection freezes it instead of erasing. */
  confirmed: boolean
  /** The title came from this media element, not from the title shared by the whole page. */
  sourceTitle: boolean
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
 * and kept out of sight, and given back the moment the verdict turns.
 *
 * This is the probation buffer. A rejection of a source that has not earned
 * its life yet is a doubt and not a freeze: what is at stake is the whole recording, because the
 * verdict may be the misreading of a single moment — the player element standing above the
 * viewport for one poll while the page lays itself out. Erasing on the spot answers a doubt with
 * the heaviest loss there is, so the material waits here instead, out of every list and out of
 * every save, until triage says which it was.
 *
 * A confirmed session is a different matter and does not come here: it has nothing to lose, and
 * a rejection of it is a freeze: a pause, a hidden tab, and an off-screen element are
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
  /** Actual media bytes retained in `material`, including what arrived before the rejection. */
  retainedBytes: number
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
 * refused for DRM — from growing for as long as the page is open. Once the cap is reached, the
 * source stops growing but keeps its bounded beginning. One first bounded chunk of a media kind
 * that starts later is admitted too, so picture reaching the cap cannot turn an otherwise whole
 * recording silent. Feed players often preload the whole item while it is off-screen and append
 * nothing after it becomes visible, so deleting that beginning would make the later promotion
 * permanently empty.
 */
export const MAX_PROBATION_BYTES = 8 * 1024 * 1024

/** Fixed aggregate ceiling for all undecided sources in one frame. */
export const MAX_TOTAL_PROBATION_BYTES = 32 * 1024 * 1024

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
  /** SourceBuffer timeline shift in seconds when this append was accepted. */
  timestampOffset?: number
  /** The offset was derived by SourceBuffer sequence mode after processing the append. */
  sequence?: true
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
 * A switch of quality opens a second representation of the same kind, and both of them in
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

/** The part of an envelope every selected track can actually put in the file. */
function commonExtentOf(picked: Chunk[][], envelope: Span): Span | null {
  let start = envelope.start
  let end = envelope.end

  for (const chunks of picked) {
    const extent = extentOf(chunks)
    if (!extent) return null
    if (extent.start > start) start = extent.start
    if (extent.end < end) end = extent.end
  }

  return end > start ? { start, end } : null
}

/** Holes between selected chunks, clipped to the part the file covers. */
function holesIn(chunks: Chunk[], clip: Span): Span[] {
  const map = new PtsMap()
  for (const chunk of chunks) map.insert(chunk)

  const holes: Span[] = []
  const runs = map.runs()
  for (let at = 1; at < runs.length; at++) {
    const start = Math.max(clip.start, runs[at - 1]!.end)
    const end = Math.min(clip.end, runs[at]!.start)
    if (end > start) holes.push({ start, end })
  }
  return holes
}

/**
 * Length after the progressive writer joins the holes it is allowed to join.
 *
 * The lead is the picture where there is one, and otherwise the only track. Every one of its
 * holes goes. Sound a player fetched ahead through a picture hole is trimmed by saveAllMp4 before
 * the ordinary gap planner runs: Save all follows the picture the viewer actually loaded rather
 * than preserving an invisible audio prefetch as a pause. Counting over the chunk map avoids
 * parsing every captured sample merely to draw the popup.
 */
function joinedLengthOf(picked: Chunk[][], envelope: Span): number {
  const clip = commonExtentOf(picked, envelope)
  const leadChunks = picked[0]
  if (!clip || !leadChunks) return 0

  let pulled = 0
  for (const hole of holesIn(leadChunks, clip)) {
    pulled += hole.end - hole.start
  }

  return Math.max(0, clip.end - clip.start - pulled)
}

/**
 * What the popup must explain about the file, the heaviest loss first.
 *
 * Ordered because the popup has one line for this and the interface is minimal by design: the
 * first of these is the one that changes the file most. A missing kind of media is a file that
 * plays without a picture; a rendition shortens it. `gap` is the one informational entry: no
 * material is omitted, but its session clock is joined on the way to the file.
 */
function omissionsOf(losses: {
  refusedTracks: boolean
  rendition: boolean
  alternate: boolean
  stretches: number
  soundLost?: boolean
  soundShort?: boolean
}): Omission[] {
  const omitted: Omission[] = []

  if (losses.refusedTracks) omitted.push('track')
  // Beside `track` and above the rest for the same reason: both are a file short of a whole kind
  // of media, which is the loss that changes a clip most.
  if (losses.soundLost) omitted.push('sound')
  if (losses.rendition) omitted.push('rendition')
  if (losses.alternate) omitted.push('alternate')
  // Kept as the established protocol token, but unlike the entries above this is information:
  // every stretch reaches the file and the writer joins their shared holes.
  if (losses.stretches > 1) omitted.push('gap')
  // Last of the list: the clip has its sound and it runs out early, which is the mildest of
  // these and the only one that is about the tail rather than about what was left behind.
  if (losses.soundShort) omitted.push('soundShort')

  return omitted
}

/**
 * What a save is made of, and where its bytes are.
 *
 * The two kinds of material meet here and nowhere else above it: the popup, the badge, the frame
 * addressing and the protocol all read the three numbers beside this and never look inside it.
 *
 * - `captured` — segments already in this frame's memory, indexed and assembled where they lie.
 * - `plain` — a cut planned over a file that is still on somebody's server, to be assembled once
 *   the ranges it names have been read (src/bridge/write.ts).
 *
 * Both end in the same writer; where the bytes are is the whole of the difference.
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
  /** Losses the file has, plus the established `gap` token when recorded runs will be joined. */
  omitted: Omission[]
  /**
   * The sound of this clip comes from a track the page was playing beside the picture, rather
   * than from the video's own material. See `SoundApart`; the popup says so in as many words.
   */
  pairedSound: boolean
}

/**
 * One computation for two questions that must never disagree: the popup asks how much there is
 * to save, and the button asks what to write. Answered apart they agree by convention alone, and
 * the convention has broken twice — a summary that summed the tracks promised fifty seconds of a
 * file that held sound only, and a summary that united the renditions promised the material of
 * two qualities where a file carries one. So the summary is not written to resemble the
 * selection: both are read off this.
 *
 * What comes out is one continuous clip — the tracks the file will hold, its joined playable
 * time, the weight of the media data going into it, and what stayed behind. Material of
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
  const cut = cutPlain(
    material.file,
    material.buffered,
    material.sound ? { track: material.sound.track } : undefined,
  )
  const nothing: SavePlan = {
    source: { kind: 'plain', read: material.read, plan: { tracks: [], duration: 0, bytes: 0 } },
    duration: 0,
    bytes: 0,
    omitted: [],
    pairedSound: false,
  }

  if (!cut) return nothing

  // Two files in one clip are two files in one address space, and the reader over them has to
  // agree with the plan about where the seam is: both come from the one module that decides it.
  const read =
    cut.paired && material.sound
      ? pairedReader(material.read, material.sound.read, soundBaseOf(material.file))
      : material.read

  return {
    source: { kind: 'plain', read, plan: cut.plan },
    duration: cut.plan.duration,
    bytes: cut.plan.bytes,
    omitted: omissionsOf({
      refusedTracks: session.refusedTracks || material.file.refusedTracks,
      // A file states its tracks once and for all, so a second one of a kind in it is other
      // material rather than the same material at another quality: see PlainCut.alternate.
      rendition: false,
      alternate: cut.alternate,
      stretches: cut.stretches,
      soundLost: material.soundLost === true && !cut.paired,
      soundShort: cut.soundShort,
    }),
    pairedSound: cut.paired,
  }
}

function planCapturedSave(session: Session): SavePlan {
  const chosen = mainTracks(session)
  const stretches = commonStretches(chosen)
  const first = stretches[0]
  const last = stretches[stretches.length - 1]
  const envelope = first && last ? { start: first.start, end: last.end } : undefined

  // The common edges keep a file from beginning or ending with a missing kind. Inside them every
  // recorded run is kept: planPreview closes shared holes and preserves one-sided ones so neither
  // real sound nor real picture is thrown away merely because the other track paused.
  const picked = envelope ? chosen.map((track) => chunksIn(track, envelope)) : []

  const material: MuxTrack[] = picked.map((chunks, index) => ({
    initBytes: chosen[index]!.initBytes,
    segments: chunks.map((chunk) => chunk.bytes),
    ...(chunks.some((chunk) => chunk.timestampOffset !== undefined)
      ? { timestampOffsets: chunks.map((chunk) => chunk.timestampOffset ?? 0) }
      : {}),
  }))

  let bytes = 0
  for (const track of material) for (const segment of track.segments) bytes += segment.byteLength

  return {
    source: { kind: 'captured', tracks: material },
    duration: envelope ? joinedLengthOf(picked, envelope) : 0,
    bytes,
    omitted: omissionsOf({
      refusedTracks: session.refusedTracks,
      // Only a rendition that holds something is a loss. A second init with no fragment under it
      // costs the file nothing, and warning about it would be a warning about every quality
      // switch the moment it happens.
      rendition: session.tracks.some((t) => !chosen.includes(t) && t.map.duration() > 0),
      // Nothing captured is an alternate. A stream out of MediaSource is opened by an init, and a
      // second init of a kind on one page is the page switching quality; two languages
      // would be two sessions, because the codecs are part of the merge key.
      alternate: false,
      stretches: stretches.length,
    }),
    // A capture holds the page's own tracks and never borrows one from an element beside it: the
    // pairing is a property of material that was never intercepted.
    pairedSound: false,
  }
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
  pairedSound?: boolean
} {
  const plan = planSave(session)
  const summary: { duration: number; bytes: number; omits?: Omission; pairedSound?: boolean } = {
    duration: plan.duration,
    bytes: plan.bytes,
  }

  // The field is left off rather than set to nothing: it travels through postMessage into the
  // popup, and a key that is always there says less than one that appears when there is a loss.
  const [heaviest] = plan.omitted
  if (heaviest) summary.omits = heaviest
  // The same rule, and this one is not a loss at all: it appears when the sound of the clip came
  // from somewhere the user would not otherwise know about.
  if (plan.pairedSound) summary.pairedSound = true

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
function isoChunk(track: TrackHeader, bytes: Uint8Array, timestampOffset = 0): Chunk | null {
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

  const start = fragment.baseMediaDecodeTime / declared.timescale + timestampOffset
  return {
    start,
    end: start + fragment.duration / declared.timescale,
    bytes,
    ...(timestampOffset === 0 ? {} : { timestampOffset }),
  }
}

/**
 * A chunk out of a segment in another container: rewritten as ISO BMFF on the way in, and it is
 * the rewriting that carries the times — the converter has already worked out, in seconds, where
 * the fragment it wrote begins and ends. What lands on the map is the converted bytes; the ones
 * the page appended are of no further use to anybody and are not kept.
 */
function convertedChunk(
  convert: SegmentConverter,
  bytes: Uint8Array,
  timestampOffset = 0,
): Chunk | null {
  const converted = convert(bytes)
  if (!converted) return null

  return {
    start: converted.start + timestampOffset,
    end: converted.end + timestampOffset,
    bytes: converted.bytes,
    ...(timestampOffset === 0 ? {} : { timestampOffset }),
  }
}

/** The coded-frame times MSE uses to decide and place a sequence-mode discontinuity. */
interface SequenceTiming {
  firstDts: number
  firstPts: number
  lastDts: number
  lastDuration: number
  highestPtsEnd: number
}

/** Reads one fragment's coded-frame times in seconds on its declared track clock. */
function sequenceTiming(
  track: TrackHeader,
  chunk: Chunk,
  defaults: Map<number, SampleDefaults>,
): SequenceTiming | null {
  const tracks = samplesInSegment(chunk.bytes, defaults)
  const fragment = parseFragment(chunk.bytes, track.info.tracks)
  const found =
    tracks.find((candidate) => candidate.trackId === fragment?.trackId) ??
    (tracks.length === 1 ? tracks[0] : undefined)
  const declared =
    track.info.tracks.find((candidate) => candidate.trackId === found?.trackId) ??
    (track.info.tracks.length === 1 ? track.info.tracks[0] : undefined)
  const first = found?.samples[0]
  const last = found?.samples[found.samples.length - 1]
  if (!declared || !(declared.timescale > 0) || !first || !last || !(last.duration > 0)) return null

  const scale = declared.timescale
  let highestPtsEnd = Number.NEGATIVE_INFINITY
  for (const sample of found.samples) {
    highestPtsEnd = Math.max(highestPtsEnd, (sample.pts + sample.duration) / scale)
  }
  return {
    firstDts: first.dts / scale,
    firstPts: first.pts / scale,
    lastDts: last.dts / scale,
    lastDuration: last.duration / scale,
    highestPtsEnd,
  }
}

/** What the page has said about one `<audio>` of its own; see SoundSource in the protocol. */
export interface SoundInput {
  sourceId: string
  pictureSourceId?: string
  url: string
  durationSeconds: number
  buffered: Array<[number, number]>
  playing: boolean
}

/** Everything the registry keeps about one soundtrack the page is playing. */
interface SoundState {
  sourceId: string
  url: string
  buffered: Span[]
  playing: boolean
  /**
   * The page has played this track at some point, whether or not it is playing now.
   *
   * The pairing is decided on this and not on `playing` because a pause freezes state rather than
   * erasing it. A viewer watches a looping picture under
   * a track, pauses it and opens the popup — and read live, the page is silent at that moment and
   * the clip would come out without the sound the viewer had been listening to.
   */
  played: boolean
  /** The head of the track, once it has been read. */
  opened?: OpenedSound
  /** A read of the head is on its way. */
  reading: boolean
  /** It could not be read at all, and no later poll will change that. */
  unreadable: boolean
  /** How many seconds of it were asked for, so that a longer picture can ask for more. */
  seconds: number
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

/**
 * Reads the head of a soundtrack playing beside a picture that has none.
 *
 * `seconds` is the length of that picture and bounds both what is indexed and what is fetched:
 * a clip cannot outrun the material of its picture, so the rest of the track is never read. See
 * `SoundApart` for the whole of what a clip means on such a page.
 */
export type SoundOpener = (url: string, seconds: number) => Promise<OpenedSound | null>

/**
 * A piece of material has just landed on the map of a session: everything the history needs to
 * write it down, said once, at the moment it happened.
 *
 * Said and not asked, because asking would mean walking the maps of every session on a timer and
 * working out what is new since the last walk — a diff of megabytes to find the eight that
 * arrived. It carries the init segment of its track on every call, and the writer decides whether
 * that init is new to the disk: the registry has no idea what is on the disk and must not start
 * keeping one.
 *
 * A chunk the map refused is not reported at all. A second viewing of the same stretch produces a
 * matching interval, the map drops it, and reporting it would put a copy of the same bytes
 * on disk and count it twice in the length of the session.
 */
export interface ChunkStored {
  /** Merge key by which the index finds a session on disk. */
  key: string
  page: { url: string; title: string; createdAt: number; lastSeenAt: number }
  track: {
    representation: string
    bufferId: string
    kinds: TrackKind[]
    info: InitInfo
    initBytes: Uint8Array
  }
  chunk: Chunk
  /** Largest player this session has been seen in so far; see Session.widthPx. */
  widthPx: number
}

/**
 * A session is known under a new merge key from now on.
 *
 * Said in three places and meaning two different things, which is why it carries both keys and
 * lets the writer decide. Two of them are renames: `followTo` moves the freshest session to the
 * address a soft navigation went to, and `bind` re-keys a session once the player states the
 * length — until then the key says `live`. The third is a merge: `bind` finds a session already
 * standing at the new key and pours this one into it (`absorb`).
 *
 * Nothing of the material is reported again by any of them. The history hears about a chunk when
 * a map takes it, and everything a merge moves was taken when it arrived.
 */
export interface SessionRekeyed {
  from: string
  to: string
  /** Where the session stands now: what the row on disk is renamed to say. */
  page: { url: string; title: string }
}

/** A source-scoped title changed after, or before, its session was opened. */
export interface SessionDescribed {
  key: string
  title: string
}

export interface StoreOptions {
  openPlain?: PlainOpener
  openSound?: SoundOpener
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
  /**
   * A chunk was taken onto a map. The history writes it down; a build with no writer records
   * nothing and behaves exactly as the registry did before this stage.
   */
  onChunk?: (event: ChunkStored) => void
  /**
   * The key of a session has changed. What is on disk is addressed by that key, so whatever
   * writes the history has to move with it — see HistoryWriter.rekey.
   */
  onRekey?: (event: SessionRekeyed) => void
  /** Persistent history mirrors a source title without waiting for another media segment. */
  onDescribe?: (event: SessionDescribed) => void
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
  /**
   * The page plays its sound apart from this picture and none of it could be used; see
   * `PlainMaterial.soundLost`. Undefined until the question has been asked at all.
   */
  soundLost?: boolean
}

/**
 * How far an element holds a track from its very start, in seconds; zero when it holds no such
 * stretch.
 *
 * The clip takes the head of the soundtrack and nothing else (see `SoundApart`), so this is the
 * only part of `buffered` that says anything. A track being played on a loop has always got it.
 */
function heldFromStart(spans: readonly Span[]): number {
  for (const span of spans) if (span.start <= 0) return span.end
  return 0
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
  /** Sources evicted from probation by an aggregate or configured memory ceiling. */
  private screenedOut = new Set<string>()
  /** Actual bytes retained across `probation`; kept incrementally on the append hot path. */
  private probationHeldBytes = 0
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
  /** Nothing is taken in at all when recording mode disables this page. See pauseIntake(). */
  private paused = false
  /** sourceId → the largest player it has been measured in; see sawPlayer(). */
  private playerWidths = new Map<string, number>()
  /** sourceId → the ordinary file that source is playing; see plain(). */
  private plainSources = new Map<string, PlainState>()
  /** sourceId → a soundtrack an `<audio>` of the page is playing; see sound(). */
  private soundSources = new Map<string, SoundState>()
  /** Ordinary picture source → the soundtrack sources explicitly observed beside it. */
  private pairedSounds = new Map<string, Set<string>>()
  /** sourceId → presentation read from that media element rather than from the whole page. */
  private mediaTitles = new Map<string, { title: string; url: string }>()
  /** Reads of the tables now in flight: what settled() waits on. */
  private reads = new Set<Promise<void>>()
  private readonly openPlain?: PlainOpener
  private readonly openSound?: SoundOpener
  private readonly onFileRead?: () => void
  private readonly onChunk?: (event: ChunkStored) => void
  private readonly onRekey?: (event: SessionRekeyed) => void
  private readonly onDescribe?: (event: SessionDescribed) => void

  constructor(options: StoreOptions = {}) {
    this.openPlain = options.openPlain
    this.openSound = options.openSound
    this.onFileRead = options.onFileRead
    this.onChunk = options.onChunk
    this.onRekey = options.onRekey
    this.onDescribe = options.onDescribe
  }

  /** Gives one media source its own name, independently of the title shared by the whole tab. */
  describeMedia(sourceId: string, description: { title: string; url: string }): void {
    const title = description.title.trim()
    if (!title) return
    this.mediaTitles.set(sourceId, { title, url: normalizeUrl(description.url) })

    for (const session of this.sessions.values()) {
      if (session.sources.has(sourceId)) this.applyMediaTitle(session, sourceId)
    }
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
   * there is nothing to offer for it. Measured on addresses that had expired between the element
   * fetching them and the save. Without it the popup answers such a page with "nothing recorded
   * yet" — the words for a page that holds no video at all.
   *
   * The imageboard thread this was first measured on no longer lands here: its file is a whole
   * WebM of VP8 and Vorbis, and both the container and the two codecs are read now.
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
    if (this.paused) return

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
    const media: Uint8Array[] = []
    const takeMedia = (): void => {
      if (media.length === 0) return
      this.take(input, media)
      media.length = 0
    }

    for (const unit of this.streamOf(input).push(input.bytes)) {
      // Protection, read out of the segment itself. It is asked before anything else is, because
      // the answer is about the page and not about this stream: what has already been collected
      // in the clear goes too, and nothing more is taken in.
      if (encryptedMedia(unit)) {
        this.refuseEncrypted()
        return
      }

      if (unit.kind === 'init') {
        takeMedia()
        // An init in a container or a codec the ingest boundary will not take opens no track, and
        // the segments behind it then land nowhere. Better that than a track that cannot be saved
        // — but the loss is written down, because a file short of a whole kind of media must not
        // be offered as if it were the video.
        const opened = ingestInit(unit.bytes, input.mime)
        if (opened) this.openTrack(input, opened)
        else this.refuse(input)
        continue
      }

      media.push(unit.bytes)
    }
    takeMedia()
  }

  /**
   * A media element of the page is playing an ordinary file, and this is everything the page can
   * say about it: where it is, how long it is, and how much of it the browser holds.
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
    // The one road the hook does not stand on: nothing of an ordinary file passes through the
    // MAIN world, so the recording switch reaches it only here. Without this line a denied host
    // playing a plain <video src> would go on being recorded and offered for saving.
    if (this.paused || this.encryptedSeen) return

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
   * An `<audio>` of the page is playing a soundtrack of its own.
   *
   * It is never a session and never a saved file: a soundtrack alone is not a clip of anything,
   * and offering one would make this a music downloader. What it can be is the sound of a picture
   * on the same page that has none of its own, and that is settled in `pairSound` below.
   *
   * Nothing is read here either. A soundtrack is fetched only once a picture has asked for it,
   * which means only once triage has promoted that picture — the same rule, and for the same
   * reason, as an ordinary file.
   */
  sound(input: SoundInput): void {
    if (this.paused || this.encryptedSeen) return

    let state = this.soundSources.get(input.sourceId)
    if (!state) {
      state = {
        sourceId: input.sourceId,
        url: input.url,
        buffered: [],
        playing: false,
        played: false,
        reading: false,
        unreadable: false,
        seconds: 0,
      }
      this.soundSources.set(input.sourceId, state)
    }

    state.buffered = spansOf(input.buffered, 0)
    state.playing = input.playing
    state.played ||= input.playing

    // The watcher preserves element identity and reports a pair only when the page leaves one
    // possible picture. Resynchronising every picture here is what used to replace a feed item's
    // soundtrack with the audio of the item scrolled to after it.
    if (input.pictureSourceId) {
      let paired = this.pairedSounds.get(input.pictureSourceId)
      if (!paired) {
        paired = new Set()
        this.pairedSounds.set(input.pictureSourceId, paired)
      }
      paired.add(input.sourceId)
      const plain = this.plainSources.get(input.pictureSourceId)
      if (plain) this.syncPlain(plain)
    }
  }

  /**
   * The soundtrack to lay under this picture, if the page is playing one and it can be read.
   *
   * Refused outright unless the picture has no sound of its own: a track from outside is an
   * answer to a silent picture, and a second one beside a file's own would be composing rather
   * than clipping.
   *
   * Exactly one playing track, or none. Two at once — a page with music behind it and a video
   * player beside that — cannot be resolved by anything this can see, and guessing which belongs
   * to the picture would put a stranger's sound into somebody's clip. Then the clip is silent and
   * the popup says why.
   */
  private pairSound(state: PlainState): PairedSound | undefined {
    const file = state.opened?.file
    if (!file || file.tracks.some((track) => track.kind === 'audio')) return undefined

    // What is playing right now, and failing that what has played at all. The first answers a
    // page as it stands; the second answers the same page paused, which is the state a page is in
    // while somebody decides to save from it. A page that has played two tracks in turn — a feed,
    // a playlist — falls through both and is left unpaired rather than guessed at: putting a
    // stranger's sound into somebody's clip is worse than handing them a silent one and saying so.
    const associated = [...(this.pairedSounds.get(state.sourceId) ?? [])]
      .map((sourceId) => this.soundSources.get(sourceId))
      .filter((sound): sound is SoundState => sound !== undefined)
    const playing = associated.filter((sound) => sound.playing)
    const heard = associated.filter((sound) => sound.played)
    const candidates = playing.length ? playing : heard

    if (candidates.length !== 1) {
      // Nothing has played at all is not a loss: a silent picture on a page with no sound on it
      // is simply a silent picture, and there is nothing to tell the user about.
      state.soundLost = candidates.length > 1
      return undefined
    }

    const sound = candidates[0]!
    // How much of the track can ever be used: a clip cannot outrun the picture's own material.
    // Clamped to the stretch the element actually holds from its start, so that what is offered
    // is what really passed through the player — the same promise the picture is held to.
    const seconds = Math.min(file.durationSeconds, heldFromStart(sound.buffered))

    if (!(seconds > 0)) {
      state.soundLost = false
      return undefined
    }

    // A read may be wanted even with a track already in hand: the element has since buffered more
    // of it and the clip can reach further. What was read stays on offer while the longer read is
    // on its way — dropped, the popup would lose the line about the sound and get it back a
    // moment later, and a save made in between would come out silent.
    this.readSound(sound, seconds)

    if (sound.opened) {
      state.soundLost = false
      return { url: sound.url, track: sound.opened.track, read: sound.opened.read }
    }

    state.soundLost = sound.unreadable
    return undefined
  }

  /** Reads the head of one soundtrack, once, and only as far as a picture has asked for. */
  private readSound(sound: SoundState, seconds: number): void {
    if (!this.openSound || sound.reading || sound.unreadable) return
    if (sound.opened && sound.seconds >= seconds) return

    sound.reading = true
    sound.seconds = seconds

    const read = this.openSound(sound.url, seconds)
      .then((opened) => {
        sound.reading = false
        if (this.encryptedSeen) return

        // A track that could not be read at all: an address that is gone, a host that will not
        // range, bytes in no container this reads. Refused for good rather than retried twice a
        // second — nothing about the file will be different on the next poll.
        if (!opened) {
          sound.unreadable = true
        } else {
          sound.opened = opened
        }

        for (const plain of this.plainSources.values()) {
          if (this.pairedSounds.get(plain.sourceId)?.has(sound.sourceId)) this.syncPlain(plain)
        }
      })
      .catch(() => {
        sound.reading = false
        sound.unreadable = true
      })
      .finally(() => {
        this.reads.delete(read)
        this.onFileRead?.()
      })

    this.reads.add(read)
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
        // source: encryption is a property of the material, and the refusal never turns.
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
   * probation free here: the captured path has to carry its material out of the registry
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
    // confirmed session is a freeze instead — it stays exactly as it is, and the
    // stretch it offers stops growing because nothing here is updated under a rejection.
    if (this.rejected.has(state.sourceId) && !standing?.confirmed) {
      this.dropPlainSession(state)
      return
    }
    if (this.rejected.has(state.sourceId)) return

    state.signature ??= state.page
    const session = standing ?? this.createSession(key, state.signature)
    const sound = this.pairSound(state)
    session.plain = {
      url: state.url,
      file: opened.file,
      read: opened.read,
      buffered: state.buffered,
      ...(sound ? { sound } : {}),
      ...(state.soundLost ? { soundLost: true } : {}),
    }
    session.sources.add(state.sourceId)
    this.applyMediaTitle(session, state.sourceId)
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
  private take(input: AppendInput, bytes: readonly Uint8Array[]): void {
    const source = this.sources.get(input.sourceId)
    // A buffer whose init never arrived: a second player on the page whose beginning we missed,
    // or a stream in a container the parser does not read. Dumping its segments into a
    // neighbouring track would mix two streams into one map.
    const representation = source?.buffers.get(input.bufferId)
    const header = representation === undefined ? undefined : source?.headers.get(representation)
    if (!source || !header) return

    const finalOffset =
      typeof input.timestampOffset === 'number' && Number.isFinite(input.timestampOffset)
        ? input.timestampOffset
        : 0
    const chunks = bytes.flatMap((one) => {
      const chunk = header.convert
        ? convertedChunk(header.convert, one)
        : isoChunk(header, one)
      return chunk ? [chunk] : []
    })
    if (chunks.length === 0) return

    const offsets = new Array<number>(chunks.length).fill(finalOffset)
    if (input.sequence && chunks.length > 1) {
      const defaults = trackDefaults(header.initBytes)
      const timings = chunks.map((chunk) => sequenceTiming(header, chunk, defaults))
      const groups: Array<{
        from: number
        to: number
        firstPts: number
        highestPtsEnd: number
      }> = []
      let from = 0
      const highestEnd = (start: number, end: number): number => {
        let highest = Number.NEGATIVE_INFINITY
        for (let at = start; at <= end; at++) {
          highest = Math.max(highest, timings[at]?.highestPtsEnd ?? chunks[at]!.end)
        }
        return highest
      }

      for (let at = 0; at < chunks.length - 1; at++) {
        const current = timings[at]
        const next = timings[at + 1]
        const discontinuity =
          current && next
            ? next.firstDts < current.lastDts ||
              next.firstDts - current.lastDts > 2 * current.lastDuration
            : chunks[at + 1]!.start <= chunks[at]!.end
        if (!discontinuity) continue

        groups.push({
          from,
          to: at,
          firstPts: timings[from]?.firstPts ?? chunks[from]!.start,
          highestPtsEnd: highestEnd(from, at),
        })
        from = at + 1
      }
      groups.push({
        from,
        to: chunks.length - 1,
        firstPts: timings[from]?.firstPts ?? chunks[from]!.start,
        highestPtsEnd: highestEnd(from, chunks.length - 1),
      })

      // MSE exposes the offset of the last coded-frame group after updateend. Recover every
      // earlier group from the same relation MSE used: its highest presentation end becomes the
      // next group's first presentation timestamp. Decode spans alone are wrong for B-frames.
      let groupOffset = finalOffset
      for (let at = groups.length - 1; at >= 0; at--) {
        const group = groups[at]!
        if (at < groups.length - 1) {
          const next = groups[at + 1]!
          groupOffset += next.firstPts - group.highestPtsEnd
        }
        for (let chunk = group.from; chunk <= group.to; chunk++) offsets[chunk] = groupOffset
      }
    }

    for (const [at, raw] of chunks.entries()) {
      const timestampOffset = offsets[at]!
      const chunk =
        timestampOffset === 0
          ? raw
          : {
              ...raw,
              start: raw.start + timestampOffset,
              end: raw.end + timestampOffset,
              timestampOffset,
            }
      this.keep(input, source, header, chunk)
    }
  }

  private keep(input: AppendInput, source: SourceState, header: TrackHeader, chunk: Chunk): void {
    if (this.rejected.has(input.sourceId)) {
      // A rejection of a confirmed session is a freeze and nothing is recorded under it;
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
    if (this.trackFor(session, header).map.insert(chunk)) this.stored(session, header, chunk)
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

  /** Tells whoever is writing the history that this piece is now part of this session. */
  private stored(session: StoredSession, header: TrackHeader, chunk: Chunk): void {
    this.onChunk?.({
      key: session.key,
      page: {
        url: session.url,
        title: session.title,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
      },
      track: {
        representation: header.representation,
        bufferId: header.bufferId,
        kinds: header.kinds,
        info: header.info,
        initBytes: header.initBytes,
      },
      chunk,
      widthPx: session.widthPx,
    })
  }

  /**
   * The key of this session has changed; whoever writes the history has to hear it once.
   *
   * Every caller has already settled that the two keys differ — `followTo` gives up when the key
   * it computed is already taken, and both branches of `bind` are past the early return for a
   * source that stayed where it was. A guard here would be a line no test could reach, and the
   * writer answers a move to the key it already stands under by itself (`HistoryWriter.rekey`).
   */
  private rekeyed(from: string, session: StoredSession): void {
    this.onRekey?.({
      from,
      to: session.key,
      page: { url: session.url, title: session.title },
    })
  }

  /**
   * A segment of a source whose rejection is under review: set aside instead of collected, and
   * out of sight until triage settles which kind of rejection it was.
   *
   * Nothing of what is set aside can be listed or saved. What it costs is bounded — see
   * MAX_PROBATION_BYTES: each media kind stops growing at the cap, apart from the first bounded
   * chunk of a kind that starts later. Its bounded beginning remains available if the verdict
   * turns, and the aggregate ceiling remains absolute.
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
        retainedBytes: 0,
      }
      this.probation.set(input.sourceId, held)
    }

    const bytes = chunk.bytes.byteLength
    if (held.bytes + bytes > MAX_PROBATION_BYTES) {
      const kindsAlreadyHeld = new Set<TrackKind>()
      for (const track of held.material.values()) {
        for (const kind of track.header.kinds) kindsAlreadyHeld.add(kind)
      }
      const firstChunkOfLateKind =
        bytes <= MAX_PROBATION_BYTES &&
        header.kinds.some((kind) => !kindsAlreadyHeld.has(kind))
      if (!firstChunkOfLateKind) {
        // Stop copying this kind, but keep the decodable beginning already gathered. A feed can
        // preload the whole off-screen item and emit nothing after it becomes visible; deleting
        // the prefix here made that later promotion permanently empty. Sound commonly starts
        // after picture, so its first bounded chunk is still admitted below.
        if (held.retainedBytes === 0) this.forgetProbation(input.sourceId)
        return
      }
    }
    if (!this.makeProbationRoom(input.sourceId, bytes)) {
      this.screenedOut.add(input.sourceId)
      return
    }

    held.bytes += bytes
    held.retainedBytes += bytes
    this.probationHeldBytes += bytes

    const under = held.material.get(header.representation)
    if (under) under.chunks.push(chunk)
    else held.material.set(header.representation, { header, chunks: [chunk] })
    held.lastSeenAt = input.now
  }

  /** Removes one retained doubt and keeps the aggregate counter exact. */
  private forgetProbation(sourceId: string): Probation | undefined {
    const held = this.probation.get(sourceId)
    if (!held) return undefined
    this.probation.delete(sourceId)
    this.probationHeldBytes = Math.max(0, this.probationHeldBytes - held.retainedBytes)
    return held
  }

  /** Makes room for the newest undecided item by evicting older ones, never by growing memory. */
  private makeProbationRoom(sourceId: string, bytes: number): boolean {
    while (this.probationHeldBytes + bytes > MAX_TOTAL_PROBATION_BYTES) {
      let oldest: { sourceId: string; held: Probation } | undefined
      for (const [candidateId, candidate] of this.probation) {
        if (candidateId === sourceId) continue
        if (
          !oldest ||
          candidate.lastSeenAt < oldest.held.lastSeenAt ||
          (candidate.lastSeenAt === oldest.held.lastSeenAt && candidateId < oldest.sourceId)
        ) {
          oldest = { sourceId: candidateId, held: candidate }
        }
      }
      if (!oldest) return false
      this.forgetProbation(oldest.sourceId)
      this.screenedOut.add(oldest.sourceId)
    }
    return true
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
      if (normalizeUrl(session.url) === normalized && !session.sourceTitle) session.title = title
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

    const previousKey = freshest.key
    this.sessions.delete(previousKey)
    freshest.key = key
    freshest.url = url
    freshest.title = title
    this.sessions.set(key, freshest)
    this.rekeyed(previousKey, freshest)

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

  /**
   * Trims every session to the configured buffer length.
   *
   * The position each session is measured from is the newest end of its own material, unless a
   * caller states one. Three reasons, and none of them is an approximation. The playhead is known
   * to the watcher and not here, and carrying it over would be a number per element twice a
   * second. A jump backwards past the window is a re-request: the player downloads the
   * stretch again and the segments land back on the map — so the case this would protect against
   * heals itself. And a session that nothing arrives in stays exactly a buffer long instead of
   * melting away three minutes after the page was paused, which is what a wall clock would do to
   * it.
   */
  trimToBuffer(windowSeconds: number, at?: number): void {
    for (const session of this.sessions.values()) {
      let newest = at ?? 0
      if (at === undefined) {
        for (const track of session.tracks) newest = Math.max(newest, track.map.span()?.end ?? 0)
        for (const span of session.plain?.buffered ?? []) newest = Math.max(newest, span.end)
      }

      for (const track of session.tracks) track.map.evict(windowSeconds, newest)

      // The same rule over the other kind of material: what lies further back than the buffer
      // reaches is no longer on offer. There is nothing to free by it — a plain session holds an
      // index and not the material — so what it does is keep the promise the same on both kinds:
      // the popup offers as far back as the setting says and no further, whichever way the video
      // arrived. A captured map drops whole segments because a segment is what it holds; here the
      // unit is a sample, so the stretch is cut at the line rather than at the segment before it.
      //
      // Written onto the session as well as onto the source, because eviction reaches a frozen
      // session too: a rejection stops a recording growing, and it does not exempt what
      // was already gathered from the buffer length. Reached through the session rather than by
      // walking the sources, because the position is the session's own end — a file feeding no
      // session has no end of its own to be measured from, and a rejection the session has not
      // outgrown takes it out of the registry altogether (see syncPlain).
      //
      // Every source feeding the session, and not the first of them. The merge key normalises the
      // address, so two elements playing `clip.mp4#t=0` and `clip.mp4#t=30` are one key and two
      // sources of it. Trimmed by the first alone, the second went on reporting the whole file,
      // the next poll wrote that back onto the session, and the material eviction had just taken
      // came back — against the check beside this one and against this very comment.
      const floor = newest - windowSeconds
      for (const state of this.plainSources.values()) {
        if (state.key !== session.key) continue
        if (floor > state.floor) state.floor = floor
        state.buffered = clampSpans(state.buffered, state.floor)
        if (session.plain) session.plain.buffered = state.buffered
      }
    }
  }

  /** Weight of everything this frame is holding in memory, across every session. */
  heldBytes(): number {
    let bytes = this.probationHeldBytes
    for (const session of this.sessions.values()) {
      for (const track of session.tracks) bytes += track.map.totalBytes()
    }
    return bytes
  }

  /**
   * Brings what this frame holds back under the memory ceiling.
   *
   * Whole sessions first, lowest-value first, and not the oldest runs of each: the runs are
   * already trimmed to the buffer length, and taking more off every session would break the
   * promise of the setting evenly across all of them instead of keeping it for the ones worth
   * keeping.
   *
   * Only what holds memory is weighed here at all, because memory is what this ceiling is made
   * of. An ordinary file keeps an index of material the browser fetched and this frame
   * never saw, so it weighs nothing — and weighing nothing, with no tracks to take a length or a
   * soundtrack from either, it used to stand first in the queue by every signal there is. It went
   * first and freed not one byte, and it could not come back afterwards: the watcher speaks about
   * a file only when what it says changes, so the popup lost a recording that was still playing.
   *
   * The most valuable of the rest is never offered, however far over the ceiling the frame is.
   * Dropping the last session standing frees the whole recording and leaves the user with none of
   * it, and that is what a long buffer used to run into every few minutes: one 1080p session
   * passes a flat 512 MiB at about eleven minutes, so a half-hour buffer meant losing everything
   * and starting again, over and over, while the slider went on promising half an hour. Such a
   * session is shortened instead — see `trimToCeiling`.
   *
   * Nothing here knows about pins, and that is not an oversight: a pin is about the history on
   * disk, which this ceiling has nothing to do with. What is pinned is on the disk and outlives
   * the frame either way.
   */
  dropOverCeiling(ceilingBytes: number, now: number): void {
    // Undecided material is the first thing to yield under the frame's configured ceiling. It is
    // not user-visible yet, while every listed session has already survived the admission test.
    while (this.heldBytes() > ceilingBytes && this.probation.size > 0) {
      let oldest: { sourceId: string; at: number } | undefined
      for (const [sourceId, held] of this.probation) {
        if (!oldest || held.lastSeenAt < oldest.at) oldest = { sourceId, at: held.lastSeenAt }
      }
      if (!oldest) break
      this.forgetProbation(oldest.sourceId)
      this.screenedOut.add(oldest.sourceId)
    }

    const over = this.heldBytes() - ceilingBytes
    if (over <= 0) return

    const held: Valued[] = []
    for (const session of this.sessions.values()) {
      const bytes = session.tracks.reduce((total, track) => total + track.map.totalBytes(), 0)
      if (bytes === 0) continue

      held.push({
        id: session.key,
        pinned: false,
        usedAt: 0,
        lastSeenAt: session.lastSeenAt,
        seconds: session.tracks[0]?.map.duration() ?? 0,
        sound: session.tracks.some((track) => track.kinds.includes('audio')),
        widthPx: session.widthPx,
        bytes,
      })
    }

    const offered = evictionOrder(held, now).slice(0, -1)
    for (const victim of victimsFor(offered, now, over)) this.sessions.delete(victim.id)

    this.trimToCeiling(ceilingBytes)
  }

  /**
   * Shortens a session that is over the ceiling on its own, instead of taking it whole.
   *
   * Reached only where dropping cannot help: the offer above holds back the most valuable session
   * whatever the shortfall, so either the drops brought the frame under the ceiling and every
   * session here is already inside it, or one session is left and it is bigger than the ceiling
   * by itself. That happens where the material comes in faster than the reference rate the
   * ceiling is sized at — 4K against `REFERENCE_BITS_PER_SECOND` — and the answer to it is a
   * shorter recording, not none.
   *
   * The window is worked out from what the session actually weighs per second, so one pass lands
   * about on the ceiling and the tick two seconds later corrects whatever the segment boundaries
   * left over. It is a window and not a byte budget, exactly as the buffer length is: a session
   * with a hole in it gives up more than the arithmetic asks for, because what lies further back
   * than the window goes whether the hole is counted or not. A ceiling with room for nothing at
   * all takes the session after all: an empty one would sit in the popup offering a recording of
   * zero seconds.
   */
  private trimToCeiling(ceilingBytes: number): void {
    for (const [key, session] of this.sessions) {
      let bytes = 0
      let newest = 0
      let seconds = 0
      for (const track of session.tracks) {
        bytes += track.map.totalBytes()
        newest = Math.max(newest, track.map.span()?.end ?? 0)
        seconds = Math.max(seconds, track.map.duration())
      }
      if (bytes <= ceilingBytes || !(seconds > 0)) continue

      const fits = (seconds * Math.max(0, ceilingBytes)) / bytes
      for (const track of session.tracks) track.map.evict(fits, newest)
      if (session.tracks.every((track) => track.map.totalBytes() === 0)) this.sessions.delete(key)
    }
  }

  /**
   * This page plays encrypted media: nothing of it is kept, and nothing more is taken in. DRM is
   * refused before a single byte is copied, and the user is told plainly instead of receiving a
   * partial recording.
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
  /**
   * Whether material is taken in at all, as determined by the recording mode.
   *
   * Belt and braces beside the hook, which is where the switch actually saves anything — but the
   * hook of a page loaded before the extension was updated, or a worker wrapped in a realm of its
   * own, can still be sending. And the hook is not on every road: an ordinary file never passes
   * through it at all, so ordinary-file and split-sound intake stop here as well. What the registry
   * already holds is not touched: switching recording off stops intake without erasing material.
   */
  pauseIntake(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused

    // Coming back, the readers are let go rather than resumed. MSE hands a SourceBuffer a byte
    // stream and not a list of segments, so a reader that kept the half of a segment it had would
    // splice it onto bytes from minutes later and read the join as a header. A fresh reader finds
    // the next header and starts there, and the material in between is a gap — which is what it
    // is, and what the timeline keeps honestly.
    if (!paused) this.streams.clear()
  }

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
    this.soundSources.clear()
    this.probation.clear()
    this.probationHeldBytes = 0
    this.rejected.clear()
    this.promoted.clear()
    this.screenedOut.clear()
    this.declaredDurations.clear()
  }

  /**
   * The page has stated how long what this source plays actually is.
   *
   * This is the third component of the merge key, and the registry used to leave it unsaid:
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
    const held = probationOf(session)
    this.forgetProbation(sourceId)
    if (
      held.retainedBytes <= MAX_TOTAL_PROBATION_BYTES &&
      this.makeProbationRoom(sourceId, held.retainedBytes)
    ) {
      this.probation.set(sourceId, held)
      this.probationHeldBytes += held.retainedBytes
    } else {
      this.screenedOut.add(sourceId)
    }
  }

  /**
   * The largest player the session under this merge key has been watched in; 0 — none, or no such
   * session in this frame any more.
   *
   * Read where a piece of history lands, because that is later than anywhere else: the width of
   * a player is measured half a second into the page at the earliest, and a site that hands over
   * its whole video in the first second has by then cut every chunk it will ever cut. Stamping
   * the number on the chunk alone would leave such a session on disk with a width of nothing.
   */
  widthOf(key: string): number {
    return this.sessions.get(key)?.widthPx ?? 0
  }

  /**
   * The watcher measured the element playing this source. See Session.widthPx.
   *
   * Remembered on the source as well as put on the session, because it regularly arrives before
   * there is a session to put it on: the watcher measures the player half a second after the page
   * loads, and on a page that opens its MediaSource a moment later the first init has not arrived
   * yet. Only growth is reported (see Measured in the watcher), so a measurement dropped here
   * would never be repeated.
   */
  sawPlayer(sourceId: string, widthPx: number): void {
    // News and nothing else, in one comparison written this way round on purpose. A width no
    // larger than the one already held changes nothing; zero and anything below it are that case
    // too; and NaN — what an element that never reached the layout measures out as — fails the
    // comparison and is refused rather than stored. Refusing it matters: nothing is greater than
    // NaN, so a NaN kept here would answer "not news" to every measurement after it, and the
    // session this source opens later would start out of `join` at a width of nothing.
    //
    // Two guards stood here, the first of them "greater than zero". It said nothing this line
    // does not: the only case it answered on its own was the NaN, and it answered it twice.
    if (!(widthPx > (this.playerWidths.get(sourceId) ?? 0))) return
    this.playerWidths.set(sourceId, widthPx)

    const source = this.sources.get(sourceId)
    const session = source && this.sessions.get(source.key)
    if (session && widthPx > session.widthPx) session.widthPx = widthPx
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
      // Nothing was set aside — the rejection came before the first segment, or a memory ceiling
      // evicted its probation. The source simply takes its place in whatever session it was
      // feeding again.
      const current = this.sessions.get(source.key)
      if (current) this.join(current, sourceId)
      return current
    }

    this.forgetProbation(sourceId)
    const session = this.bind(source, sourceId, {
      url: held.url,
      title: held.title,
      now: held.lastSeenAt,
    })
    if (source.refused) session.refusedTracks = true

    for (const { header, chunks } of held.material.values()) {
      const track = this.trackFor(session, header)
      for (const chunk of chunks) if (track.map.insert(chunk)) this.stored(session, header, chunk)
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
      this.forgetProbation(input.sourceId)

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
        const previousKey = previous.key
        this.sessions.delete(previousKey)
        previous.key = key
        this.join(previous, sourceId)
        this.sessions.set(key, previous)
        this.rekeyed(previousKey, previous)
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
      // A merge and not a rename, and said as one: what the absorbed session collected is already
      // on the maps of this one and is not reported again. What the writer does about two keys
      // that have become one is its own business (HistoryWriter.rekey).
      this.rekeyed(previous.key, target)
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
    this.applyMediaTitle(session, sourceId)
    if (this.promoted.has(sourceId)) session.confirmed = true
    // What was measured of this player before the session existed is a measurement of this very
    // video: see sawPlayer. The one place a source starts feeding a session, whichever of the
    // four roads of bind() brought it here.
    const measured = this.playerWidths.get(sourceId) ?? 0
    if (measured > session.widthPx) session.widthPx = measured
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
      widthPx: 0,
      sources: new Set(),
      confirmed: false,
      sourceTitle: false,
    }
  }

  /** Applies a pending source title once, and tells persistence only when something changed. */
  private applyMediaTitle(session: StoredSession, sourceId: string): void {
    const description = this.mediaTitles.get(sourceId)
    if (!description || description.url !== normalizeUrl(session.url)) return
    const { title } = description
    if (session.sourceTitle && session.title === title) return
    session.title = title
    session.sourceTitle = true
    this.onDescribe?.({ key: session.key, title })
  }
}

/** A session taken out of the registry, in the form its source holds it while under review. */
function probationOf(session: StoredSession): Probation {
  const material = new Map<string, HeldTrack>()
  let retainedBytes = 0

  for (const track of session.tracks) {
    // The map stays behind with the session that is leaving; what goes aside is the header and
    // the segments themselves, and they are put on a map again when the verdict turns.
    const { map, ...header } = track
    const chunks: Chunk[] = []
    for (const run of map.runs()) {
      chunks.push(...run.chunks)
      for (const chunk of run.chunks) retainedBytes += chunk.bytes.byteLength
    }
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
    retainedBytes,
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

  // The size of the player is deliberately not in this list. It belongs to the source that was
  // measured rather than to the session, and it lands on whatever session that source starts
  // feeding, at the moment it starts (see join) — which on this road has already happened. A line
  // here would be a second way to the same number, and no test could tell whether it was taken.
}

/**
 * The session as the snapshot format wants it.
 *
 * The chunks come off `map.runs()` and not out of a field of their own, because runs() is the one
 * place the order and the de-duplication of the map are decided. A second traversal written here
 * would agree with the popup by convention, and the convention has broken before.
 *
 * The traversal is synchronous from end to end and has to stay that way: eviction goes on while
 * the popup is open, and a source read on one side of an await would name bytes the map has
 * already let go of.
 */
export function snapshotSourceOf(session: Session): SnapshotSource {
  return {
    page: snapshotPageOf(session),
    tracks: session.tracks.map((track, at) => ({
      // A name of its own inside the snapshot: bufferId is unique in its media source and not in
      // the file, and two sources of one page do give out the same one.
      id: `t${at}`,
      bufferId: track.bufferId,
      representation: track.representation,
      kinds: track.kinds,
      info: track.info,
      initBytes: track.initBytes,
      chunks: track.map.runs().flatMap((run) => run.chunks),
    })),
  }
}

/** Everything about a session that cannot be worked out of the material, whichever kind it is. */
function snapshotPageOf(session: Session): SnapshotPage {
  return {
    sessionKey: session.key,
    url: session.url,
    title: session.title,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    // A track the ingest refused on the captured path, or one the movie box declared and the
    // index could not read on this one: either way the material is short of a kind of media.
    refusedTracks: session.refusedTracks || session.plain?.file.refusedTracks === true,
  }
}

/**
 * The chunks of a whole file carry no bytes of their own: one `mdat` holds the samples of every
 * stretch, and the file is laid out once. See `SnapshotSourceTrack.movie`.
 */
const NO_SEGMENT = new Uint8Array(0)

/**
 * The same session as a snapshot source, when its material is an ordinary complete file.
 *
 * `file` is that material already assembled — the very clip "Save all" would have written, cut
 * over the stretch the element actually held (see planSave and src/bridge/write.ts). It goes into
 * the snapshot whole and unopened, and what is described here is where its movie box lies inside
 * it; the editor reads the sample tables out of that and never asks the network for anything.
 *
 * Copying the material rather than remembering where it came from is the point of a snapshot: the
 * editor tab outlives the page it was opened from, and an address on somebody's CDN does not —
 * signed URLs expire, sessions end, nodes go away. It costs one read of what the popup already
 * promised to save, made once, on a click.
 *
 * One track and not one per stream: a file states its tracks in one movie box and its samples in
 * one `mdat`, so the picture and the sound are the same material here — which is exactly the
 * shape a muxed init has on the captured path, and the reader treats them alike.
 *
 * null when the assembled bytes hold no movie box or no readable track. Nothing but a defect in
 * our own writer produces that, and it is answered rather than thrown: a freeze that cannot
 * describe what it wrote must refuse instead of writing a snapshot no editor can open.
 */
export function fileSnapshotSourceOf(
  session: Session,
  file: Uint8Array,
  duration: number,
): SnapshotSource | null {
  const moov = topLevelBoxes(file).find((box) => box.type === 'moov')
  const info = parseInit(file)
  if (!moov || !info) return null

  return {
    page: snapshotPageOf(session),
    tracks: [
      {
        id: 't0',
        // No SourceBuffer ever existed to name: the browser fetched this file itself and the
        // extension saw not one byte of it go by.
        bufferId: 'file',
        representation: `file:${info.tracks.map((track) => track.codec).join('+')}`,
        kinds: [...new Set(info.tracks.map((track) => track.kind))],
        info,
        initBytes: file,
        movie: { at: moov.start, length: moov.size },
        // One stretch, from zero: the cut that assembled this file already joined every buffered
        // run, so what came out is continuous from end to end and its own clock starts at its
        // first frame.
        chunks: [{ start: 0, end: duration, bytes: NO_SEGMENT }],
      },
    ],
  }
}
