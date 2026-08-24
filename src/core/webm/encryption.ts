import {
  ID,
  childElements,
  childWithId,
  childrenWithId,
  elementBody,
  readUint,
  segmentLevel,
} from './reader'

/** ContentEncodingType: zero is compression, one is encryption. Absent means compression. */
const ENCRYPTION = 1

/**
 * Whether a WebM init segment declares an encrypted track.
 *
 * Matroska says it in the track itself: a ContentEncoding of type one, and the ContentEncryption
 * that describes the scheme. The counterpart of the ISO BMFF reading next door, and narrower than
 * it by the nature of the container — a Matroska block carries its encryption in a signal byte in
 * front of every frame, which cannot be told from the frame itself without knowing the track it
 * belongs to. So the declaration in the Tracks is the whole of the evidence here, and the
 * fragments say nothing.
 *
 * Compression is read out of the same place and is not protection: header stripping is the
 * ordinary thing for a Matroska track to do, and calling it DRM would cost a page its recording.
 */
export function webmEncrypted(data: Uint8Array): boolean {
  const tracks = segmentLevel(data).find((e) => e.id === ID.tracks)
  if (!tracks) return false

  for (const entry of childElements(data, tracks)) {
    if (entry.id !== ID.trackEntry) continue

    const encodings = childWithId(data, entry, ID.contentEncodings)
    if (!encodings) continue

    for (const encoding of childrenWithId(data, encodings, ID.contentEncoding)) {
      if (childWithId(data, encoding, ID.contentEncryption)) return true

      const type = childWithId(data, encoding, ID.contentEncodingType)
      if (type && readUint(elementBody(data, type)) === ENCRYPTION) return true
    }
  }

  return false
}
