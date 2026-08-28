import { describe, it, expect } from 'vitest'
import { ctx, FRAME } from './edit-fixture'
import { ACTION_TYPES, reduce, undoModeOf, type Action } from '../../src/core/edit/actions'
import { newProject, type Doc, type Project } from '../../src/core/edit/project'
import { HISTORY_LIMIT, canRedo, canUndo } from '../../src/core/edit/history'
import { newSession, step, type EditSession, type SessionAction } from '../../src/core/edit/session'
import { actionFor, type KeyPress } from '../../src/core/edit/keymap'

const fresh = (): Project => newProject(1_200, ctx)

/** A list of actions is a scenario: the reducer is pure, so a test needs nothing else. */
const run = (actions: Action[], from: Project = fresh()): Project =>
  actions.reduce((project, action) => reduce(project, action, ctx), from)

const play = (actions: SessionAction[], from: EditSession = newSession(fresh())): EditSession =>
  actions.reduce((session, action) => step(session, action, ctx), from)

const seek = (time: number): Action => ({ type: 'seek', time })

/**
 * One command, with whatever has to be true before it means anything.
 *
 * The type is a `Record` over the union on purpose: a command added to `Action` and not to this
 * table does not compile, and the census below then holds the table to the one in the source.
 * Every sample must actually do something — an inert sample would let a real defect through
 * every check in this file, which is why that is the second thing tested.
 */
interface Sample {
  before: Action[]
  action: Action
}

const SAMPLES: Record<Action['type'], Sample> = {
  seek: { before: [], action: seek(1) },
  step: { before: [seek(1)], action: { type: 'step', frames: 1 } },
  skip: { before: [seek(1)], action: { type: 'skip', seconds: 1 } },
  selectClip: {
    before: [seek(1), { type: 'setIn' }],
    action: { type: 'selectClip', id: null },
  },
  zoom: { before: [], action: { type: 'zoom', atPx: 600, factor: 0.5 } },
  zoomStep: { before: [], action: { type: 'zoomStep', factor: 0.5 } },
  zoomToSelection: {
    before: [seek(1), { type: 'setIn' }],
    action: { type: 'zoomToSelection' },
  },
  fitAll: {
    before: [{ type: 'zoom', atPx: 600, factor: 0.25 }],
    action: { type: 'fitAll' },
  },
  pan: {
    before: [{ type: 'zoom', atPx: 600, factor: 0.25 }],
    action: { type: 'pan', dxPx: 60 },
  },
  resize: { before: [], action: { type: 'resize', widthPx: 900 } },
  setSnapping: { before: [], action: { type: 'setSnapping', on: false } },
  toggleSnapping: { before: [], action: { type: 'toggleSnapping' } },

  setIn: { before: [seek(1)], action: { type: 'setIn' } },
  setOut: { before: [seek(8)], action: { type: 'setOut' } },
  addClip: { before: [seek(1)], action: { type: 'addClip' } },
  removeClip: {
    before: [seek(1), { type: 'setIn' }],
    action: { type: 'removeClip', id: 'c1' },
  },
  splitClip: {
    before: [seek(1), { type: 'setIn' }, seek(2)],
    action: { type: 'splitClip' },
  },
  renameClip: {
    before: [seek(1), { type: 'setIn' }],
    action: { type: 'renameClip', id: 'c1', name: 'A better name' },
  },
  toggleSound: {
    before: [seek(1), { type: 'setIn' }],
    action: { type: 'toggleSound', id: 'c1' },
  },
  addMarker: { before: [seek(1)], action: { type: 'addMarker' } },
  removeMarker: {
    before: [seek(1), { type: 'addMarker' }],
    action: { type: 'removeMarker', id: 'm1' },
  },
  removeMarkerAt: {
    before: [seek(1), { type: 'addMarker' }],
    action: { type: 'removeMarkerAt' },
  },
  trim: {
    before: [seek(1), { type: 'setIn' }],
    action: { type: 'trim', id: 'c1', edge: 'out', time: 2 },
  },
}

const samples = (): Array<[Action['type'], Sample]> =>
  Object.entries(SAMPLES) as Array<[Action['type'], Sample]>

describe('the census of commands', () => {
  it('holds a sample of every command there is', () => {
    expect([...ACTION_TYPES].sort()).toEqual(Object.keys(SAMPLES).sort())
  })

  it('has no sample that does nothing', () => {
    for (const [name, sample] of samples()) {
      const before = run(sample.before)
      expect(reduce(before, sample.action, ctx), `${name} changes nothing`).not.toBe(before)
    }
  })

  it('never changes the document behind the back of the history', () => {
    for (const [name, sample] of samples()) {
      const before = run(sample.before)
      const after = reduce(before, sample.action, ctx)
      if (after.doc === before.doc) continue

      // The law this whole task exists for: an edit the history does not know about is an edit
      // Ctrl+Z cannot take back, and nothing else in the program would ever say so.
      expect(undoModeOf(sample.action).kind, `${name} edits the document silently`).not.toBe('skip')
    }
  })

  it('writes no step of history for a command that edits nothing', () => {
    for (const [name, sample] of samples()) {
      if (undoModeOf(sample.action).kind === 'skip') continue
      const before = run(sample.before)

      // The other direction: a movement listed as an edit would make Ctrl+Z eat a step that
      // never happened, and the user would press it twice to undo one thing.
      expect(reduce(before, sample.action, ctx).doc, `${name}`).not.toBe(before.doc)
    }
  })
})

/** A copy that shares nothing with the original: the yardstick for "the same document back". */
const copy = (doc: Doc): Doc => structuredClone(doc)

/** Freezes an object and everything under it, so that a write in place throws instead of hiding. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

describe('the round trip', () => {
  it('takes back and puts back every edit there is', () => {
    for (const [name, sample] of samples()) {
      if (undoModeOf(sample.action).kind === 'skip') continue

      const opened = play(sample.before)
      const was = copy(opened.project.doc)
      const edited = step(opened, sample.action, ctx)
      const now = copy(edited.project.doc)

      expect(canUndo(edited.history), `${name} wrote no step`).toBe(true)

      const undone = step(edited, { type: 'undo' }, ctx)
      // Field for field and not by identity: the point is that the document comes back whole,
      // including the counter behind the identifiers — reusing c1 after an undo would give two
      // clips the same name in the same session.
      expect(undone.project.doc, `${name} came back different`).toEqual(was)
      expect(canRedo(undone.history), `${name} left nothing to redo`).toBe(true)

      const redone = step(undone, { type: 'redo' }, ctx)
      expect(redone.project.doc, `${name} was put back different`).toEqual(now)
    }
  })

  it('writes no step for a movement, whatever else has happened', () => {
    for (const [name, sample] of samples()) {
      if (undoModeOf(sample.action).kind !== 'skip') continue

      const opened = play(sample.before)
      const moved = step(opened, sample.action, ctx)

      expect(moved.history.past.length, `${name} grew the history`).toBe(opened.history.past.length)
      expect(moved.history.present, `${name} put a different document in the present`).toBe(
        opened.project.doc,
      )
    }
  })

  it('never writes into a document it has already put away', () => {
    // Every document the history is holding is frozen, and the ones the reducer makes after that
    // are frozen too. An array sorted in place or a clip patched in place then throws on the spot
    // instead of quietly changing what Ctrl+Z is going to restore.
    //
    // A session of its own per sample, and not one threaded through the whole table, because the
    // samples name the clip they work on: `c1` is what the first `setIn` of a fresh document
    // makes. Threaded, `removeClip` takes `c1` away halfway down the table, and `renameClip`,
    // `toggleSound` and `trim` then find nothing and return at the first line — the three
    // branches that patch a clip that already exists, which are the three likeliest places for a
    // write in place, would be the three this check never reached.
    let last = newSession(fresh())

    for (const [name, sample] of samples()) {
      let session = newSession(fresh())
      deepFreeze(session.project.doc)

      for (const action of [...sample.before, sample.action]) {
        // The throw, if there is one, comes from inside the reducer: it is being handed frozen
        // clips and a frozen array of them, and a sort or a push in place dies on the spot.
        expect(() => {
          session = step(session, action, ctx)
        }, `${name}`).not.toThrow()
        deepFreeze(session.project.doc)
      }

      // And once more over documents the history has been holding frozen since it took them.
      session = step(session, { type: 'undo' }, ctx)
      session = step(session, { type: 'redo' }, ctx)
      last = session
    }

    // The table ends on `trim`, whose sample makes a clip before it moves an edge of it: a loop
    // that quietly ran nothing would leave an empty document here.
    expect(last.project.doc.clips.length).toBeGreaterThan(0)
  })
})

/**
 * Everything a person does in one sitting, in the order they do it.
 *
 * Eleven edits with movements between them, on both runs of the material and on both zones. The
 * identifiers are written out rather than looked up: `c1`, `c2`, `c3`, `m4`, `m5` is the scheme
 * — one counter for clips and markers, different prefixes — and a test that spelled them out is
 * a test that notices when the scheme changes.
 */
const SITTING: Action[] = [
  seek(1),
  { type: 'setIn' },                                        // c1 = [1, 4]
  { type: 'trim', id: 'c1', edge: 'out', time: 3 },         // c1 = [1, 3]
  { type: 'selectClip', id: null },
  seek(6.4),
  { type: 'setIn' },                                        // c2 = [6.4, 10]
  { type: 'trim', id: 'c2', edge: 'out', time: 8 },         // c2 = [6.4, 8]
  seek(7),
  { type: 'splitClip' },                                    // c2 = [6.4, 7], c3 = [7, 8]
  { type: 'renameClip', id: 'c3', name: 'Tail' },
  { type: 'toggleSound', id: 'c3' },
  { type: 'addMarker' },                                    // m4 at 7
  seek(2),
  { type: 'addMarker' },                                    // m5 at 2
  { type: 'removeMarker', id: 'm4' },
  { type: 'removeClip', id: 'c1' },
]

describe('a whole sitting', () => {
  it('unwinds to the beginning and winds back up, state for state', () => {
    let session = newSession(fresh())
    /** The document after every edit, in order — what undo has to hand back on the way down. */
    const marks: Doc[] = [copy(session.project.doc)]

    for (const action of SITTING) {
      const next = step(session, action, ctx)
      if (next.project.doc !== session.project.doc) marks.push(copy(next.project.doc))
      session = next
    }

    expect(marks).toHaveLength(12)
    expect(session.project.doc.clips.map((clip) => clip.id)).toEqual(['c2', 'c3'])
    expect(session.project.doc.markers.map((marker) => marker.id)).toEqual(['m5'])
    expect(session.project.doc.clips[1]).toMatchObject({ name: 'Tail', sound: false })

    for (let at = marks.length - 2; at >= 0; at--) {
      session = step(session, { type: 'undo' }, ctx)
      expect(session.project.doc, `undo to state ${at}`).toEqual(marks[at])
    }

    expect(canUndo(session.history)).toBe(false)
    expect(session.project.doc.clips).toEqual([])
    // The selection cannot point at a clip that is not in the document any more; it is the one
    // part of the interface a change of document is allowed to touch (withDoc, Task 10).
    expect(session.project.ui.selectedClipId).toBeNull()

    for (let at = 1; at < marks.length; at++) {
      session = step(session, { type: 'redo' }, ctx)
      expect(session.project.doc, `redo to state ${at}`).toEqual(marks[at])
    }

    expect(canRedo(session.history)).toBe(false)
  })

  it('throws away what was ahead as soon as something new is done', () => {
    const played = play([seek(1), { type: 'setIn' }, { type: 'addMarker' }])
    const back = play([{ type: 'undo' }, { type: 'undo' }], played)
    expect(canRedo(back.history)).toBe(true)

    const elsewhere = play([seek(6.4), { type: 'setIn' }], back)

    expect(canRedo(elsewhere.history)).toBe(false)
    expect(elsewhere.project.doc.clips).toHaveLength(1)
    expect(elsewhere.project.doc.clips[0]!.in).toBeCloseTo(6.4, 9)
  })
})

describe('the depth of the history', () => {
  /** 150 marks: a hundred on the first run at a frame apart, fifty on the second. */
  const many: Action[] = Array.from({ length: 150 }, (_, i) =>
    i < 100 ? seek(Math.round(i * FRAME * 1000) / 1000) : seek(6 + Math.round((i - 100) * FRAME * 1000) / 1000),
  ).flatMap((at) => [at, { type: 'addMarker' } as Action])

  it('keeps a hundred steps and forgets the oldest', () => {
    const session = play(many)

    expect(session.project.doc.markers).toHaveLength(150)
    expect(session.history.past).toHaveLength(HISTORY_LIMIT)

    let back = session
    for (let i = 0; i < HISTORY_LIMIT; i++) back = step(back, { type: 'undo' }, ctx)

    // A hundred steps back from a hundred and fifty: the first fifty are past taking back, and
    // that is what a bounded history means. Silence about it would be worse than the bound.
    expect(back.project.doc.markers).toHaveLength(50)
    expect(canUndo(back.history)).toBe(false)
  })

  it('does nothing at all when there is nothing left to undo', () => {
    const empty = newSession(fresh())
    expect(step(empty, { type: 'undo' }, ctx)).toBe(empty)
    expect(step(empty, { type: 'redo' }, ctx)).toBe(empty)
  })
})

const drag = (edge: 'in' | 'out', time: number): Action => ({ type: 'trim', id: 'c1', edge, time })

/** A clip to drag the handles of: c1 = [1, 4] on the first run. */
const withClip = (): EditSession => play([seek(1), { type: 'setIn' }])

describe('merging what belongs to one gesture', () => {
  it('folds a whole drag into one step', () => {
    // A hundred events is what a second of dragging really produces, and it has to undo in one.
    // Half a frame apart, because that is the other half of the same truth: a drag sends more
    // events than there are frames under them, and the ones that land on the frame already held
    // change nothing at all. A frame apart, a hundred of them would run out the bottom of a clip
    // seventy-five frames long and the tail of the drag would be the clip refusing to shrink.
    const moves: Action[] = Array.from({ length: 100 }, (_, i) => drag('out', 3.9 - (i * FRAME) / 2))
    const dragged = play(moves, withClip())

    // Two, not one: the step that made the clip, and then the whole drag as a single step.
    expect(dragged.history.past).toHaveLength(2)
    expect(dragged.project.doc.clips[0]!.out).toBeCloseTo(3.9 - (99 * FRAME) / 2, 6)

    const undone = step(dragged, { type: 'undo' }, ctx)
    expect(undone.project.doc.clips[0]!.out).toBe(4)
  })

  it('makes two steps of two drags with a movement between them', () => {
    const twice = play([drag('out', 3), seek(2), drag('out', 2.5)], withClip())
    expect(twice.history.past).toHaveLength(3)

    const once = step(twice, { type: 'undo' }, ctx)
    expect(once.project.doc.clips[0]!.out).toBe(3)
  })

  it('keeps the two edges of one clip apart', () => {
    const both = play([drag('out', 3), drag('in', 2)], withClip())
    expect(both.history.past).toHaveLength(3)
  })

  it('does not join a typed boundary to the drag before it', () => {
    // Dragging is hundreds of events and one act; typing a number is one event and another act.
    // Joined, Ctrl+Z after a typed correction would throw away the drag as well.
    const typed = play(
      [drag('out', 3), { type: 'trim', id: 'c1', edge: 'out', time: 2, typed: true }],
      withClip(),
    )

    expect(typed.history.past).toHaveLength(3)
    expect(step(typed, { type: 'undo' }, ctx).project.doc.clips[0]!.out).toBe(3)
  })

  it('merges renames per clip and not across them', () => {
    const two = play([{ type: 'selectClip', id: null }, seek(6.4), { type: 'setIn' }], withClip())
    const renamed = play(
      [
        { type: 'renameClip', id: 'c1', name: 'F' },
        { type: 'renameClip', id: 'c1', name: 'Fi' },
        { type: 'renameClip', id: 'c1', name: 'First' },
        { type: 'renameClip', id: 'c2', name: 'Second' },
      ],
      two,
    )

    expect(renamed.history.past).toHaveLength(4)
    expect(step(renamed, { type: 'undo' }, ctx).project.doc.clips[1]!.name).not.toBe('Second')
  })

  it('does not let a movement of nothing claim the key of the next one', () => {
    // The first pixel of a drag usually moves nothing. Were that no-op to claim the key, the
    // first real movement would merge into the step before it and swallow that step whole.
    const marked = play([{ type: 'addMarker' }], withClip())
    const nudged = play([drag('out', 4), drag('out', 3)], marked)

    expect(nudged.history.past).toHaveLength(3)

    const undone = step(nudged, { type: 'undo' }, ctx)
    expect(undone.project.doc.clips[0]!.out).toBe(4)
    expect(undone.project.doc.markers).toHaveLength(1)
  })
})

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shift: false,
  ctrl: false,
  meta: false,
  alt: false,
  repeat: false,
  ...mods,
})

describe('the keyboard against the history', () => {
  /** Every press the layout answers with an editing or a moving command, and what it must be. */
  const BOUND: Array<[string, Partial<KeyPress>, 'step' | 'skip' | 'merge']> = [
    ['i', {}, 'step'],
    ['o', {}, 'step'],
    ['s', {}, 'step'],
    ['m', {}, 'step'],
    ['Delete', {}, 'step'],
    ['Backspace', {}, 'step'],
    ['ArrowRight', {}, 'skip'],
    ['ArrowLeft', { shift: true }, 'skip'],
    ['Home', {}, 'skip'],
    ['End', {}, 'skip'],
    ['n', {}, 'skip'],
    ['z', {}, 'skip'],
    ['f', {}, 'skip'],
    ['=', {}, 'skip'],
    ['-', {}, 'skip'],
  ]

  it('answers every bound press with a command whose place in the history is decided', () => {
    for (const [key, mods, kind] of BOUND) {
      const action = actionFor(press(key, mods))
      expect(action, `${key} is bound to nothing`).not.toBeNull()
      expect(undoModeOf(action as Action).kind, `${key}`).toBe(kind)
    }
  })

  it('leaves undo and redo to the history rather than to the reducer', () => {
    // They are not members of `Action`, so `undoModeOf` never sees them, and the reducer has no
    // branch for them: the session is the one place that knows how to go back.
    expect(actionFor(press('z', { ctrl: true }))).toEqual({ type: 'undo' })
    expect(actionFor(press('z', { ctrl: true, shift: true }))).toEqual({ type: 'redo' })
    expect(actionFor(press('y', { ctrl: true }))).toEqual({ type: 'redo' })
    expect(actionFor(press('z', { meta: true }))).toEqual({ type: 'undo' })
  })
})
