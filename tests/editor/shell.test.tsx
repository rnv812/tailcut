// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { render } from 'preact'
import { Shell, type EditorState } from '../../src/editor/shell'
import { planSnapshot, type SnapshotSource } from '../../src/core/snapshot/build'
import { SnapshotReader } from '../../src/core/snapshot/read'
import { materialOf } from '../../src/core/snapshot/material'
import { FrameTable } from '../../src/core/timeline/frames'
import type { Preview } from '../../src/editor/source/preview'
import { DEFAULTS } from '../../src/shared/settings'
import { METRICS, rowTop } from '../../src/core/timeline/layout'
import { concatBytes } from '../../src/core/iso/writer'
import { parseInit } from '../../src/core/iso/init'

const page = {
  sessionKey: 'https://site.example/watch|avc1|inf',
  url: 'https://site.example/watch?v=abc',
  title: 'Clip — site.example',
  createdAt: 1_756_022_100_000,
  lastSeenAt: 1_756_022_399_000,
  refusedTracks: false,
}

const source: SnapshotSource = {
  page,
  tracks: [
    {
      id: 't0',
      bufferId: 'sb-1',
      representation: 'video:avc1.640028:1280x720',
      kinds: ['video'],
      info: {
        tracks: [
          { trackId: 1, kind: 'video', timescale: 12_288, codec: 'avc1.640028', width: 1280, height: 720 },
        ],
      },
      initBytes: new Uint8Array(64),
      // Two runs with a gap of four seconds between them.
      chunks: [
        { start: 0, end: 2, bytes: new Uint8Array(1_000) },
        { start: 2, end: 4, bytes: new Uint8Array(1_000) },
        { start: 8, end: 10, bytes: new Uint8Array(1_000) },
      ],
    },
    {
      id: 't1',
      bufferId: 'sb-2',
      representation: 'audio:mp4a.40.2:0x0',
      kinds: ['audio'],
      info: {
        tracks: [{ trackId: 1, kind: 'audio', timescale: 44_100, codec: 'mp4a.40.2', width: 0, height: 0 }],
      },
      initBytes: new Uint8Array(48),
      chunks: [{ start: 0, end: 4, bytes: new Uint8Array(500) }],
    },
  ],
}

/**
 * Real frames, for the one test that asks the editor to write a file.
 *
 * The stub material above is enough for every layout question, and for none of the export ones:
 * an init of sixty-four nought bytes indexes to nothing, so the Export button never leaves the
 * state it opens in and a panel wired to nothing would look exactly the same.
 */
const CUT_INIT = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const CUT_SEGMENTS = [1, 2, 3].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/h264/chunk-stream0-0000${n}.m4s`)),
)

async function cuttable(): Promise<Extract<EditorState, { status: 'ready' }>> {
  const plan = planSnapshot(
    {
      page,
      tracks: [
        {
          id: 't0',
          bufferId: 'sb-1',
          representation: 'video:avc1.4d401e:320x240',
          kinds: ['video'],
          info: parseInit(CUT_INIT)!,
          initBytes: CUT_INIT,
          chunks: CUT_SEGMENTS.map((bytes, at) => ({ start: at * 2, end: at * 2 + 2, bytes })),
        },
      ],
    },
    { id: 'cut', capturedAt: 1_756_022_400_000, producer: 'tailcut test' },
  )
  const file = concatBytes(plan.parts)
  const reader = (await SnapshotReader.open(
    async (at, length) => file.subarray(at, at + length),
    file.byteLength,
  ))!

  return { status: 'ready', reader, material: materialOf(reader.index), preview: null }
}

/** The ready state, spelled out rather than as the union: the tests build on top of it. */
async function ready(): Promise<Extract<EditorState, { status: 'ready' }>> {
  const plan = planSnapshot(source, { id: 'x', capturedAt: 1_756_022_400_000, producer: 'tailcut test' })
  const file = concatBytes(plan.parts)
  const reader = (await SnapshotReader.open(
    async (at, length) => file.subarray(at, at + length),
    file.byteLength,
  ))!

  return { status: 'ready', reader, material: materialOf(reader.index), preview: null }
}

const show = (state: EditorState) => render(<Shell state={state} />, document.body)
const text = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ''

/**
 * Two frames and two turns of the queue.
 *
 * Preact queues a rerender rather than doing it in the handler, so a press read back in the same
 * turn answers about the screen before it. Two rounds and not one, because the panels are two
 * deep: the workbench rerenders on the first, and the box inside a `TimecodeField` follows the
 * value it was handed from an effect, which preact runs after that render. Waiting one round
 * reads a timecode field that is still showing the number before the press.
 */
const turn = () => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0)))
const settled = async () => {
  await turn()
  await turn()
}

/** Five frames at 25 fps: enough grid for a step, a fit and a clip. */
const previewOf = (frameSize = { width: 1280, height: 720 }): Preview => ({
  url: 'blob:preview',
  bytes: 10,
  // The size of the picture the shell would be playing. Nothing on this screen draws a rectangle
  // over it yet; it is here because `Preview` promises it, and a cast that let it be missing is
  // how a zero would reach the crop without a word (§8.5).
  frameSize,
  frames: FrameTable.of(
    Array.from({ length: 5 }, (_, at) => ({
      pts: at / 25,
      out: at / 25,
      duration: 1 / 25,
      sync: at === 0,
      source: { at, length: 1 },
    })),
  ),
  release: () => {},
})

/** Turns the wheel until the screen says what is being waited for, or gives up saying so. */
const until = async (ready: () => boolean, what: string): Promise<void> => {
  for (let round = 0; round < 50; round++) {
    if (ready()) return
    await settled()
  }
  throw new Error(what)
}

const button = (testId: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!

const press = (key: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))

const point = (target: Element, type: string, clientX: number, clientY: number): void => {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, clientX, clientY, pointerId: 1 }),
  )
}

/**
 * Puts the editor up and waits until it is listening.
 *
 * The listener on the window goes on in an effect, and preact runs effects after the render
 * rather than during it. A press sent in the same turn as the mount reaches nothing at all —
 * which looks exactly like a keyboard that does not work, and is not what these tests are about.
 */
const mount = async (state: EditorState) => {
  show(state)
  await settled()
}

afterEach(() => {
  render(null, document.body)
  document.body.innerHTML = ''
})

describe('the editor shell', () => {
  it('lays out the player on top, the inspector right and the timeline below', async () => {
    show(await ready())

    for (const pane of ['player', 'inspector', 'timeline']) {
      expect(document.querySelector(`[data-testid="${pane}"]`), `the ${pane} pane is missing`).not.toBeNull()
    }
  })

  it('takes the title and the address of the page out of the snapshot', async () => {
    show(await ready())

    expect(text('title')).toBe('Clip — site.example')
    expect(text('host')).toBe('site.example')
  })

  it('shows the length of the material, not the distance from end to end', async () => {
    // Runs of 0…4 and 8…10: six seconds of material across a span of ten.
    show(await ready())
    expect(text('duration')).toBe('0:06')
  })

  it('counts the gaps out loud instead of passing over them', async () => {
    show(await ready())
    expect(text('gaps')).toContain('1 gap')
  })

  it('lists the tracks with their codec and frame size', async () => {
    show(await ready())

    const tracks = [...document.querySelectorAll('[data-testid="track"]')].map((n) => n.textContent)
    expect(tracks).toHaveLength(2)
    expect(tracks[0]).toContain('avc1.640028')
    expect(tracks[0]).toContain('1280×720')
    expect(tracks[1]).toContain('mp4a.40.2')
  })

  it('removes the stage-three placeholders now that clip controls do the work', async () => {
    show(await ready())

    expect(document.querySelector('[data-testid="crop"]')).toBeNull()
    expect(document.querySelector('[data-testid="webp"]')).toBeNull()
    expect(document.querySelector('[data-testid="reencode-note"]')).toBeNull()
  })

  it('says so while the snapshot is being opened', () => {
    show({ status: 'opening' })
    expect(document.body.textContent).toContain('Opening')
  })

  it('explains every refusal in its own words and leaves no blank screen', () => {
    const said: string[] = []

    for (const reason of ['no-id', 'missing', 'unfinished', 'empty'] as const) {
      show({ status: 'failed', reason })
      const message = text('failure')
      expect(message.length, `the ${reason} refusal says nothing`).toBeGreaterThan(20)
      said.push(message)
    }

    expect(new Set(said).size, 'two refusals are explained in the same words').toBe(4)
  })

  it('draws neither a player nor a timeline on a refusal', () => {
    show({ status: 'failed', reason: 'missing' })
    expect(document.querySelector('[data-testid="player"]')).toBeNull()
    expect(document.querySelector('[data-testid="timeline"]')).toBeNull()
  })

  it('leaves the player pane in place while the preview is being assembled', async () => {
    show({ ...(await ready()), preview: 'building' })

    expect(document.querySelector('[data-testid="player"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="preview"]')).toBeNull()
    expect(document.body.textContent).toContain('Building the preview')
  })

  it('says why there is nothing to play in a snapshot with no picture', async () => {
    show({ ...(await ready()), preview: null })
    expect(document.body.textContent).toContain('no picture in this recording')
  })

  it('puts the element and the frame readout in the player pane once there is a preview', async () => {
    const preview = previewOf()

    show({ ...(await ready()), preview })

    expect(document.querySelector<HTMLVideoElement>('[data-testid="preview"]')!.src).toBe(
      'blob:preview',
    )
    expect(text('frame')).toBe('1')
    expect(text('frame-count')).toBe('5')
    expect(text('timecode')).toBe('00:00:00:00')
    // And the box the frame under the pointer is drawn in, mounted with the strip and hidden
    // until the pointer is over it — mounted, so that the cache of pictures outlives a hover.
    expect(document.querySelector<HTMLElement>('[data-testid="thumb"]')!.hidden).toBe(true)
  })

  it('draws a crop only over a picture with a real source size', async () => {
    await mount({ ...(await ready()), preview: previewOf() })
    press('i')
    await settled()

    expect(document.querySelector('[data-testid="crop-host"]')).not.toBeNull()

    render(null, document.body)
    document.body.innerHTML = ''
    await mount({
      ...(await ready()),
      preview: { ...previewOf(), frameSize: { width: 0, height: 0 } },
    })
    press('i')
    await settled()

    expect(document.querySelectorAll('[data-testid="clip"]')).toHaveLength(1)
    expect(document.querySelector('[data-testid="crop-host"]')).toBeNull()
    expect(document.querySelector('[data-testid="crop-geometry"]')).toBeNull()
  })

  it('names and prices the geometry the crop will actually encode', async () => {
    await mount({ ...(await cuttable()), preview: previewOf({ width: 320, height: 240 }) })
    press('i')
    await settled()

    button('crop-ratio-9:16').click()
    await settled()

    expect(text('crop-geometry')).toBe('134 × 240')
    await until(
      () => text('cost-c1').includes('no encoder for 134 × 240'),
      `the crop verdict never arrived: ${text('cost-c1') || 'no cost line'}`,
    )
    expect(button('export').disabled).toBe(true)
    expect(button('export').textContent).toBe('Checking the encoder…')

    button('crop-reset').click()
    await until(
      () => text('cost-c1').includes('Copied from the recording'),
      `the reset verdict never arrived: ${text('cost-c1') || 'no cost line'}`,
    )
    expect(text('crop-geometry')).toBe('320 × 240')
    expect(button('export').textContent).toBe('Export 1 clip')
  })

  it('applies the selected crop to every clip through the shared model', async () => {
    await mount({ ...(await ready()), preview: previewOf() })
    press('i')
    press('ArrowRight')
    press('ArrowRight')
    press('s')
    await settled()

    button('crop-ratio-9:16').click()
    button('crop-apply-all').click()
    await settled()

    document.querySelector<HTMLElement>('[data-id="c1"]')!.click()
    await settled()
    expect(text('crop-geometry')).toBe('404 × 720')
    expect(document.querySelector<HTMLSelectElement>('[data-testid="mode-c1"]')!.disabled).toBe(
      true,
    )
  })

  it('keeps a crop dragged over the player in the shared model', async () => {
    await mount({ ...(await ready()), preview: previewOf() })
    press('i')
    await settled()
    button('crop-ratio-9:16').click()
    await settled()

    vi.spyOn(
      document.querySelector<HTMLDivElement>('[data-testid="crop-host"]')!,
      'getBoundingClientRect',
    ).mockReturnValue({
      width: 640,
      height: 360,
      x: 0,
      y: 0,
      top: 0,
      right: 640,
      bottom: 360,
      left: 0,
      toJSON: () => ({}),
    })

    const box = document.querySelector<HTMLDivElement>('[data-testid="crop-box"]')!
    expect(box.style.left).toBe('34.21875%')
    point(box, 'pointerdown', 100, 100)
    point(box, 'pointermove', 110, 100)
    point(box, 'pointerup', 110, 100)
    await settled()

    expect(document.querySelector<HTMLDivElement>('[data-testid="crop-box"]')!.style.left).toBe(
      '35.78125%',
    )
  })

  it('waits for every MP4 geometry but never asks the MP4 ladder about WebP', async () => {
    await mount({ ...(await ready()), preview: previewOf() })
    press('i')
    press('ArrowRight')
    press('ArrowRight')
    press('s')
    await settled()

    // Split selects c2. Change the unselected c1 directly: the controls stop their events from
    // selecting the row, and the batch still has to wait for work outside the selected one.
    const mode = document.querySelector<HTMLSelectElement>('[data-testid="mode-c1"]')!
    mode.value = 'optimize'
    mode.dispatchEvent(new Event('change', { bubbles: true }))
    await settled()

    expect(button('export').textContent).toBe('Checking the encoder…')

    const format = document.querySelector<HTMLSelectElement>('[data-testid="format-c1"]')!
    format.value = 'webp'
    format.dispatchEvent(new Event('change', { bubbles: true }))
    await settled()
    expect(button('export').textContent).toBe('Export 2 clips')
  })

  it('uses rewrite-head for both the selected verdict and the whole batch', async () => {
    await mount({
      ...(await cuttable()),
      preview: previewOf({ width: 320, height: 240 }),
      options: { export: { ...DEFAULTS.export, rewriteHead: false } },
    })
    press('ArrowRight')
    press('i')
    await until(
      () => text('cost-c1').includes('Copied from the recording'),
      `the copy verdict never arrived: ${text('cost-c1') || 'no cost line'}`,
    )
    expect(button('export').textContent).toBe('Export 1 clip')

    render(null, document.body)
    document.body.innerHTML = ''
    await mount({
      ...(await cuttable()),
      preview: previewOf({ width: 320, height: 240 }),
      options: { export: { ...DEFAULTS.export, rewriteHead: true } },
    })
    press('ArrowRight')
    press('i')
    await until(
      () => text('cost-c1').includes('no encoder for 320 × 240'),
      `the rewrite verdict never arrived: ${text('cost-c1') || 'no cost line'}`,
    )

    expect(button('export').disabled).toBe(true)
    expect(button('export').textContent).toBe('Checking the encoder…')
  })

  it('answers the keyboard from the tab and not from the player', async () => {
    await mount({ ...(await ready()), preview: previewOf() })
    press('ArrowRight')
    await settled()

    // One listener, one step. Two — the player's own and the tab's — would move two frames.
    expect(text('frame')).toBe('2')
  })

  it('shows the clip panel, and says how a clip is made', async () => {
    show({ ...(await ready()), preview: null })

    expect(document.querySelector('[data-testid="clips"]')).not.toBeNull()
    expect(document.body.textContent).toContain('I marks')
  })

  it('sends what the keyboard says to the same model the inspector reads', async () => {
    // The whole point of the assembly: I is a press, and the clip it makes shows up in the panel
    // with its In already typed into a box that the panel took off the document.
    await mount({ ...(await ready()), preview: previewOf() })

    press('ArrowRight')
    press('i')
    await settled()

    expect(document.querySelectorAll('[data-testid="clip"]')).toHaveLength(1)
    // The clip a press made is the selected one, and the panel is told which that is.
    expect(document.querySelector('[data-testid="clip"]')!.className).toContain('selected')
    expect(document.querySelector<HTMLInputElement>('[data-testid="in-c1"]')!.value)
      .toBe('00:00:00:01')
    expect(document.querySelector<HTMLInputElement>('[data-testid="playhead-field"]')!.value)
      .toBe('00:00:00:01')
  })

  it('names a new clip by the Export group the tab was opened with', async () => {
    // The wire held here is the group itself. `main.tsx` reads §9.4 once, the shell carries it,
    // and the workbench hands it whole to `deriveMaterial`; two of its fields reach the model —
    // the template a clip is named by, and the format a clip is born in — and only the first of
    // the two shows on a screen this stage draws. So the format rides here: cut the argument in
    // `workbench.tsx` and this name falls back to the one stage 2 built, taking the format with
    // it in silence. That the group's format then reaches a new clip is held next door, in
    // `tests/editor/store.test.ts`. Measured before it was written: with the format passed as an
    // argument of its own, dropping it left all 2787 tests green.
    await mount({
      ...(await ready()),
      preview: previewOf(),
      options: { export: { ...DEFAULTS.export, nameTemplate: '{host} at {in}', format: 'webp' } },
    })

    press('i')
    await settled()

    expect(document.querySelectorAll('[data-testid="clip"]')).toHaveLength(1)
    expect(document.querySelector<HTMLInputElement>('[data-testid="name-c1"]')!.value).toBe(
      'site.example at 00.00',
    )
  })

  it('names it the way stage 2 did when the tab read no settings at all', async () => {
    // The other end of the same wire, so that the test above cannot be satisfied by a template
    // baked in anywhere: no Export group, and the name is the page title and the timecode.
    await mount({ ...(await ready()), preview: previewOf() })

    press('i')
    await settled()

    expect(document.querySelector<HTMLInputElement>('[data-testid="name-c1"]')!.value).toBe(
      'Clip — site.example 00.00',
    )
  })

  it('undoes a press of the keyboard', async () => {
    await mount({ ...(await ready()), preview: previewOf() })

    press('i')
    await settled()
    expect(document.querySelectorAll('[data-testid="clip"]')).toHaveLength(1)

    press('z', { ctrlKey: true })
    await settled()
    expect(document.querySelectorAll('[data-testid="clip"]')).toHaveLength(0)
  })

  it('puts the whole keyboard on the screen on ? and takes it off on Escape', async () => {
    await mount({ ...(await ready()), preview: null })

    press('?')
    await settled()
    expect(document.querySelector('[data-testid="help"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Shuttle back, stop, shuttle forward')

    press('Escape')
    await settled()
    expect(document.querySelector('[data-testid="help"]')).toBeNull()

    // And the button on the sheet, for the hand that reached for the mouse instead.
    press('?')
    await settled()
    document.querySelector<HTMLButtonElement>('[data-testid="help-close"]')!.click()
    await settled()
    expect(document.querySelector('[data-testid="help"]')).toBeNull()
  })

  it('says how fast the shuttle is going, and stops saying it on K', async () => {
    await mount({ ...(await ready()), preview: previewOf() })

    press('l')
    press('l')
    await settled()
    expect(text('rate')).toContain('2×')
    // Forwards is the element's own doing, so it is running.
    expect(text('play')).toBe('Pause')

    press('k')
    await settled()
    expect(document.querySelector('[data-testid="rate"]')).toBeNull()
    expect(text('play')).toBe('Play')

    // Backwards the element cannot do at all: the playhead is walked and the picture is stopped.
    press('j')
    await settled()
    expect(text('rate')).toContain('1× back')
    expect(text('play')).toBe('Play')

    // And the play button clears the shuttle rather than leaving a speed nothing is going at.
    document.querySelector<HTMLButtonElement>('[data-testid="play"]')!.click()
    await settled()
    expect(document.querySelector('[data-testid="rate"]')).toBeNull()
  })

  it('sends what the inspector is clicked for back into the same model', async () => {
    // The other direction of the assembly. M drops a marker from the keyboard, and Remove in the
    // panel takes it away again — a panel wired to nothing would show the row and never lose it.
    await mount({ ...(await ready()), preview: previewOf() })

    press('m')
    await settled()
    expect(document.querySelectorAll('[data-testid="marker"]')).toHaveLength(1)

    document.querySelector<HTMLButtonElement>('[data-testid="drop-m1"]')!.click()
    await settled()
    expect(document.querySelectorAll('[data-testid="marker"]')).toHaveLength(0)
    expect(document.querySelector('[data-testid="no-markers"]')).not.toBeNull()
  })

  it('sends what the canvas is dragged for back into the same model', async () => {
    // The third of the three roads into the reducer. happy-dom measures every element as zero,
    // so the strip is given a box to report — without one the viewport is a nought pixels wide
    // and a press on the ruler is a press on no instant at all.
    const measured = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = () =>
      ({ width: 800, height: 0, x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 0, toJSON: () => ({}) }) as DOMRect

    try {
      // No preview, so the frame grid is empty and a seek lands where it was asked to rather
      // than on the nearest of five frames — the arithmetic under test is the viewport's.
      await mount({ ...(await ready()), preview: null })

      // F fits the whole recording to the width the strip reported, which is how the width
      // gets into the arithmetic at all: laid out over the 1200 px the project opens with, the
      // same press of the same pixel would answer 00:00:03:08.
      press('f')
      await settled()

      const canvas = document.querySelector('canvas')!
      const spot = { clientX: 300, clientY: METRICS.rulerHeight - 2, button: 0, bubbles: true }
      canvas.dispatchEvent(new MouseEvent('pointerdown', spot))
      window.dispatchEvent(new MouseEvent('pointerup', spot))
      await settled()

      // Ten seconds of material across 800 px: 300 px in is 3.75 s, which is frame 18 of a
      // second — a landing off a whole second on purpose, so that the rate the panel counts in
      // is part of the answer and a frame rate of nought would read 00:00:03:00.
      expect(document.querySelector<HTMLInputElement>('[data-testid="playhead-field"]')!.value)
        .toBe('00:00:03:18')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = measured
    }
  })

  it('draws the clips of the document, and knows which one was clicked on', async () => {
    // The document reaches the canvas as well as the panel: hit-testing a band is done against
    // the clips the strip was handed, so a strip handed none selects nothing wherever it is hit.
    const measured = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = () =>
      ({ width: 800, height: 0, x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 0, toJSON: () => ({}) }) as DOMRect

    try {
      await mount({ ...(await ready()), preview: null })
      press('f')
      press('i')
      await settled()

      const canvas = document.querySelector('canvas')!
      // Two lanes below the ruler, then the first row of clips. A clip begun at nought runs to
      // the end of its run, so 100 px in is inside the band.
      const onBand = {
        clientY: rowTop(METRICS, 2, 0) + METRICS.clipHeight / 2,
        button: 0,
        bubbles: true,
      }
      const away = { clientY: rowTop(METRICS, 2, 3), button: 0, bubbles: true }

      for (const spot of [{ clientX: 700, ...away }, { clientX: 100, ...onBand }]) {
        canvas.dispatchEvent(new MouseEvent('pointerdown', spot))
        window.dispatchEvent(new MouseEvent('pointerup', spot))
        await settled()
      }

      expect(document.querySelector('[data-testid="clip"]')!.className).toContain('selected')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = measured
    }
  })

  it('counts one break of the recording once, however many lanes stopped for it', async () => {
    // The picture and the sound never stop at the same instant, so the lane the cut follows is
    // the one that counts. Added up over both lanes this recording has two holes and one break.
    const staggered: SnapshotSource = {
      page,
      tracks: [
        { ...source.tracks[0]!, chunks: [
          { start: 0, end: 4, bytes: new Uint8Array(1_000) },
          { start: 8, end: 10, bytes: new Uint8Array(1_000) },
        ] },
        { ...source.tracks[1]!, chunks: [
          { start: 0, end: 4.1, bytes: new Uint8Array(500) },
          { start: 7.9, end: 10, bytes: new Uint8Array(500) },
        ] },
      ],
    }
    const plan = planSnapshot(staggered, { id: 'y', capturedAt: 1, producer: 'tailcut test' })
    const file = concatBytes(plan.parts)
    const reader = (await SnapshotReader.open(
      async (at, length) => file.subarray(at, at + length),
      file.byteLength,
    ))!

    show({ status: 'ready', reader, material: materialOf(reader.index), preview: null })
    expect(text('gaps')).toBe('1 gap')
  })

  it('says out loud that the sound of this recording cannot be drawn', async () => {
    // There is sound in the snapshot and no AudioDecoder in this environment, which is exactly
    // the state the note exists for: the timeline shows a flat audio lane, and without a word
    // beside it that reads as a recording with no sound in it.
    await mount({ ...(await ready()), preview: null })

    expect(text('no-wave')).toContain('cannot be decoded')
  })

  it('says nothing about the sound of a recording that has none', async () => {
    const silent: SnapshotSource = { page, tracks: [source.tracks[0]!] }
    const plan = planSnapshot(silent, { id: 'z', capturedAt: 1, producer: 'tailcut test' })
    const file = concatBytes(plan.parts)
    const reader = (await SnapshotReader.open(
      async (at, length) => file.subarray(at, at + length),
      file.byteLength,
    ))!

    await mount({ status: 'ready', reader, material: materialOf(reader.index), preview: null })
    expect(document.querySelector('[data-testid="no-wave"]')).toBeNull()
  })

  it('runs and stops on the space bar and on the button alike', async () => {
    await mount({ ...(await ready()), preview: previewOf() })
    const video = document.querySelector<HTMLVideoElement>('[data-testid="preview"]')!

    press(' ')
    await settled()
    expect(text('play')).toBe('Pause')
    expect(video.paused, 'the button says Pause and the element was never started').toBe(false)

    // The same key again, not a second start: a transport that only ever ran would say Pause
    // for ever and the space bar would be a one-way switch.
    press(' ')
    await settled()
    expect(text('play')).toBe('Play')
    expect(video.paused).toBe(true)

    // And the button, which reports the state it is going to rather than the one it is in.
    document.querySelector<HTMLButtonElement>('[data-testid="play"]')!.click()
    await settled()
    expect(text('play')).toBe('Pause')
  })

  it('takes what playback reports as a frame number and not as an instant', async () => {
    // The element reports the time of the frame on screen in the file's own clock; the model is
    // told a time in the session's. Between them stands the frame table, and handing the index
    // straight to the model would put the playhead at frame two seconds in.
    await mount({ ...(await ready()), preview: previewOf() })
    const video = document.querySelector<HTMLVideoElement>('[data-testid="preview"]')!

    press(' ')
    await settled()

    // happy-dom has no requestVideoFrameCallback, so the player is listening on timeupdate.
    video.currentTime = 0.09
    video.dispatchEvent(new Event('timeupdate'))
    await settled()

    expect(text('frame')).toBe('3')
  })

  it('stops the picture when a frame is stepped by the button', async () => {
    // The transport and the playhead pull in two directions otherwise: the element goes on
    // decoding forwards while the number under it is being walked by hand.
    await mount({ ...(await ready()), preview: previewOf() })

    press(' ')
    await settled()
    expect(text('play')).toBe('Pause')

    document.querySelector<HTMLButtonElement>('[data-testid="next"]')!.click()
    await settled()
    expect(text('play')).toBe('Play')
  })

  it('writes the clip the keyboard made, from the panel mounted in the inspector', async () => {
    // The last of the roads out of the assembly, and the only one that leaves anything behind:
    // press, click, file. Every piece below it is tested on its own — the panel draws a queue it
    // is handed, the runner writes a plan it is given, the exporter turns clips into requests —
    // and none of that says the three are joined to each other in the tab the user opens.
    const asked: Array<{ url: string; filename: string }> = []
    vi.stubGlobal('chrome', {
      downloads: {
        download: (
          options: { url: string; filename: string },
          done: (id: number | undefined) => void,
        ) => {
          asked.push(options)
          done(11)
        },
      },
      runtime: { lastError: undefined },
    })

    try {
      show(await cuttable())

      // The panel is up before the recording has been read, and says which of the two it is
      // waiting on: there is no clip yet, and there is nothing indexed to cut one out of.
      expect(document.querySelector('[data-testid="export-panel"]')).not.toBeNull()
      expect(button('export').disabled).toBe(true)
      expect(text('export-note')).toContain('Reading the recording')

      // The note goes when the index is there; the button stays down, because a recording with
      // no clip marked on it has nothing to write.
      await until(
        () => document.querySelector('[data-testid="export-note"]') === null,
        'the recording was never indexed',
      )
      expect(button('export').textContent).toBe('Export 0 clips')
      expect(button('export').disabled).toBe(true)

      press('i')
      await settled()
      expect(button('export').disabled).toBe(false)

      // The clip the press made reaches the panel, and its weight is quoted from the same plan
      // the export is about to run.
      expect(button('export').textContent).toBe('Export 1 clip')
      expect(text('estimate')).toMatch(/about \d/)

      button('export').click()
      await until(
        () => text('job-state') === 'Saved',
        `the export never finished: ${text('job-state') || 'no row at all'}`,
      )

      expect(document.querySelectorAll('[data-testid="job"]')).toHaveLength(1)
      expect(asked, 'no file was handed to the browser').toHaveLength(1)
      expect(asked[0]!.filename).toMatch(/\.mp4$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('leaves a text box its own letters, mounted in the tab as it is', async () => {
    // The rule that makes the rest of the layout usable, checked where the field really is: the
    // name of a clip is typed into the inspector while the same letters are commands outside it.
    await mount({ ...(await ready()), preview: previewOf() })
    press('i')
    await settled()

    // And the playhead is walked off the In it has just set. A split at the very edge of a clip
    // is refused whatever the keyboard says, so left standing there the count below is 1 for a
    // layout switched off and 1 for a layout left on, and the check says nothing at all.
    press('ArrowRight')
    press('ArrowRight')
    await settled()

    const name = document.querySelector<HTMLInputElement>('[data-testid="name-c1"]')!
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true }))
    await settled()

    // S outside the box splits; inside it, it is a letter and the clip count does not move.
    expect(document.querySelectorAll('[data-testid="clip"]')).toHaveLength(1)
  })
})
