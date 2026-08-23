/**
 * What an mp4 has to be told about a VP9 track, and where those facts come from.
 *
 * A vp09 sample entry is worth nothing without a vpcC beside it: profile, level, bit depth,
 * chroma subsampling and the three colour fields. Matroska carries none of them. A WebM
 * TrackEntry for VP9 says V_VP9, the frame size, and — if the packager felt like it — a Colour
 * element with the range in it. Nothing else. So the facts have to come from somewhere.
 *
 * There are two candidates and they are not equal.
 *
 * The bitstream is the authority: the uncompressed header of every keyframe states the profile,
 * the bit depth and the subsampling, and it cannot lie about them because it is what the decoder
 * reads. What it cannot do is arrive in time. A track is described the moment its init segment
 * lands — that is when the registry opens it, when a refusal is still possible and when there is
 * still nothing collected under it to throw away — and the first frame comes after. Describing
 * the track from the first frame instead means opening it undescribed, taking in segments that
 * may turn out to belong to a shape this program cannot write, and discovering that only once
 * they are already on the map. That is the exact failure the ingest boundary exists to prevent.
 *
 * The codec string arrives in time, and it is not a hint: it is the string the page handed
 * `MediaSource.isTypeSupported` and `addSourceBuffer`, and the browser built a decoder out of it.
 * A file described by the same numbers the browser is decoding by is described correctly by
 * construction. `vp09.<profile>.<level>.<bitDepth>.<chromaSubsampling>.<primaries>.<transfer>.
 * <matrix>.<fullRange>` spells the vpcC field for field, in order.
 *
 * So the codec string it is, and it is read whole or not at all — the input comes from an
 * arbitrary website, and a string this module cannot make sense of is a track this module will
 * not describe. See vp9Config below for what each shape of input turns into.
 *
 * What a site cannot do by declaring its stream wrongly is break the picture. Every VP9 decoder
 * reads the profile, the bit depth and the subsampling out of the frame headers and not out of
 * the vpcC — ffmpeg and Chromium both play a file whose box contradicts its frames — so a false
 * declaration costs a wrong line in the file's metadata and nothing more. That is the reason the
 * bitstream is not worth waiting for, and the reason a refusal here is about a description that
 * cannot be written at all rather than one that might be inaccurate.
 */

/** The vpcC record, in the fields the box states them. */
export interface Vp9Config {
  /** 0…3. Fixes what bit depths and what subsampling the stream may use. */
  profile: number
  /** Ten times the level number: 10 is level 1, 51 is level 5.1. */
  level: number
  /** Bits per colour component: 8, 10 or 12. */
  bitDepth: number
  /** 0 — 4:2:0 vertical, 1 — 4:2:0 colocated with luma, 2 — 4:2:2, 3 — 4:4:4. */
  chromaSubsampling: number
  /** Full-swing colour rather than the studio range. */
  fullRange: boolean
  /** The three CICP codes, as ISO/IEC 23091-2 numbers them. */
  colourPrimaries: number
  transferCharacteristics: number
  matrixCoefficients: number
}

/**
 * Levels the format defines, as the codec string spells them. A number outside this set is not a
 * level, and a vpcC carrying one describes a stream no player has a table for.
 */
const LEVELS = new Set([10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 52, 60, 61, 62])

/**
 * The level table of the format, smallest first: luma samples of one picture, and the longest
 * side. A level is chosen by the picture it has to hold.
 */
const LEVEL_LIMITS: Array<{ level: number; samples: number; side: number }> = [
  { level: 10, samples: 36_864, side: 512 },
  { level: 11, samples: 73_728, side: 768 },
  { level: 20, samples: 122_880, side: 960 },
  { level: 21, samples: 245_760, side: 1344 },
  { level: 30, samples: 552_960, side: 2048 },
  { level: 31, samples: 983_040, side: 2752 },
  { level: 40, samples: 2_228_224, side: 4160 },
  { level: 50, samples: 8_912_896, side: 8384 },
  { level: 60, samples: 35_651_584, side: 16_832 },
]

/** The highest level there is: a picture too large for the table has nowhere else to go. */
const TOP_LEVEL = 62

/** Bit depths and chroma subsamplings each profile is allowed to use. */
const PROFILES: Array<{ depths: number[]; chromas: number[] }> = [
  { depths: [8], chromas: [0, 1] }, // 0: eight bits, 4:2:0
  { depths: [8], chromas: [2, 3] }, // 1: eight bits, 4:2:2 or 4:4:4
  { depths: [10, 12], chromas: [0, 1] }, // 2: ten or twelve bits, 4:2:0
  { depths: [10, 12], chromas: [2, 3] }, // 3: ten or twelve bits, 4:2:2 or 4:4:4
]

/**
 * Values the codec string leaves out, as the VP9 codec string specification defines them:
 * 4:2:0 colocated with luma, BT.709 throughout, studio range.
 */
const OPTIONAL_DEFAULTS = [1, 1, 1, 1, 0]

/** CICP for "the stream does not say" — what a packager writes when it has not been told. */
const UNSPECIFIED = 2

/**
 * The `codecs` parameter of a MIME type, split into the codecs it names.
 *
 * The parameter is quoted whenever it holds more than one codec, and pages quote it either way.
 * Everything else in the type is another parameter or the type itself and is passed over: what a
 * caller wants from `video/webm; codecs="vp09.00.10.08"` is the one token in the middle.
 */
export function codecsOf(mime: string): string[] {
  const match = /(?:^|;)\s*codecs\s*=\s*("[^"]*"|'[^']*'|[^;]*)/i.exec(mime)
  if (!match) return []

  const value = match[1]!.trim().replace(/^["']|["']$/g, '')
  return value
    .split(',')
    .map((codec) => codec.trim())
    .filter((codec) => codec.length > 0)
}

/** A field of the codec string: two decimal digits and nothing else. */
function field(text: string | undefined): number | null {
  if (text === undefined || !/^\d{2}$/.test(text)) return null
  return Number(text)
}

/**
 * The lowest level whose picture fits. The frame rate would raise it further — the format also
 * limits luma samples per second — and the frame rate is one thing neither the codec string nor a
 * WebM init segment carries. A packager with no frame rate to hand writes exactly this number.
 */
export function levelFor(width: number, height: number): number {
  const samples = width * height
  const side = Math.max(width, height)

  for (const limit of LEVEL_LIMITS) {
    if (samples <= limit.samples && side <= limit.side) return limit.level
  }

  return TOP_LEVEL
}

/**
 * The full form: vp09 and eight fields after it, of which the first three are required.
 *
 * Read whole or not at all. A field that is not two digits, a profile the format does not have, a
 * bit depth or a subsampling the profile forbids — each of those is a declaration this program
 * cannot honestly turn into a vpcC, and correcting one field of it would be inventing the rest.
 */
function parseExtended(parts: string[]): Vp9Config | null {
  // vp09 plus the three required fields, and no more than the eight the form defines.
  if (parts.length < 4 || parts.length > 9) return null

  const numbers: number[] = []
  for (const text of parts.slice(1)) {
    const value = field(text)
    if (value === null) return null
    numbers.push(value)
  }
  for (let i = numbers.length; i < 8; i++) numbers.push(OPTIONAL_DEFAULTS[i - 3]!)

  // Filled in above to exactly eight, in the order the form spells them.
  const profile = numbers[0]!
  const level = numbers[1]!
  const bitDepth = numbers[2]!
  const chromaSubsampling = numbers[3]!
  const primaries = numbers[4]!
  const transfer = numbers[5]!
  const matrix = numbers[6]!
  const range = numbers[7]!

  // A profile the format does not have, or one used with a bit depth or a subsampling it forbids.
  // Refused rather than corrected: the shape of the stream is what the site knows and we do not.
  const allowed = PROFILES[profile]
  if (!allowed) return null
  if (!allowed.depths.includes(bitDepth)) return null
  if (!allowed.chromas.includes(chromaSubsampling)) return null
  if (!LEVELS.has(level)) return null
  if (range > 1) return null

  return {
    profile,
    level,
    bitDepth,
    chromaSubsampling,
    fullRange: range === 1,
    colourPrimaries: primaries,
    transferCharacteristics: transfer,
    matrixCoefficients: matrix,
  }
}

/**
 * The legacy form: the bare name, with no fields after it.
 *
 * It names profile 0 and nothing else, which is how a browser reads it too — Chromium turns a
 * bare `vp9` into VP9 profile 0 before it will open a SourceBuffer for it. Profile 0 is not a
 * guess about the rest: the format defines it as eight bits and 4:2:0, so the two fields that
 * matter to a decoder follow from the name. The colour fields go down as unspecified, which is
 * what they are, and the level as the one the picture asks for.
 */
function parseLegacy(width: number, height: number): Vp9Config {
  return {
    profile: 0,
    level: levelFor(width, height),
    bitDepth: 8,
    chromaSubsampling: 1,
    fullRange: false,
    colourPrimaries: UNSPECIFIED,
    transferCharacteristics: UNSPECIFIED,
    matrixCoefficients: UNSPECIFIED,
  }
}

/**
 * What a VP9 track is to be described as, out of the MIME type the page opened its SourceBuffer
 * with. Null when the type describes no VP9 track this program can write, and then the track is
 * refused whole rather than written under a description made up here.
 *
 * - `vp09.00.51.08.01.01.01.01.00` and every shorter form of it: taken field for field.
 * - `vp9`, `vp09`: profile 0, and what profile 0 fixes; see parseLegacy.
 * - a `vp09.` string that does not parse: refused. A site that declares a shape the format does
 *   not have has not told us what its stream is, and the next best thing is not a guess.
 * - no MIME at all, no `codecs` parameter, a parameter naming some other codec: refused. The
 *   track is then undescribed, and an undescribed track opened here would swallow segments for
 *   the length of a recording and produce a file with a video stream that decodes to nothing.
 */
export function vp9Config(
  mime: string | undefined,
  width: number,
  height: number,
): Vp9Config | null {
  if (!mime) return null

  for (const codec of codecsOf(mime)) {
    const parts = codec.split('.')
    const name = parts[0]!.toLowerCase()
    if (name !== 'vp9' && name !== 'vp09') continue

    return parts.length === 1 ? parseLegacy(width, height) : parseExtended(parts)
  }

  return null
}
