import { buildProgressiveMp4, type OutSample } from '../iso/progressive'
import type { PlannedTrack } from '../export/plan'
import type { Located } from '../../shared/types'

/** The picture as the encoder gave it back: bytes in hand, already in decode order. */
export interface EncodedVideo {
  /** 'avc1' or 'hvc1' — the entry `codedSampleEntry` was asked to write. */
  sampleEntry: Uint8Array
  width: number
  height: number
  timescale: number
  samples: OutSample[]
}

/**
 * The file: a picture this program encoded, and the sound it did not touch.
 *
 * There is no edit list on the picture and there is one on the sound, and that asymmetry is the
 * whole synchronisation story. The picture's head was not hidden, it was not encoded — the frames
 * before the entry point are simply absent — so its presentation zero *is* the entry point. The
 * sound still holds its warm-up packets and its own priming, so its edit hides exactly as much as
 * it did on the copy path. Both tracks therefore begin at the same instant, and neither was moved
 * to make it so.
 */
export function assembleEncoded(
  video: EncodedVideo,
  audio: { track: PlannedTrack; bytesOf: (at: Located) => Uint8Array } | null,
): Uint8Array {
  return buildProgressiveMp4([
    {
      trackId: 1,
      kind: 'video',
      timescale: video.timescale,
      sampleEntry: video.sampleEntry,
      width: video.width,
      height: video.height,
      samples: video.samples,
      skipTicks: 0,
    },
    ...(audio
      ? [
          {
            trackId: 2,
            kind: 'audio' as const,
            timescale: audio.track.timescale,
            sampleEntry: audio.track.sampleEntry,
            width: 0,
            height: 0,
            samples: audio.track.samples.map((sample) => ({
              bytes: audio.bytesOf(sample.source),
              duration: sample.duration,
              cts: sample.cts,
              sync: sample.sync,
            })),
            skipTicks: audio.track.skipTicks,
            ...(audio.track.delayTicks === undefined
              ? {}
              : { delayTicks: audio.track.delayTicks }),
          },
        ]
      : []),
  ])
}
