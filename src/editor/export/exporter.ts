import type { Clip } from '../../core/edit/clip'
import { fileNameOf, uniqueNames } from '../../core/export/naming'
import { planClip, type ClipSource, type ExportPlan } from '../../core/export/plan'
import {
  clipSourceFrom,
  clipSourceOf,
  movieTracksOf,
  type SourceTrackInput,
} from '../../core/export/source'
import type { ExportIo, ExportRequest } from '../../core/export/run'
import type { Material, MaterialTrack } from '../../core/snapshot/material'
import type { SnapshotReader } from '../../core/snapshot/read'
import type { TrackKind } from '../../shared/types'

/**
 * How long a blob address lives after a download starts. Chrome does not read it at once, and an
 * address revoked straight after the call cuts an already started download off halfway. The
 * bridge waits exactly as long, for exactly this reason.
 */
const REVOKE_DELAY_MS = 60_000

async function inputOf(
  reader: SnapshotReader,
  track: MaterialTrack,
  kind: TrackKind,
): Promise<SourceTrackInput> {
  const chunks = track.runs.flatMap((run) => run.chunks)
  const [initBytes, segments] = await Promise.all([
    reader.bytesOf(track.track.init),
    // One read per run: the chunks of a track lie next to each other in the snapshot.
    reader.bytesOfMany(chunks.map((chunk) => chunk.source)),
  ])

  return {
    kind,
    initBytes,
    segments: segments.map((bytes, at) => ({ bytes, at: chunks[at]!.source })),
  }
}

/**
 * The sample index of the recording, built once when the tab opens.
 *
 * The segments are read to be parsed and then let go: what stays is a `Located` per sample, a few
 * thousand numbers against a hundred megabytes of frames. The reading is the same one the preview
 * already does (Task 6) and costs the same tens of milliseconds; reading only the heads of the
 * segments would be cheaper still, and it would change this function and nothing else.
 */
export async function openClipSource(
  reader: SnapshotReader,
  material: Material,
): Promise<ClipSource | null> {
  // Material that was never intercepted, held in the snapshot as the file it arrived in (§5.6).
  // There are no fragments to walk: `init` names the movie box inside that range, and the sample
  // tables have been in the snapshot all along. Reading them is one read of a few kilobytes, and
  // the addresses that come back point into the snapshot — the same ones the preview cuts by, so
  // the Export button and the picture in the tab still cannot come out differently.
  const lead = material.video ?? material.audio
  const whole = lead?.track.whole
  if (lead && whole) {
    const moov = await reader.bytesOf(lead.track.init)
    return clipSourceFrom(movieTracksOf(moov, whole.length, whole.at))
  }

  const inputs: SourceTrackInput[] = []

  if (material.video) {
    const input = await inputOf(reader, material.video, 'video')
    inputs.push(input)
    // A muxed init puts both kinds into one buffer: the sound is in these very segments under a
    // track number of its own, and reading them a second time would double the peak for nothing.
    if (!material.audio && material.video.kinds.includes('audio')) {
      inputs.push({ ...input, kind: 'audio' })
    }
  }

  if (material.audio) inputs.push(await inputOf(reader, material.audio, 'audio'))

  return clipSourceOf(inputs)
}

/** What one clip would be written as — the same plan the export runs, so the estimate cannot lie. */
export function planOf(source: ClipSource, clip: Clip): ExportPlan {
  return planClip(source, { in: clip.in, out: clip.out, sound: clip.sound })
}

export function requestsFor(source: ClipSource, clips: readonly Clip[]): ExportRequest[] {
  const names = uniqueNames(clips.map(fileNameOf))

  return clips.map((clip, at) => ({
    clipId: clip.id,
    name: clip.name,
    fileName: names[at]!,
    plan: planOf(source, clip),
  }))
}

/** What the settings and the recording have to say about where a clip goes. */
export interface SaveOptions {
  /** §9.4: put the browser's own Save dialogue up for every clip. */
  askWhere?: boolean
  /**
   * Called once the browser has taken a file, and not before.
   *
   * A recording that was cut from is a recording the user chose (§7.3), and the editor is the
   * only place that knows a clip came out of one. A refusal is not a choice, so this is not
   * called on the path that rejects.
   */
  onSaved?: () => void
}

/** The snapshot for reading and Chrome for writing: the only two places the editor touches. */
export function downloadIo(reader: SnapshotReader, options: SaveOptions = {}): ExportIo {
  const askWhere = options.askWhere ?? false

  return {
    read: (at) => reader.bytesOf(at),

    save: (file, name) =>
      new Promise((resolve, reject) => {
        // A Blob takes a view over a plain ArrayBuffer; the writer allocates its own, and it is
        // never shared.
        const url = URL.createObjectURL(
          new Blob([file as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }),
        )

        chrome.downloads.download(
          {
            url,
            filename: name,
            conflictAction: 'uniquify',
            // §9.4: ask where each clip goes. Off by default — a queue of six clips would be six
            // dialogues — and worth having for the person who files as they cut.
            saveAs: askWhere,
          },
          (id) => {
            const failed = id === undefined
            // The failure has to be read, or Chrome writes about it to the console itself.
            if (failed) void chrome.runtime.lastError

            setTimeout(() => URL.revokeObjectURL(url), failed ? 0 : REVOKE_DELAY_MS)
            if (failed) {
              reject(new Error('The browser refused to save the file.'))
              return
            }
            options.onSaved?.()
            resolve()
          },
        )
      }),
  }
}
