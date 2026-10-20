import type { ExportCodec, ExportQuality } from '../../shared/settings'

/**
 * The encoder's input picture after crop geometry has been rounded to the codec grid.
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
  | {
      /**
       * VP9 in MP4, out of libvpx, for a browser with no H.264 encoder at all.
       *
       * Yandex Browser is built without OpenH264: its software H.264 encoder fails with "Failed
       * to create OpenH264 encoder", and where no hardware encoder answers either, the rungs
       * above this one are refusals, one after another. libvpx is in every Chromium build — it is what
       * WebRTC runs on — so this rung is the one that is there when the others are not. It is
       * last on purpose: a VP9 MP4 plays in every browser and in VLC, but QuickTime and the
       * editors a clip is usually taken into do not all open it, and H.264 is the better file
       * wherever there is a way to write it.
       *
       * The quantizer is on libvpx's own 0–63 scale (see `VP9_QUANTIZERS`): Chrome takes
       * `bitrateMode: 'quantizer'` for VP9 and honours `{ vp9: { quantizer } }` per frame —
       * measured in this project's Chromium 151 and in Yandex 26.8 alike.
       */
      kind: 'vp9-sw'
      config: VideoEncoderConfig
      control: 'quantizer'
      quantizer: number
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
 * VP9 levels, by luma samples of one picture, luma samples a second, and the longest side.
 *
 * The level definitions as libvpx states them (`vp9_level_defs`). The rate column is the one
 * `levelFor` in src/core/vp9/codec.ts has to leave out — a WebM init carries no frame rate — but
 * an encoder is told its rate, so here it counts: 1080p30 is 4.0 and 1080p60 is 4.1.
 */
const VP9_LEVELS: Array<{ level: number; samples: number; perSecond: number; side: number }> = [
  { level: 10, samples: 36_864, perSecond: 829_440, side: 512 },
  { level: 11, samples: 73_728, perSecond: 2_764_800, side: 768 },
  { level: 20, samples: 122_880, perSecond: 4_608_000, side: 960 },
  { level: 21, samples: 245_760, perSecond: 9_216_000, side: 1344 },
  { level: 30, samples: 552_960, perSecond: 20_736_000, side: 2048 },
  { level: 31, samples: 983_040, perSecond: 36_864_000, side: 2752 },
  { level: 40, samples: 2_228_224, perSecond: 83_558_400, side: 4160 },
  { level: 41, samples: 2_228_224, perSecond: 160_432_128, side: 4160 },
  { level: 50, samples: 8_912_896, perSecond: 311_951_360, side: 8384 },
  { level: 51, samples: 8_912_896, perSecond: 588_251_136, side: 8384 },
  { level: 52, samples: 8_912_896, perSecond: 1_176_502_272, side: 8384 },
  { level: 60, samples: 35_651_584, perSecond: 1_176_502_272, side: 16_832 },
  { level: 61, samples: 35_651_584, perSecond: 2_353_004_544, side: 16_832 },
  { level: 62, samples: 35_651_584, perSecond: 4_706_009_088, side: 16_832 },
]

/**
 * The level of `vp09.00.LL.08` for this picture, as the two digits the string spells it in.
 *
 * Chrome does not refuse a VP9 encoder over its level, so nothing would fail if this were a
 * constant. It is computed because the string becomes the vpcC of a file, and a file that
 * understates its level is a file a hardware decoder with a table may refuse to open.
 */
export function vp9Level(g: EncodeGeometry): string {
  const samples = g.width * g.height
  const perSecond = samples * rate(g)
  const side = Math.max(g.width, g.height)
  const level = VP9_LEVELS.find(
    (l) => samples <= l.samples && perSecond <= l.perSecond && side <= l.side,
  )
  return String((level ?? VP9_LEVELS[VP9_LEVELS.length - 1]!).level).padStart(2, '0')
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
 * Quantizer per quality level on the VP9 rung, on libvpx's 0–63 scale.
 *
 * A different scale from the table above, so a table of its own: Chrome hands the number to
 * libvpx as its external quantizer, which libvpx maps onto an internal 0–255 index, and a VP9
 * file halves in size every eight or so steps of it where H.264 halves every six — measured with
 * ffmpeg's libvpx-vp9 at fixed quantizers from 20 to 48 on 720p material. Eight apart keeps the
 * three levels about a halving apart, as the H.264 three are. The middle row sits at the constant
 * quality Google's VP9 guidance gives for 720p to 1080p, which is where most clips are.
 */
export const VP9_QUANTIZERS: Record<ExportQuality, number> = { high: 26, medium: 34, low: 42 }

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
 * hardware measurement shows a repeatable minimum, then the floor returns as an enforced number.
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

const vp9Config = (g: EncodeGeometry): VideoEncoderConfig => ({
  // Profile 0, eight bits: what libvpx makes of the 4:2:0 frames a decoder hands over.
  codec: `vp09.00.${vp9Level(g)}.08`,
  width: g.width,
  height: g.height,
  framerate: g.framerate,
  hardwareAcceleration: 'prefer-software',
  bitrateMode: 'quantizer',
  latencyMode: 'quality',
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

  const vp9: Rung = {
    config: vp9Config(g),
    get choice(): Choice {
      return {
        kind: 'vp9-sw',
        config: vp9Config(g),
        control: 'quantizer',
        quantizer: VP9_QUANTIZERS[options.quality],
      }
    },
  }

  // VP9 is last in every arrangement, the H.264-only one included: it is not a codec the setting
  // chooses between, it is what stands between a browser with no H.264 encoder and no file.
  if (options.codec === 'h264') return [h264hw, h264sw, vp9]
  return hevcFirst(options) ? [hevc, h264hw, h264sw, vp9] : [h264hw, hevc, h264sw, vp9]
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

/** The picture a choice's configuration is about, read back off the configuration itself. */
const geometryOfConfig = (config: VideoEncoderConfig): EncodeGeometry => ({
  width: config.width,
  height: config.height,
  framerate: config.framerate ?? 0,
})

const QUALITY_LEVELS: ExportQuality[] = ['high', 'medium', 'low']

/**
 * The quality level a choice was made at, recovered from the choice itself; null for one that
 * `ladderFor` did not make.
 *
 * Recoverable because every rung states it in a number that differs per level: the quantizer
 * rungs by their quantizer — the three of each table are distinct on purpose — and the software
 * H.264 rung by the bitrate `bitrateFor` asks at the picture its configuration names.
 */
export function qualityOf(choice: EncodingChoice): ExportQuality | null {
  switch (choice.kind) {
    case 'hevc-hw':
    case 'h264-hw':
      return QUALITY_LEVELS.find((one) => QUANTIZERS[one] === choice.quantizer) ?? null
    case 'vp9-sw':
      return QUALITY_LEVELS.find((one) => VP9_QUANTIZERS[one] === choice.quantizer) ?? null
    case 'h264-sw': {
      const g = geometryOfConfig(choice.config)
      return QUALITY_LEVELS.find((one) => bitrateFor(g, one) === choice.bitrate) ?? null
    }
  }
}

/**
 * The same choice for another picture — size, rate, level and bitrate re-derived, nothing else
 * changed — or the choice itself when it is already about that picture.
 *
 * It exists because the probe and the plan count the picture in different numbers. The probe is
 * asked about `geometryOf(clip.crop, ctx.frameSize, …)`, and `frameSize` is the size the track
 * header declares; the plan cuts every frame to a rectangle normalised against the size the
 * samples are coded in (src/core/encode/plan.ts). Where those differ — an anamorphic track, a
 * header that rounds — an encoder configured from the probe's numbers is fed frames of another
 * size, and `VideoEncoder` does not refuse that: it scales them, and the sample entry, which
 * states the plan's size, then describes a stream that is not that size. The encoder has to be
 * configured with the size of what it is fed.
 *
 * A choice the ladder did not make keeps its codec family and profile and gets the level of the
 * new picture; its bitrate, where it has one, moves with the pixel rate.
 */
export function choiceAt(choice: EncodingChoice, g: EncodeGeometry): EncodingChoice {
  const was = geometryOfConfig(choice.config)
  if (was.width === g.width && was.height === g.height && was.framerate === g.framerate) {
    return choice
  }

  const quality = qualityOf(choice)
  if (quality) {
    const codec = choice.kind === 'hevc-hw' ? 'hevc' : 'h264'
    const rung = ladderFor(g, { codec, quality }).find((one) => one.choice.kind === choice.kind)
    if (rung) return rung.choice as EncodingChoice
  }

  const codec = choice.config.codec
  const config: VideoEncoderConfig = {
    ...choice.config,
    codec: codec.startsWith('avc')
      ? `${codec.slice(0, -2)}${avcLevelHex(g)}`
      : codec.startsWith('hev') || codec.startsWith('hvc')
        ? codec.replace(/\.([LH])\d+/, `.$1${hevcLevelIdc(g)}`)
        : codec.startsWith('vp09')
          ? codec.replace(/^(vp09\.\d{2})\.\d{2}/, `$1.${vp9Level(g)}`)
          : codec,
    width: g.width,
    height: g.height,
    framerate: g.framerate,
  }
  if (choice.kind !== 'h264-sw') return { ...choice, config }

  const scale = (g.width * g.height * rate(g)) / Math.max(1, was.width * was.height * rate(was))
  const bitrate = Math.round(choice.bitrate * scale)
  return { ...choice, config: { ...config, bitrate }, bitrate }
}

/**
 * The already-probed choice followed by codecs that can take over if a real encoder rejects it.
 *
 * `isConfigSupported` is advisory: a hardware encoder can answer true and still report
 * `EncodingError` when real frames arrive, and a software one can answer true and then not be
 * created at all — Yandex Browser says yes to `prefer-software` H.264 and fails with "Failed to
 * create OpenH264 encoder", because it ships without OpenH264. So every rung below the probed
 * one is a place to land, down to VP9, the one encoder every Chromium build carries. The quality
 * is recovered from the choice itself (see `qualityOf`); a choice this file did not make has
 * nothing to be translated into and stays alone.
 *
 * There is no `hardwareAcceleration: 'no-preference'` H.264 rung, deliberately: it is not a third
 * encoder. Chrome resolves it to the platform's hardware encoder where there is one and to
 * OpenH264 where there is not. Measured: on this project's Chromium it takes a constant bitrate
 * and refuses a quantizer with "Unsupported bitrate mode", which is OpenH264's answer, and on
 * Yandex it fails with the same "Failed to create OpenH264 encoder" the software rung does. Both
 * of those are rungs here already, each named in the failure; a rung that can only repeat one of
 * them would cost the one browser this list was extended for a whole extra failed attempt.
 */
export function runtimeChoices(
  first: EncodingChoice,
  geometry: EncodeGeometry,
): EncodingChoice[] {
  const quality = qualityOf(first)
  if (!quality) return [first]

  const rungs = ladderFor(geometry, { codec: 'h264', quality }).map(
    (rung) => rung.choice as EncodingChoice,
  )
  // Everything below the probed rung, in the ladder's own order. HEVC is only ever tried above
  // both H.264 rungs, so all of them are below it.
  const below =
    first.kind === 'hevc-hw'
      ? rungs
      : rungs.slice(rungs.findIndex((rung) => rung.kind === first.kind) + 1)
  return [first, ...below]
}
