export type TrackKind = 'video' | 'audio'

export interface TrackInfo {
  trackId: number
  kind: TrackKind
  /** тактов в секунде для времён этой дорожки */
  timescale: number
  /** четырёхбуквенный код формата из stsd: avc1, hev1, vp09, mp4a */
  codec: string
  width: number
  height: number
}

export interface InitInfo {
  tracks: TrackInfo[]
}

export interface FragmentInfo {
  trackId: number
  /** начало фрагмента в тактах дорожки */
  baseMediaDecodeTime: number
  /** длительность фрагмента в тактах дорожки */
  duration: number
}

/** Кусок медиаданных, уложенный на шкалу времени в секундах. */
export interface Chunk {
  start: number
  end: number
  bytes: Uint8Array
}

/** Непрерывный участок без разрывов. */
export interface Run {
  start: number
  end: number
  chunks: Chunk[]
}
