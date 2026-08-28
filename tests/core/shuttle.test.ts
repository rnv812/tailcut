import { describe, it, expect } from 'vitest'
import type { KeyPress } from '../../src/core/edit/keymap'
import {
  SHUTTLE_RATES,
  STILL,
  shuttleAdvance,
  shuttleKeyOf,
  shuttleLabel,
  shuttled,
  type ShuttleState,
} from '../../src/core/edit/shuttle'

const press = (key: string, held: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shift: false,
  ctrl: false,
  meta: false,
  alt: false,
  repeat: false,
  ...held,
})

const play = (keys: string): ShuttleState =>
  [...keys].reduce((state, key) => shuttled(state, key as 'j' | 'k' | 'l'), STILL)

describe('shuttleKeyOf', () => {
  it('takes J, K and L in either case, Shift included', () => {
    expect(shuttleKeyOf(press('j'))).toBe('j')
    expect(shuttleKeyOf(press('L'))).toBe('l')
    // Shift is not a separate command here on purpose: CapsLock produces the same capital, and a
    // shuttle that stops working with CapsLock on is a mystery nobody solves. The cost is that
    // Shift+J/K/L are spoken for and cannot be given to anything else.
    expect(shuttleKeyOf(press('K', { shift: true }))).toBe('k')
  })

  it('leaves the letters alone when a modifier is down', () => {
    // Ctrl+J opens the downloads; Alt is the modifier that frees a handle. Shift is not on this
    // list, and that is the whole difference between it and the three above.
    for (const held of [{ ctrl: true }, { meta: true }, { alt: true }]) {
      expect(shuttleKeyOf(press('j', held))).toBeNull()
    }
  })

  it('says nothing about any other key', () => {
    for (const key of ['i', ' ', 'ArrowLeft', 'Escape']) expect(shuttleKeyOf(press(key))).toBeNull()
  })
})

describe('shuttled', () => {
  it('starts at one and steps up the ladder', () => {
    expect(play('l')).toEqual({ direction: 1, rate: 1 })
    expect(play('lll')).toEqual({ direction: 1, rate: 4 })
    expect(play('lllll')).toEqual({ direction: 1, rate: 16 })
  })

  it('stops at the top rather than running off it', () => {
    const fastest = play('lllll')

    expect(shuttled(fastest, 'l')).toBe(fastest)
    expect(SHUTTLE_RATES[SHUTTLE_RATES.length - 1]).toBe(16)
  })

  it('slows down before it turns round', () => {
    // Eight forward, then J: four forward, not one back. A shuttle that turned round on the
    // first press of the opposite key would make a two-key correction impossible.
    expect(shuttled(play('llll'), 'j')).toEqual({ direction: 1, rate: 4 })
    expect(play('lllljj')).toEqual({ direction: 1, rate: 2 })
  })

  it('crosses over from the slowest notch, because K is what stops', () => {
    expect(shuttled(play('l'), 'j')).toEqual({ direction: -1, rate: 1 })
  })

  it('goes back the other way in the same ladder', () => {
    expect(play('jj')).toEqual({ direction: -1, rate: 2 })
  })

  it('stops dead on K and gives the state itself back when already still', () => {
    expect(shuttled(play('lll'), 'k')).toEqual(STILL)
    expect(shuttled(STILL, 'k')).toBe(STILL)
  })
})

describe('shuttleAdvance', () => {
  it('moves by the rate, and backwards when going back', () => {
    expect(shuttleAdvance({ direction: 1, rate: 4 }, 0.016)).toBeCloseTo(0.064, 9)
    expect(shuttleAdvance({ direction: -1, rate: 8 }, 0.016)).toBeCloseTo(-0.128, 9)
  })

  it('moves nothing while still', () => {
    expect(shuttleAdvance(STILL, 0.5)).toBe(0)
  })
})

describe('shuttleLabel', () => {
  it('says what the transport is doing, and says nothing while still', () => {
    expect(shuttleLabel(STILL)).toBe('')
    expect(shuttleLabel({ direction: 1, rate: 4 })).toBe('4×')
    expect(shuttleLabel({ direction: -1, rate: 8 })).toBe('8× back')
  })
})
