import { defineConfig } from '@playwright/test'

/**
 * The sets, and what decides which a file belongs to.
 *
 * A whole run of this suite is minutes of wall clock, and a task that runs it four or five times
 * spends more of its life waiting than working. So the suite is split in two, and the line is
 * drawn by what a set is *for* rather than by what it costs: the working set is what an agent
 * runs after every change while a task is in hand, and it has to hold everything that the code
 * being changed could break — the hook, the bridge, triage, the popup, and every path that ends
 * in a saved file. The sweep is run once, when the task is finished, and it holds what breadth
 * and real time buy: the whole codec matrix, a minute of watching, the ordinary-file path with
 * its ranged reads, and the pages whose shape is the point.
 *
 * Nothing is in the sweep because it is slow. `webm.spec.ts` and `seek.spec.ts` cost twenty
 * seconds each and are in the working set, because a clip that loses its keyframe flags or grows
 * a hole is exactly what the work ahead can do; `two-player.spec.ts` costs eight and is in it for
 * the same reason. What is in the sweep is there because the question it answers does not change
 * while a task is being written.
 */
const SWEEP_ONLY = [
  // Eight codec and container pairings, each saved and then played back twice in real time. The
  // h264+aac row of it is what sound.spec.ts runs in the working set; the other seven answer
  // "does every pairing a site may serve come out whole", and that answer moves with the
  // container readers and not with a day's work.
  '**/codecs.spec.ts',
  // A minute of watching, in a minute of wall clock. The length is the whole of what it proves.
  '**/minute.spec.ts',
  // The ordinary-file path: a real HTTP host, real Range requests, a file read out of the
  // extension frame. Its own stage, and two browsers of real-time playback apiece.
  '**/plain.spec.ts',
  // One file on a page twice — bookkeeping of the registry, and thirty seconds of it.
  '**/twice.spec.ts',
  // Players inside frames and the badge over a page of fifty of them: the frame plumbing, which
  // the editor does not touch.
  '**/embedded.spec.ts',
]

/**
 * The measurements, and why they run by themselves.
 *
 * `overhead.spec.ts` prices `appendBuffer` with and without the extension and states the
 * difference in copies of a segment. Both halves of that fraction are wall-clock measurements of
 * this machine, and a neighbour running a browser on the other cores inflates them — but not by
 * the same amount, which is what makes it a problem and not merely noise. Run under three
 * workers, every one of its three clean rounds priced a copy above 20 µs and the lowest came out
 * at 21.7 against 15.0 alone; the overhead above it rose by less, and the verdict fell to 1.34
 * copies from 1.82. The test still passed. It had stopped being able to fail: a regression of a
 * whole copy would have fitted inside the room the inflated denominator gave it.
 *
 * `history-write-cost.spec.ts` is here for the same reason and had the same failure to show for
 * it. It times one write of 8 MiB, which costs 8.9–21.9 ms with the machine to itself. Under four
 * workers the very same write ran 16.6–37: the neighbours doubled the number and stretched its
 * tail, and the bound had to be widened until it cleared their worst rather than the write's. It
 * was set at 400 and named three regressions it could not see — the segmented write it was meant
 * to catch straddled that line at 369–420 and went green in four runs out of six. Alone, eighty
 * milliseconds is nearly four times the worst honest sample and a fifth of the cheapest
 * segmented one.
 *
 * So each gets a project of its own with one worker, and `dependencies` puts them after everything
 * else rather than beside it.
 */
const MEASURED = ['**/overhead.spec.ts', '**/history-write-cost.spec.ts']

/**
 * Four browsers at a time on eight cores.
 *
 * Each test drives one browser that spends most of its life waiting on media in real time, so the
 * cores are not the limit and the wall clock falls close to linearly with the workers. Measured
 * on this suite, headless, whole: 586 s at one worker, 203 s at three, 158 s at four.
 *
 * Four is where it stops paying. At six the run took 174 s — longer than the 170 s of four — and
 * the sum of the tests' own times rose from 599 s to 621 s: the workers were now taking time off
 * each other rather than off the clock. What four leaves is not idle cores anyway but the codec
 * matrix, which is one chain of 164 s and the floor of the whole run.
 *
 * Override with `--workers=` when a run needs to be watched.
 */
const WORKERS = 4

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  // Tests of one file share nothing — every one of them launches its own browser on its own
  // profile — so a file is spread over the pool like any other work.
  fullyParallel: true,
  workers: WORKERS,
  use: { trace: 'retain-on-failure' },
  projects: [
    // The sweep stands first, and the order is not cosmetic. Playwright hands work to the pool in
    // the order the projects are declared, so the working set queued first took all four workers
    // and the longest chain in the suite — the eight codec rows, pinned to one worker — could not
    // start until one of them came free at 54 s. Declared first, that chain starts at zero and
    // the working set fills in around it: the whole run fell from 222 s to 170 s for it.
    { name: 'sweep', testMatch: SWEEP_ONLY },
    { name: 'working', testIgnore: [...SWEEP_ONLY, ...MEASURED] },
    // Last, and alone: see MEASURED. A failure anywhere else skips it, which is the price of
    // ordering it this way and is paid on a run that is red already.
    { name: 'measured', testMatch: MEASURED, workers: 1, dependencies: ['working', 'sweep'] },
  ],
})
