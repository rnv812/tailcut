import { describe, it, expect } from 'vitest'
import {
  BITS_PER_PIXEL,
  QUANTIZERS,
  avcLevelHex,
  bitrateFor,
  cacheKeyOf,
  chooseCodec,
  hevcLevelIdc,
  ladderFor,
  type EncodeGeometry,
  type EncodingChoice,
  type LadderOptions,
  type Probe,
} from '../../src/core/encode/codec'
import type { ExportQuality } from '../../src/shared/settings'

const geometry = (width: number, height: number, framerate: number): EncodeGeometry => ({
  width,
  height,
  framerate,
})

const config = (over: Partial<VideoEncoderConfig> = {}): VideoEncoderConfig => ({
  codec: 'avc1.640028',
  width: 1920,
  height: 1080,
  framerate: 30,
  hardwareAcceleration: 'prefer-hardware',
  ...over,
})

describe('avcLevelHex', () => {
  it('gives 4.0 for an ordinary 1080p30 picture', () => {
    // 120 × 68 = 8160 macroblocks and 244 800 a second, both under the 8192 / 245 760 of level
    // 4.0 — which is why a hardcoded `avc1.640028` looked right for as long as nobody cropped.
    expect(avcLevelHex(geometry(1920, 1080, 30))).toBe('28')
  })

  it('gives 5.1 for 4K30, and that difference is the measured refusal', () => {
    // 240 × 135 = 32 400 macroblocks, four times what level 4.0 admits: `avc1.640028` is refused
    // at 4K, both H.264 rungs fall with it, and the clip is told there is no encoder on a
    // machine that encodes 4K perfectly well. 32 400 ≤ 36 864 and 972 000 ≤ 983 040 → 5.1.
    expect(avcLevelHex(geometry(3840, 2160, 30))).toBe('33')
    expect(avcLevelHex(geometry(3840, 2160, 30))).not.toBe('28')
  })

  it('climbs to 5.2 at 4K60, where 5.1 runs out of rate rather than size', () => {
    // The same 32 400 macroblocks fit 5.1, but 1 944 000 a second is past its 983 040. The frame
    // size alone would have kept the level; the framerate is a third of the question.
    expect(avcLevelHex(geometry(3840, 2160, 60))).toBe('34')
  })

  it('gives 3.0 for a small picture — the lowest row the table carries', () => {
    // 40 × 23 = 920 macroblocks, 27 600 a second. Nothing below 3.0 is worth a row: a level that
    // never wins is a row to keep correct for nobody.
    expect(avcLevelHex(geometry(640, 360, 30))).toBe('1e')
  })
})

describe('hevcLevelIdc', () => {
  it('gives 4.0 at 1080p and 5.0 at 4K, in the 30×L the string carries', () => {
    // 2 073 600 luma samples ≤ 2 228 224 and 62 208 000 a second ≤ 66 846 720 → level 4.0, idc
    // 120. At 4K30 the samples alone (8 294 400) are past 4.1 and land on 5.0, idc 150.
    expect(hevcLevelIdc(geometry(1920, 1080, 30))).toBe(120)
    expect(hevcLevelIdc(geometry(3840, 2160, 30))).toBe(150)
    // And the rate counts here too: the same 4K frame at 60 is 497 664 000 samples a second,
    // past the 267 386 880 of 5.0, so it lands on 5.1 — idc 153.
    expect(hevcLevelIdc(geometry(3840, 2160, 60))).toBe(153)
  })
})

describe('cacheKeyOf', () => {
  it('tells apart two configurations that differ in the framerate alone', () => {
    // Measured: hardware HEVC says yes at 3840×2160@30 and no at the same frame at 60. A key
    // that dropped the framerate would answer the 60 with what it learned about the 30.
    expect(cacheKeyOf(config({ framerate: 30 }))).not.toBe(cacheKeyOf(config({ framerate: 60 })))
  })

  it('tells apart two configurations that differ in the acceleration demanded alone', () => {
    // The software rung is the same codec at the same size: a key without the acceleration would
    // let the refusal of hardware answer for the software rung below it, and the ladder would
    // stop one step above the step that works.
    expect(cacheKeyOf(config({ hardwareAcceleration: 'prefer-hardware' }))).not.toBe(
      cacheKeyOf(config({ hardwareAcceleration: 'prefer-software' })),
    )
  })

  it('holds the whole question — codec, size, framerate, acceleration — and not one boolean', () => {
    // Written out in full because this is the shape of the bug §8.4 names: one flag per install
    // is a key with none of these four in it, and it answers about a clip nobody asked about.
    expect(cacheKeyOf(config())).toBe('avc1.640028|1920x1080@30|prefer-hardware')
    expect(cacheKeyOf(config({ codec: 'hev1.1.6.L150.B0', width: 3840, height: 2160 }))).toBe(
      'hev1.1.6.L150.B0|3840x2160@30|prefer-hardware',
    )
    // A configuration that demands nothing is its own question, not the same one as either demand.
    expect(cacheKeyOf(config({ hardwareAcceleration: undefined }))).toBe(
      'avc1.640028|1920x1080@30|no-preference',
    )
  })
})

/**
 * A probe made of a rule, keeping every question it was asked and the order it was asked in.
 *
 * The whole ladder is a pure function over this, which is what makes all four of its outcomes
 * reachable here: the machine this runs on has no hardware encoder and no HEVC at all, so three
 * of the four are unreachable in a browser and none of them is unreachable in this file.
 */
const probeOf = (
  grants: (config: VideoEncoderConfig) => boolean,
): { probe: Probe; asked: string[] } => {
  const asked: string[] = []
  return {
    probe: async (candidate) => {
      asked.push(cacheKeyOf(candidate))
      return grants(candidate)
    },
    asked,
  }
}

/** A machine where everything is granted — the only place both hardware rungs can be seen. */
const everything = (): boolean => true

/** A machine with no encoder at all: the answer is `none`, and it is an answer, not a failure. */
const nothing = (): boolean => false

/** This machine, as measured: software H.264 and not one hardware configuration of anything. */
const softwareOnly = (candidate: VideoEncoderConfig): boolean =>
  candidate.hardwareAcceleration !== 'prefer-hardware'

const HD = geometry(1920, 1080, 30)
const UHD = geometry(3840, 2160, 30)

const keysOf = (g: EncodeGeometry, options: LadderOptions): string[] =>
  ladderFor(g, options).map((rung) => cacheKeyOf(rung.config))

/**
 * The three quality levels, held to being three.
 *
 * Nothing above this block would notice if they were made equal: every assertion about a
 * quantizer reads `QUANTIZERS[…]` for the number it expects, so a table of three identical rows
 * satisfies all of them, and `bitrateFor` was only ever spelled out at `low`. Both tables were
 * mutated to check it — one quantizer for all three levels and a `high` of 0.9 bits a pixel —
 * and the whole suite stayed green. What the levels are worth is that they differ; that is what
 * is written out here.
 */
describe('the ladder of quality', () => {
  const LEVELS: ExportQuality[] = ['high', 'medium', 'low']

  it('is three quantizers, spaced far enough apart to be seen', () => {
    expect(QUANTIZERS).toEqual({ high: 22, medium: 27, low: 33 })

    // Six steps of this scale halve the bitrate, which is where the spacing comes from: a step
    // of five is most of a halving, and three levels closer together than that would be three
    // names for one file. Written as the property and not only as the numbers, so that a future
    // retune has to keep the promise the comment beside the table makes.
    expect(QUANTIZERS.medium - QUANTIZERS.high).toBeGreaterThanOrEqual(5)
    expect(QUANTIZERS.low - QUANTIZERS.medium).toBeGreaterThanOrEqual(5)
    expect(QUANTIZERS.low - QUANTIZERS.high).toBeGreaterThanOrEqual(11)

    // And all three on the scale both codecs count on: 0–51. A quantizer off it is not a worse
    // picture, it is a configuration the encoder refuses.
    for (const level of LEVELS) {
      expect(QUANTIZERS[level], `${level} is off the 0–51 scale`).toBeGreaterThanOrEqual(0)
      expect(QUANTIZERS[level], `${level} is off the 0–51 scale`).toBeLessThanOrEqual(51)
    }
  })

  it('is three asks on the software rung, each smaller than the one above it', () => {
    expect(BITS_PER_PIXEL).toEqual({ high: 0.1, medium: 0.07, low: 0.045 })
    expect(BITS_PER_PIXEL.high).toBeGreaterThan(BITS_PER_PIXEL.medium)
    expect(BITS_PER_PIXEL.medium).toBeGreaterThan(BITS_PER_PIXEL.low)

    // Spelled out at all three and not at `low` alone: 1080p30 is 62.2 million pixels a second,
    // so an eyeball cannot tell 0.1 from 0.9 in a megabit count, and the number below is the one
    // the panel will show. High is a little over 6 Mbit/s — the rate the large sites serve
    // 1080p at (see REFERENCE_BITS_PER_SECOND) — and low is under 3.
    expect(bitrateFor(HD, 'high')).toBe(6_220_800)
    expect(bitrateFor(HD, 'medium')).toBe(4_354_560)
    expect(bitrateFor(HD, 'low')).toBe(2_799_360)
  })

  it('carries all three the whole way through the ladder, hardware rung and software', async () => {
    // The tables are one half; that the choice is made from the level asked for is the other. A
    // ladder that read one row of them would still hand back a configuration, and every claim
    // above would still hold.
    const quantizers: number[] = []
    const bitrates: number[] = []

    for (const quality of LEVELS) {
      const hardware = await chooseCodec(HD, probeOf(everything).probe, { codec: 'h264', quality })
      expect(hardware).toMatchObject({ kind: 'h264-hw', control: 'quantizer' })
      quantizers.push((hardware as { quantizer: number }).quantizer)

      const software = await chooseCodec(HD, probeOf(softwareOnly).probe, { codec: 'h264', quality })
      expect(software).toMatchObject({ kind: 'h264-sw', control: 'fixed-bitrate' })
      bitrates.push((software as { bitrate: number }).bitrate)
    }

    expect(quantizers).toEqual([QUANTIZERS.high, QUANTIZERS.medium, QUANTIZERS.low])
    expect(new Set(quantizers).size, 'two quality levels ask the encoder for the same picture').toBe(3)
    expect(bitrates).toEqual([bitrateFor(HD, 'high'), bitrateFor(HD, 'medium'), bitrateFor(HD, 'low')])
    expect(new Set(bitrates).size, 'two quality levels ask for the same number of bits').toBe(3)
  })
})

describe('chooseCodec', () => {
  it('takes the codec the setting names, and never asks about the one it was not asked for', async () => {
    const asked = probeOf(everything)
    expect(await chooseCodec(HD, asked.probe, { codec: 'hevc', quality: 'high' })).toMatchObject({
      kind: 'hevc-hw',
      control: 'quantizer',
      quantizer: QUANTIZERS.high,
    })

    const h264 = probeOf(everything)
    const choice = await chooseCodec(HD, h264.probe, { codec: 'h264', quality: 'high' })
    expect(choice).toMatchObject({ kind: 'h264-hw', control: 'quantizer', quantizer: QUANTIZERS.high })
    // Not merely "HEVC did not win": it was never a question. A user who asked for H.264 is not
    // told about a codec they ruled out, and the tab does not pay for probing it.
    expect(h264.asked).toEqual(['avc1.640028|1920x1080@30|prefer-hardware'])

    // Asked again on a machine that grants no hardware at all, so that the ladder is walked to
    // its end rather than stopping on its first rung: a claim about what is never asked is worth
    // nothing if the walk stops before the rung it is about.
    const walked = probeOf(softwareOnly)
    expect(await chooseCodec(HD, walked.probe, { codec: 'h264', quality: 'low' })).toMatchObject({
      kind: 'h264-sw',
    })
    expect(walked.asked.some((key) => key.startsWith('hev1'))).toBe(false)
    expect(walked.asked).toHaveLength(2)
  })

  it('reads auto as H.264, and reaches for HEVC only where the bits are few', async () => {
    // The measured advantage: +0.029 SSIM at 800 kbit/s and +0.0003 at 2 Mbit/s. So HEVC goes
    // first at `low` and nowhere else — at ordinary quality it would be paid for in players that
    // cannot open the file, for three ten-thousandths of an SSIM.
    const high = probeOf(everything)
    expect(await chooseCodec(HD, high.probe, { codec: 'auto', quality: 'high' })).toMatchObject({
      kind: 'h264-hw',
    })
    expect(high.asked[0]).toBe('avc1.640028|1920x1080@30|prefer-hardware')

    const medium = probeOf(everything)
    expect(await chooseCodec(HD, medium.probe, { codec: 'auto', quality: 'medium' })).toMatchObject({
      kind: 'h264-hw',
    })

    const low = probeOf(everything)
    expect(await chooseCodec(HD, low.probe, { codec: 'auto', quality: 'low' })).toMatchObject({
      kind: 'hevc-hw',
      quantizer: QUANTIZERS.low,
    })
    expect(low.asked[0]).toBe('hev1.1.6.L120.B0|1920x1080@30|prefer-hardware')
  })

  it('falls to software H.264 when nothing hardware is granted, and says so by its control', async () => {
    const asked = probeOf(softwareOnly)
    const choice = await chooseCodec(HD, asked.probe, { codec: 'auto', quality: 'high' })

    expect(choice).toMatchObject({ kind: 'h264-sw', control: 'fixed-bitrate' })
    // The narrowed type exists and this is a value of it: what `pathFor` and `encodeToTrack` are
    // handed after `none` has been ruled out.
    const encodable: EncodingChoice = choice as EncodingChoice
    expect(encodable.config.hardwareAcceleration).toBe('prefer-software')
    expect(encodable.config.bitrateMode).toBe('constant')
    // Both hardware rungs were asked and refused before it: the software rung is where the
    // ladder ended, not where it started.
    expect(asked.asked).toEqual(keysOf(HD, { codec: 'auto', quality: 'high' }))
  })

  it('answers "no encoder" rather than throwing, and names everything it tried', async () => {
    const asked = probeOf(nothing)
    const choice = await chooseCodec(HD, asked.probe, { codec: 'auto', quality: 'high' })

    expect(choice.kind).toBe('none')
    // The list is what the inspector turns into a sentence about this geometry, so it holds the
    // whole ladder in order — not the last rung, and not a bare boolean.
    expect(choice).toEqual({
      kind: 'none',
      tried: [
        'avc1.640028|1920x1080@30|prefer-hardware',
        'hev1.1.6.L120.B0|1920x1080@30|prefer-hardware',
        'avc1.640028|1920x1080@30|prefer-software',
      ],
    })
    expect(asked.asked).toEqual(choice.kind === 'none' ? choice.tried : [])
  })

  it('asks about 4K with the level 4K needs, on both H.264 rungs', async () => {
    const asked = probeOf(nothing)
    await chooseCodec(UHD, asked.probe, { codec: 'auto', quality: 'high' })

    expect(asked.asked).toEqual([
      'avc1.640033|3840x2160@30|prefer-hardware',
      'hev1.1.6.L150.B0|3840x2160@30|prefer-hardware',
      'avc1.640033|3840x2160@30|prefer-software',
    ])
    // The bug this is here for: with a hardcoded 4.0 both H.264 rungs are refused at 4K and the
    // clip is told there is no encoder on a machine that encodes 4K.
    expect(asked.asked.some((key) => key.includes('avc1.640028'))).toBe(false)
  })

  it('lets a crop change the rung: a small frame is under the hardware threshold', async () => {
    // The measured behaviour of the machine the extension is installed on: its hardware encoder
    // refuses anything narrower than 130 or shorter than 34, and software takes everything.
    const measured = (candidate: VideoEncoderConfig): boolean =>
      candidate.hardwareAcceleration !== 'prefer-hardware' ||
      (candidate.width >= 130 && candidate.height >= 34)

    const cropped = probeOf(measured)
    expect(
      await chooseCodec(geometry(128, 72, 30), cropped.probe, { codec: 'auto', quality: 'high' }),
    ).toMatchObject({ kind: 'h264-sw' })

    // The same probe, the same settings, the whole frame: hardware. The crop is what moved it,
    // and a support answer cached per install would have said one of these about both.
    const whole = probeOf(measured)
    expect(await chooseCodec(HD, whole.probe, { codec: 'auto', quality: 'high' })).toMatchObject({
      kind: 'h264-hw',
    })
  })

  it('asks the software rung for exactly bitrateFor, with no floor raising it', async () => {
    const asked = probeOf(softwareOnly)
    const choice = await chooseCodec(HD, asked.probe, { codec: 'auto', quality: 'low' })

    expect(choice).toMatchObject({ kind: 'h264-sw', bitrate: bitrateFor(HD, 'low') })
    expect(bitrateFor(HD, 'low')).toBe(Math.round(1920 * 1080 * 30 * 0.045))

    // Asked again on the smallest picture a crop can leave, where any floor worth writing would
    // be visible: 128 × 72 × 30 × 0.045 is 12 442 bits a second, and a floor of even one megabit
    // would multiply it by eighty. At 1080p a floor hides — the ask is already megabits — so a
    // test that only ever looked at 1080p would let one in without noticing.
    const small = geometry(128, 72, 30)
    const cropped = probeOf(softwareOnly)
    expect(await chooseCodec(small, cropped.probe, { codec: 'auto', quality: 'low' })).toMatchObject({
      kind: 'h264-sw',
      bitrate: 12_442,
    })
    expect(bitrateFor(small, 'low')).toBe(12_442)

    // Counted out loud, because the code has no floor in it and this is why. openh264 was
    // measured writing 1.97 Mbit/s when asked for 0.4 at 1080p30 — that is 0.0317 bits a pixel,
    // and the lowest quality of the ladder asks for 0.045. Both numbers are the same linear
    // function of width × height × fps, so the ask is above the floor at every geometry: a
    // `Math.max` between them would be a branch no input can reach.
    const measuredFloorBitsPerPixel = 1_970_000 / (1920 * 1080 * 30)
    expect(measuredFloorBitsPerPixel).toBeCloseTo(0.0317, 4)
    expect(measuredFloorBitsPerPixel).toBeLessThan(BITS_PER_PIXEL.low)
    for (const g of [HD, UHD, geometry(128, 72, 30), geometry(640, 360, 60)]) {
      expect(bitrateFor(g, 'low')).toBeGreaterThan(measuredFloorBitsPerPixel * g.width * g.height * g.framerate)
    }
  })

  it('walks exactly the ladder, in the ladder’s own order, whatever the setting says', async () => {
    // The ladder is the decision and the probe only says how far down it goes, so the order is a
    // thing a test can hold without a probe at all.
    for (const options of [
      { codec: 'auto', quality: 'high' },
      { codec: 'auto', quality: 'low' },
      { codec: 'hevc', quality: 'medium' },
      { codec: 'h264', quality: 'high' },
    ] as LadderOptions[]) {
      const asked = probeOf(nothing)
      const choice = await chooseCodec(HD, asked.probe, options)
      expect(asked.asked).toEqual(keysOf(HD, options))
      expect(choice).toEqual({ kind: 'none', tried: keysOf(HD, options) })
    }

    // And the two hardware rungs are the only thing the setting reorders: H.264 alone never
    // grows an HEVC rung, and the software rung is last in every arrangement.
    expect(keysOf(HD, { codec: 'h264', quality: 'low' })).toEqual([
      'avc1.640028|1920x1080@30|prefer-hardware',
      'avc1.640028|1920x1080@30|prefer-software',
    ])
    expect(keysOf(HD, { codec: 'hevc', quality: 'high' })).toEqual([
      'hev1.1.6.L120.B0|1920x1080@30|prefer-hardware',
      'avc1.640028|1920x1080@30|prefer-hardware',
      'avc1.640028|1920x1080@30|prefer-software',
    ])
  })
})
