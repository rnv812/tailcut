import type { Clip } from '../edit/clip'
import type { ExportFormat } from '../../shared/settings'

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

/** The seventeen planes of Unicode, each of which ends on two noncharacters. */
const PLANES = Array.from({ length: 17 }, (_, plane) => plane)

/**
 * Characters that show nothing and break everything: removed outright rather than turned into a
 * space, because they stand inside a word as readily as between two.
 *
 * The bidirectional controls — the marks, the embeddings, the overrides and the isolates — are
 * written by every page that mixes scripts, and by plenty that do not. Measured: a title carrying
 * U+200E LEFT-TO-RIGHT MARK, which is neither whitespace nor forbidden, survived every step of the
 * cleaning, Chrome refused the name, and the popup blamed the session for being gone. The
 * zero-width characters and the soft hyphen come from the same place — a page's own typography.
 *
 * By category and not by list, because a list was measured to fall short: Chrome refuses the
 * whole of "Other, format" (its base::i18n::IsFilenameLegal), and the characters the list did not
 * name were refused all the same — the Arabic number signs U+0600-0605, the interlinear
 * annotations U+FFF9-FFFB, the musical beams U+1D173-1D17A, and the tag characters U+E0001 and
 * U+E0020-E007F. The tags are the real case: they spell the subdivision flags, and "Euro 2024
 * <flag of England> vs Spain" lost its download to them. Taken out, the flag is left as the black
 * flag it is built on. The same check refuses noncharacters — U+FDD0-FDEF and the last two code
 * points of every plane — and a lone surrogate, which is no character at all and fails Chrome's
 * conversion of the name before any check is made.
 */
const INVISIBLE = new RegExp(
  `[\\p{Cf}\\p{Cs}\\u{fdd0}-\\u{fdef}${PLANES.map((plane) => {
    const end = (offset: number) => `\\u{${(plane * 0x10000 + offset).toString(16)}}`
    return `${end(0xfffe)}-${end(0xffff)}`
  }).join('')}]`,
  'gu',
)

/**
 * The device names of Windows: a file may not be called one, with or without an extension.
 *
 * Chrome checks them on every system and not only on Windows (net::IsSafePortablePathComponent,
 * by way of IsReservedNameOnWindows), so "CON.mp4" is refused on Linux as well — measured — and
 * so is "Aux.final.mp4": the name counts up to its first dot. In any case, since Windows matches
 * them in any case. CLOCK$ is Chrome's own addition; CONIN$ and CONOUT$ and the superscript
 * COM¹-LPT³ are Windows' own, which Chrome does not check and Windows would still refuse.
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|clock\$|conin\$|conout\$)(?=\.|$)/i

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
    // A tilde goes with them: Chrome refuses one at either end of a name ("~ Downloads
    // trick.mp4" was refused, "a~b.mp4" was saved) — at the front it reads as a home directory,
    // and the end of the name is the extension, which is ours.
    .replace(/^[.\s~]+/, '')

  // The cut comes last, so that the limits are spent on what survived the cleaning, and the tail
  // is tidied after the cut, so that a name cut on a space or a dot does not carry it into the
  // extension.
  const base = tidy(cleaned, maxLength)

  // A device name is checked on what is left, since the cleaning is what can make one: "con ."
  // loses its tail and comes out as "con". Renamed by a mark right after the device name rather
  // than by a prefix, so that the name still starts with what the title starts with, and cut
  // again so that the mark is spent out of the limit and not on top of it.
  if (RESERVED.test(base)) return tidy(base.replace(RESERVED, '$1_'), maxLength)

  return base || 'tailcut'
}

/** The name cut to the limits, without a dot or a space left on the tail for the extension. */
function tidy(text: string, maxLength: number): string {
  return clipToLimits(text, maxLength).replace(/[.\s]+$/, '')
}

/**
 * The extension and the content type of each format, side by side so they cannot disagree.
 *
 * They are one fact about a file and they used to be two constants in two modules: `.mp4` here
 * and `video/mp4` in the downloader. An animation then arrived as `clip.mp4` of type `video/mp4`
 * — a file Chrome will not preview and no messenger will take.
 */
const FILE_TYPES: Record<ExportFormat, { extension: string; mime: string }> = {
  mp4: { extension: '.mp4', mime: 'video/mp4' },
  webp: { extension: '.webp', mime: 'image/webp' },
}

/** The output file for one clip, named from the page title and start timecode. */
export function fileNameOf(clip: Clip): string {
  return `${sanitizeFileName(clip.name)}${FILE_TYPES[clip.format].extension}`
}

/**
 * What the browser is told a finished file is, read back off its own name.
 *
 * Off the name because that is what the saver has: `ExportIo.save` takes a file and a name, and a
 * third argument would be a third thing to keep in step with the other two. The extension was
 * written by `fileNameOf` out of the clip's format, so the extension *is* the format.
 */
export function contentTypeOf(fileName: string): string {
  const known = Object.values(FILE_TYPES).find((type) => fileName.endsWith(type.extension))
  return (known ?? FILE_TYPES.mp4).mime
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
