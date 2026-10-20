import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compatibleMp4,
  conversionNeeded,
  convertsPicture,
  keptOriginal,
} from '../../src/core/export/compatible'
import { planClip } from '../../src/core/export/plan'
import { saveAllMp4 } from '../../src/core/export/save'
import { clipSourceFrom, movieTracksOf } from '../../src/core/export/source'
import { exportTrack as track, readMedia as read } from '../support/export-fixture'

/** The converter as the extension loads it, from its own address: here, its source file. */
function stubConverterAt(path: string): void {
  vi.stubGlobal('chrome', { runtime: { getURL: () => path } })
}

describe('MP4 export compatibility', () => {
  it('keeps H.264 and AAC without conversion', () => {
    expect(conversionNeeded(read('plain/whole.mp4'))).toEqual({ video: false, audio: false })
  })

  it('returns a compatible file unchanged without loading browser codecs', async () => {
    const file = read('plain/whole.mp4')
    const result = await compatibleMp4(file)
    expect(result!.file).toBe(file)
    expect(result!.note).toBeUndefined()
  })

  it('does no work for a canceled export', async () => {
    expect(await compatibleMp4(new Uint8Array(), () => true)).toBeNull()
  })

  it('converts both YouTube-style VP9 and Opus tracks', () => {
    const file = saveAllMp4([track('webm', 0, 'webm'), track('webm', 1, 'webm')])
    expect(conversionNeeded(file)).toEqual({ video: true, audio: true })
  })

  it('converts Opus even when the picture is already H.264', () => {
    const file = saveAllMp4([track('h264', 0), track('webm', 1, 'webm')])
    expect(conversionNeeded(file)).toEqual({ video: false, audio: true })
  })

  it('converts AV1 and leaves absent sound absent', () => {
    const file = saveAllMp4([track('av1', 0)])
    expect(conversionNeeded(file)).toEqual({ video: true, audio: false })
  })

  it('detects Vorbis inside mp4a instead of mistaking it for AAC', () => {
    const file = saveAllMp4([track('webm-vp8', 0, 'webm'), track('webm-vp8', 1, 'webm')])
    expect(conversionNeeded(file)).toEqual({ video: true, audio: true })
  })
})

describe('a conversion this browser cannot do', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const vp9Opus = () => saveAllMp4([track('webm', 0, 'webm'), track('webm', 1, 'webm')])

  it('saves the original and says why, in a browser with no H.264 encoder', async () => {
    // Node has no VideoEncoder at all, which is exactly Yandex Browser: built without OpenH264,
    // every H.264 encoder it has fails to start. The conversion used to throw "Try updating
    // Chrome" and the clip was lost; the original is a file every other player opens.
    stubConverterAt(resolve('src/shared/convert-mp4.ts'))
    const file = vp9Opus()

    const result = await compatibleMp4(file)

    expect(result!.file).toBe(file)
    expect(result!.note).toBe(
      'Saved with the original VP9/Opus — Premiere cannot import it: this browser has no H.264 encoder.',
    )
  })

  it('saves the original when the converter itself would not load', async () => {
    stubConverterAt(resolve('src/shared/no-such-converter.js'))
    const file = vp9Opus()

    const result = await compatibleMp4(file)

    expect(result!.file).toBe(file)
    expect(result!.note).toMatch(/^Saved with the original VP9\/Opus — Premiere cannot import it: /)
  })

  it('still answers nothing for an export called off on the way', async () => {
    stubConverterAt(resolve('src/shared/convert-mp4.ts'))
    let calls = 0
    // Called off once the module has loaded: the second question is the one after the import.
    expect(await compatibleMp4(vp9Opus(), () => ++calls > 1)).toBeNull()
  })

  it('names only the codecs that kept the file out of Premiere', () => {
    const h264Opus = saveAllMp4([track('h264', 0), track('webm', 1, 'webm')])
    expect(keptOriginal(h264Opus, conversionNeeded(h264Opus), 'this browser has no AAC encoder').note)
      .toBe('Saved with the original Opus — Premiere cannot import it: this browser has no AAC encoder.')

    const av1 = saveAllMp4([track('av1', 0)])
    expect(keptOriginal(av1, conversionNeeded(av1), 'why').note)
      .toBe('Saved with the original AV1 — Premiere cannot import it: why.')

    const vp8Vorbis = saveAllMp4([track('webm-vp8', 0, 'webm'), track('webm-vp8', 1, 'webm')])
    expect(keptOriginal(vp8Vorbis, conversionNeeded(vp8Vorbis), 'why').note)
      .toBe('Saved with the original VP8/Vorbis — Premiere cannot import it: why.')
  })
})

describe('which copies re-encode their picture on the way out', () => {
  const planOf = (file: Uint8Array) => {
    const source = clipSourceFrom(movieTracksOf(file, file.byteLength))!
    return planClip(source, { in: 0, out: 1, sound: true })
  }

  it('says yes for VP9, AV1 and VP8', () => {
    expect(convertsPicture(planOf(saveAllMp4([track('webm', 0, 'webm'), track('webm', 1, 'webm')])))).toBe(true)
    expect(convertsPicture(planOf(saveAllMp4([track('av1', 0)])))).toBe(true)
    expect(convertsPicture(planOf(saveAllMp4([track('webm-vp8', 0, 'webm')])))).toBe(true)
  })

  it('says no for H.264, even beside Opus: a sound alone is a light conversion', () => {
    expect(convertsPicture(planOf(saveAllMp4([track('h264', 0), track('webm', 1, 'webm')])))).toBe(false)
    expect(convertsPicture(planOf(read('plain/whole.mp4')))).toBe(false)
  })
})
