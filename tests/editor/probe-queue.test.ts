import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Choice, EncodeGeometry } from '../../src/core/encode/codec'
import { createProbeQueue, PROBE_SETTLE_MS } from '../../src/editor/export/probe-queue'

const at = (width: number, height = 240): [string, EncodeGeometry] => [
  `${width}x${height}@25`,
  { width, height, framerate: 25 },
]

const wanted = (...widths: number[]): Map<string, EncodeGeometry> => new Map(widths.map((one) => at(one)))

const none = (key: string): Choice => ({ kind: 'none', tried: [key] })

/**
 * A ladder that answers only when told to, and remembers how many of it were running at once.
 *
 * The browser's `isConfigSupported` is the thing being protected: one question in flight builds a
 * real software encoder, so the number that matters is the peak of open ladders, not the total.
 */
function ladder() {
  const asked: string[] = []
  const open = new Map<string, (choice: Choice) => void>()
  let peak = 0

  const choose = (g: EncodeGeometry): Promise<Choice> => {
    const key = `${g.width}x${g.height}@${g.framerate}`
    asked.push(key)
    return new Promise((resolve) => {
      open.set(key, resolve)
      peak = Math.max(peak, open.size)
    })
  }

  const answer = async (key: string): Promise<void> => {
    const resolve = open.get(key)
    if (!resolve) throw new Error(`${key} was not being asked`)
    open.delete(key)
    resolve(none(key))
    await vi.advanceTimersByTimeAsync(0)
  }

  return { asked, open, answer, choose, peak: () => peak }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the probe queue', () => {
  it('asks nothing while the rectangle is still moving, and only about where it stopped', async () => {
    const probe = ladder()
    const queue = createProbeQueue(probe.choose)

    // Forty rectangles a frame apart: a drag, an undo held down, a ratio button hammered.
    for (let step = 0; step < 40; step++) {
      queue.want(wanted(100 + step * 2))
      await vi.advanceTimersByTimeAsync(16)
    }
    expect(probe.asked).toEqual([])

    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS)
    expect(probe.asked).toEqual(['178x240@25'])
    queue.dispose()
  })

  it('runs one ladder at a time and still answers every geometry the document holds', async () => {
    const probe = ladder()
    const queue = createProbeQueue(probe.choose)
    const seen: Array<ReadonlyMap<string, Choice>> = []
    queue.subscribe((answers) => seen.push(answers))

    queue.want(wanted(320, 240, 160))
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS)
    expect([...probe.open.keys()]).toEqual(['320x240@25'])

    await probe.answer('320x240@25')
    expect([...probe.open.keys()]).toEqual(['240x240@25'])
    await probe.answer('240x240@25')
    await probe.answer('160x240@25')

    expect(probe.peak()).toBe(1)
    expect([...queue.answers().keys()]).toEqual(['320x240@25', '240x240@25', '160x240@25'])
    expect(seen.at(-1)).toBe(queue.answers())
    queue.dispose()
  })

  it('drops a geometry that stopped being wanted while another was being asked', async () => {
    const probe = ladder()
    const queue = createProbeQueue(probe.choose)

    queue.want(wanted(320))
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS)
    expect(probe.asked).toEqual(['320x240@25'])

    // The question in flight cannot be called back — the browser has no way to — so it is
    // allowed to finish. What was wanted for a moment behind it is never asked at all.
    queue.want(wanted(320, 200))
    queue.want(wanted(320, 180))
    queue.want(wanted(320, 140))
    await probe.answer('320x240@25')
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS)

    expect(probe.asked).toEqual(['320x240@25', '140x240@25'])
    queue.dispose()
  })

  it('never asks again about a geometry it has an answer for', async () => {
    const probe = ladder()
    const queue = createProbeQueue(probe.choose)

    queue.want(wanted(320))
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS)
    await probe.answer('320x240@25')

    queue.want(wanted(200))
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS)
    await probe.answer('200x240@25')

    // Reset, then the crop again: both answers are still good, and nothing is asked.
    queue.want(wanted(320))
    queue.want(wanted(200))
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS * 2)

    expect(probe.asked).toEqual(['320x240@25', '200x240@25'])
    queue.dispose()
  })

  it('does not hold back a document whose geometries did not change', async () => {
    const probe = ladder()
    const queue = createProbeQueue(probe.choose)

    queue.want(wanted(320))
    // A trim or a rename rebuilds the map with the same key in it. That is not a rectangle in
    // motion and must not keep pushing the question back.
    for (let step = 0; step < 10; step++) {
      await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS / 4)
      queue.want(wanted(320))
    }

    expect(probe.asked).toEqual(['320x240@25'])
    queue.dispose()
  })

  it('files a ladder that threw as an answer of no, so the Export button cannot wait for ever', async () => {
    const queue = createProbeQueue(() => Promise.reject(new Error('the browser threw')))

    queue.want(wanted(320))
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS)

    expect(queue.answers().get('320x240@25')).toMatchObject({ kind: 'none' })
    queue.dispose()
  })

  it('tells nobody anything after it is disposed', async () => {
    const probe = ladder()
    const queue = createProbeQueue(probe.choose)
    const listener = vi.fn()
    queue.subscribe(listener)

    queue.want(wanted(320))
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS)
    queue.dispose()
    await probe.answer('320x240@25')

    queue.want(wanted(200))
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS)

    expect(listener).not.toHaveBeenCalled()
    expect(probe.asked).toEqual(['320x240@25'])
  })
})
