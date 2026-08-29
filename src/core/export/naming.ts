import type { Clip } from '../edit/clip'

/** As much of a name as a file system will take, in characters. The extension goes after it. */
export const MAX_NAME_LENGTH = 100

/**
 * The same limit in bytes, which is the unit the file systems actually count in.
 *
 * The two are not the same limit and neither implies the other: a hundred characters of Japanese
 * are three hundred bytes and a hundred emoji are four hundred, both past what ext4 and NTFS take
 * for one name. Two hundred leaves room under the shortest common limit of 255 for the extension
 * and for the "(1)" Chrome appends when a name is already taken.
 */
export const MAX_NAME_BYTES = 200

/**
 * Characters a file name may not carry, replaced by a space because their place is between words.
 *
 * `\ / : * ? " < > |` are forbidden outright by Windows, and the two slashes are path separators
 * everywhere: "AC\DC.mp4" is written not as a file but as a directory AC holding DC.mp4, and the
 * user who pressed "Save all" finds no clip. The control characters follow, both ranges of them:
 * C0 below the space, and C1 above DEL, which arrives from pages served in a legacy encoding.
 */
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]+/g

/**
 * Characters that show nothing and break everything: removed outright rather than turned into a
 * space, because they stand inside a word as readily as between two.
 *
 * The bidirectional controls — the marks, the embeddings, the overrides and the isolates — are
 * written by every page that mixes scripts, and by plenty that do not. Measured: a title carrying
 * U+200E LEFT-TO-RIGHT MARK, which is neither whitespace nor forbidden, survived every step of the
 * cleaning, Chrome refused the name, and the popup blamed the session for being gone. The
 * zero-width characters (space, non-joiner, joiner, no-break space) and the soft hyphen come from
 * the same place — a page's own typography — and are as invisible in a file manager as they are
 * in a title.
 */
const INVISIBLE =
  /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g

/** How many bytes one code point takes in UTF-8: the unit a file system counts its limit in. */
function utf8SizeOf(point: string): number {
  const code = point.codePointAt(0) ?? 0
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0x10000) return 3
  return 4
}

/**
 * The name cut down to what a file system will take — by whole characters and by bytes at once.
 *
 * By code points and not by string index: a title of emoji is a string of surrogate pairs, and a
 * cut between the halves of one leaves a lone surrogate behind. That is not valid Unicode, and
 * Chrome refuses such a name exactly as it refuses a control character.
 */
function clipToLimits(text: string, maxLength: number): string {
  let taken = ''
  let bytes = 0
  let points = 0

  for (const point of text) {
    if (points === maxLength) break
    const size = utf8SizeOf(point)
    if (bytes + size > MAX_NAME_BYTES) break

    taken += point
    bytes += size
    points += 1
  }

  return taken
}

/**
 * A name a file system will accept, out of a name a page gave.
 *
 * What file names forbid is taken out and the rest stays: the title reaches the user, and a title
 * in any language is no reason to hand back a file made of underscores. The name is written by a
 * page and travels from here straight into the file system, so every step below answers something
 * a real title was measured to do — Chrome answers a name it will not take by refusing the whole
 * download, which is the one failure the user has no way of guessing at.
 *
 * The one cleaning in the program: the popup's "Save all" and the editor's clips both come
 * through here, and a second copy of these rules would be a second set of titles Chrome refuses.
 */
export function sanitizeFileName(text: string, maxLength = MAX_NAME_LENGTH): string {
  const cleaned = text
    // The invisible ones go first and go away: turned into spaces they would open gaps inside
    // words, and left alone they reach Chrome and the download is refused.
    .replace(INVISIBLE, '')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A name starting with a dot is a hidden file to Chrome, and ".." is a path upwards. The dots
    // at the edges go after the whitespace is collapsed and not before — otherwise "../../.bashrc"
    // keeps them behind the first space, and Chrome reads the result as a path upwards and
    // refuses the download whole.
    .replace(/^[.\s]+/, '')

  // The cut comes last, so that the limits are spent on what survived the cleaning, and the tail
  // is tidied after the cut, so that a name cut on a space or a dot does not carry it into the
  // extension.
  const base = clipToLimits(cleaned, maxLength).replace(/[.\s]+$/, '')

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

/** What a name template may put into a name. Anything else in braces is left as it stands. */
export const NAME_FIELDS = ['title', 'in', 'out', 'date', 'host'] as const

export type NameFields = Record<(typeof NAME_FIELDS)[number], string>

/**
 * A clip name out of the user's template.
 *
 * Substitution and nothing more: no expressions, no conditionals, no defaults. A template is a
 * setting a user types by hand, and every feature beyond `{field}` is a way for a typed sentence
 * to become an error message. An unknown field is left in the name exactly as it was written —
 * the user meant those characters, and silently deleting a word out of the middle of a file name
 * is worse than a name with `{oops}` in it, which explains itself.
 *
 * The result still goes through sanitizeFileName: the template may hold a slash, and the fields
 * hold a page title.
 */
export function applyTemplate(template: string, fields: NameFields): string {
  const filled = template.replace(/\{([a-z]+)\}/g, (whole, name: string) =>
    (NAME_FIELDS as readonly string[]).includes(name) ? fields[name as keyof NameFields] : whole,
  )
  return filled.replace(/\s+/g, ' ').trim()
}
