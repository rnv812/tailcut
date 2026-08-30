import { describe, it, expect } from 'vitest'
import { METRICS, packRows, rowTop } from '../../src/core/timeline/layout'
import { snapSet } from '../../src/core/timeline/snap'
import {
  DRAG_SLOP_PX,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  type Surface,
} from '../../src/core/timeline/gesture'
import { timeToX, zoomFactorOf, type Viewport } from '../../src/core/timeline/view'

const view: Viewport = { start: 0, scale: 0.05, widthPx: 1200 }
const surface: Surface = {
  view,
  metrics: METRICS,
  laneCount: 2,
  clips: [],
  rows: new Map(),
  frames: new Float64Array(),
  snap: { targets: [], keyframes: new Float64Array() },
  snapping: true,
}

const wheel = (overrides: Partial<Parameters<typeof onWheel>[0]> = {}) =>
  onWheel({ x: 300, deltaX: 0, deltaY: 0, deltaMode: 0, alt: false, ...overrides })

/** A point inside the first lane: below the ruler, above the clip rows. */
const inLane = { x: 300, y: METRICS.rulerHeight + 10, alt: false }
const inRuler = { x: 200, y: 6, alt: false }

describe('onWheel', () => {
  it('pans through time on a vertical wheel', () => {
    expect(wheel({ deltaY: -120 })).toEqual({ type: 'pan', dxPx: 120 })
    expect(wheel({ deltaY: 120 })).toEqual({ type: 'pan', dxPx: -120 })
  })

  it('zooms toward the pointer only while Alt is held', () => {
    expect(wheel({ deltaY: -120, alt: true })).toEqual({
      type: 'zoom',
      atPx: 300,
      factor: zoomFactorOf(-120),
    })

    const out = wheel({ deltaY: 120, alt: true })

    expect(out).toMatchObject({ type: 'zoom' })
    expect((out as { factor: number }).factor).toBeGreaterThan(1)
  })

  it('pans on a horizontal wheel', () => {
    // A trackpad swipe: the horizontal delta wins whenever it is the larger one.
    expect(wheel({ deltaX: 90, deltaY: 10 })).toEqual({ type: 'pan', dxPx: -90 })
    expect(wheel({ deltaX: 90, deltaY: 10, alt: true })).toEqual({ type: 'pan', dxPx: -90 })
  })

  it('turns lines and pages into pixels before deciding', () => {
    expect(wheel({ deltaY: -3, deltaMode: 1 })).toEqual({
      type: 'pan',
      dxPx: 48,
    })
    expect(wheel({ deltaY: -3, deltaMode: 1, alt: true })).toEqual({
      type: 'zoom',
      atPx: 300,
      factor: zoomFactorOf(-48),
    })
  })

  it('says nothing about a wheel that did not move', () => {
    expect(wheel({})).toBeNull()
    expect(wheel({ alt: true })).toBeNull()
  })
})

describe('pointer', () => {
  it('scrubs on a press in the ruler', () => {
    const result = onPointerDown(surface, inRuler)

    expect(result.gesture).toEqual({ type: 'seek', time: 10 })
    expect(result.drag).toEqual({ kind: 'scrub' })
  })

  it('keeps scrubbing while the pointer is dragged along the ruler', () => {
    const down = onPointerDown(surface, inRuler)
    const move = onPointerMove(surface, down.drag, { ...inRuler, x: 400 })

    expect(move.gesture).toEqual({ type: 'seek', time: 20 })
    expect(move.drag).toEqual({ kind: 'scrub' })
  })

  it('starts a pan on a press in a lane and says nothing yet', () => {
    const result = onPointerDown(surface, inLane)

    expect(result.gesture).toBeNull()
    expect(result.drag).toEqual({ kind: 'pan', x: 300, from: 300, moved: false })
  })

  it('pans by the pixels travelled since the last move', () => {
    const down = onPointerDown(surface, inLane)
    const first = onPointerMove(surface, down.drag, { ...inLane, x: 340 })
    const second = onPointerMove(surface, first.drag, { ...inLane, x: 350 })

    expect(first.gesture).toEqual({ type: 'pan', dxPx: 40 })
    expect(second.gesture).toEqual({ type: 'pan', dxPx: 10 })
  })

  it('a press and a release without travel is a seek', () => {
    const down = onPointerDown(surface, inLane)
    const move = onPointerMove(surface, down.drag, { ...inLane, x: 300 + DRAG_SLOP_PX - 1 })
    const up = onPointerUp(surface, move.drag, { ...inLane, x: 300 + DRAG_SLOP_PX - 1 })

    // 302 px at 0.05 s/px: 302 × 0.05 is 15.100000000000001 in binary, so the seek is compared
    // as the number it is and not as the decimal it prints to.
    expect(up.gesture).toMatchObject({ type: 'seek' })
    expect((up.gesture as { time: number }).time).toBeCloseTo(15.1, 12)
    expect(up.drag).toBeNull()
  })

  it('a release after a real drag seeks nowhere', () => {
    const down = onPointerDown(surface, inLane)
    const move = onPointerMove(surface, down.drag, { ...inLane, x: 500 })
    const up = onPointerUp(surface, move.drag, { ...inLane, x: 500 })

    expect(up.gesture).toBeNull()
    expect(up.drag).toBeNull()
  })

  it('a release of a scrub seeks nowhere either', () => {
    const down = onPointerDown(surface, inRuler)

    expect(onPointerUp(surface, down.drag, inRuler).gesture).toBeNull()
  })

  it('ignores a move that belongs to no drag', () => {
    expect(onPointerMove(surface, null, inLane)).toEqual({ drag: null, gesture: null })
    expect(onPointerUp(surface, null, inLane)).toEqual({ drag: null, gesture: null })
  })

  it('never seeks before the material', () => {
    expect(onPointerDown(surface, { ...inRuler, x: -40 }).gesture).toEqual({ type: 'seek', time: 0 })
  })
})

describe('handles', () => {
  const clips = [
    { id: 'c1', name: 'One', in: 10, out: 20, selected: true },
    { id: 'c2', name: 'Two', in: 15, out: 30, selected: false },
  ]
  const rows = packRows(clips)
  /** Quarter-second frames from 0 to 60; every fourth second carries a keyframe. */
  const frames = Float64Array.from({ length: 241 }, (_, i) => i * 0.25)
  const set = snapSet({
    keyframes: Float64Array.from([0, 4, 8, 12, 16, 20, 24]),
    zones: [],
    gaps: [],
    markers: [],
    clips,
    playhead: 0,
  })
  const withHandles: Surface = { ...surface, clips, rows, frames, snap: set, snapping: true }

  /**
   * The middle of the handle of a clip, in pixels of the surface it is drawn on.
   *
   * The viewport is a parameter because a handle is a place on the screen and not a time: at
   * another zoom the same edge of the same clip is somewhere else entirely, and a press at the
   * pixel of the opening zoom would land in the middle of nothing.
   */
  const handle = (id: string, edge: 'in' | 'out', v: Viewport = view) => {
    const clip = clips.find((candidate) => candidate.id === id)!
    const row = rows.get(id) ?? 0
    return {
      x: timeToX(v, edge === 'in' ? clip.in : clip.out),
      y: rowTop(METRICS, 2, row) + METRICS.clipHeight / 2,
      alt: false,
    }
  }

  it('grabbing a handle selects its clip and holds it', () => {
    const down = onPointerDown(withHandles, handle('c1', 'out'))

    expect(down.gesture).toEqual({ type: 'selectClip', id: 'c1' })
    expect(down.drag).toEqual({ kind: 'handle', id: 'c1', edge: 'out' })
  })

  it('grabs a handle from a few pixels off, and not from across the clip', () => {
    // The tab is seven pixels wide and the hand is not that steady, so the grab reaches wider
    // than the drawing. It does not reach the middle of the clip: that press means the body.
    const out = handle('c1', 'out')

    expect(onPointerDown(withHandles, { ...out, x: out.x - 4 }).drag).toMatchObject({
      kind: 'handle',
      edge: 'out',
    })
    expect(onPointerDown(withHandles, { ...out, x: out.x - 12 }).drag).toMatchObject({
      kind: 'clip',
      id: 'c1',
    })
  })

  it('grabs the handle of the clip on the row that was pressed', () => {
    const down = onPointerDown(withHandles, handle('c2', 'in'))

    expect(down.drag).toEqual({ kind: 'handle', id: 'c2', edge: 'in' })
  })

  it('trims to the frame grid while it is dragged', () => {
    const down = onPointerDown(withHandles, handle('c1', 'out'))
    // 20.61 s: nothing to snap to nearby, so the grid alone decides — 0.25 s frames.
    const move = onPointerMove(withHandles, down.drag, { x: 20.61 / view.scale, y: 0, alt: false })

    expect(move.gesture).toEqual({ type: 'trim', id: 'c1', edge: 'out', time: 20.5 })
    expect(move.hint).toBeNull()
  })

  it('catches a keyframe and says which one', () => {
    const down = onPointerDown(withHandles, handle('c1', 'out'))
    const move = onPointerMove(withHandles, down.drag, { x: 24.2 / view.scale, y: 0, alt: false })

    expect(move.gesture).toEqual({ type: 'trim', id: 'c1', edge: 'out', time: 24 })
    expect(move.hint).toMatchObject({ kind: 'keyframe', time: 24 })
  })

  it('drops the hint when the grid moves the handle off the target', () => {
    // A keyframe in the middle of a hole is a keyframe no cut can stand on: the grid pulls the
    // handle to the edge of the run, and a caption saying "keyframe" would name a place the
    // handle is not.
    const holed: Surface = {
      ...withHandles,
      frames: Float64Array.from([0, 20, 24, 24.25]),
      snap: snapSet({
        keyframes: Float64Array.from([22]),
        zones: [],
        gaps: [],
        markers: [],
        clips,
        playhead: 0,
      }),
    }
    const down = onPointerDown(holed, handle('c1', 'out'))
    const move = onPointerMove(holed, down.drag, { x: 21.9 / view.scale, y: 0, alt: false })

    expect(move.gesture).toMatchObject({ time: 20 })
    expect(move.hint).toBeNull()
  })

  it('alt frees the handle from the targets but not from the frames', () => {
    const down = onPointerDown(withHandles, handle('c1', 'out'))
    const move = onPointerMove(withHandles, down.drag, { x: 24.2 / view.scale, y: 0, alt: true })

    expect(move.gesture).toEqual({ type: 'trim', id: 'c1', edge: 'out', time: 24.25 })
    expect(move.hint).toBeNull()
  })

  it('alt turns snapping back on when it was switched off', () => {
    const off: Surface = { ...withHandles, snapping: false }
    const down = onPointerDown(off, handle('c1', 'out'))

    expect(onPointerMove(off, down.drag, { x: 24.2 / view.scale, y: 0, alt: false }).gesture).toMatchObject({
      time: 24.25,
    })
    expect(onPointerMove(off, down.drag, { x: 24.2 / view.scale, y: 0, alt: true }).gesture).toMatchObject({
      time: 24,
    })
  })

  it('the tolerance is in pixels, so a deeper zoom stops catching from afar', () => {
    const deep: Surface = { ...withHandles, view: { ...view, scale: 0.0005 } }
    const down = onPointerDown(deep, handle('c1', 'out', deep.view))
    const move = onPointerMove(deep, down.drag, { x: 24.2 / deep.view.scale, y: 0, alt: false })

    // The same handle, a hundred times as wide a screen: it is still grabbed, and it is the
    // catching that stops. Eight pixels are four thousandths of a second here, so 0.2 s is far.
    expect(down.drag).toMatchObject({ kind: 'handle', id: 'c1', edge: 'out' })
    expect(move.hint).toBeNull()
  })

  it('never offers a handle its own clip as a target', () => {
    const down = onPointerDown(withHandles, handle('c1', 'in'))
    const move = onPointerMove(withHandles, down.drag, { x: 19.9 / view.scale, y: 0, alt: false })

    expect(move.hint).not.toMatchObject({ owner: 'c1' })

    // And a nudge of the in handle where nothing else stands: the edge being dragged is the only
    // target within reach, and offered it the handle would stick to the place it started from.
    const nudge = onPointerMove(withHandles, down.drag, { x: 9.9 / view.scale, y: 0, alt: false })

    expect(nudge.hint).toBeNull()
  })

  it('pressing the body of a clip selects it and holds its original position', () => {
    // At 15 s, which is where the clip on the row below has its in handle: a handle belongs to
    // the row it is drawn on, or the rows would grab each other's edges through the screen.
    const body = { x: 15 / view.scale, y: rowTop(METRICS, 2, 0) + 9, alt: false }
    const down = onPointerDown(withHandles, body)

    expect(down.gesture).toEqual({ type: 'selectClip', id: 'c1' })
    expect(down.drag).toEqual({ kind: 'clip', id: 'c1', from: body.x, in: 10, moved: false })
  })

  it('moves a clip body on the frame grid without losing the grab offset', () => {
    const body = { x: 15 / view.scale, y: rowTop(METRICS, 2, 0) + 9, alt: false }
    const down = onPointerDown(withHandles, body)
    const move = onPointerMove(withHandles, down.drag, { ...body, x: 18.13 / view.scale })

    // Grabbed five seconds inside c1. The pointer moved to 18.13, so its in point moves from 10
    // to the nearest quarter-second frame at 13.25 instead of jumping under the pointer.
    expect(move.gesture).toEqual({ type: 'moveClip', id: 'c1', time: 13.25 })
    expect(move.drag).toMatchObject({ kind: 'clip', id: 'c1', moved: true })
  })

  it('a clip click selects on press and seeks on release', () => {
    const body = { x: 15 / view.scale, y: rowTop(METRICS, 2, 0) + 9, alt: false }
    const down = onPointerDown(withHandles, body)
    const up = onPointerUp(withHandles, down.drag, body)

    expect(down.gesture).toEqual({ type: 'selectClip', id: 'c1' })
    expect(up).toEqual({ drag: null, gesture: { type: 'seek', time: 15 } })
  })

  it('a shaky clip click seeks but does not move the clip', () => {
    const body = { x: 15 / view.scale, y: rowTop(METRICS, 2, 0) + 9, alt: false }
    const down = onPointerDown(withHandles, body)
    const move = onPointerMove(withHandles, down.drag, { ...body, x: body.x + DRAG_SLOP_PX - 1 })
    const up = onPointerUp(withHandles, move.drag, { ...body, x: body.x + DRAG_SLOP_PX - 1 })

    expect(move.gesture).toBeNull()
    expect(up.gesture).toMatchObject({ type: 'seek' })
  })

  it('releasing a moved clip seeks nowhere', () => {
    const body = { x: 15 / view.scale, y: rowTop(METRICS, 2, 0) + 9, alt: false }
    const down = onPointerDown(withHandles, body)
    const move = onPointerMove(withHandles, down.drag, { ...body, x: body.x + 20 })

    expect(onPointerUp(withHandles, move.drag, { ...body, x: body.x + 20 }).gesture).toBeNull()
  })

  it('pressing the empty space under the clips clears the selection', () => {
    const beyond = { x: 50 / view.scale, y: rowTop(METRICS, 2, 0) + 9, alt: false }
    // 25 s is empty on the first row and inside the clip of the second: a press picks what is
    // drawn where it landed, not what is drawn at that time somewhere else.
    const beside = { x: 25 / view.scale, y: rowTop(METRICS, 2, 0) + 9, alt: false }

    expect(onPointerDown(withHandles, beyond).gesture).toEqual({ type: 'selectClip', id: null })
    expect(onPointerDown(withHandles, beside).gesture).toEqual({ type: 'selectClip', id: null })
  })

  it('pressing between two rows of clips is not a press on either', () => {
    // The gap between the rows belongs to nobody: a press there clears the selection rather
    // than picking whichever clip happens to be drawn nearest.
    const between = { x: 17 / view.scale, y: rowTop(METRICS, 2, 1) - 1, alt: false }

    expect(onPointerDown(withHandles, between).gesture).toEqual({ type: 'selectClip', id: null })
  })

  it('releasing a handle clears the drag and the hint', () => {
    const down = onPointerDown(withHandles, handle('c1', 'out'))
    const up = onPointerUp(withHandles, down.drag, handle('c1', 'out'))

    expect(up).toEqual({ drag: null, gesture: null, hint: null })
  })
})
