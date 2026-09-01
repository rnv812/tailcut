import { describe, it, expect, vi } from 'vitest'
import { ctx, clip, oneQuality, FPS } from './edit-fixture'
import {
  MIN_CLIP_FRAMES,
  clipName,
  forcesEncoder,
  heldByQuality,
  normalizeClip,
  stamp,
} from '../../src/core/edit/clip'
import { runAt, viewBounds, zoneAt, type EditContext } from '../../src/core/edit/context'
import type { Zone } from '../../src/core/timeline/lanes'

const zone = (start: number, end: number, representation: string): Zone => ({
  start,
  end,
  representation,
  codec: 'avc1',
  width: 854,
  height: 480,
})

/** The same ten seconds with the quality flapping: 480p, then 720p, then 480p again. */
const flapping: EditContext = {
  ...ctx,
  zones: [zone(0, 4, '480p'), zone(6, 8, '720p'), zone(8, 10, '480p')],
}

describe('context', () => {
  it('finds the zone and the run a time falls in', () => {
    expect(zoneAt(ctx, 2)!.representation).toBe('480p')
    expect(zoneAt(ctx, 7)!.representation).toBe('720p')
    expect(zoneAt(ctx, 5)).toBeUndefined()
    expect(runAt(ctx, 7)).toEqual({ start: 6, end: 10 })
    expect(runAt(ctx, 5)).toBeUndefined()
  })

  it('counts the edge of a zone and of a run as inside it', () => {
    // Everything that asks about a handle asks at a boundary: the quality a new clip is born
    // with, the run I runs to the end of. A half-open answer there would name the wrong one.
    expect(zoneAt(ctx, 4)!.representation).toBe('480p')
    expect(zoneAt(ctx, 6)!.representation).toBe('720p')
    expect(runAt(ctx, 0)).toEqual({ start: 0, end: 4 })
    expect(runAt(ctx, 4)).toEqual({ start: 0, end: 4 })
  })

  it('hands the viewport the bounds of the material', () => {
    expect(viewBounds(ctx)).toEqual({ duration: 10, fps: FPS })
  })
})

describe('normalizeClip', () => {
  it('puts both edges on a frame boundary', () => {
    const fixed = normalizeClip(clip({ in: 1.011, out: 2.999 }), ctx)

    expect(fixed.in).toBeCloseTo(1, 9)
    expect(fixed.out).toBeCloseTo(3, 9)
  })

  it('lets a clip cross a hole, because a hole is not a change of quality', () => {
    // Gaps collapse in the output: the material stops and starts again, while the quality
    // never changed, and the export collapses the hole out of the clip. A clip stopped at the
    // edge of a hole could not be made to span one at all.
    const fixed = normalizeClip(clip({ in: 1, out: 9 }), oneQuality)

    expect([fixed.in, fixed.out]).toEqual([1, 9])
  })

  it('counts the frames of a clip by the grid and not by the clock', () => {
    // In and out on the two edges of the hole: two seconds apart, and one frame of material
    // between them. Seconds say fifty frames, the grid says one, and the grid decides — so the
    // out point is grown to reach the minimum, exactly as it would be inside a run.
    const grown = normalizeClip(clip({ in: 4, out: 6 }), oneQuality)

    expect(grown.in).toBe(4)
    expect(grown.out).toBeCloseTo(6 + 1 / FPS, 9)
  })

  it('stops a clip at a change of quality, and names the quality it stopped at', () => {
    // Two resolutions in one track need an encoder, so the handle stops at the boundary of
    // the zone the clip belongs to and the inspector says why. There is no way past it here.
    const fixed = normalizeClip(clip({ in: 1, out: 9 }), ctx)

    expect(fixed.out).toBe(4)
    expect(heldByQuality(fixed, ctx)!.representation).toBe('720p')
  })

  it('holds a clip in the nearest stretch of its quality, not the first one of that name', () => {
    // Quality that flaps records 480p twice, and the two stretches are two zones. A clip at nine
    // seconds belongs to the second of them; taking the first would pull it back six seconds.
    const late = normalizeClip(clip({ representation: '480p', in: 9, out: 12 }), flapping)

    expect([late.in, late.out]).toEqual([9, 10])
  })

  it('chooses the home stretch by the in point when a clip spans two equal candidates', () => {
    const spanning = clip({ representation: '480p', in: 1, out: 9 })

    expect(normalizeClip(spanning, flapping)).toMatchObject({ in: 1, out: 4 })
  })

  it('recognises a quality change whose zones meet at the same frame', () => {
    const adjacent = {
      ...ctx,
      zones: [zone(0, 4, '480p'), zone(4, 10, '720p')],
    }

    expect(heldByQuality(clip({ in: 1, out: 4 }), adjacent)!.representation).toBe('720p')
  })

  it('names the quality behind a clip standing on the start of its zone', () => {
    const first = clip({ representation: '720p', in: 6, out: 8 })

    expect(heldByQuality(first, ctx)!.representation).toBe('480p')
  })

  it('says nothing about a clip that is not standing against a boundary', () => {
    expect(heldByQuality(clip({ in: 1, out: 3 }), ctx)).toBeNull()
    expect(heldByQuality(clip({ in: 1, out: 9 }), oneQuality)).toBeNull()
    expect(heldByQuality(clip({ representation: '480p', in: 8.5, out: 9.5 }), flapping)).toBeNull()
  })

  it('a clip of a representation the material does not have is bounded by the material', () => {
    const fixed = normalizeClip(clip({ representation: '1080p', in: -5, out: 99 }), ctx)

    expect(fixed.in).toBe(0)
    expect(fixed.out).toBe(10)
  })

  it('the edge that moved is the one that gives way', () => {
    const pushed = normalizeClip(clip({ in: 3.5, out: 3 }), ctx, 'in')

    expect(pushed.out).toBe(3)
    expect(pushed.in).toBeCloseTo(3 - MIN_CLIP_FRAMES / FPS, 9)
  })

  it('and the other edge is left where it was', () => {
    const pushed = normalizeClip(clip({ in: 3, out: 2.5 }), ctx, 'out')

    expect(pushed.in).toBe(3)
    expect(pushed.out).toBeCloseTo(3 + MIN_CLIP_FRAMES / FPS, 9)
  })

  it('gives the very same object back when nothing had to move', () => {
    const already = clip({ in: 1, out: 3 })

    expect(normalizeClip(already, ctx)).toBe(already)
  })

  it('with no frames at all it only orders the edges', () => {
    const bare = { ...ctx, frames: new Float64Array() }

    expect(normalizeClip(clip({ in: 3, out: 1 }), bare)).toMatchObject({ in: 1, out: 3 })
  })
})

describe('clipName', () => {
  it('joins the title and the timecode', () => {
    expect(clipName({ title: 'Cats', at: 83, taken: [] })).toBe('Cats 01.23')
  })

  it('numbers a name that is taken', () => {
    expect(clipName({ title: 'Cats', at: 83, taken: ['Cats 01.23'] })).toBe('Cats 01.23 (2)')
    expect(clipName({ title: 'Cats', at: 83, taken: ['Cats 01.23', 'Cats 01.23 (2)'] })).toBe(
      'Cats 01.23 (3)',
    )
  })

  it('cuts a title too long to be a file name', () => {
    const long = clipName({ title: 'x'.repeat(200), at: 0, taken: [] })

    expect(long.length).toBeLessThan(60)
    expect(long.endsWith('00.00')).toBe(true)
  })

  it('cuts a long title at a word rather than through one', () => {
    const title = 'Cats of the internet and their extraordinary adventures'

    expect(clipName({ title, at: 0, taken: [] })).toBe('Cats of the internet and their 00.00')
  })

  it('has something to say about a page with no title', () => {
    expect(clipName({ title: '   ', at: 0, taken: [] })).toBe('Clip 00.00')
  })

  it('follows the template when there is one', () => {
    expect(
      clipName({
        title: 'Cats',
        at: 83,
        to: 90,
        host: 'site.example',
        taken: [],
        template: '{host} {title} {in}-{out}',
      }),
    ).toBe('site.example Cats 01.23-01.30')
  })

  it('has an out and a host for the template even when the caller gave neither', () => {
    const name = clipName({ title: 'Cats', at: 83, taken: [], template: '{title} {in}-{out} {host}' })

    expect(name).toBe('Cats 01.23-01.23')
  })

  it('numbers a repeat of a templated name the same way', () => {
    expect(clipName({ title: 'Cats', at: 83, taken: ['Cats'], template: '{title}' })).toBe('Cats (2)')
  })

  it('falls back to the default name when the template says nothing', () => {
    // A field the user cleared, or typed three spaces into, gives a name made of the title —
    // not an empty one, and not a file called "tailcut".
    expect(clipName({ title: 'Cats', at: 83, taken: [], template: '   ' })).toBe('Cats')
  })

  it('shortens a title inside a template exactly as it does without one', () => {
    // The very name the test above expects without a template: a template chooses the shape of a
    // name, not how much of a page title a file name may carry.
    const title = 'Cats of the internet and their extraordinary adventures'

    expect(clipName({ title, at: 0, taken: [], template: '{title} {in}' })).toBe(
      'Cats of the internet and their 00.00',
    )
  })

  it('dates a clip by the local calendar day', () => {
    const timezone = process.env.TZ
    process.env.TZ = 'Asia/Tokyo'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T16:00:00.000Z'))

    try {
      expect(clipName({ title: 'Cats', at: 0, taken: [], template: '{date}' })).toBe('2024-01-02')
    } finally {
      vi.useRealTimers()
      if (timezone === undefined) delete process.env.TZ
      else process.env.TZ = timezone
    }
  })

  it('stamps hours only when there are hours', () => {
    expect(stamp(0)).toBe('00.00')
    expect(stamp(3723)).toBe('01.02.03')
  })
})

describe('forcesEncoder', () => {
  it('names each of the four reasons a clip cannot simply be copied', () => {
    // Facts about the clip, not preferences. A crop changes the picture; WebP is not a container
    // coded frames can be moved into; `optimize` is the request itself; and a start that is not
    // on a sync sample can only be made exact by re-encoding the head, which is what
    // `rewriteHead` asks for.
    expect(forcesEncoder(clip({ crop: { x: 0, y: 0, width: 64, height: 64 } }), true, false)).toBe(true)
    expect(forcesEncoder(clip({ format: 'webp' }), true, false)).toBe(true)
    expect(forcesEncoder(clip({ mode: 'optimize' }), true, false)).toBe(true)
    expect(forcesEncoder(clip(), false, true)).toBe(true)
  })

  it('copies only an MP4 whose first kept picture is independently decodable', () => {
    // The default clip: no rectangle, an MP4, and a sync sample at its first kept picture.
    expect(forcesEncoder(clip(), true, false)).toBe(false)
    // An edit list can hide the run-up in Chrome, but Windows Media Player presents it. Exact
    // portable output therefore cannot copy an off-keyframe start, even when a legacy settings
    // record says not to rewrite the head.
    expect(forcesEncoder(clip(), false, false)).toBe(true)
    // And the setting on its own is not one either, when the clip starts on a key frame.
    expect(forcesEncoder(clip(), true, true)).toBe(false)
  })
})
