import type { Clip } from '../edit/clip'

/** As much of a name as a file system will take. The extension is added after this. */
export const MAX_NAME_LENGTH = 100

/**
 * A name a file system will accept, out of a name a page gave.
 *
 * What file names forbid is taken out and the rest stays: the title reaches the user, and a title
 * in any language is no reason to hand back a file made of underscores. The dots at the edges go
 * after the whitespace is collapsed and not before — otherwise "../../.bashrc" keeps them behind
 * the first space, and Chrome reads the result as a path upwards and refuses the download whole.
 */
export function sanitizeFileName(text: string, maxLength = MAX_NAME_LENGTH): string {
  const base = text
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, maxLength)
    .replace(/[.\s]+$/, '')

  return base || 'tailcut'
}

/** The file one clip is written to. The name was made of the page title and the timecode (Task 10). */
export function fileNameOf(clip: Clip): string {
  return `${sanitizeFileName(clip.name)}.mp4`
}

/** The same list with repeats numbered: one batch never writes two files over one name. */
export function uniqueNames(names: readonly string[]): string[] {
  const taken = new Set<string>()

  return names.map((name) => {
    if (!taken.has(name)) {
      taken.add(name)
      return name
    }

    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ''

    for (let n = 2; ; n++) {
      const candidate = `${stem} (${n})${extension}`
      if (!taken.has(candidate)) {
        taken.add(candidate)
        return candidate
      }
    }
  })
}
