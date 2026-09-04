import { readFileSync } from 'node:fs'
import { parseInit } from '../../src/core/webm/init'
import { webmToIso } from '../../src/core/webm/to-iso'

export const readMedia = (path: string) => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

export function exportTrack(folder: string, stream: number, ext = 'm4s') {
  const initBytes = readMedia(`${folder}/init-stream${stream}.${ext}`)
  const segments = [1, 2, 3].map((n) => readMedia(`${folder}/chunk-stream${stream}-0000${n}.${ext}`))
  if (ext !== 'webm') return { initBytes, segments }
  const converter = webmToIso(parseInit(initBytes)!, folder === 'webm-vp8'
    ? 'video/webm; codecs="vp8"' : 'video/webm; codecs="vp09.00.10.08"')!
  return { initBytes: converter.initBytes, segments: segments.map((bytes) => converter.segment(bytes)!.bytes) }
}
