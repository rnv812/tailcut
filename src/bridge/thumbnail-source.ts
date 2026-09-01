import type { Session } from './session-store'
import { planSave } from './session-store'
import { ByteMap, sourceTrackOf } from '../core/export/source'
import type { PlannedTrack, SourceTrack } from '../core/export/plan'
import type { ThumbnailSource } from '../core/thumbnail'
import type { Located } from '../shared/types'

type ByteReader = (at: Located) => Promise<Uint8Array>

/** Restricts the reader to bytes that belong to one of the selected picture samples. */
function boundedSource(video: SourceTrack, read: ByteReader): ThumbnailSource {
  return {
    video,
    async read(at) {
      const end = at.at + at.length
      const belongs = video.samples.some((sample) => {
        const sampleEnd = sample.source.at + sample.source.length
        return at.at >= sample.source.at && end <= sampleEnd
      })
      if (!(at.length > 0) || !Number.isSafeInteger(end) || !belongs) {
        throw new RangeError('thumbnail read lies outside the selected picture samples')
      }

      const bytes = await read(at)
      if (bytes.byteLength < at.length) {
        throw new RangeError('thumbnail read ended before the selected picture sample')
      }
      return bytes.byteLength === at.length ? bytes : bytes.subarray(0, at.length)
    },
  }
}

function capturedSourceOf(session: Session): ThumbnailSource | null {
  const save = planSave(session)
  if (save.source.kind !== 'captured') return null

  const map = new ByteMap()
  for (const material of save.source.tracks) {
    const video = sourceTrackOf({
      kind: 'video',
      initBytes: material.initBytes,
      segments: material.segments.map((bytes, index) => ({
        bytes,
        at: map.place(bytes),
        ...(material.timestampOffsets
          ? { timestampOffset: material.timestampOffsets[index] ?? 0 }
          : {}),
      })),
    })
    if (video) return boundedSource(video, async (at) => map.bytesOf(at))
  }

  return null
}

/** Restores the implicit decode clock of the picture track already planned by `cutPlain`. */
function sourceTrackFromPlanned(track: PlannedTrack): SourceTrack {
  let dts = 0
  return {
    kind: track.kind,
    timescale: track.timescale,
    sampleEntry: track.sampleEntry,
    width: track.width,
    height: track.height,
    editOffset: track.skipTicks,
    samples: track.samples.map((sample) => {
      const located = {
        dts,
        pts: dts + sample.cts,
        duration: sample.duration,
        sync: sample.sync,
        source: sample.source,
      }
      dts += sample.duration
      return located
    }),
    dropped: 0,
  }
}

function plainSourceOf(session: Session): ThumbnailSource | null {
  const save = planSave(session)
  if (save.source.kind !== 'plain') return null

  const planned = save.source.plan.tracks.find((track) => track.kind === 'video')
  if (!planned?.samples.length) return null

  const video = sourceTrackFromPlanned(planned)
  const read = save.source.read
  return boundedSource(video, async (at) => {
    const answer = await read(at.at, at.length)
    return answer.bytes
  })
}

/**
 * The picture material a lazy popup thumbnail may read, without any browser or protocol work.
 * Selection is delegated to the same save plan used by Save all, so a thumbnail cannot advertise
 * another rendition or an unwatched part of an ordinary file.
 */
export function thumbnailSourceOf(session: Session): ThumbnailSource | null {
  return session.plain ? plainSourceOf(session) : capturedSourceOf(session)
}
