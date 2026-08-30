import { test, expect, type Page } from '@playwright/test'
import * as esbuild from 'esbuild'
import path from 'node:path'
import { launchWithExtension, openExtensionPage } from './helpers'

/**
 * What this machine can and cannot encode — stated out loud, and checked.
 *
 * Everything else in this stage rests on a premise: the browser the suite runs in has no hardware
 * encoder and no HEVC, so a re-encoded clip here comes out of the software H.264 rung and only
 * that one. A premise that is merely believed is worth nothing — "the export worked" would then
 * mean "the fallback worked" while reading like "the ladder worked" — so it is asserted here, in
 * the browser, by asking the browser rather than by asking our code.
 *
 * Which means this file is the one file of the suite that is *supposed* to go red on better
 * hardware. What that red means is written out at the bottom.
 */

const HD = { width: 1920, height: 1080 }
const UHD = { width: 3840, height: 2160 }
const SD = { width: 640, height: 360 }

/** Asks the browser itself, one configuration at a time, and never mistakes a throw for a yes. */
async function answers(page: Page, configs: VideoEncoderConfig[]): Promise<boolean[]> {
  return page.evaluate(async (list: VideoEncoderConfig[]) => {
    const out: boolean[] = []
    for (const config of list) {
      try {
        out.push((await VideoEncoder.isConfigSupported(config)).supported === true)
      } catch {
        out.push(false)
      }
    }
    return out
  }, configs)
}

/** A page of the extension: the origin the editor actually encodes on. */
async function encodingPage(): Promise<{ page: Page; close: () => Promise<void> }> {
  const { context, extensionId } = await launchWithExtension()
  const page = await openExtensionPage(context, extensionId, 'options/options.html')
  return { page, close: () => context.close() }
}

test('has no HEVC encoder at all: three levels, two demands, six refusals', async () => {
  const { page, close } = await encodingPage()

  try {
    const configs: VideoEncoderConfig[] = []
    for (const accel of ['prefer-hardware', 'no-preference'] as const) {
      for (const [codec, size] of [
        ['hev1.1.6.L93.B0', SD],
        ['hev1.1.6.L120.B0', HD],
        ['hev1.1.6.L150.B0', UHD],
      ] as const) {
        configs.push({ codec, ...size, framerate: 30, hardwareAcceleration: accel })
      }
    }

    // `no-preference` is half the point: it lets the browser answer with any implementation it
    // has, hardware or software, so a no there is a no about HEVC and not about hardware.
    expect(await answers(page, configs)).toEqual([false, false, false, false, false, false])

    // And the refusal is not an artifact of what is asked beside the codec: the same six with the
    // quantizer control the hardware rungs use, and with the plain constant bitrate below them.
    const withControls = configs.flatMap((config) => [
      { ...config, bitrateMode: 'quantizer' as const },
      { ...config, bitrateMode: 'constant' as const, bitrate: 2_000_000 },
    ])
    expect(await answers(page, withControls)).toEqual(withControls.map(() => false))
  } finally {
    await close()
  }
})

test('has no hardware H.264 either, at any size the ladder asks about', async () => {
  const { page, close } = await encodingPage()

  try {
    // The three strings `avcLevelHex` computes for these three geometries: 3.0, 4.0, 5.1.
    const sizes = [
      { codec: 'avc1.64001e', ...SD },
      { codec: 'avc1.640028', ...HD },
      { codec: 'avc1.640033', ...UHD },
    ]
    const asked = sizes.flatMap((config) => [
      { ...config, framerate: 30, hardwareAcceleration: 'prefer-hardware' as const },
      {
        ...config,
        framerate: 30,
        hardwareAcceleration: 'prefer-hardware' as const,
        bitrateMode: 'quantizer' as const,
      },
    ])

    // Refused bare and refused in the configuration the ladder actually asks for, which separates
    // the two things a single row could not: there is no hardware encoder here, and the refusal
    // is not the quantizer control being unavailable.
    expect(await answers(page, asked)).toEqual(asked.map(() => false))
  } finally {
    await close()
  }
})

test('has software H.264, and that is the one rung of the ladder this machine can walk', async () => {
  const { page, close } = await encodingPage()

  try {
    const software = (codec: string, size: { width: number; height: number }): VideoEncoderConfig => ({
      codec,
      ...size,
      framerate: 30,
      hardwareAcceleration: 'prefer-software',
      bitrateMode: 'constant',
      bitrate: 2_000_000,
      latencyMode: 'quality',
      avc: { format: 'avc' },
    })

    // Without this row the two above would be indistinguishable from a browser with no WebCodecs
    // at all, or a page where every question throws: they are all-false either way.
    expect(
      await answers(page, [
        software('avc1.64001e', SD),
        software('avc1.640028', HD),
        software('avc1.640033', UHD),
      ]),
    ).toEqual([true, true, true])
  } finally {
    await close()
  }
})

test('walks the whole ladder down to the software rung, whatever the codec setting says', async () => {
  const { page, close } = await encodingPage()

  try {
    // Our two modules, bundled and handed to the page: `chooseCodec` over the live probe, which
    // is the pair the editor uses. Nothing here is faked — the answers come from the browser.
    const built = await esbuild.build({
      stdin: {
        contents: [
          `import { chooseCodec, cacheKeyOf } from './src/core/encode/codec'`,
          `import { cachedProbe, liveProbe } from './src/editor/export/support'`,
          `Object.assign(globalThis, { tcEncode: { chooseCodec, cacheKeyOf, cachedProbe, liveProbe } })`,
        ].join('\n'),
        resolveDir: path.resolve('.'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'iife',
      target: 'chrome120',
      logLevel: 'silent',
    })
    await page.evaluate(built.outputFiles[0]!.text)

    const walked = await page.evaluate(async () => {
      const { chooseCodec, cacheKeyOf, cachedProbe, liveProbe } = (
        globalThis as unknown as {
          tcEncode: {
            chooseCodec: (
              g: { width: number; height: number; framerate: number },
              probe: (config: VideoEncoderConfig) => Promise<boolean>,
              options: { codec: string; quality: string },
            ) => Promise<{ kind: string; config?: VideoEncoderConfig; tried?: string[] }>
            cacheKeyOf: (config: VideoEncoderConfig) => string
            cachedProbe: (
              probe: (config: VideoEncoderConfig) => Promise<boolean>,
            ) => (config: VideoEncoderConfig) => Promise<boolean>
            liveProbe: () => (config: VideoEncoderConfig) => Promise<boolean>
          }
        }
      ).tcEncode

      const out: Array<{ setting: string; kind: string; codec?: string; accel?: string; asked: string[] }> = []
      for (const setting of ['auto', 'hevc', 'h264']) {
        const asked: string[] = []
        const live = liveProbe()
        const probe = cachedProbe(async (config: VideoEncoderConfig) => {
          asked.push(cacheKeyOf(config))
          return live(config)
        })
        const choice = await chooseCodec({ width: 1920, height: 1080, framerate: 30 }, probe, {
          codec: setting,
          quality: 'high',
        })
        out.push({
          setting,
          kind: choice.kind,
          codec: choice.config?.codec,
          accel: choice.config?.hardwareAcceleration,
          asked,
        })
      }
      return out
    })

    for (const run of walked) {
      expect(run.kind, `the codec setting ${run.setting} landed somewhere else`).toBe('h264-sw')
      expect(run.codec).toBe('avc1.640028')
      expect(run.accel).toBe('prefer-software')
    }

    // The fallback happened because the browser refused, not because the ladder never asked: the
    // run that puts HEVC first did ask about HEVC, and it did ask about hardware H.264. Without
    // this the three greens above would be equally green if `chooseCodec` returned the software
    // rung unconditionally — which is exactly the shape of bug this whole file exists to catch.
    expect(walked.find((run) => run.setting === 'hevc')!.asked).toEqual([
      'hev1.1.6.L120.B0|1920x1080@30|prefer-hardware|quantizer|default',
      'avc1.640028|1920x1080@30|prefer-hardware|quantizer|default',
      'avc1.640028|1920x1080@30|prefer-software|constant|6220800',
    ])
    expect(walked.find((run) => run.setting === 'h264')!.asked).toEqual([
      'avc1.640028|1920x1080@30|prefer-hardware|quantizer|default',
      'avc1.640028|1920x1080@30|prefer-software|constant|6220800',
    ])
  } finally {
    await close()
  }
})

/**
 * If this file is red, read it before reading anything else.
 *
 * It describes the machine the suite is running on, not the code. Every green here says "this
 * browser has no hardware encoder and no HEVC", and a red one says the suite has moved to a
 * machine that has them — which is good news for the extension and bad news for every conclusion
 * drawn from the rest of the stage. On such a machine:
 *
 *  - "the re-encoding path works" has been proven for the software rung and for nothing else;
 *    the hardware rungs and HEVC have never once been executed, only chosen (unit tests) and
 *    refused (here);
 *  - `docs/manual-checks-windows.md` is the list of what only that machine can answer, and it is
 *    the thing to work through rather than this file;
 *  - do not relax the expectations below to make this pass. Rewrite them to state what the new
 *    machine actually answers, and say in the commit which machine that was.
 */
