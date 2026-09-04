import { describe, expect, it } from 'vitest'
import { compatibleMp4, conversionNeeded } from '../../src/core/export/compatible'
import { saveAllMp4 } from '../../src/core/export/save'
import { exportTrack as track, readMedia as read } from '../support/export-fixture'

describe('MP4 export compatibility', () => {
  it('keeps H.264 and AAC without conversion', () => {
    expect(conversionNeeded(read('plain/whole.mp4'))).toEqual({ video: false, audio: false })
  })

  it('returns a compatible file unchanged without loading browser codecs', async () => {
    const file = read('plain/whole.mp4')
    expect(await compatibleMp4(file)).toBe(file)
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
