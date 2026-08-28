import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { ingestInit } from '../../../src/core/container'
import { assembleMp4 } from '../../../src/core/export/assemble'
import { planPreview } from '../../../src/core/export/plan'
import { ByteMap, clipSourceOf } from '../../../src/core/export/source'
import { FrameTable, framesOf, retimeToPlan } from '../../../src/core/timeline/frames'
import type { Hover } from '../../../src/core/timeline/hover'
import type { Lane } from '../../../src/core/timeline/lanes'
import type { Viewport } from '../../../src/core/timeline/view'
import type { Preview } from '../../../src/editor/source/preview'
import { FramePreview } from '../../../src/editor/timeline/hover'
import { Timeline } from '../../../src/editor/timeline/timeline'

const bytesOf = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await (await fetch(`/fixtures/${path}`)).arrayBuffer())

/**
 * The six-second picture fixture, assembled the way the editor assembles a preview.
 *
 * The same plan and the same writer, deliberately: a stand that built its file some other way
 * would be measuring a thumbnail source the product does not have.
 */
async function preview(): Promise<Preview> {
  const initBytes = await bytesOf('h264/init-stream0.m4s')
  const info = ingestInit(initBytes)!.info
  const track = info.tracks[0]!
  const segments = await Promise.all(
    [1, 2, 3].map((index) => bytesOf(`h264/chunk-stream0-${String(index).padStart(5, '0')}.m4s`)),
  )

  const map = new ByteMap()
  const placed = segments.map((bytes) => ({ bytes, at: map.place(bytes) }))
  const source = clipSourceOf([{ kind: 'video', initBytes, segments: placed }])!
  const plan = planPreview(source)

  const file = assembleMp4(plan, (at) => map.bytesOf(at))
  const url = URL.createObjectURL(new Blob([file as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }))

  const frames = retimeToPlan(
    framesOf({
      init: initBytes,
      trackId: track.trackId,
      timescale: track.timescale,
      segments: placed.map((one) => ({ bytes: one.bytes, source: one.at })),
    }),
    plan.tracks[0]!,
  )

  return {
    url,
    bytes: file.byteLength,
    frames: FrameTable.of(frames),
    release: () => URL.revokeObjectURL(url),
  }
}

const LANES: Lane[] = [{ kind: 'video', runs: [{ start: 0, end: 6 }], gaps: [], zones: [] }]

/** How many positions the timeline has handed out. Outside the component: it is not drawn. */
let reports = 0

function Host() {
  const [built, setBuilt] = useState<Preview | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const [view, setView] = useState<Viewport>({ start: 0, scale: 6 / 1_000, widthPx: 1_000 })

  useEffect(() => {
    void preview().then(setBuilt)
  }, [])

  const shared = globalThis as unknown as Record<string, unknown>
  shared.tcReady = () => Boolean(built)
  shared.tcReports = (): number => reports
  /**
   * A sweep of the strip delivered inside one turn.
   *
   * The driver cannot stage one: measured on this page, sixty `mouse.move` calls take a second —
   * seventeen milliseconds apiece, a whole animation frame each — so every position gets its own
   * frame and its own seek however tightly the loop is written. A hand on a trackpad does not
   * wait for the frame, and neither does this.
   */
  shared.tcSweep = (fromPx: number, toPx: number, count: number): void => {
    const canvas = document.querySelector('canvas')!
    const box = canvas.getBoundingClientRect()
    for (let step = 0; step < count; step++) {
      const x = fromPx + ((toPx - fromPx) * step) / (count - 1)
      canvas.dispatchEvent(
        new MouseEvent('pointermove', { clientX: box.left + x, clientY: box.top + 30, bubbles: true }),
      )
    }
  }
  shared.tcSeeks = (): number =>
    Number(document.querySelector<HTMLVideoElement>('[data-testid="thumb"] video')?.dataset.seeks ?? -1)
  shared.tcShot = (): number => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="thumb-shot"]')!
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    const seen = new Set<number>()
    for (let at = 0; at < data.length; at += 4) seen.add((data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!)
    return seen.size
  }

  if (!built) return <div>building…</div>

  return (
    <div class="strip">
      <Timeline
        lanes={LANES}
        clips={[]}
        markers={[]}
        view={view}
        playhead={0}
        fps={built.frames.fps()}
        frames={new Float64Array()}
        snap={{ targets: [], keyframes: new Float64Array() }}
        snapping={false}
        onResize={(widthPx) => setView((current) => ({ ...current, widthPx }))}
        onGesture={() => {}}
        onHover={(next) => {
          reports++
          setHover(next)
        }}
      />
      <FramePreview preview={built} hover={hover} widthPx={view.widthPx} fps={built.frames.fps()} />
    </div>
  )
}

render(<Host />, document.getElementById('root')!)
