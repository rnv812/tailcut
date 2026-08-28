import { test, expect, type Page } from '@playwright/test'
import { clickEdit, recordPlayer } from './helpers'

/** The fixture the test page plays: 24 fps, 144 frames, a keyframe every 24. */
const FPS = 24
const FRAMES = 144
/** Half a frame: the widest a landing may miss by and still be the right frame. */
const HALF_FRAME = 1 / FPS / 2

/**
 * Starts recording what the element actually shows.
 *
 * requestVideoFrameCallback fires once per presented frame and reports the time of that frame,
 * which is the only honest answer to "which frame is on screen" — currentTime says what was
 * asked for, and asking is what is under test.
 */
async function watch(editor: Page): Promise<void> {
  await editor.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement & {
      requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number }) => void): number
    }
    const store = window as unknown as { tcShown: number[]; tcSeeks: number }
    store.tcShown = []
    store.tcSeeks = 0
    video.addEventListener('seeked', () => (store.tcSeeks += 1))

    const tick = (_now: number, meta: { mediaTime: number }) => {
      store.tcShown.push(meta.mediaTime)
      video.requestVideoFrameCallback(tick)
    }
    video.requestVideoFrameCallback(tick)
  })
}

const shown = (editor: Page) =>
  editor.evaluate(() => {
    const store = window as unknown as { tcShown: number[] }
    return store.tcShown[store.tcShown.length - 1] ?? -1
  })

const seeks = (editor: Page) =>
  editor.evaluate(() => (window as unknown as { tcSeeks: number }).tcSeeks)

/** Waits until the element has settled on the frame the readout claims. */
async function settled(editor: Page, index: number): Promise<void> {
  await expect(editor.getByTestId('frame')).toHaveText(String(index + 1))
  await expect(editor.getByTestId('stale')).toHaveCount(0)
  await editor.waitForFunction(
    (expected: number) => {
      const store = window as unknown as { tcShown: number[] }
      const last = store.tcShown[store.tcShown.length - 1]
      return last !== undefined && Math.abs(last - expected) < 1 / 48
    },
    index / FPS,
    { timeout: 10_000 },
  )
}

async function openEditor(): Promise<{ close: () => Promise<void>; editor: Page }> {
  const { context, player, extensionId } = await recordPlayer()
  const { editor } = await clickEdit(context, player, extensionId)

  await expect(editor.getByTestId('frame-count')).toHaveText(String(FRAMES))
  await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
  await watch(editor)

  return { editor, close: () => context.close() }
}

test('a step forward lands in the frame and not beside it', async () => {
  const { editor, close } = await openEditor()

  try {
    // Thirty steps in a row, each of them checked: were the seek asked for the boundary of a
    // frame rather than its middle, every landing would be one frame early.
    for (let at = 1; at <= 30; at++) {
      await editor.getByTestId('next').click()
      await settled(editor, at)
      expect(Math.abs((await shown(editor)) - at / FPS)).toBeLessThan(HALF_FRAME)
    }
  } finally {
    await close()
  }
})

test('a step lands deep inside a group of pictures and at the edges of the material', async () => {
  const { editor, close } = await openEditor()

  try {
    // A second at a time is Shift with an arrow; a keyframe every 24 frames puts 40 sixteen
    // frames deep into its group.
    await editor.keyboard.press('Shift+ArrowRight')
    await settled(editor, 24)
    for (let at = 25; at <= 40; at++) {
      await editor.getByTestId('next').click()
    }
    await settled(editor, 40)
    expect(Math.abs((await shown(editor)) - 40 / FPS)).toBeLessThan(HALF_FRAME)

    // Backwards across the boundary of a group.
    for (let at = 39; at >= 20; at--) await editor.getByTestId('prev').click()
    await settled(editor, 20)
    expect(Math.abs((await shown(editor)) - 20 / FPS)).toBeLessThan(HALF_FRAME)

    // The last frame: a step of a second runs into the edge and does not go past it.
    for (let at = 0; at < 10; at++) await editor.keyboard.press('Shift+ArrowRight')
    await settled(editor, FRAMES - 1)
    expect(Math.abs((await shown(editor)) - (FRAMES - 1) / FPS)).toBeLessThan(HALF_FRAME)
    await expect(editor.getByTestId('next')).toBeDisabled()

    // And the first.
    for (let at = 0; at < 10; at++) await editor.keyboard.press('Shift+ArrowLeft')
    await settled(editor, 0)
    expect(await shown(editor)).toBeLessThan(HALF_FRAME)
    await expect(editor.getByTestId('prev')).toBeDisabled()
  } finally {
    await close()
  }
})

/**
 * What this measures, and what it does not.
 *
 * Thirty repeats arriving in one turn are batched by the renderer into a single update, so what
 * is under test here is the composition of the steps and not the suppression of a queue: the
 * handler adds a delta to the playhead rather than setting a number, and thirty handlers reading
 * one stale index would move the picture on by a single frame. That failure is a real one and it
 * is this test's own — the first draft of the stepper had it.
 *
 * The queue is a different claim: a seek asked for while another is in flight is dropped and the
 * last request wins. It is measured where it can be, in `tests/editor/seek.test.ts` ("keeps one
 * seek in flight" and "catches up to the last request afterwards"), over an element that finishes
 * a seek only when told to. A browser cannot be made to do that: the presses would have to be
 * spaced further apart than a decode, and then every one of them is answered and there is no
 * queue to suppress. This test used to carry the queue's name and the seek count below is all
 * that was left of the claim — one batched step costs the element one seek, no more.
 */
test('a burst of key repeats composes into one step instead of racing', async () => {
  const { editor, close } = await openEditor()

  try {
    const before = await seeks(editor)

    // Thirty repeats in one go, the way a held arrow arrives on a fast key repeat.
    await editor.evaluate(() => {
      for (let at = 0; at < 30; at++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      }
    })

    // Thirty frames on and not one: the readout followed the keyboard at once, and every press
    // of the burst counted. Set rather than added, the whole burst would read "2" here.
    await expect(editor.getByTestId('frame')).toHaveText('31')

    await settled(editor, 30)
    expect(Math.abs((await shown(editor)) - 30 / FPS)).toBeLessThan(HALF_FRAME)
    expect(
      (await seeks(editor)) - before,
      'one composed step cost the element more than one seek',
    ).toBeLessThanOrEqual(3)
  } finally {
    await close()
  }
})

test('ordinary playback runs and carries the frame number with it', async () => {
  const { editor, close } = await openEditor()

  try {
    await editor.getByTestId('play').click()
    await expect(editor.getByTestId('play')).toHaveText('Pause')

    // A second of playback has to move the frame number on by a good deal more than one step.
    await editor.waitForTimeout(1_000)
    const running = Number(await editor.getByTestId('frame').textContent())
    expect(running).toBeGreaterThan(10)

    await editor.getByTestId('play').click()
    await expect(editor.getByTestId('play')).toHaveText('Play')

    // Stopped, and stepping from here is exact again.
    const stopped = Number(await editor.getByTestId('frame').textContent())
    await editor.getByTestId('next').click()
    await settled(editor, stopped)
    expect(Math.abs((await shown(editor)) - stopped / FPS)).toBeLessThan(HALF_FRAME)
  } finally {
    await close()
  }
})

test('the timecode and the frame number agree with each other', async () => {
  const { editor, close } = await openEditor()

  try {
    await expect(editor.getByTestId('timecode')).toHaveText('00:00:00:00')

    await editor.keyboard.press('Shift+ArrowRight')
    await settled(editor, 24)
    await expect(editor.getByTestId('timecode')).toHaveText('00:00:01:00')

    await editor.getByTestId('next').click()
    await settled(editor, 25)
    await expect(editor.getByTestId('timecode')).toHaveText('00:00:01:01')
  } finally {
    await close()
  }
})
