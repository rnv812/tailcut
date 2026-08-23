import { parseFragment } from '../core/iso/fragment'
import { ingestInit, type IngestedInit, type SegmentConverter } from '../core/container'
import { SegmentStream } from '../core/stream'
import { PtsMap } from '../core/timeline/map'
import { normalizeUrl, sessionKey } from '../core/session-key'
import type { MuxTrack } from '../core/mux'
import type { Omission } from '../shared/protocol'
import type { Chunk, InitInfo, TrackKind } from '../shared/types'

/**
 * One SourceBuffer of a media source: its own init segment, its own timescale, its own map of
 * media time. MSE hands video and audio to separate buffers, so in the usual case a track here
 * is exactly one media track; a muxed init puts several ISO tracks into one buffer, and then
 * one track carries both kinds — the segments of such a buffer are shared by them anyway.
 *
 * A track is also a representation in the sense of the design (§6.2): a new init on the same
 * buffer with different codecs or a different frame size opens a track of its own instead of
 * spoiling the material already collected under the previous one.
 */
export interface Track {
  /** SourceBuffer the stream came from. Unique inside its media source, not across the page. */
  bufferId: string
  /** Identity of the representation inside the session — see representationOf(). */
  representation: string
  /** Media kinds this buffer carries: one of them normally, both for a muxed init. */
  kinds: TrackKind[]
  /** ftyp and moov of the track, in ISO BMFF whatever container the page delivered it in. */
  initBytes: Uint8Array
  info: InitInfo
  map: PtsMap
  /**
   * Set on a track that did not arrive in ISO BMFF: turns each of its media segments into one.
   * Handed over by ingestInit, which is the one place a second container is spoken of. Absent on
   * an mp4 track, whose segments are already what a file is built of.
   */
  convert?: SegmentConverter
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
   * Every codec this source has ever opened, in the order they appeared. The merge key is built
   * of all of them, so it describes the video as a whole and not the init that came last.
   */
  codecs: string[]
  /**
   * One of this source's buffers declared a track that could not be taken in. Remembered on the
   * source because the refusal usually comes before there is a session to remember it on: the
   * picture buffer opens first and the sound buffer, the one that ends up creating the session,
   * a moment later.
   */
  refused: boolean
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

/** A stretch of media time. */
interface Span {
  start: number
  end: number
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
function omissionsOf(session: Session, chosen: Track[], stretches: Span[]): Omission[] {
  const omitted: Omission[] = []

  if (session.refusedTracks) omitted.push('track')
  // Only a rendition that holds something is a loss. A second init with no fragment under it
  // costs the file nothing, and warning about it would be a warning about every quality switch
  // the moment it happens.
  const dropped = session.tracks.some((t) => !chosen.includes(t) && t.map.duration() > 0)
  if (dropped) omitted.push('rendition')
  if (stretches.length > 1) omitted.push('gap')

  return omitted
}

/** What a save of this session would write, and what it would leave behind. */
export interface SavePlan {
  /** The streams of the file, in the order the muxer writes them: the picture first. */
  material: MuxTrack[]
  /** Length of the clip in seconds: the stretch its material was chosen over. */
  duration: number
  /** Weight of the media data that goes into it; the boxes around it are a kilobyte or two. */
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
    material,
    duration: longest ? lengthOf(picked, longest) : 0,
    bytes,
    omitted: omissionsOf(session, chosen, stretches),
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

/** The material a saved file is built out of. */
export function selectMaterial(session: Session): MuxTrack[] {
  return planSave(session).material
}

/**
 * A chunk out of an ISO BMFF media segment. The bytes travel on as they arrived: a captured
 * segment is already what a saved file is assembled from.
 */
function isoChunk(track: Track, bytes: Uint8Array): Chunk | null {
  const fragment = parseFragment(bytes)
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

export class SessionStore {
  private sessions = new Map<string, StoredSession>()
  /** What each MediaSource of the page feeds, and where. */
  private sources = new Map<string, SourceState>()
  /** sourceId and bufferId → the byte stream that SourceBuffer is being fed, half-read. */
  private streams = new Map<string, SegmentStream>()
  /** Rejected sources: their bytes are not kept while the verdict stands. */
  private rejected = new Set<string>()

  /**
   * Takes what a page appended to one of its SourceBuffers and works out for itself what it is.
   * The store is fed from a foreign page, so no parse here is allowed to throw: a piece it cannot
   * make sense of is dropped silently.
   *
   * What arrives is a piece of a byte stream and not necessarily a segment — see
   * src/core/stream.ts — so the segments are recovered first, and only whole ones are read.
   */
  append(input: AppendInput): void {
    // The MAIN world hook knows nothing about verdicts and copies to the last: triage lives here.
    // A rejection works forwards as well as backwards — otherwise a banner that got one before
    // its first segment would open a session right after it.
    if (this.rejected.has(input.sourceId)) return

    for (const unit of this.streamOf(input).push(input.bytes)) {
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
   * One media segment onto the map of the track it belongs to. Which container it is written in
   * was settled when the init of its buffer arrived: the track is found first and the bytes read
   * second, through whichever reading its own buffer was opened with.
   *
   * A segment before its init is a normal thing: the page may have started playing before the
   * bridge stood up. There is nowhere to put it, and that is not an error.
   */
  private take(input: AppendInput, bytes: Uint8Array): void {
    const found = this.locate(input)
    if (!found) return

    const { session, track } = found
    const chunk = track.convert ? convertedChunk(track.convert, bytes) : isoChunk(track, bytes)
    if (!chunk) return

    // The map is per buffer, so the deduplication rule of PtsMap ("the same start means the same
    // piece") compares only segments of one stream, as it was meant to. Inside one buffer two
    // appends with the same start really are one segment appended twice: a muxed segment carries
    // all of its tracks in one call.
    track.map.insert(chunk)
    session.lastSeenAt = input.now
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
   * The page has learned its own title, and the sessions already opened on it take it on.
   *
   * A session is signed with the title of the moment its first init segment arrived, and on a
   * single-page application that moment comes before the title does: recording starts at
   * document_start, where <head> is not parsed yet, and the next video of the feed is loaded
   * without a navigation at all. Without this the file would be saved under the name of nothing.
   *
   * Only the sessions of that very address are touched, and the address is compared the way the
   * merge key compares it — through the referral marks. A page that has moved on to another video
   * keeps the previous one titled as it was: the material is that video's, and so is its name.
   */
  retitle(url: string, title: string): void {
    // An empty title is not news but the absence of it: a page that has not filled in its <title>
    // yet, or a frame that never will. Erasing a name we already have for it would be a loss.
    if (!title) return

    const normalized = normalizeUrl(url)
    for (const session of this.sessions.values()) {
      if (normalizeUrl(session.url) === normalized) session.title = title
    }
  }

  evictAll(windowSeconds: number, currentTime: number): void {
    for (const session of this.sessions.values()) {
      for (const track of session.tracks) track.map.evict(windowSeconds, currentTime)
    }
  }

  /**
   * Triage: the source is deemed junk. What it collected is erased unless the session has been
   * confirmed or someone else is still feeding it; a confirmed session survives the rejection —
   * recording simply freezes (a pause, a hidden tab, the element leaving the screen) and what has
   * been collected stays.
   */
  dropPending(sourceId: string): void {
    this.rejected.add(sourceId)

    const source = this.sources.get(sourceId)
    if (!source) return

    const session = this.sessions.get(source.key)
    if (session?.confirmed) return

    this.sources.delete(sourceId)
    // The half-read segments of its buffers go with it: nobody will finish them now, and they
    // would be assembled onto a track that no longer exists.
    for (const key of this.streams.keys()) {
      if (key.startsWith(`${sourceId}\u0000`)) this.streams.delete(key)
    }
    if (!session) return

    // The verdict is addressed: a session that a neighbouring source is also feeding stays. The
    // key is built from the page address and the codecs, so a banner and the real player next to
    // it may well share one, and erasing the session would kill the neighbour's recording.
    session.sources.delete(sourceId)
    if (session.sources.size === 0) this.sessions.delete(session.key)
  }

  /** Probation served: a rejection of this source no longer erases its session. */
  promotePending(sourceId: string): void {
    this.rejected.delete(sourceId)

    const source = this.sources.get(sourceId)
    if (!source) return

    const session = this.sessions.get(source.key)
    if (session) session.confirmed = true
  }

  /** A hold after a rejection: the source is recorded again but has not earned its life yet. */
  resumePending(sourceId: string): void {
    this.rejected.delete(sourceId)
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

    const session = this.bind(source, input)
    session.lastSeenAt = input.now
    // A buffer refused before this one was opened: the loss is the session's from the moment it
    // has one.
    if (source.refused) session.refusedTracks = true

    // The representation is already known: this is a reload, a return to the previous quality or
    // simply a repeated init. The session keeps the init it was opened with — the material
    // already on the map was collected under it.
    if (session.tracks.some((t) => t.representation === representation)) return

    session.tracks.push({
      bufferId: input.bufferId,
      representation,
      kinds: kindsOf(info),
      initBytes: opened.initBytes,
      info,
      map: new PtsMap(),
      convert: opened.convert ?? undefined,
    })
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
      source = { key: '', url: '', buffers: new Map(), codecs: [], refused: false }
      this.sources.set(input.sourceId, source)
    }

    const url = normalizeUrl(input.url)
    if (source.url !== url) {
      source.url = url
      source.key = ''
      source.codecs = []
      source.buffers.clear()
      source.refused = false
    }

    return source
  }

  /**
   * Puts the source under the key its tracks add up to, and returns the session it now feeds.
   * The key is recomputed on every init, because a source learns about its own tracks one at a
   * time: the video buffer opens first and the audio one a moment later, and only together do
   * they describe the video.
   */
  private bind(source: SourceState, input: AppendInput): StoredSession {
    const key = sessionKey({
      url: input.url,
      codecs: source.codecs,
      durationSeconds: Infinity,
    })

    const previous = this.sessions.get(source.key)
    if (previous && previous.key === key) return previous

    source.key = key
    previous?.sources.delete(input.sourceId)
    // Nobody else is feeding the old session: it does not split, it simply becomes known under
    // the wider key together with everything it has collected.
    const alone = previous !== undefined && previous.sources.size === 0

    const target = this.sessions.get(key)

    if (!target) {
      if (previous && alone) {
        this.sessions.delete(previous.key)
        previous.key = key
        previous.sources.add(input.sourceId)
        this.sessions.set(key, previous)
        return previous
      }

      const created = this.createSession(key, input)
      if (previous) carryRepresentations(previous, created, source)
      created.sources.add(input.sourceId)
      this.sessions.set(key, created)
      return created
    }

    target.sources.add(input.sourceId)
    if (previous && alone) {
      absorb(target, previous)
      this.sessions.delete(previous.key)
    } else if (previous) {
      carryRepresentations(previous, target, source)
    }
    return target
  }

  private createSession(key: string, input: AppendInput): StoredSession {
    return {
      key,
      url: input.url,
      title: input.title,
      tracks: [],
      createdAt: input.now,
      lastSeenAt: input.now,
      refusedTracks: false,
      sources: new Set(),
      confirmed: false,
    }
  }

  private locate(input: AppendInput): { session: StoredSession; track: Track } | undefined {
    const source = this.sources.get(input.sourceId)
    if (!source) return

    // A buffer whose init never arrived: a second player on the page whose beginning we missed,
    // or a stream in a container the parser does not read. Dumping its segments into a
    // neighbouring track would mix two streams into one map.
    const representation = source.buffers.get(input.bufferId)
    if (representation === undefined) return

    const session = this.sessions.get(source.key)
    if (!session) return

    const track = session.tracks.find((t) => t.representation === representation)
    if (!track) return

    return { session, track }
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

/**
 * The source moves to another session while its old one keeps living on other sources: their
 * material is common and cannot be untangled, so it stays where it is and the source starts
 * collecting the same representations anew. Only the init segments are carried over — without
 * them the buffers whose init has already passed would have nowhere to append until the next one.
 */
function carryRepresentations(from: Session, to: Session, source: SourceState): void {
  for (const representation of source.buffers.values()) {
    if (to.tracks.some((t) => t.representation === representation)) continue
    const track = from.tracks.find((t) => t.representation === representation)
    if (track) to.tracks.push({ ...track, map: new PtsMap() })
  }
}
