// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { render } from 'preact'
import { Shell, type EditorState } from '../../src/editor/shell'
import { planSnapshot, type SnapshotSource } from '../../src/core/snapshot/build'
import { SnapshotReader } from '../../src/core/snapshot/read'
import { materialOf } from '../../src/core/snapshot/material'
import { FrameTable } from '../../src/core/timeline/frames'
import { concatBytes } from '../../src/core/iso/writer'

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

  it('shows crop and WebP disabled, with the reason beside them', async () => {
    show(await ready())

    const crop = document.querySelector<HTMLInputElement>('[data-testid="crop"]')!
    const webp = document.querySelector<HTMLInputElement>('[data-testid="webp"]')!

    expect(crop.disabled).toBe(true)
    expect(webp.disabled).toBe(true)
    expect(text('reencode-note')).toContain('re-encoding')
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
    show({ ...(await ready()), preview: 'building' } as EditorState)

    expect(document.querySelector('[data-testid="player"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="preview"]')).toBeNull()
    expect(document.body.textContent).toContain('Building the preview')
  })

  it('says why there is nothing to play in a snapshot with no picture', async () => {
    show({ ...(await ready()), preview: null } as EditorState)
    expect(document.body.textContent).toContain('no picture in this recording')
  })

  it('puts the element and the frame readout in the player pane once there is a preview', async () => {
    const frames = Array.from({ length: 5 }, (_, at) => ({
      pts: at / 25,
      out: at / 25,
      duration: 1 / 25,
      sync: at === 0,
      source: { at, length: 1 },
    }))
    const preview = {
      url: 'blob:preview',
      bytes: 10,
      frames: FrameTable.of(frames),
      release: () => {},
    }

    show({ ...(await ready()), preview } as EditorState)

    expect(document.querySelector<HTMLVideoElement>('[data-testid="preview"]')!.src).toBe(
      'blob:preview',
    )
    expect(text('frame')).toBe('1')
    expect(text('frame-count')).toBe('5')
    expect(text('timecode')).toBe('00:00:00:00')
  })
})
