// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { render } from 'preact'
import { Shell, type EditorState } from '../../src/editor/shell'
import { automaticClip, selectClipFromBin } from '../../src/editor/workbench'
import { planSnapshot, type SnapshotSource } from '../../src/core/snapshot/build'
import { SnapshotReader } from '../../src/core/snapshot/read'
import { materialOf } from '../../src/core/snapshot/material'
import { FrameTable } from '../../src/core/timeline/frames'
import { buildPreview, type Preview } from '../../src/editor/source/preview'
import { DEFAULTS } from '../../src/shared/settings'
import { forcesEncoder } from '../../src/core/edit/clip'
import { METRICS, rowTop } from '../../src/core/timeline/layout'
import { concatBytes } from '../../src/core/iso/writer'
import { parseInit } from '../../src/core/iso/init'

const exportHarness = vi.hoisted(() => ({
  codecCalls: [] as VideoEncoderConfig[],
  codecAnswer: false as boolean | 'pending',
  webpPlans: [] as Array<{ crop: unknown }>,
  webpBytes: [] as number[],
  surfaceCalls: 0,
  encodeIoCalls: 0,
  encodeRequests: [] as Array<{ path: { kind: string; plan?: { geometry: { width: number; height: number; framerate: number }; kept: number }; choice?: { kind: string; quantizer?: number } } }>,
  openedTracks: [] as Array<string | null>,
  skipSave: false,
}))

vi.mock('../../src/editor/export/support', async () => {
  const actual = await vi.importActual<typeof import('../../src/editor/export/support')>(
    '../../src/editor/export/support',
  )
  return {
    ...actual,
    liveProbe: () => (config: VideoEncoderConfig) => {
      exportHarness.codecCalls.push({ ...config })
      if (exportHarness.codecAnswer === 'pending') return new Promise<boolean>(() => undefined)
      return Promise.resolve(exportHarness.codecAnswer)
    },
  }
})

vi.mock('../../src/editor/export/webp', async () => {
  const actual = await vi.importActual<typeof import('../../src/editor/export/webp')>(
    '../../src/editor/export/webp',
  )
  return {
    ...actual,
    liveSurface: () => {
      exportHarness.surfaceCalls += 1
      return {
        resize: () => undefined,
        draw: () => undefined,
        still: async () => new Uint8Array([1]),
      }
    },
    probeWebpBytes: async (plan: { crop: unknown }) => {
      exportHarness.webpPlans.push(plan)
      return exportHarness.webpBytes.shift() ?? null
    },
  }
})

vi.mock('../../src/editor/export/exporter', async () => {
  const actual = await vi.importActual<typeof import('../../src/editor/export/exporter')>(
    '../../src/editor/export/exporter',
  )
  return {
    ...actual,
    openClipSource: async (...args: Parameters<typeof actual.openClipSource>) => {
      exportHarness.openedTracks.push(args[1].video?.track.id ?? null)
      return actual.openClipSource(...args)
    },
    encodeIo: (...args: unknown[]) => {
      exportHarness.encodeIoCalls += 1
      const reader = args[0] as SnapshotReader
      const options = args.at(-1) as {
        askWhere?: boolean
        onSaved?: () => void
        onPace: (
          kind: 'mp4' | 'webp',
          geometry: { width: number; height: number; framerate: number },
          frames: number,
          ms: number,
        ) => void
      }
      const base = actual.downloadIo(reader, options)
      return {
        ...base,
        save: exportHarness.skipSave ? async () => undefined : base.save,
        encode: async (
          request: (typeof exportHarness.encodeRequests)[number],
          report: (frames: number) => void,
          stale: () => boolean,
        ) => {
          exportHarness.encodeRequests.push(request)
          if (stale() || request.path.kind !== 'encode' || !request.path.plan) return null
          report(request.path.plan.kept)
          options.onPace('mp4', request.path.plan.geometry, request.path.plan.kept, 1_200)
          return new Uint8Array([1, 2, 3])
        },
      }
    },
  }
})

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

/** Two picture representations whose different frame counts make the one on screen observable. */
async function switchable(): Promise<Extract<EditorState, { status: 'ready' }>> {
  const long: SnapshotSource['tracks'][number] = {
    id: 'v-long',
    bufferId: 'sb-long',
    representation: 'video:avc1.4d401e:320x240-long',
    kinds: ['video'],
    info: parseInit(CUT_INIT)!,
    initBytes: CUT_INIT,
    chunks: CUT_SEGMENTS.slice(0, 2).map((bytes, at) => ({
      start: at * 2,
      end: at * 2 + 2,
      bytes,
    })),
  }
  const plan = planSnapshot(
    {
      page,
      tracks: [
        long,
        {
          ...long,
          id: 'v-short',
          bufferId: 'sb-short',
          representation: 'video:avc1.4d401e:320x240-short',
          chunks: [{ start: 4, end: 6, bytes: CUT_SEGMENTS[2]! }],
        },
      ],
    },
    { id: 'switchable', capturedAt: 1_756_022_400_000, producer: 'tailcut test' },
  )
  const file = concatBytes(plan.parts)
  const reader = (await SnapshotReader.open(
    async (at, length) => file.subarray(at, at + length),
    file.byteLength,
  ))!
  const material = materialOf(reader.index)
  const preview = await buildPreview(reader, material)

  expect(preview, 'the default representation did not assemble').not.toBeNull()
  return { status: 'ready', reader, material, preview }
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
  // how a zero would reach crop geometry without a word.
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

const select = (testId: string, value: string): void => {
  const field = document.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`)!
  field.value = value
  field.dispatchEvent(new Event('change', { bubbles: true }))
}

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
  exportHarness.codecCalls.length = 0
  exportHarness.codecAnswer = false
  exportHarness.webpPlans.length = 0
  exportHarness.webpBytes.length = 0
  exportHarness.surfaceCalls = 0
  exportHarness.encodeIoCalls = 0
  exportHarness.encodeRequests.length = 0
  exportHarness.openedTracks.length = 0
  exportHarness.skipSave = false
  vi.unstubAllGlobals()
})

describe('the editor shell', () => {
  it('selects and seeks a bin clip without changing the timeline view', () => {
    const dispatch = vi.fn()

    selectClipFromBin(dispatch, { id: 'c7', in: 12.5 })

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: 'selectClip', id: 'c7' },
      { type: 'seek', time: 12.5 },
    ])
  })

  it('lays out media, monitor, inspector, and timeline as separate work areas', async () => {
    show(await ready())

    for (const pane of ['media-panel', 'player', 'inspector', 'timeline']) {
      expect(document.querySelector(`[data-testid="${pane}"]`), `the ${pane} pane is missing`).not.toBeNull()
    }
    expect(document.querySelectorAll('[data-testid="clip-bin"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-testid="clips"]')).toHaveLength(1)
  })

  it('keeps the crop shade inside the picture and gives the timeline an editing row', () => {
    const html = readFileSync('src/editor/editor.html', 'utf8')

    expect(html).toMatch(/\.tc-picture-frame\s*\{[^}]*overflow:\s*hidden/s)
    expect(html).toMatch(/\.tc-edit-tool-row\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(html).toMatch(/grid-template-areas:\s*"head head head"\s*"media player inspector"\s*"timeline timeline timeline"/s)
    expect(html).toMatch(/grid-template-rows:\s*auto\s+minmax\([^;]+\)\s+minmax\(300px,\s*42vh\)/s)
  })

  it('takes the title and the address of the page out of the snapshot', async () => {
    show(await ready())

    expect(text('title')).toBe('Clip — site.example')
    expect(text('host')).toBe('site.example')
  })

  it('identifies the workbench with the packaged tailcut mark', async () => {
    show(await ready())
    const mark = document.querySelector<HTMLImageElement>('[data-testid="brand-mark"]')
    const support = document.querySelector<HTMLAnchorElement>('[data-testid="support-link"]')

    expect(mark?.alt).toBe('tailcut')
    expect(mark?.getAttribute('src')).toBe('../assets/tailcut/svg/mark-light.svg')
    expect(support?.closest('.head-actions')).not.toBeNull()
    expect(support?.textContent).toContain('Support the author')
    expect(support?.href).toBe('https://donatty.com/rnv812')
    expect(support?.title).toContain('free and open source')
  })

  it('returns to the original page tab without closing the editor', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('chrome', {
      tabs: {
        get: async (tabId: number) => ({ id: tabId, windowId: 23 }),
        update: async (tabId: number, update: unknown) => calls.push(['tab', tabId, update]),
      },
      windows: {
        update: async (windowId: number, update: unknown) => calls.push(['window', windowId, update]),
      },
    })
    show({ ...(await ready()), sourceTabId: 7 })

    button('return-source').click()
    await settled()

    expect(calls).toEqual([
      ['tab', 7, { active: true }],
      ['window', 23, { focused: true }],
    ])
    expect(button('return-source')).not.toBeNull()
  })

  it('shows the length of the material, not the distance from end to end', async () => {
    // Runs of 0…4 and 8…10: six seconds of material across a span of ten.
    show(await ready())
    expect(text('duration')).toBe('0:06')
  })

  it('shows the whole composite monitor duration instead of the selected ABR track duration', async () => {
    const state = await ready()
    const picture = state.material.video!.track
    const composite: Preview = {
      ...previewOf(),
      monitor: {
        pictures: [
          {
            trackId: picture.id,
            representation: picture.representation,
            start: 0,
            end: 6,
            codec: picture.info.tracks[0]!.codec,
            width: picture.info.tracks[0]!.width,
            height: picture.info.tracks[0]!.height,
          },
        ],
      },
    }

    show({ ...state, material: { ...state.material, duration: 4 }, preview: composite })

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

  it('opens every recorded picture with its own preview, grid and visible span', async () => {
    exportHarness.skipSave = true
    await mount(await switchable())

    const picker = document.querySelector<HTMLSelectElement>('[data-testid="representation"]')
    expect(picker, 'there is no way to open the other recorded picture').not.toBeNull()
    expect([...picker!.options].map((option) => option.value)).toEqual(['v-long', 'v-short'])
    expect(text('frame-count')).toBe('96')
    expect(text('duration')).toBe('0:04')
    expect(document.body.textContent).toContain('Switching starts a new edit')

    press('i')
    await settled()
    expect(document.querySelectorAll('[data-testid="clip"]')).toHaveLength(1)

    select('representation', 'v-short')
    await until(() => text('frame-count') === '48', 'the second representation never opened')

    expect(text('duration')).toBe('0:02')
    expect(
      document.querySelectorAll('[data-testid="clip"]'),
      'the old picture edit crossed into a different frame grid',
    ).toHaveLength(0)

    const playhead = document.querySelector<HTMLInputElement>('[data-testid="playhead-field"]')!
    playhead.value = '4'
    playhead.dispatchEvent(new Event('input', { bubbles: true }))
    playhead.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settled()
    press('i')
    await settled()

    expect(
      document.querySelectorAll('[data-testid="clip"]'),
      'the visible second-representation zone cannot be cut',
    ).toHaveLength(1)

    await until(() => !button('export-selected').disabled, 'the selected representation was not indexed')
    button('export-selected').click()
    await until(() => text('job-state') === 'Saved', 'the selected representation could not export')
    expect(exportHarness.openedTracks.at(-1)).toBe('v-short')
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

  it('does not call an assembly failure a recording with no picture', async () => {
    show({ ...(await ready()), preview: 'failed' })

    expect(document.body.textContent).toContain('could not build a preview')
    expect(document.body.textContent).not.toContain('no picture in this recording')
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

  it('shows the selected clip In, Out, and Duration above the timeline', async () => {
    await mount({ ...(await ready()), preview: previewOf() })

    expect(text('no-selection')).toContain('whole recording')
    press('i')
    await settled()

    expect(document.querySelector('[data-testid="selection-summary"]')).not.toBeNull()
    expect(text('selection-in')).toBe('00:00:00:00')
    expect(text('selection-out')).toBe('00:00:00:05')
    expect(text('selection-duration')).toBe('00:00:00:05')
  })

  it('switches preview playback between stopping and looping at the active range end', async () => {
    await mount({ ...(await ready()), preview: previewOf() })

    expect(text('end-mode')).toBe('Stop after')
    button('end-mode').click()
    await settled()
    expect(text('end-mode')).toBe('Repeat')

    button('end-mode').click()
    await settled()
    expect(text('end-mode')).toBe('Stop after')
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

  it('automatically prepares the geometry a crop will encode', async () => {
    await mount({ ...(await cuttable()), preview: previewOf({ width: 320, height: 240 }) })
    press('i')
    await settled()

    button('crop-ratio-9:16').click()
    await settled()

    expect(text('crop-geometry')).toBe('134 × 240')
    await until(() => exportHarness.codecCalls.length > 0, 'the crop geometry was never probed')
    expect(exportHarness.codecCalls[0]).toMatchObject({ width: 134, height: 240, framerate: 25 })
    expect(button('export-selected').disabled).toBe(false)

    button('crop-reset').click()
    await settled()
    expect(text('crop-geometry')).toBe('320 × 240')
    expect(text('estimate')).toContain('copied from the recording')
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
    expect(document.querySelector('[data-testid="mode-c1"]')).toBeNull()
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

  it('builds the encode io without building a canvas for a copy-only editor', async () => {
    await mount({ ...(await cuttable()), preview: previewOf({ width: 320, height: 240 }) })

    expect(exportHarness.encodeIoCalls).toBe(1)
    expect(exportHarness.surfaceCalls).toBe(0)
  })

  it('probes the cropped MP4 geometry without an Optimize switch', async () => {
    exportHarness.codecAnswer = true
    await mount({ ...(await cuttable()), preview: previewOf({ width: 320, height: 240 }) })

    press('i')
    press('ArrowRight')
    press('ArrowRight')
    press('s')
    await settled()

    button('crop-ratio-1:1').click()
    await until(
      () => exportHarness.codecCalls.some(({ width, height }) => width === 240 && height === 240),
      'the crop geometry was not probed',
    )

    expect(
      exportHarness.codecCalls.map(({ width, height, framerate }) => `${width}x${height}@${framerate}`),
    ).toEqual(['320x240@25', '240x240@25'])
  })

  it('keeps one pending codec question for the life of the tab', async () => {
    exportHarness.codecAnswer = 'pending'
    await mount({ ...(await cuttable()), preview: previewOf({ width: 320, height: 240 }) })
    press('i')
    await settled()
    button('crop-ratio-1:1').click()
    await until(() => exportHarness.codecCalls.length > 0, 'the codec was never asked')

    const sound = document.querySelector<HTMLInputElement>('[data-testid="sound-c1"]')!
    sound.checked = !sound.checked
    sound.dispatchEvent(new Event('change', { bubbles: true }))
    await settled()

    expect(exportHarness.codecCalls).toHaveLength(1)
  })

  it('weighs only the selected WebP again after its crop moves', async () => {
    exportHarness.webpBytes.push(1024 ** 2, 512 * 1024)
    await mount({ ...(await cuttable()), preview: previewOf({ width: 320, height: 240 }) })
    press('i')
    await settled()
    select('format-c1', 'webp')

    await until(() => exportHarness.webpPlans.length === 1, 'the WebP was never weighed')
    await until(() => text('estimate').includes('1.0 MB'), 'the measured WebP weight was not shown')
    expect(exportHarness.codecCalls).toEqual([])
    expect(exportHarness.webpPlans[0]!.crop).toBeNull()

    button('crop-ratio-9:16').click()
    await until(() => exportHarness.webpPlans.length === 2, 'the moved crop was not weighed again')
    await until(() => text('estimate').includes('512 KB'), 'the moved crop kept the old weight')

    expect(exportHarness.webpPlans[1]!.crop).not.toBeNull()
    expect(exportHarness.surfaceCalls).toBe(2)
  })

  it('automatically uses the safe internal encoder for a cropped MP4', async () => {
    exportHarness.codecAnswer = true
    exportHarness.skipSave = true
    await mount({
      ...(await cuttable()),
      preview: previewOf({ width: 320, height: 240 }),
      options: {
        export: { ...DEFAULTS.export, codec: 'hevc', quality: 'low', rewriteHead: true },
      },
    })
    press('i')
    await settled()
    button('crop-ratio-1:1').click()
    await until(() => exportHarness.codecCalls.length > 0, 'the crop was not offered to the encoder')

    button('export-selected').click()
    await until(() => text('job-state') === 'Saved', 'the controlled encode did not finish')

    expect(exportHarness.codecCalls[0]!.codec).toMatch(/^avc1/)
    expect(exportHarness.encodeRequests[0]!.path.choice).toMatchObject({
      kind: 'h264-hw',
      quantizer: 22,
    })
  })

  it('keeps WebP outside the MP4 codec ladder', async () => {
    exportHarness.codecAnswer = 'pending'
    await mount({ ...(await cuttable()), preview: previewOf({ width: 320, height: 240 }) })
    press('i')
    await settled()

    select('format-c1', 'webp')
    await settled()
    expect(exportHarness.codecCalls).toEqual([])
    expect(button('export-selected').disabled).toBe(false)
  })

  it('normalizes a legacy optimized clip without losing edits or exact-start encoding', () => {
    const legacy = automaticClip({
      id: 'legacy',
      name: 'Legacy',
      in: 1,
      out: 2,
      representation: 'video:avc1:320x240',
      sound: false,
      crop: null,
      format: 'mp4',
      mode: 'optimize',
    })

    expect(legacy).toMatchObject({ mode: 'original', in: 1, out: 2, crop: null, sound: false })
    expect(forcesEncoder(legacy, false, false)).toBe(true)
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
    // The wire held here is the group itself. `main.tsx` reads settings once, the shell carries them,
    // and the workbench hands it whole to `deriveMaterial`; two of its fields reach the model —
    // the template a clip is named by, and the format a clip is born in — and only the first of
    // the two is visible on this screen. So the format rides here: cut the argument in
    // `workbench.tsx` and this name falls back to the default, taking the format with
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

  it('uses the default name when the tab read no settings at all', async () => {
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
    expect(button('play').getAttribute('aria-label')).toBe('Pause preview')

    press('k')
    await settled()
    expect(document.querySelector('[data-testid="rate"]')).toBeNull()
    expect(button('play').getAttribute('aria-label')).toBe('Play preview')

    // Backwards the element cannot do at all: the playhead is walked and the picture is stopped.
    press('j')
    await settled()
    expect(text('rate')).toContain('1× back')
    expect(button('play').getAttribute('aria-label')).toBe('Play preview')

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

  it('a clip chosen from the media panel becomes selected and takes the playhead to its start', async () => {
    await mount({ ...(await ready()), preview: previewOf() })

    press('i')
    press('ArrowRight')
    press('ArrowRight')
    await settled()
    expect(text('frame')).toBe('3')

    document.querySelector<HTMLButtonElement>('[data-testid="clip-go-c1"]')!.click()
    await settled()

    expect(text('frame')).toBe('1')
    expect(document.querySelector('[data-testid="clip"]')!.className).toContain('selected')
  })

  it('keeps the timeline zoom when a clip is chosen from the media panel', async () => {
    await mount({ ...(await ready()), preview: previewOf() })
    press('i')
    press('ArrowRight')
    press('ArrowRight')
    press('o')
    await settled()

    button('fit-all').click()
    await settled()
    const timeline = document.querySelector<HTMLElement>('.tc-timeline')!
    const scale = timeline.dataset.viewScale

    button('clip-go-c1').click()
    await settled()

    expect(timeline.dataset.viewScale).toBe(scale)
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
    expect(button('play').getAttribute('aria-label')).toBe('Pause preview')
    expect(video.paused, 'the button says Pause and the element was never started').toBe(false)

    // The same key again, not a second start: a transport that only ever ran would say Pause
    // for ever and the space bar would be a one-way switch.
    press(' ')
    await settled()
    expect(button('play').getAttribute('aria-label')).toBe('Play preview')
    expect(video.paused).toBe(true)

    // And the button, which reports the state it is going to rather than the one it is in.
    document.querySelector<HTMLButtonElement>('[data-testid="play"]')!.click()
    await settled()
    expect(button('play').getAttribute('aria-label')).toBe('Pause preview')
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

  it('keeps the picture running when a frame is stepped by the button', async () => {
    await mount({ ...(await ready()), preview: previewOf() })

    press(' ')
    await settled()
    expect(button('play').getAttribute('aria-label')).toBe('Pause preview')

    document.querySelector<HTMLButtonElement>('[data-testid="next"]')!.click()
    await settled()
    expect(button('play').getAttribute('aria-label')).toBe('Pause preview')
    expect(document.querySelector<HTMLVideoElement>('[data-testid="preview"]')!.paused).toBe(false)
  })

  it('navigates the recording, active clip, and markers from the monitor controls', async () => {
    await mount({ ...(await ready()), preview: previewOf() })

    press('m')
    press('ArrowRight')
    press('ArrowRight')
    press('m')
    await settled()

    button('recording-end').click()
    await settled()
    expect(text('frame')).toBe('5')

    button('previous-marker').click()
    await settled()
    expect(text('frame')).toBe('3')

    button('recording-start').click()
    await settled()
    button('next-marker').click()
    await settled()
    expect(text('frame')).toBe('3')

    press('i')
    await settled()
    button('recording-start').click()
    await settled()
    button('range-start').click()
    await settled()
    expect(text('frame')).toBe('3')

    button('range-end').click()
    await settled()
    expect(text('frame')).toBe('5')
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
      show({ ...(await cuttable()), preview: previewOf({ width: 320, height: 240 }) })

      // The panel is up before the recording has been read, and says which of the two it is
      // waiting on: there is no clip yet, and there is nothing indexed to cut one out of.
      expect(document.querySelector('[data-testid="export-panel"]')).not.toBeNull()
      expect(button('export-selected').disabled).toBe(true)
      expect(button('export-all').disabled).toBe(true)
      expect(text('export-note')).toContain('Reading the recording')

      // The note goes when the index is there; the button stays down, because a recording with
      // no clip marked on it has nothing to write.
      await until(
        () => document.querySelector('[data-testid="export-note"]') === null,
        'the recording was never indexed',
      )
      expect(button('export-all').textContent).toBe('Export all (0)')
      expect(button('export-all').disabled).toBe(true)

      press('i')
      await settled()
      expect(button('export-selected').disabled).toBe(false)
      expect(button('export-all').disabled).toBe(false)

      // The clip the press made reaches the panel, and its weight is quoted from the same plan
      // the export is about to run.
      expect(button('export-selected').textContent).toBe('Export selected clip')
      expect(text('estimate')).toMatch(/about \d/)

      button('export-selected').click()
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

  it('exports only the selection or the complete clip list from the two explicit actions', async () => {
    exportHarness.skipSave = true
    await mount({ ...(await cuttable()), preview: previewOf() })
    press('i')
    press('ArrowRight')
    press('ArrowRight')
    press('s')
    await settled()

    expect(document.querySelectorAll('[data-testid="clip"]')).toHaveLength(2)
    await until(() => !button('export-selected').disabled, 'selected export never became ready')
    button('export-selected').click()
    await until(
      () => document.querySelectorAll('[data-testid="job"]').length === 1,
      'selected export did not enqueue exactly one clip',
    )

    await until(() => !button('export-all').disabled, 'batch export never became ready')
    button('export-all').click()
    await until(
      () => document.querySelectorAll('[data-testid="job"]').length === 3,
      'batch export did not enqueue both clips',
    )
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
