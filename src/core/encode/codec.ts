import type { ExportCodec, ExportQuality } from '../../shared/settings'

/**
 * The picture the encoder is asked for: what comes out of the crop, already rounded (§8.5).
 *
 * All three numbers are part of the question. Support is not a property of the machine but of
 * the triple: hardware HEVC answers yes at 3840×2160@30 and no at the same frame at 60, and
 * `avc1.640028` is refused at 4K where `avc1.640033` is accepted. A cache keyed on anything less
 * than this answers about a clip it was never asked about.
 */
export interface EncodeGeometry {
  width: number
  height: number
  framerate: number
}

/**
 * Whatever answers "can this be encoded here". Injected, always.
 *
 * The whole ladder is a pure function over this, and that is the point: the machine this is
 * written on has no hardware encoder and no HEVC at all, so every branch but one is unreachable
 * in a browser here. Over an injected probe all four are reachable in a unit test.
 */
export type Probe = (config: VideoEncoderConfig) => Promise<boolean>

/** One step of the ladder: what would be asked for, and what it would mean if granted. */
export interface Rung {
  config: VideoEncoderConfig
  choice: Choice
}

export type Choice =
  | { kind: 'hevc-hw'; config: VideoEncoderConfig; control: 'quantizer'; quantizer: number }
  | { kind: 'h264-hw'; config: VideoEncoderConfig; control: 'quantizer'; quantizer: number }
  | {
      kind: 'h264-sw'
      config: VideoEncoderConfig
      control: 'fixed-bitrate'
      /**
       * What is asked for. What is written may be more: openh264 was measured writing 1.97
       * Mbit/s when asked for 0.4 at 1080p30, and it has no quantizer mode to ask instead. So
       * this rung's number is a floor the panel says "no smaller than" about, never "about".
       */
      bitrate: number
    }
  | { kind: 'none'; tried: string[] }

/**
 * A choice that can actually encode: the ladder's answer with "there is no encoder" ruled out.
 *
 * Declared here, once, and exported, because two other files want the narrowed thing rather than
 * the union: `pathFor` only builds an `encode` path after it has ruled `none` out, and
 * `encodeToTrack` is handed something it can configure an encoder with. Written as an `Exclude`
 * rather than a second hand-written union so that a rung added above cannot be forgotten here.
 */
export type EncodingChoice = Exclude<Choice, { kind: 'none' }>

/**
 * H.264 levels, low to high, by the two limits that decide them.
 *
 * Both columns are from the specification's Table A-1 and both are load-bearing: 4K30 fits the
 * frame size of 5.0 and not its rate, and 4K60 fits the rate of nothing below 5.2. The levels
 * nobody would land on (3.3 does not exist, 4.1 differs from 4.0 only in bitrate) are left out —
 * a level that never wins would only be a row to keep correct.
 */
const AVC_LEVELS: Array<{ hex: string; macroblocks: number; perSecond: number }> = [
  { hex: '1e', macroblocks: 1_620, perSecond: 40_500 }, // 3.0
  { hex: '1f', macroblocks: 3_600, perSecond: 108_000 }, // 3.1
  { hex: '20', macroblocks: 5_120, perSecond: 216_000 }, // 3.2
  { hex: '28', macroblocks: 8_192, perSecond: 245_760 }, // 4.0
  { hex: '2a', macroblocks: 8_704, perSecond: 522_240 }, // 4.2
  { hex: '32', macroblocks: 22_080, perSecond: 589_824 }, // 5.0
  { hex: '33', macroblocks: 36_864, perSecond: 983_040 }, // 5.1
  { hex: '34', macroblocks: 36_864, perSecond: 2_073_600 }, // 5.2
  { hex: '3c', macroblocks: 139_264, perSecond: 4_177_920 }, // 6.0
  { hex: '3d', macroblocks: 139_264, perSecond: 8_355_840 }, // 6.1
  { hex: '3e', macroblocks: 139_264, perSecond: 16_711_680 }, // 6.2
]

/** HEVC levels, by luma samples and luma samples a second (Table A.8), general_level_idc = 30×L. */
const HEVC_LEVELS: Array<{ idc: number; samples: number; perSecond: number }> = [
  { idc: 93, samples: 983_040, perSecond: 33_177_600 }, // 3.1
  { idc: 120, samples: 2_228_224, perSecond: 66_846_720 }, // 4.0
  { idc: 123, samples: 2_228_224, perSecond: 133_693_440 }, // 4.1
  { idc: 150, samples: 8_912_896, perSecond: 267_386_880 }, // 5.0
  { idc: 153, samples: 8_912_896, perSecond: 534_773_760 }, // 5.1
  { idc: 156, samples: 8_912_896, perSecond: 1_069_547_520 }, // 5.2
  { idc: 180, samples: 35_651_584, perSecond: 1_069_547_520 }, // 6.0
  { idc: 183, samples: 35_651_584, perSecond: 2_139_095_040 }, // 6.1
  { idc: 186, samples: 35_651_584, perSecond: 4_278_190_080 }, // 6.2
]

const rate = (g: EncodeGeometry): number => Math.max(1, Math.ceil(g.framerate))

/**
 * The two hex digits of level_idc for this picture — the last pair of `avc1.6400xx`.
 *
 * Mandatory, not a nicety. A hardcoded 4.0 is refused at 4K, so both H.264 rungs fail there and
 * the clip lands on "no encoder" on a machine that encodes 4K fine.
 */
export function avcLevelHex(g: EncodeGeometry): string {
  const blocks = Math.ceil(g.width / 16) * Math.ceil(g.height / 16)
  const perSecond = blocks * rate(g)
  const level = AVC_LEVELS.find((l) => blocks <= l.macroblocks && perSecond <= l.perSecond)
  return (level ?? AVC_LEVELS[AVC_LEVELS.length - 1]!).hex
}

/**
 * general_level_idc for this picture — the `L…` of `hev1.1.6.L….B0`.
 *
 * Computed although Chrome's HEVC encoder ignores it: the string ends up in a file, and a file
 * whose codec string lies about its level is a file some other reader will believe.
 */
export function hevcLevelIdc(g: EncodeGeometry): number {
  const samples = g.width * g.height
  const perSecond = samples * rate(g)
  const level = HEVC_LEVELS.find((l) => samples <= l.samples && perSecond <= l.perSecond)
  return (level ?? HEVC_LEVELS[HEVC_LEVELS.length - 1]!).idc
}

/**
 * What a probe answer is about — the whole question, never less.
 *
 * Never a single global boolean: support flips with codec, width, height, framerate, whether
 * hardware was demanded, rate-control mode and bitrate. The ladder and explicit support probes
 * vary all seven, so every one is here.
 */
export function cacheKeyOf(config: VideoEncoderConfig): string {
  const accel = config.hardwareAcceleration ?? 'no-preference'
  const mode = config.bitrateMode ?? 'default'
  const bitrate = config.bitrate ?? 'default'
  return `${config.codec}|${config.width}x${config.height}@${config.framerate ?? 0}|${accel}|${mode}|${bitrate}`
}

/**
 * Quantizer per quality level, on the 0–51 scale both H.264 and HEVC count on.
 *
 * Six steps is a halving of the bitrate, which is what sets the spacing: three levels that differ
 * by five are three visibly different files rather than three names for one.
 */
export const QUANTIZERS: Record<ExportQuality, number> = { high: 22, medium: 27, low: 33 }

/**
 * Bits per pixel per frame the software rung asks for, by quality.
 *
 * **And there is no floor beside them, deliberately.** The measured fact is that openh264 does
 * not honour a low target — asked for 0.4 Mbit/s at 1080p30 it wrote 1.97 — and the obvious
 * response is a floor the ask is raised to. Written out, that floor cannot ever apply: 1.97
 * Mbit/s over 1920×1080×30 pixels a second is 0.0317 bits a pixel, and the lowest of the three
 * rows below is 0.045. Both the ask and such a floor are the same linear function of
 * width×height×fps, so the ask is above the floor at every geometry and every quality, and a
 * `Math.max` between them would be a branch no input reaches — with a flag on the estimate and a
 * sentence in the panel behind it that no user could ever see.
 *
 * What the measurement does earn is a word: on this rung the panel says "no smaller than" rather
 * than "about", because the encoder may write more than it was asked for and never less. If a
 * second geometry ever shows a floor that is *not* proportional to the pixel rate — that is the
 * manual measurement of Task 12, point 9 — then the floor comes back, as a number that fires.
 */
export const BITS_PER_PIXEL: Record<ExportQuality, number> = { high: 0.1, medium: 0.07, low: 0.045 }

export const bitrateFor = (g: EncodeGeometry, quality: ExportQuality): number =>
  Math.round(g.width * g.height * rate(g) * BITS_PER_PIXEL[quality])

export interface LadderOptions {
  codec: ExportCodec
  quality: ExportQuality
}

const hevcConfig = (g: EncodeGeometry): VideoEncoderConfig => ({
  codec: `hev1.1.6.L${hevcLevelIdc(g)}.B0`,
  width: g.width,
  height: g.height,
  framerate: g.framerate,
  hardwareAcceleration: 'prefer-hardware',
  bitrateMode: 'quantizer',
  latencyMode: 'quality',
})

const avcConfig = (g: EncodeGeometry, hardware: boolean, bitrate: number): VideoEncoderConfig => ({
  codec: `avc1.6400${avcLevelHex(g)}`,
  width: g.width,
  height: g.height,
  framerate: g.framerate,
  hardwareAcceleration: hardware ? 'prefer-hardware' : 'prefer-software',
  ...(hardware ? { bitrateMode: 'quantizer' as const } : { bitrateMode: 'constant' as const, bitrate }),
  latencyMode: 'quality',
  avc: { format: 'avc' },
})

/**
 * Whether HEVC is tried before H.264.
 *
 * `auto` is H.264 unless the quality asked for is the low one, and the reason is measured rather
 * than tasteful: HEVC's advantage over H.264 is +0.029 SSIM at 800 kbit/s and +0.0003 at 2
 * Mbit/s. It is an advantage where the bits are few, which is what `low` means, and it is nothing
 * at ordinary quality — where it would be paid for in players that cannot open the file.
 */
const hevcFirst = (options: LadderOptions): boolean =>
  options.codec === 'hevc' || (options.codec === 'auto' && options.quality === 'low')

/**
 * Every step that would be tried for this picture, in order — without asking anything.
 *
 * Separate from `chooseCodec` so that the order itself is a thing a test can hold: the ladder is
 * the decision, the probe only says how far down it goes.
 */
export function ladderFor(g: EncodeGeometry, options: LadderOptions): Rung[] {
  const quantizer = QUANTIZERS[options.quality]
  const bitrate = bitrateFor(g, options.quality)

  const hevc: Rung = {
    config: hevcConfig(g),
    get choice(): Choice {
      return { kind: 'hevc-hw', config: hevcConfig(g), control: 'quantizer', quantizer }
    },
  }

  const h264hw: Rung = {
    config: avcConfig(g, true, bitrate),
    get choice(): Choice {
      return { kind: 'h264-hw', config: avcConfig(g, true, bitrate), control: 'quantizer', quantizer }
    },
  }

  const h264sw: Rung = {
    config: avcConfig(g, false, bitrate),
    get choice(): Choice {
      return {
        kind: 'h264-sw',
        config: avcConfig(g, false, bitrate),
        control: 'fixed-bitrate',
        bitrate,
      }
    },
  }

  if (options.codec === 'h264') return [h264hw, h264sw]
  return hevcFirst(options) ? [hevc, h264hw, h264sw] : [h264hw, hevc, h264sw]
}

/**
 * The first step of the ladder this machine grants for this picture.
 *
 * Asked per clip geometry and never once per install. Everything it needs of the world is the
 * probe, so this function is as true in a unit test with no browser as it is in the tab.
 */
export async function chooseCodec(
  g: EncodeGeometry,
  probe: Probe,
  options: LadderOptions,
): Promise<Choice> {
  const tried: string[] = []

  for (const rung of ladderFor(g, options)) {
    tried.push(cacheKeyOf(rung.config))
    if (await probe(rung.config)) return rung.choice
  }

  return { kind: 'none', tried }
}
