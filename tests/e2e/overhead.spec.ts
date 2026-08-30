import { test, expect, type BrowserContext } from '@playwright/test'
import { launchWithExtension, launchWithoutExtension, serveLocal } from './helpers'

const PAGE_URL = 'https://tailcut.test/measured'

/**
 * Number of repetitions per measurement. The difference under test is tens of microseconds per
 * call, while one scheduler interruption costs twice that. Three runs are enough for at least one
 * to complete without interference.
 */
const ROUNDS = 3

/**
 * Maximum overhead expressed as segment copies. The wrapper should cost one copy (`copyOf` in
 * `src/page/main-hook.ts`) plus queueing. Twenty-five runs on the development machine measured
 * 1.45 to 2.52 copies, averaging 1.91. Allocation, WeakMap lookup, and microtask queueing account
 * for the difference.
 *
 * Four leaves 1.6 times the worst measured result. The observed variance is ±25% and comes from
 * the machine, not the code. The limit catches work roughly 2.5 times more expensive than today,
 * including copying through a plain array (63–69 copies) or waiting on the synchronous path.
 * Byte-by-byte copying instead of `set` (4.2–5.4) is near the limit and can pass with a favorable
 * calibration. One extra copy (3.4) is below the noise, so this test does not claim to detect it.
 *
 * The threshold uses copies rather than milliseconds. Both values grow on a slower machine, while
 * their ratio remains comparable.
 */
const COPY_BUDGET = 4

interface Measurement {
  /** Total time spent inside appendBuffer, in milliseconds. */
  appendMs: number
  /** Number of samples included in the total. */
  appends: number
  /** Cost of `copyCount` copies of the same bytes on this machine, in milliseconds. */
  copyMs: number
  copyCount: number
}

declare global {
  interface Window {
    measured: boolean
    failure: string | null
    appendSamples: number[]
    copyBaselineMs: number
    copyCount: number
  }
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)

async function measure(withExtension: boolean): Promise<Measurement> {
  let context: BrowserContext
  if (withExtension) ({ context } = await launchWithExtension())
  else context = await launchWithoutExtension()

  try {
    const page = await context.newPage()
    await serveLocal(page, 'measured.html', PAGE_URL)

    // Wait for failure as well as success. Otherwise a failed page stays silent until timeout and
    // the test reports the timeout instead of its cause.
    await page.waitForFunction(() => window.measured || window.failure !== null, null, {
      timeout: 120_000,
    })

    const result = await page.evaluate(() => ({
      failure: window.failure,
      samples: window.appendSamples,
      copyMs: window.copyBaselineMs,
      copyCount: window.copyCount,
    }))

    expect(result.failure, 'the measurement page did not finish').toBeNull()

    return {
      appendMs: sum(result.samples),
      appends: result.samples.length,
      copyMs: result.copyMs,
      copyCount: result.copyCount,
    }
  } finally {
    await context.close()
  }
}

test('the wrappers keep appendBuffer synchronous-path overhead within budget', async () => {
  // Six browser runs with one hundred segments each exceed the default thirty-second timeout.
  test.setTimeout(300_000)

  const clean: Measurement[] = []
  const hooked: Measurement[] = []

  // Alternate modes instead of grouping them. The machine heats up and cools down during the run,
  // so measuring all clean runs before all extension runs would assign the drift to one side.
  for (let round = 0; round < ROUNDS; round++) {
    clean.push(await measure(false))
    hooked.push(await measure(true))
  }

  const appends = clean[0]!.appends
  expect(appends, 'the page must return measurements').toBeGreaterThan(0)
  for (const round of [...clean, ...hooked]) {
    expect(round.appends, 'all runs must have the same length').toBe(appends)
  }

  // Use the minimum rather than the median: the least interrupted run best represents call cost.
  // Extra work elsewhere on the machine is independent in each mode. A regression raises even the
  // minimum, while random interference does not.
  const perAppendUs = (rounds: Measurement[]): number =>
    (Math.min(...rounds.map((round) => round.appendMs)) / appends) * 1000

  const cleanUs = perAppendUs(clean)
  const hookedUs = perAppendUs(hooked)
  // Derive copy cost from clean runs because it is a machine property and should be measured when
  // the extension is not competing with the page.
  const copyUs = Math.min(...clean.map((round) => (round.copyMs / round.copyCount) * 1000))
  const copies = (hookedUs - cleanUs) / copyUs

  // Print every named run so a failure distinguishes one disrupted sample from a broad slowdown.
  for (const [name, rounds] of [
    ['without extension', clean],
    ['with extension', hooked],
  ] as const) {
    const perRound = rounds.map(
      (round) =>
        `${((round.appendMs / appends) * 1000).toFixed(1)}/${(
          (round.copyMs / round.copyCount) *
          1000
        ).toFixed(1)}`,
    )
    console.log(`  ${name} (µs per call / µs per copy): ${perRound.join('  ')}`)
  }
  console.log(
    `appendBuffer over ${appends} calls: without extension ${cleanUs.toFixed(1)} µs/call, ` +
      `with extension ${hookedUs.toFixed(1)} µs/call; ` +
      `overhead ${(hookedUs - cleanUs).toFixed(1)} µs = ${copies.toFixed(2)} segment copies ` +
      `(one copy is ${copyUs.toFixed(1)} µs)`,
  )

  expect(copies).toBeLessThan(COPY_BUDGET)
})
