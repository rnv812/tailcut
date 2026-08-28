import { describe, it, expect } from 'vitest'
import { fileNameOf, sanitizeFileName, uniqueNames } from '../../src/core/export/naming'
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
