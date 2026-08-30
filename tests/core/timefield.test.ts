import { describe, it, expect } from 'vitest'
import {
  commitField,
  fieldOf,
  nudged,
  parseEntry,
  retyped,
  type FieldState,
} from '../../src/core/edit/timefield'

const FPS = 25
const typed = (text: string): FieldState => ({ text, invalid: false })

describe('parseEntry', () => {
  it('reads everything parseTimecode reads', () => {
    expect(parseEntry('00:01:23:12', FPS, 0)).toBeCloseTo(83.48, 9)
    expect(parseEntry('1:23', FPS, 0)).toBe(83)
    expect(parseEntry('83.5s', FPS, 0)).toBe(83.5)
  })

  it('reads a frame number, which is what a hand used to an editor types', () => {
    expect(parseEntry('250f', FPS, 0)).toBe(10)
    expect(parseEntry('0f', FPS, 0)).toBe(0)
    expect(parseEntry(' 250 F ', FPS, 0)).toBe(10)
    expect(parseEntry('250f', 24_000 / 1_001, 0)).toBeCloseTo(250 / 24, 9)
  })

  it('reads an offset from where the value stands now', () => {
    expect(parseEntry('+10', FPS, 30)).toBe(40)
    expect(parseEntry('-10', FPS, 30)).toBe(20)
    expect(parseEntry('+0:05', FPS, 30)).toBe(35)
    expect(parseEntry('-25f', FPS, 30)).toBe(29)
  })

  it('answers what it cannot read with null and not with zero', () => {
    // Zero is the one wrong answer here: it would move the playhead to the start of the
    // recording, which looks exactly like the editor losing the user's place.
    for (const bad of ['', '   ', 'abc', '1:2:3:4:5', '00:00:01:25', '00:60:00:00', '1:23.5', '+', 'f']) {
      expect(parseEntry(bad, FPS, 30), `«${bad}» was read as something`).toBeNull()
    }
  })
})

describe('commitField', () => {
  it('gives back the time and the box spelled out in full', () => {
    const result = commitField(typed('1:23'), FPS, 0)

    expect(result.time).toBe(83)
    expect(result.state).toEqual({ text: '00:01:23:00', invalid: false })
  })

  it('keeps what was typed when it cannot be read, and says so', () => {
    const result = commitField(typed('1:2x'), FPS, 30)

    expect(result.time).toBeNull()
    expect(result.state).toEqual({ text: '1:2x', invalid: true })
  })

  it('treats an emptied box as nothing to do rather than as a zero', () => {
    const result = commitField(typed('   '), FPS, 30)

    expect(result.time).toBeNull()
    expect(result.state.invalid).toBe(false)
  })

  it('never commits a time before the start of the material', () => {
    expect(commitField(typed('-10'), FPS, 4).time).toBe(0)
  })
})

describe('retyped', () => {
  it('clears the complaint as soon as the box is touched', () => {
    const complained: FieldState = { text: '1:2x', invalid: true }

    expect(retyped(complained, '1:23')).toEqual({ text: '1:23', invalid: false })
  })

  it('clears the complaint even when the same text comes back', () => {
    // The red is about the last commit and not about the letters. A hand that retypes the same
    // character over a selection has touched the box, and a box still marked wrong after being
    // touched is a box that says the next Enter will fail — which it will not.
    const complained: FieldState = { text: '1:2x', invalid: true }

    expect(retyped(complained, '1:2x')).toEqual({ text: '1:2x', invalid: false })
  })

  it('gives the state itself back when nothing changed', () => {
    const state = typed('1:23')

    expect(retyped(state, '1:23')).toBe(state)
  })
})

describe('nudged', () => {
  it('moves what stands in the box, not what stands in the model', () => {
    // Typed 1:23 and pressed the arrow: the answer is a frame past what was typed. Reading the
    // model instead would jump the value back to wherever the clip was.
    const result = nudged(typed('1:23'), 1, FPS, 300)

    expect(result.time).toBeCloseTo(83.04, 9)
    expect(result.state.text).toBe('00:01:23:01')
  })

  it('moves what the model says when the box has not been touched', () => {
    expect(nudged(fieldOf(10, FPS), -1, FPS, 10).time).toBeCloseTo(9.96, 9)
  })

  it('nudges from the model when the box has been emptied', () => {
    // An empty box stands for nothing, so there is nothing in it to move from — but the arrow
    // still means «one frame on», and the value it moves is the one the model holds. Reading the
    // empty box as a time would make the arrow land on frame one of the recording.
    const result = nudged(typed('  '), 1, FPS, 10)

    expect(result.time).toBeCloseTo(10.04, 9)
    expect(result.state.text).toBe('00:00:10:01')
  })

  it('reads back what it writes, so the second arrow moves a second frame', () => {
    // The box is the state: the value goes out as text and comes back parsed. A spelling that
    // lands a frame low would be read a frame low, and holding the arrow down would move by
    // nothing at all.
    const once = nudged(fieldOf(10, FPS), 1, FPS, 10)
    const twice = nudged(once.state, 1, FPS, 10)

    expect(once.state.text).toBe('00:00:10:01')
    expect(twice.time).toBeCloseTo(10.08, 9)
    expect(twice.state.text).toBe('00:00:10:02')
  })

  it('refuses to nudge rubbish, and keeps it', () => {
    const result = nudged(typed('1:2x'), 1, FPS, 10)

    expect(result.time).toBeNull()
    expect(result.state).toEqual({ text: '1:2x', invalid: true })
  })

  it('stops at the start of the material', () => {
    expect(nudged(fieldOf(0, FPS), -1, FPS, 0).time).toBe(0)
  })
})

describe('fieldOf', () => {
  it('spells the value the way the field shows it', () => {
    expect(fieldOf(83.48, FPS)).toEqual({ text: '00:01:23:12', invalid: false })
  })
})
