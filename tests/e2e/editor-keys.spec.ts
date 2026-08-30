import { test, expect, type Page } from '@playwright/test'
import { clickEdit, recordPlayer } from './helpers'

/** The fixture the test page plays: 24 fps, 144 frames, a keyframe every 24. */
const FPS = 24
const FRAMES = 144

async function openEditor(): Promise<{ close: () => Promise<void>; editor: Page }> {
  const { context, player, extensionId } = await recordPlayer()
  const { editor } = await clickEdit(context, player, extensionId)

  await expect(editor.getByTestId('frame-count')).toHaveText(String(FRAMES))
  await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)

  return { editor, close: () => context.close() }
}

const frame = (editor: Page): Promise<number> =>
  editor.getByTestId('frame').textContent().then((text) => Number(text))

/**
 * Types into a timecode box and accepts it.
 *
 * The frame between the two is not decoration. The Enter handler on the node is the one the last
 * render put there, and it closes over the text of that render; filled and pressed inside one
 * turn it commits the text from before the fill. Two round trips over CDP are usually enough for
 * preact to have rendered in between — usually, which is to say not on a machine running the
 * whole suite: observed committing nothing at all under four workers.
 */
async function enter(editor: Page, id: string, value: string): Promise<void> {
  const box = editor.getByTestId(id)
  await box.fill(value)
  await editor.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0))),
  )
  await box.press('Enter')
}

test('cuts, splits and undoes a clip without the mouse', async () => {
  const { editor, close } = await openEditor()

  try {
    await editor.keyboard.press('Shift+ArrowRight')
    await expect(editor.getByTestId('frame')).toHaveText(String(FPS + 1))
    await editor.keyboard.press('i')

    // A clip begun at the playhead runs to the end of the run, and its In is where I was pressed.
    await expect(editor.getByTestId('clip')).toHaveCount(1)
    await expect(editor.getByTestId('in-c1')).toHaveValue('00:00:01:00')

    await editor.keyboard.press('Shift+ArrowRight')
    await editor.keyboard.press('Shift+ArrowRight')
    await editor.keyboard.press('o')
    await expect(editor.getByTestId('out-c1')).toHaveValue('00:00:03:00')

    // The cut needs room on both sides of it: a second back is the middle of the clip.
    await editor.keyboard.press('Shift+ArrowLeft')
    await editor.keyboard.press('s')
    await expect(editor.getByTestId('clip')).toHaveCount(2)

    await editor.keyboard.press('Control+z')
    await expect(editor.getByTestId('clip')).toHaveCount(1)
    await editor.keyboard.press('Control+Shift+z')
    await expect(editor.getByTestId('clip')).toHaveCount(2)
  } finally {
    await close()
  }
})

test('runs, shuttles and stops on the transport keys', async () => {
  const { editor, close } = await openEditor()

  try {
    await editor.keyboard.press('Space')
    await expect(editor.getByTestId('play')).toHaveText('Pause')
    await editor.keyboard.press('Space')
    await expect(editor.getByTestId('play')).toHaveText('Play')

    // L three times: 1×, 2×, 4×.
    await editor.keyboard.press('l')
    await editor.keyboard.press('l')
    await editor.keyboard.press('l')
    await expect(editor.getByTestId('rate')).toContainText('4×')
    await editor.waitForTimeout(600)
    const ran = await frame(editor)
    expect(ran).toBeGreaterThan(20)

    await editor.keyboard.press('k')
    await expect(editor.getByTestId('rate')).toHaveCount(0)
    const stopped = await frame(editor)

    // J walks back, and the playhead follows the keyboard rather than the decoder.
    await editor.keyboard.press('j')
    await editor.keyboard.press('j')
    await expect(editor.getByTestId('rate')).toContainText('2× back')
    await editor.waitForTimeout(400)
    expect(await frame(editor)).toBeLessThan(stopped)

    await editor.keyboard.press('k')
  } finally {
    await close()
  }
})

test('leaves the keys alone where they belong to something else', async () => {
  const { editor, close } = await openEditor()

  try {
    /**
     * Which of these presses the editor took away from the page.
     *
     * The presses are made in the page rather than through the keyboard: asking a real Chrome for
     * Ctrl+S in a test is asking it for a save dialog, and what is under test is our listener
     * calling preventDefault or not. The spy is added after the editor's own listener, so by the
     * time it runs the decision has been made.
     */
    const taken = (keys: Array<{ key: string; ctrl?: boolean }>): Promise<string[]> =>
      editor.evaluate((list: Array<{ key: string; ctrl?: boolean }>) => {
        const out: string[] = []
        const spy = (event: KeyboardEvent): void => {
          if (event.defaultPrevented) out.push(event.key)
        }
        window.addEventListener('keydown', spy)
        for (const item of list) {
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: item.key,
              ctrlKey: Boolean(item.ctrl),
              bubbles: true,
              cancelable: true,
            }),
          )
        }
        window.removeEventListener('keydown', spy)
        return out
      }, keys)

    // The browser's own: not taken.
    expect(await taken([{ key: 's', ctrl: true }, { key: 'f', ctrl: true }, { key: 'Tab' }])).toEqual([])

    // The editor's own are taken, or the page would scroll under the playhead.
    expect(await taken([{ key: ' ' }, { key: 'ArrowRight' }])).toEqual([' ', 'ArrowRight'])
    await editor.keyboard.press('k')

    // Typing in a field is typing: s does not split, and the layout is off entirely.
    //
    // The letters are pressed rather than filled in. `fill` sets the value and fires an input
    // event, and no keydown ever happens — so a layout that was never switched off would pass
    // that just as well as one that was, which is not a check at all.
    await editor.keyboard.press('Shift+ArrowRight')
    await editor.keyboard.press('i')
    await expect(editor.getByTestId('clip')).toHaveCount(1)

    // A second on again, so the playhead stands with room on both sides of it: a split at the
    // very edge of a clip is refused whatever the keyboard says, and would prove nothing.
    await editor.keyboard.press('Shift+ArrowRight')

    const name = editor.getByTestId('name-c1')
    await name.click()
    await name.fill('')

    // A letter at a time, each one waited for. `pressSequentially` types faster than the name
    // travels to the model and back, and the box — which follows the model — then drops the
    // letter that was typed in between: observed as 'ss' out of 'sos' on a loaded machine. That
    // is `NameField`, not the keyboard, and is outside this test's scope.
    await name.press('s')
    await expect(name).toHaveValue('s')
    await name.press('o')
    await expect(name).toHaveValue('so')

    await expect(editor.getByTestId('clip')).toHaveCount(1)
    // O in a name is a letter too: the Out of the clip is where I left it.
    await expect(editor.getByTestId('out-c1')).toHaveValue('00:00:06:00')

    // And the arrows are the caret's while a box has the focus: the playhead stands where it
    // stood. Read rather than counted — a spare ArrowRight went into the page above.
    const standing = await frame(editor)
    await editor.getByTestId('out-c1').click()
    // Both presses the same way. One of each would step the playhead back and forward again and
    // land on the number it started from — a pair that passes on a layout that never switched off.
    await editor.getByTestId('out-c1').press('ArrowLeft')
    await editor.getByTestId('out-c1').press('ArrowLeft')
    await expect(editor.getByTestId('frame')).toHaveText(String(standing))
  } finally {
    await close()
  }
})

test('types a timecode into a boundary and moves the playhead by one', async () => {
  const { editor, close } = await openEditor()

  try {
    await editor.keyboard.press('i')
    await enter(editor, 'out-c1', '00:00:03:00')
    await expect(editor.getByTestId('out-c1')).toHaveValue('00:00:03:00')
    // The box alone proves nothing: it keeps whatever was accepted into it whether the model
    // took the value or not. The length beside it is worked out from the clip in the document.
    await expect(editor.getByTestId('length-c1')).toHaveText('00:00:03:00')

    // A bare number is seconds, so `+1` is a second on: frame 25 of a 24 fps recording.
    await enter(editor, 'playhead-field', '+1')
    await expect(editor.getByTestId('frame')).toHaveText(String(FPS + 1))

    // And the other relative form, which counts in frames and is the one the title explains.
    await enter(editor, 'playhead-field', '-2f')
    await expect(editor.getByTestId('frame')).toHaveText(String(FPS - 1))

    // Rubbish stays in the box, says so, and moves nothing.
    await enter(editor, 'playhead-field', 'half past four')
    await expect(editor.getByTestId('playhead-field')).toHaveValue('half past four')
    await expect(editor.getByTestId('playhead-field')).toHaveAttribute('aria-invalid', 'true')
    await expect(editor.getByTestId('frame')).toHaveText(String(FPS - 1))
  } finally {
    await close()
  }
})

test('the file the tab is playing is the file the writer makes', async () => {
  // Even without pressing Export here, there is meaningful output to check: the preview is
  // assembled by `planPreview` and `assembleMp4` — the same plan and the
  // same writer the button will use — so a preview a browser plays through to the last frame is
  // the writer's output, verified in the tab. This is the intermediate state's export check, and
  // it is why the state is worth stopping at.
  const { editor, close } = await openEditor()

  try {
    const shape = await editor.evaluate(() => {
      const video = document.querySelector('video')!
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight }
    })

    // Six seconds of fixture at 320×240: the writer's own arithmetic plans the preview
    // at 73728 ticks of 12288), read back out of the element that has to play it.
    expect(shape.duration).toBeGreaterThan(5.9)
    expect(shape.duration).toBeLessThan(6.1)
    expect([shape.width, shape.height]).toEqual([320, 240])

    // And the frame table agrees with the file to the last frame: End goes to the end of the
    // material, and the counter is one-based.
    await editor.keyboard.press('End')
    await expect(editor.getByTestId('frame')).toHaveText(String(FRAMES))
  } finally {
    await close()
  }
})

test('drops a marker and takes it away again', async () => {
  const { editor, close } = await openEditor()

  try {
    await editor.keyboard.press('m')
    await expect(editor.getByTestId('marker')).toHaveCount(1)

    // The way out that knows the id: the list in the inspector.
    await editor.getByTestId('drop-m1').click()
    await expect(editor.getByTestId('no-markers')).toBeVisible()

    // And the way out that knows only where the playhead is standing.
    await editor.keyboard.press('m')
    await expect(editor.getByTestId('marker')).toHaveCount(1)
    await editor.keyboard.press('Shift+M')
    await expect(editor.getByTestId('no-markers')).toBeVisible()
  } finally {
    await close()
  }
})

test('shows the whole keyboard on ?', async () => {
  const { editor, close } = await openEditor()

  try {
    await editor.keyboard.press('?')
    await expect(editor.getByTestId('help')).toBeVisible()
    await expect(editor.getByTestId('help-row').first()).toContainText('Space')

    await editor.keyboard.press('Escape')
    await expect(editor.getByTestId('help')).toHaveCount(0)
  } finally {
    await close()
  }
})
