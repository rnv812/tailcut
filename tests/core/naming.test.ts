import { describe, it, expect } from 'vitest'
import {
  MAX_NAME_BYTES,
  fileNameOf,
  sanitizeFileName,
  uniqueNames,
} from '../../src/core/export/naming'
import type { Clip } from '../../src/core/edit/clip'

const clip = (name: string): Clip => ({
  id: 'c1',
  name,
  in: 1,
  out: 3,
  representation: '480p',
  sound: true,
  crop: null,
  format: 'mp4',
})

describe('sanitizeFileName', () => {
  it('leaves a name in any language as it is', () => {
    // A title not in Latin is no reason to hand the user a file made of underscores.
    expect(sanitizeFileName('Ночной эфир 01.23')).toBe('Ночной эфир 01.23')
  })

  it('takes out everything a file system refuses', () => {
    // Chrome reads both slashes as a path separator, so "AC\\DC.mp4" goes out as a directory AC
    // with a file DC.mp4 in it. Windows refuses a star or a colon outright and the download is
    // rejected with nothing said. Control characters come from the same place — a page title.
    expect(sanitizeFileName('A/B: "C" <D> | E? AC\\DC * F\u0001G')).toBe('A B C D E AC DC F G')
    // C1 as well as C0 — the range above DEL arrives from pages served in a legacy encoding, and
    // Chrome refuses a name carrying one exactly as it refuses a name carrying the other.
    expect(sanitizeFileName('Se\u0001rie\u007fs\u0085 o\u009fne')).toBe('Se rie s o ne')
  })

  it('takes out the characters that show nothing and break everything', () => {
    // Measured on a real title: U+200E LEFT-TO-RIGHT MARK is neither whitespace nor forbidden, it
    // survived every other step, Chrome refused the name, and the popup blamed the session for
    // being gone. Removed outright rather than turned into a space — they stand inside a word as
    // readily as between two, and a gap where the eye sees none is a name nobody asked for.
    expect(sanitizeFileName('\u200eНовости\u200f — \u202bэфир\u202c')).toBe('Новости — эфир')
    expect(sanitizeFileName('A\u200bB\u200cC\u200dD\ufeffE')).toBe('ABCDE')
    expect(sanitizeFileName('\u200e\u200b\u202a\u202c\ufeff')).toBe('tailcut')
  })

  it('counts the limit in bytes besides, and never cuts a character in half', () => {
    // A file system counts its limit in bytes and a page title is counted in characters: one
    // character of this title is three bytes, so a hundred of them are three hundred, past what
    // ext4 and NTFS take for one name.
    const cjk = sanitizeFileName('語'.repeat(300))
    expect(new TextEncoder().encode(cjk).byteLength).toBeLessThanOrEqual(MAX_NAME_BYTES)
    expect(cjk.length, 'the title was thrown away instead of being cut').toBeGreaterThan(10)

    // And a title of emoji is a string of surrogate pairs: a cut between the halves of one leaves
    // a lone surrogate behind, which is not valid Unicode and which Chrome refuses exactly as it
    // refuses a control character.
    const emoji = sanitizeFileName(`a${'🎬'.repeat(200)}`)
    expect(emoji, `a lone surrogate in the name: ${JSON.stringify(emoji)}`).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    )
  })

  it('does not let a title of dots become a hidden file or a path upwards', () => {
    expect(sanitizeFileName('../../.bashrc')).toBe('bashrc')
  })

  it('strips a dot and a space off the tail, where the extension is going', () => {
    expect(sanitizeFileName('Серия 1.')).toBe('Серия 1')
    expect(sanitizeFileName(`${'ц'.repeat(99)} and some more words`)).toBe('ц'.repeat(99))
  })

  it('cuts a long name down to what a file system will take', () => {
    expect(sanitizeFileName('ц'.repeat(300))).toHaveLength(100)
  })

  it('falls back on the name of the extension when nothing is left', () => {
    expect(sanitizeFileName('   ')).toBe('tailcut')
    expect(sanitizeFileName('///')).toBe('tailcut')
  })
})

describe('fileNameOf', () => {
  it('is the name of the clip with an extension', () => {
    expect(fileNameOf(clip('A page about cats 01.23'))).toBe('A page about cats 01.23.mp4')
  })
})

describe('uniqueNames', () => {
  it('numbers a repeat instead of writing over it', () => {
    // Two clips renamed to the same thing is ordinary, and Chrome would silently add a number of
    // its own — after the extension on some platforms. Better to say it here.
    expect(uniqueNames(['a.mp4', 'b.mp4', 'a.mp4', 'a.mp4'])).toEqual([
      'a.mp4',
      'b.mp4',
      'a (2).mp4',
      'a (3).mp4',
    ])
  })

  it('leaves names that differ alone', () => {
    const names = ['one.mp4', 'two.mp4']
    expect(uniqueNames(names)).toEqual(names)
  })
})
