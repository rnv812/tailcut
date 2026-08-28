import { describe, it, expect } from 'vitest'
import { unexpectedWarnings } from './media'

/**
 * What ffmpeg said, word for word, decoding a clip saved off rutube through the extension.
 *
 * Not an invented string: 76.1 seconds of h264 848×480 and aac, 14 616 509 bytes, 1822 frames of
 * picture and 3272 of sound, ffprobe silent and both exit codes zero. Measured with ffmpeg 4.4.2
 * on 2026-08-28, `ffmpeg -v warning -i saved.mp4 -f null -`.
 */
const RUTUBE_SAVE = [
  '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x637b6caf22c0] Duplicated SDTP atom',
  '    Last message repeated 36 times',
  '[h264 @ 0x637b6caf4280] Increasing reorder buffer to 2',
  '',
].join('\n')

/** The same decode of a clip saved off a page playing an ordinary file: ffmpeg said nothing. */
const PLAIN_SAVE = ''

describe('the decoder complaints a correct file draws', () => {
  it('accounts for every line of a real save off rutube', () => {
    // The whole point of the list. A save off that site is the shape of material end-to-end tests
    // have to be writable over, and a line of it left unnamed makes every such test red.
    expect(unexpectedWarnings(RUTUBE_SAVE)).toEqual([])
  })

  it('accounts for a save off a page playing an ordinary file', () => {
    expect(unexpectedWarnings(PLAIN_SAVE)).toEqual([])
  })

  it('still fails over a line nobody has argued for', () => {
    // A list that grew until everything fitted would stop being an assertion. What is not named
    // with a reason is a defect, and this is the half of the helper that has to keep working.
    const broken = '[h264 @ 0x1] error while decoding MB 12 5, bytestream -7'
    expect(unexpectedWarnings(`${broken}\n`)).toEqual([broken])
  })
})
