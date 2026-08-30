import { describe, it, expect } from 'vitest'
import {
  triage,
  BALANCED,
  LOOSE,
  STRICT,
  type TriageConfig,
  type TriageVerdict,
  type VideoSignals,
} from '../../src/core/triage'

const base: VideoSignals = {
  widthPx: 640,
  muted: false,
  loop: false,
  controls: true,
  visible: true,
  playing: true,
  playedSeconds: 0,
  hasDrm: false,
  soundApart: false,
}

describe('triage: immediate rejection', () => {
  it('always rejects DRM', () => {
    expect(triage({ ...base, hasDrm: true, playedSeconds: 60 }, BALANCED)).toBe('reject')
  })

  it('rejects a small element', () => {
    expect(triage({ ...base, widthPx: 180, playedSeconds: 60 }, BALANCED)).toBe('reject')
  })

  it('rejects a muted looping banner', () => {
    const banner = { ...base, muted: true, loop: true, controls: false, playedSeconds: 60 }
    expect(triage(banner, BALANCED)).toBe('reject')
  })

  it('rejects an invisible element', () => {
    expect(triage({ ...base, visible: false, playedSeconds: 60 }, BALANCED)).toBe('reject')
  })
})

describe('triage: grace period', () => {
  it('keeps a hover preview from becoming a session', () => {
    expect(triage({ ...base, playedSeconds: 1.5 }, BALANCED)).toBe('hold')
  })

  it('promotes a genuine viewing session', () => {
    expect(triage({ ...base, playedSeconds: 7 }, BALANCED)).toBe('promote')
  })

  it('promotes exactly at the threshold', () => {
    expect(triage({ ...base, playedSeconds: 6 }, BALANCED)).toBe('promote')
  })
})

describe('triage: muted video', () => {
  it('records a large non-looping muted video with the balanced preset', () => {
    const silent = { ...base, muted: true, loop: false, playedSeconds: 7 }
    expect(triage(silent, BALANCED)).toBe('promote')
  })

  it('does not record muted video with the strict setting', () => {
    const strict = { ...BALANCED, recordMuted: false }
    const silent = { ...base, muted: true, playedSeconds: 60 }
    expect(triage(silent, strict)).toBe('reject')
  })
})

// A pause freezes time accumulation, not the verdict. playedSeconds stops growing because the
// watcher credits time only while video is playing. triage itself does not read playing, because
// then pausing after the threshold would revoke an earned promotion and pausing before it would
// cancel an immediate rejection. With all other signals equal, paused and playing states must
// therefore produce the same verdict.
describe('triage: pause', () => {
  it('bases the paused verdict on accumulated time', () => {
    expect(triage({ ...base, playing: false, playedSeconds: 2 }, BALANCED)).toBe('hold')
  })

  it('does not revoke an earned promotion when paused', () => {
    expect(triage({ ...base, playing: false, playedSeconds: 30 }, BALANCED)).toBe('promote')
  })

  const recordMutedOff: TriageConfig = { ...BALANCED, recordMuted: false }

  const invariant: Array<[string, Partial<VideoSignals>, TriageConfig, TriageVerdict]> = [
    ['DRM is rejected', { hasDrm: true, playedSeconds: 60 }, BALANCED, 'reject'],
    ['a small element is rejected', { widthPx: 180, playedSeconds: 60 }, BALANCED, 'reject'],
    ['an invisible element is rejected', { visible: false, playedSeconds: 60 }, BALANCED, 'reject'],
    [
      'a muted looping banner is rejected',
      { muted: true, loop: true, controls: false, playedSeconds: 60 },
      BALANCED,
      'reject',
    ],
    [
      'muted video is rejected with the strict setting',
      { muted: true, playedSeconds: 60 },
      recordMutedOff,
      'reject',
    ],
    ['no time accumulated means hold', { playedSeconds: 0 }, BALANCED, 'hold'],
    ['just before the threshold means hold', { playedSeconds: 5.999 }, BALANCED, 'hold'],
    ['exactly at the threshold means promote', { playedSeconds: 6 }, BALANCED, 'promote'],
    ['well past the threshold means promote', { playedSeconds: 30 }, BALANCED, 'promote'],
  ]

  for (const [name, signals, config, expected] of invariant) {
    it(`${name} while both paused and playing`, () => {
      expect(triage({ ...base, ...signals, playing: true }, config)).toBe(expected)
      expect(triage({ ...base, ...signals, playing: false }, config)).toBe(expected)
    })
  }
})

describe('triage: what is not a banner', () => {
  it('treats a looping muted element with controls as a player rather than a banner', () => {
    const player = { ...base, muted: true, loop: true, controls: true, playedSeconds: 7 }
    expect(triage(player, BALANCED)).toBe('promote')
  })

  it('does not treat a looping unmuted element without controls as a banner', () => {
    const looped = { ...base, muted: false, loop: true, controls: false, playedSeconds: 7 }
    expect(triage(looped, BALANCED)).toBe('promote')
  })

  it('does not treat a muted non-looping element without controls as a banner', () => {
    const silent = { ...base, muted: true, loop: false, controls: false, playedSeconds: 7 }
    expect(triage(silent, BALANCED)).toBe('promote')
  })
})

describe('triage: check order', () => {
  it('applies immediate rejection before the grace period', () => {
    expect(triage({ ...base, hasDrm: true, playedSeconds: 0 }, BALANCED)).toBe('reject')
    expect(triage({ ...base, widthPx: 180, playedSeconds: 0 }, BALANCED)).toBe('reject')
    expect(triage({ ...base, visible: false, playedSeconds: 0 }, BALANCED)).toBe('reject')
    const banner = { ...base, muted: true, loop: true, controls: false, playedSeconds: 0 }
    expect(triage(banner, BALANCED)).toBe('reject')
    const strict = { ...BALANCED, recordMuted: false }
    expect(triage({ ...base, muted: true, playedSeconds: 0 }, strict)).toBe('reject')
  })

  it('accepts an element exactly at the minimum width', () => {
    expect(triage({ ...base, widthPx: 320, playedSeconds: 7 }, BALANCED)).toBe('promote')
  })

  it('rejects an element one pixel below the minimum width', () => {
    expect(triage({ ...base, widthPx: 319, playedSeconds: 7 }, BALANCED)).toBe('reject')
  })

  it('still holds just before the threshold', () => {
    expect(triage({ ...base, playedSeconds: 5.999 }, BALANCED)).toBe('hold')
  })
})

describe('triage: presets', () => {
  it('promotes earlier with the loose preset than with balanced or strict', () => {
    const early = { ...base, playedSeconds: 4 }
    expect(triage(early, LOOSE)).toBe('promote')
    expect(triage(early, BALANCED)).toBe('hold')
    expect(triage(early, STRICT)).toBe('hold')
  })

  it('has the strict preset reject by width what the others record', () => {
    const medium = { ...base, widthPx: 400, playedSeconds: 60 }
    expect(triage(medium, LOOSE)).toBe('promote')
    expect(triage(medium, BALANCED)).toBe('promote')
    expect(triage(medium, STRICT)).toBe('reject')
  })

  it('uses a 3-second threshold and a 200-pixel minimum for the loose preset', () => {
    expect(triage({ ...base, playedSeconds: 2.9 }, LOOSE)).toBe('hold')
    expect(triage({ ...base, playedSeconds: 3 }, LOOSE)).toBe('promote')
    expect(triage({ ...base, widthPx: 199, playedSeconds: 60 }, LOOSE)).toBe('reject')
    expect(triage({ ...base, widthPx: 200, playedSeconds: 60 }, LOOSE)).toBe('promote')
  })

  it('uses a 12-second threshold and a 480-pixel minimum for the strict preset', () => {
    expect(triage({ ...base, playedSeconds: 11.9 }, STRICT)).toBe('hold')
    expect(triage({ ...base, playedSeconds: 12 }, STRICT)).toBe('promote')
    expect(triage({ ...base, widthPx: 479, playedSeconds: 60 }, STRICT)).toBe('reject')
    expect(triage({ ...base, widthPx: 480, playedSeconds: 60 }, STRICT)).toBe('promote')
  })

  it('rejects muted video with strict and records it with loose', () => {
    expect(triage({ ...base, muted: true, playedSeconds: 60 }, STRICT)).toBe('reject')
    expect(triage({ ...base, muted: true, widthPx: 210, playedSeconds: 60 }, LOOSE)).toBe('promote')
  })
})

// getBoundingClientRect almost never returns an integer width, so the threshold must be compared
// with the actual fractional value rather than a rounded one. A 319.6-pixel element is below the
// minimum and must be rejected even though it rounds to 320.
describe('triage: fractional width', () => {
  it('rejects a fractional width just below the threshold even if it rounds up', () => {
    expect(triage({ ...base, widthPx: 319.6, playedSeconds: 60 }, BALANCED)).toBe('reject')
    expect(triage({ ...base, widthPx: 319.5, playedSeconds: 60 }, BALANCED)).toBe('reject')
  })

  it('accepts a fractional width just above the threshold', () => {
    expect(triage({ ...base, widthPx: 320.4, playedSeconds: 60 }, BALANCED)).toBe('promote')
    expect(triage({ ...base, widthPx: 320.01, playedSeconds: 60 }, BALANCED)).toBe('promote')
  })

  it('compares fractional width with the preset threshold rather than a rounded value', () => {
    expect(triage({ ...base, widthPx: 199.7, playedSeconds: 60 }, LOOSE)).toBe('reject')
    expect(triage({ ...base, widthPx: 200.3, playedSeconds: 60 }, LOOSE)).toBe('promote')
    expect(triage({ ...base, widthPx: 479.8, playedSeconds: 60 }, STRICT)).toBe('reject')
    expect(triage({ ...base, widthPx: 480.2, playedSeconds: 60 }, STRICT)).toBe('promote')
  })
})

// Numeric signals come from live page measurements and may be NaN. playedSeconds is a timestamp
// difference, and the first subtraction with an unset timestamp yields NaN. widthPx comes from
// getBoundingClientRect and is undefined until the element enters layout. NaN means unmeasured,
// not measured and acceptable: unmeasured time does not earn promotion, and unmeasured width
// cannot confirm the minimum and is rejected.
describe('triage: unmeasured numeric signals (NaN)', () => {
  it('does not promote when playback time is NaN', () => {
    expect(triage({ ...base, playedSeconds: NaN }, BALANCED)).toBe('hold')
    expect(triage({ ...base, playedSeconds: NaN }, LOOSE)).toBe('hold')
    expect(triage({ ...base, playedSeconds: NaN }, STRICT)).toBe('hold')
  })

  it('does not cancel immediate rejection when playback time is NaN', () => {
    expect(triage({ ...base, hasDrm: true, playedSeconds: NaN }, BALANCED)).toBe('reject')
    expect(triage({ ...base, visible: false, playedSeconds: NaN }, BALANCED)).toBe('reject')
  })

  it('rejects a NaN width because the minimum is unconfirmed', () => {
    expect(triage({ ...base, widthPx: NaN, playedSeconds: 60 }, BALANCED)).toBe('reject')
    expect(triage({ ...base, widthPx: NaN, playedSeconds: 60 }, LOOSE)).toBe('reject')
    expect(triage({ ...base, widthPx: NaN, playedSeconds: 60 }, STRICT)).toBe('reject')
  })

  it('rejects a NaN width before applying the grace period', () => {
    expect(triage({ ...base, widthPx: NaN, playedSeconds: 0 }, BALANCED)).toBe('reject')
    expect(triage({ ...base, widthPx: NaN, playedSeconds: NaN }, BALANCED)).toBe('reject')
  })
})

describe('triage — a page that plays its sound in another element', () => {
  const half = { ...base, muted: true, loop: true, controls: false, playedSeconds: 60 }

  it('records a looping silent picture when the page is playing sound beside it', () => {
    // The banner rule reads this element as decoration, and on nearly every page it is right. On
    // a page whose sound is in an <audio> of its own it is wrong: the picture is not silent, its
    // sound is in the other element, and together they make up the content being watched.
    expect(triage(half, BALANCED)).toBe('reject')
    expect(triage({ ...half, soundApart: true }, BALANCED)).toBe('promote')
  })

  it('takes away no other refusal', () => {
    // The signal answers one question — is this element silent, or is the page's sound elsewhere
    // — and it must not become a way past the rest. A small element, a hidden one and a page that
    // has attached keys to it are refused with sound beside them as readily as without.
    expect(triage({ ...half, soundApart: true, widthPx: 180 }, BALANCED)).toBe('reject')
    expect(triage({ ...half, soundApart: true, visible: false }, BALANCED)).toBe('reject')
    expect(triage({ ...half, soundApart: true, hasDrm: true }, BALANCED)).toBe('reject')
  })

  it('still serves out the grace period', () => {
    expect(triage({ ...half, soundApart: true, playedSeconds: 2 }, BALANCED)).toBe('hold')
  })

  it('is refused under a preset that does not record muted video at all', () => {
    // `recordMuted: false` is the user saying they do not want silent pictures, and a picture
    // whose sound is somebody else's element is a silent picture by every measure this has.
    expect(triage({ ...half, soundApart: true }, STRICT)).toBe('reject')
  })
})
