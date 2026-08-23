import { parseInit } from '../core/iso/init'
import { parseFragment } from '../core/iso/fragment'
import { continuesRun, PtsMap } from '../core/timeline/map'
import { normalizeUrl, sessionKey } from '../core/session-key'
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
  initBytes: Uint8Array
  info: InitInfo
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
}

export interface AppendInput {
  sourceId: string
  /** Which SourceBuffer of that source the bytes were appended to. */
  bufferId: string
  url: string
  title: string
  bytes: Uint8Array
  now: number
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

/** Joins overlapping and touching spans; a gap within the tolerance is rounding, not a gap. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const merged: Span[] = []

  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last && continuesRun(last.end, span.start)) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }

  return merged
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

/** Time covered by one media kind: the union of the runs of every track that carries it. */
function coverageOf(session: Session, kind: TrackKind): Span[] {
  const spans: Span[] = []

  for (const track of session.tracks) {
    if (!track.kinds.includes(kind)) continue
    for (const run of track.map.runs()) spans.push({ start: run.start, end: run.end })
  }

  return mergeSpans(spans)
}

/**
 * What the session amounts to for the popup and the badge.
 *
 * The length is the part of the timeline where **every** kind is present — the intersection of
 * the tracks, not their sum and not the longest of them. That is the only number that answers
 * the question the popup is asked: how much can be cut out right now. A sum would count the same
 * six seconds twice over the two tracks and promise twelve; the maximum would promise the tail of
 * the audio track, where there is no picture to go with it. Both would show material a clip
 * cannot be made of.
 *
 * Within one kind the representations are united rather than intersected: after a switch of
 * quality the picture of the first half comes from one of them and of the second half from the
 * other, and the material is there either way. Intersecting them would report an empty
 * intersection of two halves and turn a full recording into "0:00".
 *
 * A kind that has an init but not a single fragment yet leaves the intersection empty, and this
 * is honest: a clip with a silent track is not what the user asked for. It lasts as long as the
 * gap between the init of the second buffer and its first segment.
 *
 * Runs are counted on the same intersection: they are the pieces that can actually be cut whole.
 * Gaps and runs of a single track stay the property of that track and live on its own map.
 */
export function summarize(session: Session): { duration: number; bytes: number; runs: number } {
  let bytes = 0
  for (const track of session.tracks) bytes += track.map.totalBytes()

  const kinds: TrackKind[] = []
  for (const track of session.tracks) {
    for (const kind of track.kinds) if (!kinds.includes(kind)) kinds.push(kind)
  }

  let available: Span[] = []
  for (const [index, kind] of kinds.entries()) {
    const coverage = coverageOf(session, kind)
    available = index === 0 ? coverage : mergeSpans(intersectSpans(available, coverage))
  }

  let duration = 0
  for (const span of available) duration += span.end - span.start

  return { duration, bytes, runs: available.length }
}

export class SessionStore {
  private sessions = new Map<string, StoredSession>()
  /** What each MediaSource of the page feeds, and where. */
  private sources = new Map<string, SourceState>()
  /** Rejected sources: their bytes are not kept while the verdict stands. */
  private rejected = new Set<string>()

  /**
   * Parses the incoming bytes and works out for itself what they are. The store is fed from a
   * foreign page, so no parse here is allowed to throw: a piece it cannot make sense of is
   * dropped silently.
   */
  append(input: AppendInput): void {
    // The MAIN world hook knows nothing about verdicts and copies to the last: triage lives here.
    // A rejection works forwards as well as backwards — otherwise a banner that got one before
    // its first segment would open a session right after it.
    if (this.rejected.has(input.sourceId)) return

    const info = parseInit(input.bytes)

    if (info) {
      this.openTrack(input, info)
      return
    }

    const fragment = parseFragment(input.bytes)
    if (!fragment) return

    // A fragment before its init is a normal thing: the page may have started playing before the
    // bridge stood up. There is nowhere to put it, and that is not an error.
    const found = this.locate(input)
    if (!found) return

    const { session, track } = found

    // Tracks inside a moof are marked with the trackId from the init; on a single-track stream
    // players occasionally put something of their own there, hence the fallback to the first
    // track of this very buffer. The choice is made among the tracks of the buffer the bytes came
    // from, so the timescale is always the one these ticks were counted in.
    const declared =
      track.info.tracks.find((t) => t.trackId === fragment.trackId) ?? track.info.tracks[0]
    if (!declared) return

    // Ticks are turned into seconds by dividing by the timescale, and a broken init sometimes has
    // it at zero. Substituting one for the zero would invent times (ticks would go into seconds
    // one to one), and counting as is would put a chunk with NaN boundaries on the map: it counts
    // as neither empty nor overlapping, and the NaN would spread from there across the whole
    // popup summary. Such a fragment has no time at all.
    if (!(declared.timescale > 0)) return

    const start = fragment.baseMediaDecodeTime / declared.timescale
    const chunk: Chunk = {
      start,
      end: start + fragment.duration / declared.timescale,
      bytes: input.bytes,
    }

    // The map is per buffer, so the deduplication rule of PtsMap ("the same start means the same
    // piece") compares only segments of one stream, as it was meant to. Inside one buffer two
    // appends with the same start really are one segment appended twice: a muxed segment carries
    // all of its tracks in one call.
    track.map.insert(chunk)
    session.lastSeenAt = input.now
  }

  get(key: string): Session | undefined {
    return this.sessions.get(key)
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
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
  private openTrack(input: AppendInput, info: InitInfo): void {
    const source = this.sourceState(input.sourceId)
    const url = normalizeUrl(input.url)

    // The page moved on to another video without letting go of its MediaSource — a feed of short
    // clips does exactly that. What the source collected belongs to the previous video and stays
    // in its session; here the source starts from scratch.
    if (source.url !== url) {
      source.url = url
      source.key = ''
      source.codecs = []
      source.buffers.clear()
    }

    const representation = representationOf(info)

    source.buffers.set(input.bufferId, representation)
    for (const track of info.tracks) {
      if (!source.codecs.includes(track.codec)) source.codecs.push(track.codec)
    }

    const session = this.bind(source, input)
    session.lastSeenAt = input.now

    // The representation is already known: this is a reload, a return to the previous quality or
    // simply a repeated init. The session keeps the init it was opened with — the material
    // already on the map was collected under it.
    if (session.tracks.some((t) => t.representation === representation)) return

    session.tracks.push({
      bufferId: input.bufferId,
      representation,
      kinds: kindsOf(info),
      initBytes: input.bytes,
      info,
      map: new PtsMap(),
    })
  }

  private sourceState(sourceId: string): SourceState {
    let source = this.sources.get(sourceId)
    if (!source) {
      source = { key: '', url: '', buffers: new Map(), codecs: [] }
      this.sources.set(sourceId, source)
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
