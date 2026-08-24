export type TrackKind = 'video' | 'audio'

export interface TrackInfo {
  trackId: number
  kind: TrackKind
  /** ticks per second for the times of this track */
  timescale: number
  /**
   * Format of the track as its container names it: the four-letter code from the ISO BMFF stsd —
   * avc1, hev1, vp09, mp4a — or, in WebM, the CodecID verbatim: V_VP9, A_OPUS.
   */
  codec: string
  width: number
  height: number
  /**
   * Codec setup bytes the container keeps beside the track: the Matroska CodecPrivate, which for
   * Opus is the OpusHead. ISO BMFF holds the same thing inside the sample entry of the init
   * segment, which travels whole, so the ISO reader leaves this unset.
   */
  codecPrivate?: Uint8Array
  /** Audio only: channel count as the container declares it. */
  channels?: number
  /** Audio only: sampling rate in hertz as the container declares it. */
  sampleRate?: number
  /**
   * ISO BMFF only: how long one sample of this track lasts, in its own ticks, as the `trex` of
   * the movie header states it. Zero when the movie states nothing.
   *
   * It belongs to the init segment and is read out of it because a media segment may state
   * nothing at all about the length of its samples, and then this is the only thing that does.
   * 14496-12 §8.8.3 gives a packager three places to say it — the `trun` per sample, the `tfhd`
   * per fragment, this per movie — and a reader has to fall through all three. Measured on
   * dzen.ru: the picture states it here and nowhere else, and read as absent every fragment
   * measured out as an instant.
   *
   * Absent on a track that did not arrive in ISO BMFF: Matroska has no such field.
   */
  defaultSampleDuration?: number
}

export interface InitInfo {
  tracks: TrackInfo[]
}

export interface FragmentInfo {
  trackId: number
  /** start of the fragment in ticks of the track */
  baseMediaDecodeTime: number
  /** length of the fragment in ticks of the track */
  duration: number
}

/** A piece of media data laid on a timeline measured in seconds. */
export interface Chunk {
  start: number
  end: number
  bytes: Uint8Array
}

/** A continuous stretch with no gaps in it. */
export interface Run {
  start: number
  end: number
  chunks: Chunk[]
}

/**
 * A complete piece of a media byte stream, cut out of the run of appends a page makes.
 *
 * MSE hands a SourceBuffer a byte stream, not a list of segments: a player is free to pass on the
 * download as it arrives, and YouTube does exactly that — sixteen kilobytes at a time, with every
 * boundary of the container falling in the middle of a call. What the rest of the program works
 * on is the segment, so the two have to be put back together before anything is read out of them.
 */
export interface StreamUnit {
  /** An init segment opens a track; a media segment carries its material. */
  kind: 'init' | 'media'
  /** The unit's bytes, exactly as the stream spelled them. A view, not a copy. */
  bytes: Uint8Array
}

/** What one pass of a splitter made of a buffer. */
export interface Split {
  units: StreamUnit[]
  /** Bytes from the front of the buffer that are now accounted for and need not be kept. */
  consumed: number
}
