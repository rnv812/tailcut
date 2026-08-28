import { mpegSampleEntry } from '../mpeg/mp4'
import type { MpegWalk } from '../mpeg/frames'
import type { SourceTrack } from './plan'

/**
 * A walked MPEG audio stream as a track to cut from.
 *
 * The third road into the same `SourceTrack` the rest of the program cuts and writes: an mp4
 * states its samples in the tables of a movie box (`movieTracksOf`), a Matroska in the block
 * header in front of every frame (`matroskaFileOf`), and a bare elementary stream in the four
 * bytes at the front of every frame and nowhere else (`walkMpegFrames`). What comes out here is
 * indistinguishable from the other two, which is what lets one plan, one writer and one editor
 * serve all three.
 *
 * The times are exact by construction. The timescale is the sampling rate itself and every frame
 * is a whole number of samples, so a frame boundary is a tick boundary and nothing anywhere is
 * rounded — which matters more here than elsewhere, because this track is laid beside a picture
 * out of another file and a rounding would be a drift between them.
 *
 * null when the walk found no frame: an address that answered with something that is not an
 * elementary stream, or a file of nothing but an ID3 tag.
 */
export function mpegSoundOf(walk: MpegWalk): SourceTrack | null {
  if (!walk.frames.length || !(walk.sampleRate > 0)) return null

  let at = 0
  const samples = walk.frames.map((frame) => {
    const dts = at
    at += frame.samples

    return {
      dts,
      // Sound is never reordered: a frame is shown where it is decoded, and every one of them
      // can be decoded on its own — an MP3 frame carries its own bit reservoir or does without.
      pts: dts,
      duration: frame.samples,
      sync: true,
      source: frame.source,
    }
  })

  return {
    kind: 'audio',
    timescale: walk.sampleRate,
    sampleEntry: mpegSampleEntry({
      version: walk.version,
      channels: walk.channels,
      sampleRate: walk.sampleRate,
    }),
    width: 0,
    height: 0,
    // The silence the encoder left at the head, hidden the way an mp4 hides AAC priming and Opus
    // pre-skip: the samples are decoded and the presentation starts behind them. It is stated in
    // the header frame of the stream rather than in a container, and measured on the fixture it
    // is 1105 samples — 25.1 ms, which is how far the sound would sit from the picture it was cut
    // against if this were left at zero.
    editOffset: walk.skipSamples,
    samples,
    // Nothing was walked twice: a file is a chain of frames read once from its front.
    dropped: 0,
  }
}
