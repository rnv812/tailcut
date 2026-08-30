import { describe, it, expect } from 'vitest'
import {
  evictionOrder,
  expiredBy,
  valueOf,
  victimsFor,
  WIDTH_CAP_PX,
  type Valued,
} from '../../src/core/history/value'

const NOW = 1_700_000_000_000
const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

const session = (over: Partial<Valued>): Valued => ({
  id: 'x',
  pinned: false,
  usedAt: 0,
  lastSeenAt: NOW - MINUTE,
  seconds: 120,
  sound: true,
  widthPx: 640,
  bytes: 50_000_000,
  ...over,
})

describe('valueOf — eviction value ordering', () => {
  it('never lets go of what the user pinned', () => {
    const pinned = session({ id: 'pinned', pinned: true, seconds: 1, sound: false, widthPx: 0 })
    expect(valueOf(pinned, NOW)).toBe(Number.POSITIVE_INFINITY)
  })

  it('holds a session the user took into the editor above one that was only watched', () => {
    const used = session({ id: 'used', usedAt: NOW - DAY * 3, seconds: 20, sound: false })
    const watched = session({ id: 'watched', seconds: 3_600, sound: true, widthPx: 1_920 })
    expect(valueOf(used, NOW)).toBeGreaterThan(valueOf(watched, NOW))
  })

  it('holds it there whatever the two of them have been doing since', () => {
    // Pinning is the one rule a weight must never overturn, stated on the numbers that
    // could overturn it: the used session is a scrap watched silently in a corner and not touched
    // since Sunday, the other is everything watching can be worth and was watched this second.
    // Six days is the last day the default retention period still holds either of them at all.
    const used = session({
      id: 'used',
      usedAt: NOW - DAY * 6,
      lastSeenAt: NOW - DAY * 6,
      seconds: 10,
      sound: false,
      widthPx: 0,
    })
    const best = session({
      id: 'best',
      lastSeenAt: NOW,
      seconds: 3_600,
      sound: true,
      widthPx: 1_920,
    })
    expect(valueOf(used, NOW)).toBeGreaterThan(valueOf(best, NOW))
    expect(evictionOrder([used, best], NOW)[0]!.id).toBe('best')
  })

  it('values a long watch, with sound, in a big player', () => {
    const good = session({ id: 'good', seconds: 900, sound: true, widthPx: 1_280 })
    const meagre = session({ id: 'meagre', seconds: 7, sound: false, widthPx: 320 })
    expect(valueOf(good, NOW)).toBeGreaterThan(valueOf(meagre, NOW))
  })

  it('weighs each of the three signals on its own, not only all three together', () => {
    // Otherwise any one of the three weights could be zero and the case above would go on
    // passing: three signals moved at once say nothing about which of them did the work. The
    // names are chosen so that a weight of zero loses to the tie-break instead of hiding in it.
    const bare = { seconds: 60, sound: false, widthPx: 0 }
    const plain = session({ id: 'plain', ...bare })
    const longer = session({ id: 'longer', ...bare, seconds: 600 })
    const heard = session({ id: 'heard', ...bare, sound: true })
    const big = session({ id: 'big', ...bare, widthPx: WIDTH_CAP_PX })
    expect(evictionOrder([longer, plain], NOW)[0]!.id).toBe('plain')
    expect(evictionOrder([heard, plain], NOW)[0]!.id).toBe('plain')
    expect(evictionOrder([big, plain], NOW)[0]!.id).toBe('plain')
    // And the width is a measure below the cap and not a flag: a player half a window wide is
    // worth half of what a window-wide one is, or a thumbnail with a play button would count as
    // the large player that should outrank a thumbnail.
    const half = session({ id: 'half', ...bare, widthPx: WIDTH_CAP_PX / 2 })
    expect(evictionOrder([big, half], NOW)[0]!.id).toBe('half')
    // Above the cap it says nothing more: a player pulled across a second monitor is not three
    // times the video a full window is.
    const wall = session({ id: 'wall', ...bare, widthPx: WIDTH_CAP_PX * 3 })
    expect(valueOf(wall, NOW)).toBe(valueOf(big, NOW))
  })

  it('sends the one that barely crossed the threshold out first', () => {
    // Classification promotes at six seconds; a session of seven is a page that was opened and left.
    const barely = session({ id: 'barely', seconds: 7, sound: false, widthPx: 330 })
    const rest = [session({ id: 'a', seconds: 300 }), session({ id: 'b', seconds: 120 }), barely]
    expect(evictionOrder(rest, NOW)[0]!.id).toBe('barely')
  })

  it('sends a short insert out before the long video it sat inside', () => {
    // An advert or a trailer between the halves of a film: recorded a minute ago, so newer than
    // the film, and worth nothing beside it.
    const insert = session({ id: 'insert', seconds: 15, lastSeenAt: NOW, sound: true })
    const film = session({ id: 'film', seconds: 2_400, lastSeenAt: NOW - 30 * MINUTE })
    expect(evictionOrder([film, insert], NOW)[0]!.id).toBe('insert')
  })

  it('lets age tell two otherwise equal sessions apart', () => {
    const old = session({ id: 'old', lastSeenAt: NOW - DAY })
    const fresh = session({ id: 'fresh', lastSeenAt: NOW - MINUTE })
    expect(evictionOrder([fresh, old], NOW)[0]!.id).toBe('old')
  })

  it('lets days of standing still outweigh everything watching alone could earn', () => {
    // Where a size-only ranking would say the opposite, and the numbers say what this program
    // does: everything watching can earn comes to 56 (40 + 8 + 8), and a day nobody came back
    // costs 24. So the best recording of Sunday goes before the worst of this minute, and that
    // is meant — the meagre one is what the user has in front of them right now.
    const rich = session({
      id: 'rich',
      seconds: 3_600,
      sound: true,
      widthPx: 1_920,
      lastSeenAt: NOW - DAY * 3,
    })
    const meagre = session({ id: 'meagre', seconds: 7, sound: false, widthPx: 0 })
    expect(evictionOrder([meagre, rich], NOW)[0]!.id).toBe('rich')
  })

  it('breaks a tie in value by age before it falls back to the name', () => {
    // Reachable and not decorative: eight hours of standing still cost exactly what sound earns,
    // so these two are worth the same to the last digit while their clocks differ by a working
    // day. The older goes first; the name is asked only when even the clock cannot tell them
    // apart, and it is asked last for a reason — an identifier means nothing to the user.
    const older = session({ id: 'z-older', seconds: 0, widthPx: 0, lastSeenAt: NOW - 8 * HOUR })
    const newer = session({ id: 'a-newer', seconds: 0, widthPx: 0, sound: false, lastSeenAt: NOW })
    expect(valueOf(older, NOW)).toBe(valueOf(newer, NOW))
    expect(evictionOrder([newer, older], NOW).map((one) => one.id)).toEqual(['z-older', 'a-newer'])
  })

  it('is a total order: two identical sessions still come out in a fixed order', () => {
    const twins = [session({ id: 'b' }), session({ id: 'a' })]
    expect(evictionOrder(twins, NOW).map((one) => one.id)).toEqual(['a', 'b'])
  })

  it('keeps the pinned at the back, and orders them among themselves as firmly', () => {
    // Two infinities do not subtract into an order, and a comparator that let them try would
    // answer NaN — which a sort reads as "equal" and leaves in whatever order they arrived in.
    const rows = [
      session({ id: 'pin-b', pinned: true }),
      session({ id: 'ordinary' }),
      session({ id: 'pin-a', pinned: true }),
    ]
    expect(evictionOrder(rows, NOW).map((one) => one.id)).toEqual(['ordinary', 'pin-a', 'pin-b'])
  })
})

describe('victimsFor', () => {
  const rows = [
    session({ id: 'pinned', pinned: true, bytes: 3_000_000_000 }),
    session({ id: 'used', usedAt: NOW - DAY, bytes: 500_000_000 }),
    session({ id: 'ordinary', bytes: 400_000_000, seconds: 600 }),
    session({ id: 'meagre', bytes: 300_000_000, seconds: 8, sound: false, widthPx: 330 }),
  ]

  it('takes the cheapest first and stops as soon as there is room', () => {
    expect(victimsFor(rows, NOW, 250_000_000).map((one) => one.id)).toEqual(['meagre'])
    // Exactly enough is enough: the second one is asked for only when the first falls short.
    expect(victimsFor(rows, NOW, 300_000_000).map((one) => one.id)).toEqual(['meagre'])
    expect(victimsFor(rows, NOW, 500_000_000).map((one) => one.id)).toEqual(['meagre', 'ordinary'])
  })

  it('never offers what the user pinned, even when nothing else is enough', () => {
    // The ceiling is then simply exceeded, and the writer is told storage is full: a pin is a
    // promise, and a promise that yields under pressure is not one.
    expect(victimsFor(rows, NOW, 4_000_000_000).map((one) => one.id)).toEqual([
      'meagre',
      'ordinary',
      'used',
    ])
  })

  it('asks for nothing when there is room', () => {
    expect(victimsFor(rows, NOW, 0)).toEqual([])
    expect(victimsFor(rows, NOW, -10)).toEqual([])
  })
})

describe('expiredBy', () => {
  it('names what has outlived the keeping, and leaves the pinned alone', () => {
    const rows = [
      session({ id: 'old', lastSeenAt: NOW - DAY * 8 }),
      session({ id: 'old-but-pinned', pinned: true, lastSeenAt: NOW - DAY * 400 }),
      session({ id: 'yesterday', lastSeenAt: NOW - DAY }),
    ]
    expect(expiredBy(rows, NOW, 7).map((one) => one.id)).toEqual(['old'])
  })

  it('counts the days from when material last arrived, not from when it started', () => {
    // A video watched over three evenings merges into one session, whose age is the last evening.
    const rows = [session({ id: 'long-running', lastSeenAt: NOW - DAY * 2 })]
    expect(expiredBy(rows, NOW, 7)).toEqual([])
  })
})
