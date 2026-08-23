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
