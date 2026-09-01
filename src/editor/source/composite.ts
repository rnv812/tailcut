import { FrameTable, type Frame } from '../../core/timeline/frames'
import { continuesRun } from '../../core/timeline/map'
import { seamsOf, soundUnderPicture, type Seam, type SourceTrack } from '../../core/export/plan'
import type { Material, MaterialTrack, PlacedChunk } from '../../core/snapshot/material'

export interface PicturePart {
  track: MaterialTrack
  chunks: PlacedChunk[]
  start: number
  end: number
}

export interface PictureProgram {
  parts: PicturePart[]
  runs: Array<{ start: number; end: number }>
}

export interface PictureFrames {
  trackId: string
  frames: Frame[]
}

export interface AudioMonitorClock {
  /** Audio after the same prefetched-packet and late-seam correction as an exported preview. */
  audio: SourceTrack
  seams: Seam[]
  /** Offset from the recording clock to the monitor clock at this corrected source instant. */
  shiftAt(time: number): number
}

/**
 * The sound clock of a composite monitor, derived by the normal preview policy.
 *
 * A pseudo video track is enough here: `soundUnderPicture` and `seamsOf` inspect presentation
 * coverage and sample durations, not codec bytes. Using the actual composite frame table keeps
 * the late-audio tolerance tied to the picture's real frame duration.
 */
export function audioMonitorClock(
  program: PictureProgram,
  frames: FrameTable,
  audio: SourceTrack,
): AudioMonitorClock {
  const scale = 1_000_000
  const video: SourceTrack = {
    kind: 'video',
    timescale: scale,
    sampleEntry: new Uint8Array(),
    width: 0,
    height: 0,
    editOffset: 0,
    dropped: 0,
    samples: frames.frames().map((frame) => ({
      dts: Math.round(frame.pts * scale),
      pts: Math.round(frame.pts * scale),
      duration: Math.max(1, Math.round(frame.duration * scale)),
      sync: frame.sync,
      source: frame.source,
    })),
  }
  const corrected = soundUnderPicture({ video, audio })
  const fixed = corrected.audio ?? audio
  const seams = seamsOf({ video, audio: fixed })
  const origin = program.runs[0]?.start ?? frames.at(0)?.pts ?? 0

  return {
    audio: fixed,
    seams,
    shiftAt: (time: number) => {
      let pulled = 0
      for (const seam of seams) if (time >= seam.to - 1e-7) pulled += seam.pull
      return -origin - pulled
    },
  }
}

/** The SourceBuffer offset that turns a session timestamp into this monitor's continuous clock. */
export function monitorShift(program: PictureProgram, time: number): number {
  const origin = program.runs[0]?.start ?? 0
  let pulled = 0
  for (let at = 1; at < program.runs.length; at++) {
    const before = program.runs[at - 1]!
    const after = program.runs[at]!
    if (time >= after.start) pulled += after.start - before.end
  }
  return -origin - pulled
}

/**
 * The chronological picture the page showed, across every captured ABR representation.
 *
 * Snapshot track order is representation ownership order: a later init replaces overlapping
 * material of an earlier one. Each track is overlaid whole before the parts are sorted by time;
 * sorting every chunk first would mistake an earlier representation's prefetched tail for a
 * later return and erase the actual successor's tail.
 */
export function pictureProgram(material: Material): PictureProgram {
  const family = material.video?.track.bufferId
  if (!family || material.video?.track.whole) return { parts: [], runs: [] }

  let owned: PicturePart[] = []
  for (const track of material.tracks) {
    if (
      !track.kinds.includes('video') ||
      track.track.whole ||
      track.track.bufferId !== family
    ) continue

    for (const run of track.runs) {
      for (const chunk of run.chunks) {
        const underneath = owned.flatMap((part): PicturePart[] => {
          if (part.end <= chunk.start || part.start >= chunk.end) return [part]
          const pieces: PicturePart[] = []
          if (part.start < chunk.start) pieces.push({ ...part, end: chunk.start })
          if (part.end > chunk.end) pieces.push({ ...part, start: chunk.end })
          return pieces
        })
        owned = [
          ...underneath,
          { track, chunks: [chunk], start: chunk.start, end: chunk.end },
        ]
      }
    }
  }

  owned.sort((a, b) => a.start - b.start || a.end - b.end)

  const parts: PicturePart[] = []
  for (const placed of owned) {
    const last = parts[parts.length - 1]
    if (
      last?.track.track.id === placed.track.track.id && continuesRun(last.end, placed.start)
    ) {
      for (const chunk of placed.chunks) {
        if (!last.chunks.some((known) => known.source.at === chunk.source.at)) last.chunks.push(chunk)
      }
      if (placed.end > last.end) last.end = placed.end
      continue
    }
    parts.push({ ...placed, chunks: [...placed.chunks] })
  }

  const runs: Array<{ start: number; end: number }> = []
  for (const placed of parts) {
    const last = runs[runs.length - 1]
    if (last && continuesRun(last.end, placed.start)) {
      if (placed.end > last.end) last.end = placed.end
    } else {
      runs.push({ start: placed.start, end: placed.end })
    }
  }

  return { parts, runs }
}

const contains = (part: PicturePart, time: number): boolean =>
  time >= part.start - 1e-7 && time < part.end - 1e-7

/** Frames of all ABR parts, retaining session PTS while removing only uncovered monitor holes. */
export function compositeFrames(
  program: PictureProgram,
  sources: readonly PictureFrames[],
): FrameTable {
  const byTrack = new Map<string, Frame[]>()
  for (const source of sources) {
    const known = byTrack.get(source.trackId) ?? []
    known.push(...source.frames)
    byTrack.set(source.trackId, known)
  }

  const owned: Array<{ frame: Frame; part: number }> = []
  for (const [part, stretch] of program.parts.entries()) {
    for (const frame of byTrack.get(stretch.track.track.id) ?? []) {
      if (contains(stretch, frame.pts)) owned.push({ frame, part })
    }
  }
  owned.sort((a, b) => a.frame.pts - b.frame.pts || a.part - b.part)

  // A quality switch commonly overlaps one segment. The part appended later is the one MSE
  // leaves visible at an equal presentation time, so it is the row the monitor table retains.
  const unique: Array<{ frame: Frame; part: number }> = []
  for (const row of owned) {
    const last = unique[unique.length - 1]
    if (last && Math.abs(last.frame.pts - row.frame.pts) < 1e-7) unique[unique.length - 1] = row
    else unique.push(row)
  }

  const frames = unique.map(({ frame }) => ({
    ...frame,
    out: frame.pts + monitorShift(program, frame.pts),
  }))

  return FrameTable.of(frames)
}
