import type { Run } from '../shared/types'

/**
 * Склеивает init-сегмент с медиафрагментами прогона.
 * Результат — fragmented MP4: боксы идут подряд, перегенерация moov не нужна.
 */
export function assembleFragmentedMp4(initBytes: Uint8Array, run: Run): Uint8Array {
  let total = initBytes.byteLength
  for (const chunk of run.chunks) total += chunk.bytes.byteLength

  const out = new Uint8Array(total)
  out.set(initBytes, 0)

  let offset = initBytes.byteLength
  for (const chunk of run.chunks) {
    out.set(chunk.bytes, offset)
    offset += chunk.bytes.byteLength
  }

  return out
}
