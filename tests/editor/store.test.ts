// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { h, render } from 'preact'
import { useEffect } from 'preact/hooks'
import { newSession } from '../../src/core/edit/session'
import { newProject } from '../../src/core/edit/project'
import { reduce } from '../../src/core/edit/actions'
import { geometryOf } from '../../src/core/encode/crop'
import { DEFAULTS, type ExportFormat, type ExportSettings } from '../../src/shared/settings'
import { FrameTable, type Frame } from '../../src/core/timeline/frames'
import { planSnapshot, type SnapshotSource } from '../../src/core/snapshot/build'
import { createStore, useSession, type EditorStore } from '../../src/editor/state/store'
import { deriveMaterial } from '../../src/editor/source/media'
import type { Preview } from '../../src/editor/source/preview'
import type { TrackInfo } from '../../src/shared/types'

const FPS = 25

const info = (kind: 'video' | 'audio'): { tracks: TrackInfo[] } => ({
  tracks: [
    {
      trackId: kind === 'video' ? 1 : 2,
      kind,
      timescale: 1_000,
      codec: kind === 'video' ? 'avc1' : 'mp4a',
      width: kind === 'video' ? 640 : 0,
      height: kind === 'video' ? 480 : 0,
    },
  ],
})

/**
 * Six seconds of picture with a hole from two to four, and sound with a hole of its own.
 *
 * The two holes are the same break of the recording and they are not the same numbers: the sound
 * stopped a little later and came back a little sooner. Counted lane by lane that is two gaps;
 * counted the way the cut counts them it is one (`cuttingLane` joins across the gap).
 */
const source: SnapshotSource = {
  page: { sessionKey: 'k', url: 'https://site.example/w', title: 'Talk', createdAt: 1, lastSeenAt: 2, refusedTracks: false },
  tracks: [
    {
      id: 'v',
      bufferId: 'sb-v',
      representation: 'video:avc1:640x480',
      kinds: ['video'],
      info: info('video'),
      initBytes: new Uint8Array(16),
      chunks: [
        { start: 0, end: 2, bytes: new Uint8Array(8) },
        { start: 4, end: 6, bytes: new Uint8Array(8) },
      ],
    },
    {
      id: 'a',
      bufferId: 'sb-a',
      representation: 'audio:mp4a',
      kinds: ['audio'],
      info: info('audio'),
      initBytes: new Uint8Array(16),
      chunks: [
        { start: 0, end: 2.1, bytes: new Uint8Array(8) },
        { start: 3.9, end: 6, bytes: new Uint8Array(8) },
      ],
    },
  ],
}

const index = planSnapshot(source, { id: 'x', capturedAt: 0, producer: 'test' }).index

const switchedIndex = planSnapshot(
  {
    page: source.page,
    tracks: [
      source.tracks[0]!,
      {
        ...source.tracks[0]!,
        id: 'v-second',
        bufferId: 'sb-v-second',
        representation: 'video:avc1:1280x720',
        chunks: [{ start: 8, end: 10, bytes: new Uint8Array(8) }],
      },
      source.tracks[1]!,
    ],
  },
  { id: 'switched', capturedAt: 0, producer: 'test' },
).index

/** A frame table over the same material: two runs of fifty frames, nothing inside the hole. */
const preview: Preview = {
  url: 'blob:preview',
  bytes: 1,
  // The size the fixture's own picture track declares — see `info('video')` above. A crop is a
  // rectangle of this, so a number invented here would be a rectangle of nothing.
  frameSize: { width: 640, height: 480 },
  frames: FrameTable.of(
    [0, 4].flatMap((from) =>
      Array.from({ length: 50 }, (_, at): Frame => ({
        pts: from + at / FPS,
        out: from + at / FPS,
        duration: 1 / FPS,
        sync: at === 0,
        source: { at: 0, length: 1 },
      })),
    ),
  ),
  release: () => {},
}

/** The Export settings as a tab reads them, with the value under test changed. */
const exported = (over: Partial<ExportSettings> = {}): ExportSettings => ({
  ...DEFAULTS.export,
  ...over,
})

describe('deriveMaterial', () => {
  it('builds the context the model works against out of the snapshot and the preview', () => {
    const { ctx, lanes, gaps, snapGaps } = deriveMaterial(index, preview)

    expect(lanes.map((lane) => lane.kind)).toEqual(['video', 'audio'])
    // One break of the recording, counted once — on the picture, which is what the cut follows.
    expect(gaps).toEqual([{ start: 2, end: 4 }])
    // And both edges of it as places to stick to: two chances to land on the hole exactly.
    expect(snapGaps).toEqual([
      { start: 2, end: 4 },
      { start: 2.1, end: 3.9 },
    ])
    expect(ctx.title).toBe('Talk')
    expect(ctx.duration).toBe(6)
    expect(ctx.fps).toBeCloseTo(FPS, 6)
    // Frame boundaries, so a handle can stand on the end of the material and never inside a hole.
    expect(ctx.frames.length).toBe(102)
    expect(ctx.frames.at(-1)).toBeCloseTo(6, 6)
    expect(ctx.keyframes.length).toBe(2)
  })

  it('carries the name template and the host of the page into the context', () => {
    // The setting is read once when the tab opens and reaches the model this way and no
    // other. The host comes with it because it has nowhere else to come from — `{host}` is one
    // of the five fields the settings page offers, the recording knows the address it was
    // watched at, and the reducer that names a clip knows nothing but the context.
    const { ctx } = deriveMaterial(index, preview, exported({ nameTemplate: '{host} {title} {in}' }))

    expect(ctx.nameTemplate).toBe('{host} {title} {in}')
    expect(ctx.host).toBe('site.example')
  })

  it('leaves the template out when the tab was opened without one', () => {
    // Which is what `clipName` reads as the default name: title and timecode. An empty
    // string here instead of nothing would be a template that resolves to an empty name.
    expect(deriveMaterial(index, preview).ctx.nameTemplate).toBeUndefined()
  })

  it('takes the runs and the zones from the picture, which is the lane the cut follows', () => {
    // Both come from the whole recording (see EditContext) and both are read off one lane, so a
    // derivation that reached for the audio lane — or for whichever lane came first — would put
    // the sound's own edges on the timeline the picture is cut against.
    const { ctx } = deriveMaterial(index, preview)

    expect(ctx.runs).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ])
    expect(ctx.zones.map((zone) => zone.representation)).toEqual(['video:avc1:640x480'])
  })

  it('shows only the picture zones of the representation whose frame grid is open', () => {
    const { ctx, lanes } = deriveMaterial(switchedIndex, preview, undefined, 'v')

    expect(ctx.zones.map((zone) => zone.representation)).toEqual(['video:avc1:640x480'])
    expect(lanes.find((lane) => lane.kind === 'video')!.runs).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ])
  })

  it('shows the whole ABR monitor but makes only the selected representation editable', () => {
    const low = {
      ...source.tracks[0]!,
      id: 'low',
      bufferId: 'abr-picture',
      representation: 'video:avc1:640x480:low',
      chunks: [
        { start: 0, end: 3, bytes: new Uint8Array(8) },
        { start: 4, end: 6, bytes: new Uint8Array(8) },
      ],
    }
    const high = {
      ...source.tracks[0]!,
      id: 'high',
      bufferId: 'abr-picture',
      representation: 'video:avc1:1280x720:high',
      chunks: [{ start: 2, end: 5, bytes: new Uint8Array(8) }],
    }
    const abrIndex = planSnapshot(
      { page: source.page, tracks: [low, high, source.tracks[1]!] },
      { id: 'abr', capturedAt: 0, producer: 'test' },
    ).index
    const monitorFps = 50
    const frames = Array.from({ length: 6 * monitorFps }, (_, at): Frame => ({
      pts: at / monitorFps,
      out: at / monitorFps,
      duration: 1 / monitorFps,
      sync: at % monitorFps === 0,
      source: { at: 0, length: 1 },
    }))
    const selectedFrames = FrameTable.of(
      [0, 4].flatMap((from) =>
        Array.from({ length: 2 * FPS }, (_, at): Frame => ({
          pts: from + at / FPS,
          out: from + at / FPS,
          duration: 1 / FPS,
          sync: at === 0,
          source: { at: 0, length: 1 },
        })),
      ),
    )
    const composite = {
      ...preview,
      frames: FrameTable.of(frames),
      editFrames: selectedFrames,
      monitor: {
        pictures: [
          { trackId: 'low', representation: low.representation, start: 0, end: 2, codec: 'avc1', width: 640, height: 480 },
          { trackId: 'high', representation: high.representation, start: 2, end: 4, codec: 'avc1', width: 1280, height: 720 },
          { trackId: 'low', representation: low.representation, start: 4, end: 6, codec: 'avc1', width: 640, height: 480 },
        ],
      },
    } as Preview & {
      editFrames: FrameTable
      monitor: { pictures: Array<{ trackId: string; representation: string; start: number; end: number; codec: string; width: number; height: number }> }
    }

    const { ctx, lanes } = deriveMaterial(abrIndex, composite, undefined, 'low')

    expect(lanes.find((lane) => lane.kind === 'video')!.runs).toEqual([{ start: 0, end: 6 }])
    expect(
      lanes.find((lane) => lane.kind === 'video')!.zones.map(({ start, end, representation }) => [
        start,
        end,
        representation,
      ]),
    ).toEqual([
      [0, 2, low.representation],
      [2, 4, high.representation],
      [4, 6, low.representation],
    ])
    expect(ctx.fps).toBe(FPS)
    expect(ctx.keyframes).toEqual(selectedFrames.keyframeTimes())
    expect(ctx.zones.map(({ start, end, representation }) => [start, end, representation])).toEqual([
      [0, 2, low.representation],
      [4, 6, low.representation],
    ])

    const middle = reduce(newProject(1_000, ctx), { type: 'seek', time: 3 }, ctx)
    expect(reduce(middle, { type: 'setIn' }, ctx)).toBe(middle)

    const returned = reduce(newProject(1_000, ctx), { type: 'seek', time: 4.5 }, ctx)
    const clipped = reduce(returned, { type: 'setOut' }, ctx)
    expect(clipped.doc.clips[0]).toMatchObject({
      in: 4,
      representation: low.representation,
    })
  })

  /**
   * Delivery, not source. What `frameSize` is measured from is the preview's own video track,
   * and that is proven where a preview is really assembled — `tests/editor/preview.test.ts`.
   * Here the only claim is that `deriveMaterial` carries the number across without inventing
   * one, which is exactly what a literal `{ width: 0, height: 0 }` in this file would do.
   */
  it('carries the size of the picture from the preview into the context', () => {
    const { ctx } = deriveMaterial(index, preview)

    expect(ctx.frameSize).toEqual(preview.frameSize)
    expect(ctx.frameSize).toEqual({ width: 640, height: 480 })
  })

  it('hands that size on to whoever asks what is being encoded', () => {
    // The number reaching the field is not the same as the number reaching the encoder. This is
    // the question the codec probe and ladder are asked, built from the context alone.
    const { ctx } = deriveMaterial(index, preview)

    expect(geometryOf(null, ctx.frameSize, ctx.fps)).toEqual({
      width: 640,
      height: 480,
      framerate: ctx.fps,
    })
  })

  it('has no frame size for a tab with no picture in it', () => {
    // The one place a zero is honest: nothing is open, so there is nothing a crop is a rectangle
    // of. Everywhere else a zero is a crop that collapses without saying so.
    expect(deriveMaterial(index, null).ctx.frameSize).toEqual({ width: 0, height: 0 })
  })

  it('carries the format a new clip is born in out of the settings and into the reducer', () => {
    // Settings reach the model this way and no other: the clip is made by `reduce`, which is pure
    // and knows nothing but the context it is handed. What carries the group this far is held
    // by `tests/editor/shell.test.tsx` — see the note on `deriveMaterial`.
    const born = (format?: ExportFormat): string => {
      const { ctx } = deriveMaterial(index, preview, format && exported({ format }))
      const project = reduce(newProject(1_000, ctx), { type: 'addClip' }, ctx)
      expect(project.doc.clips, 'no clip was made to read the format off').toHaveLength(1)
      return project.doc.clips[0]!.format
    }

    expect(born('webp')).toBe('webp')
    // A missing setting uses the documented default, not whatever the last tab used.
    expect(born(undefined)).toBe('mp4')
    expect(DEFAULTS.export.format).toBe('mp4')
  })

  it('opens a snapshot with no preview without falling over', () => {
    const { ctx } = deriveMaterial(index, null)

    expect(ctx.frames.length).toBe(0)
    expect(ctx.keyframes.length).toBe(0)
    expect(ctx.fps).toBe(0)
    expect(ctx.duration).toBe(6)
  })
})

describe('createStore', () => {
  const start = () => {
    const { ctx } = deriveMaterial(index, preview)
    return { ctx, store: createStore(newSession(newProject(1_000, ctx)), ctx) }
  }

  it('moves the session and tells whoever is listening', () => {
    const { store } = start()
    const heard = vi.fn()
    store.subscribe(heard)

    store.dispatch({ type: 'seek', time: 1 })

    expect(store.get().project.ui.playhead).toBeCloseTo(1, 6)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('says nothing when the action changed nothing', () => {
    const { store } = start()
    const heard = vi.fn()
    store.subscribe(heard)

    // Splitting with nothing selected, and seeking to where the playhead already is.
    store.dispatch({ type: 'splitClip' })
    store.dispatch({ type: 'seek', time: 0 })

    expect(heard).not.toHaveBeenCalled()
  })

  it('measures an action against the material it was given', () => {
    // The context is the store's, not the caller's: without it `step` would be reducing against
    // an empty frame grid, and a seek would land wherever it was asked to rather than on a frame.
    const { store } = start()

    store.dispatch({ type: 'seek', time: 1.031 })

    // 1.031 is inside frame 25 of a 25 fps grid, whose boundaries are 1.00 and 1.04.
    expect(store.get().project.ui.playhead).toBeCloseTo(1.04, 6)
  })

  it('undoes what it did', () => {
    const { store } = start()
    store.dispatch({ type: 'seek', time: 1 })
    store.dispatch({ type: 'setIn' })
    expect(store.get().project.doc.clips).toHaveLength(1)

    store.dispatch({ type: 'undo' })
    expect(store.get().project.doc.clips).toHaveLength(0)
  })

  it('lets a listener go', () => {
    const { store } = start()
    const heard = vi.fn()
    store.subscribe(heard)()

    store.dispatch({ type: 'seek', time: 1 })
    expect(heard).not.toHaveBeenCalled()
  })

  it('tells every listener, not merely the last one to arrive', () => {
    const { store } = start()
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe(first)
    store.subscribe(second)

    store.dispatch({ type: 'seek', time: 1 })

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('useSession', () => {
  const host = document.createElement('div')
  document.body.append(host)

  afterEach(() => render(null, host))

  it('subscribes before a child mount effect can update the store', async () => {
    const { ctx } = deriveMaterial(index, preview)
    const store = createStore(newSession(newProject(1_000, ctx)), ctx)

    function ResizeOnMount({ target }: { target: EditorStore }) {
      useEffect(() => target.dispatch({ type: 'resize', widthPx: 800 }), [target])
      return null
    }

    function Probe({ target }: { target: EditorStore }) {
      const session = useSession(target)
      return h(
        'div',
        null,
        h(ResizeOnMount, { target }),
        h('span', { 'data-testid': 'width' }, String(session.project.ui.view.widthPx)),
      )
    }

    render(h(Probe, { target: store }), host)
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))

    // Child passive effects run before parent passive effects in Preact. A passive subscription
    // misses this first measurement and leaves the opening 1200 px bitmap stretched until any
    // unrelated edit wakes the store.
    expect(host.querySelector('[data-testid="width"]')!.textContent).toBe('800')
  })
})
