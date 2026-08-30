import { describe, it, expect } from 'vitest'
import { BALANCED, LOOSE, STRICT } from '../../src/core/triage'
import {
  DEFAULTS,
  LIMITS,
  REFERENCE_BITS_PER_SECOND,
  SPARE_MEMORY_BYTES,
  memoryCeilingFor,
  merge,
  presetOf,
  presetNamed,
  siteAllows,
  type Settings,
} from '../../src/shared/settings'

describe('DEFAULTS', () => {
  it('matches the documented defaults owned by settings', () => {
    expect(DEFAULTS.recording.bufferSeconds).toBe(180)
    expect(DEFAULTS.recording.mode).toBe('all')
    expect(DEFAULTS.history.toDisk).toBe(true)
    expect(DEFAULTS.history.keepDays).toBe(7)
    expect(DEFAULTS.history.ceilingBytes).toBe(4 * 1024 ** 3)
    expect(DEFAULTS.detection).toEqual(BALANCED)
    expect(DEFAULTS.export.format).toBe('mp4')
    expect(DEFAULTS.export.codec).toBe('auto')
    // The quality is a row of that table too, and it has to be: `auto` is H.264 everywhere
    // except at the low quality (§8.4), so "the codec defaults to Auto" says nothing about
    // which codec a fresh installation actually reaches for until this line says `high`.
    expect(DEFAULTS.export.quality).toBe('high')
    expect(DEFAULTS.export.rewriteHead).toBe(false)
  })

  it('is not shared with what it is merged into', () => {
    const merged = merge({})
    merged.recording.deny.push('example.com')
    expect(DEFAULTS.recording.deny).toEqual([])
  })
})

describe('merge', () => {
  it('gives the defaults for anything that is not there', () => {
    expect(merge(undefined)).toEqual(DEFAULTS)
    expect(merge(null)).toEqual(DEFAULTS)
    expect(merge('settings')).toEqual(DEFAULTS)
    expect(merge({ recording: { bufferSeconds: 60 } }).recording.mode).toBe('all')
  })

  it('keeps what was stored', () => {
    const stored = merge({ recording: { bufferSeconds: 60, deny: ['a.example'] } })
    expect(stored.recording.bufferSeconds).toBe(60)
    expect(stored.recording.deny).toEqual(['a.example'])
  })

  it('throws away what it does not know: a build of tomorrow wrote it, or a page did', () => {
    const merged = merge({ recording: { bufferSeconds: 60, colour: 'red' }, nonsense: 1 })
    expect(merged).toEqual({ ...DEFAULTS, recording: { ...DEFAULTS.recording, bufferSeconds: 60 } })
  })

  it('refuses a value of the wrong kind rather than carrying it into the program', () => {
    const merged = merge({
      recording: { mode: 'sometimes', bufferSeconds: 'lots', allow: 'a.example', deny: [1, 'b.example'] },
      history: { toDisk: 'yes', keepDays: null },
      export: { rewriteHead: 'no' },
    })
    expect(merged.recording.mode).toBe(DEFAULTS.recording.mode)
    expect(merged.recording.bufferSeconds).toBe(DEFAULTS.recording.bufferSeconds)
    expect(merged.recording.allow).toEqual([])
    // A list is cleaned rather than dropped: one bad entry is not a reason to lose the list.
    expect(merged.recording.deny).toEqual(['b.example'])
    expect(merged.history.toDisk).toBe(true)
    expect(merged.history.keepDays).toBe(7)
    // Read for its kind and not for its truthiness: every non-empty string is truthy, so a
    // stored 'no' would come back out of storage as a yes.
    expect(merged.export.rewriteHead).toBe(false)
  })

  it('refuses a number that is not a number, and one that has no size', () => {
    // clamp is three comparisons, and NaN loses all three: Math.min(Math.max(NaN, min), max) is
    // NaN, and a buffer of NaN seconds is a buffer that trims nothing at all.
    const merged = merge({
      recording: { bufferSeconds: Number.NaN },
      history: { keepDays: Number.POSITIVE_INFINITY },
    })
    expect(merged.recording.bufferSeconds).toBe(DEFAULTS.recording.bufferSeconds)
    expect(merged.history.keepDays).toBe(DEFAULTS.history.keepDays)
  })

  it('leaves the defaults alone: every one of them is inside the limits that guard it', () => {
    // A default outside its own limit is a setting that changes as it is stored and read back:
    // merge({}) hands out 7 days, and merge of that very 7 clamps it to something else. The
    // settings page writes the whole shape back on every change, so the drift is one save away.
    expect(merge(DEFAULTS)).toEqual(DEFAULTS)
  })

  it('clamps a number into its limits instead of trusting it', () => {
    const low = merge({ recording: { bufferSeconds: 1 }, history: { keepDays: 0, ceilingBytes: 1 } })
    expect(low.recording.bufferSeconds).toBe(LIMITS.bufferSeconds.min)
    expect(low.history.keepDays).toBe(LIMITS.keepDays.min)
    expect(low.history.ceilingBytes).toBe(LIMITS.ceilingBytes.min)

    const high = merge({ recording: { bufferSeconds: 999_999 } })
    expect(high.recording.bufferSeconds).toBe(LIMITS.bufferSeconds.max)
  })

  it('keeps a name template that says something and refuses one that says nothing', () => {
    // The one string a user types into these settings, and the one field a wrong kind reaches the
    // file system through: an empty template names every clip after the page and nothing else.
    expect(merge({ export: { nameTemplate: '{host} {title}' } }).export.nameTemplate).toBe(
      '{host} {title}',
    )
    expect(merge({ export: { nameTemplate: '   ' } }).export.nameTemplate).toBe(
      DEFAULTS.export.nameTemplate,
    )
    expect(merge({ export: { nameTemplate: 7 } }).export.nameTemplate).toBe(
      DEFAULTS.export.nameTemplate,
    )
  })

  it('turns a stored webm into mp4, and needs not one line of migration to do it', () => {
    // §8.4 knows two formats and this build writes one container: a clip is assembled by the MP4
    // writer, and there is nothing here that could write a WebM. A profile that stored `webm`
    // under an earlier build is read by `asOneOf`, which does not know the word and hands back
    // the default — which is why the union losing a member costs no migration at all.
    expect(merge({ export: { format: 'webm' } }).export.format).toBe('mp4')
    // And the format that stayed is still read as itself, or the line above would prove nothing.
    expect(merge({ export: { format: 'webp' } }).export.format).toBe('webp')
    expect(merge({ export: { format: 'mp4' } }).export.format).toBe('mp4')
  })

  it('keeps every codec of the three and refuses a fourth', () => {
    // The setting decides the order of the two hardware rungs, so a value that survives storage
    // as something else would silently reorder the ladder.
    expect(merge({ export: { codec: 'auto' } }).export.codec).toBe('auto')
    expect(merge({ export: { codec: 'hevc' } }).export.codec).toBe('hevc')
    expect(merge({ export: { codec: 'h264' } }).export.codec).toBe('h264')
    expect(merge({ export: { codec: 'av1' } }).export.codec).toBe('auto')
    expect(merge({ export: { codec: 7 } }).export.codec).toBe('auto')
  })

  it('stands the codec on auto when nothing was stored', () => {
    // Auto is H.264 except where the quality asked for is low: HEVC's measured advantage is
    // +0.029 SSIM at 800 kbit/s and +0.0003 at 2 Mbit/s, so a default of HEVC would have been
    // paid for in players that cannot open the file, for three ten-thousandths of an SSIM.
    expect(merge({}).export.codec).toBe('auto')
    expect(merge({ export: {} }).export.codec).toBe('auto')
  })

  it('lowercases and trims a host, drops what is not one, and keeps it once', () => {
    const merged = merge({
      recording: {
        deny: [
          '  Example.COM ',
          '',
          'https://x.example/y',
          'ok.example',
          'not a host',
          'example.com',
        ],
      },
    })
    expect(merged.recording.deny).toEqual(['example.com', 'x.example', 'ok.example'])
  })
})

describe('presetOf', () => {
  it('names the three of §7.4 and calls anything else custom', () => {
    expect(presetOf(BALANCED)).toBe('balanced')
    expect(presetOf(LOOSE)).toBe('loose')
    expect(presetOf(STRICT)).toBe('strict')
    expect(presetOf({ ...BALANCED, minWidthPx: 321 })).toBe('custom')
  })

  it('gives back the three by name, and the balanced one for anything else', () => {
    expect(presetNamed('strict')).toEqual(STRICT)
    expect(presetNamed('custom')).toEqual(BALANCED)
    // A copy of it: what asks for a preset is a settings page whose sliders then write into the
    // answer, and STRICT is a module constant every other reader shares.
    expect(presetNamed('strict')).not.toBe(STRICT)
  })
})

describe('siteAllows', () => {
  const with_ = (over: Partial<Settings['recording']>): Settings => ({
    ...DEFAULTS,
    recording: { ...DEFAULTS.recording, ...over },
  })

  it('records everything in the ordinary mode', () => {
    expect(siteAllows(with_({}), 'https://site.example/watch')).toBe(true)
  })

  it('records nothing at all when the mode is off', () => {
    // Against a list that would otherwise match: `off` is a refusal of its own, and not the
    // emptiness of an allowlist wearing another name.
    const off = with_({ mode: 'off', allow: ['site.example'] })
    expect(siteAllows(off, 'https://site.example/watch')).toBe(false)
  })

  it('records only what is listed when the mode is a list', () => {
    const only = with_({ mode: 'allowlist', allow: ['site.example'] })
    expect(siteAllows(only, 'https://site.example/watch')).toBe(true)
    expect(siteAllows(only, 'https://other.example/watch')).toBe(false)
  })

  it('lets a host stand for its subdomains, and not for a host that merely ends the same way', () => {
    const only = with_({ mode: 'allowlist', allow: ['site.example'] })
    expect(siteAllows(only, 'https://www.site.example/watch')).toBe(true)
    expect(siteAllows(only, 'https://notsite.example/watch')).toBe(false)
  })

  it('lets deny win over allow, in every mode', () => {
    expect(siteAllows(with_({ deny: ['site.example'] }), 'https://site.example/x')).toBe(false)
    expect(
      siteAllows(
        with_({ mode: 'allowlist', allow: ['site.example'], deny: ['ads.site.example'] }),
        'https://ads.site.example/x',
      ),
    ).toBe(false)
  })

  it('records nothing at an address it cannot read', () => {
    // A frame at about:blank, a data: document, an empty referrer: nothing to weigh a list
    // against, and a recording nobody can turn off from the settings page is worse than none.
    expect(siteAllows(with_({}), '')).toBe(false)
    expect(siteAllows(with_({}), 'about:blank')).toBe(false)
  })
})

describe('memoryCeilingFor', () => {
  /** What one buffer of this length weighs at the rate the ceiling is sized at. */
  const oneBuffer = (seconds: number) => (seconds * REFERENCE_BITS_PER_SECOND) / 8

  it('holds room for the buffer the user set, at every length the setting takes', () => {
    // The whole of the defect this exists for. A flat 512 MiB is passed by one ordinary 1080p
    // session at about eleven minutes, so at any longer setting the frame threw the recording
    // away and began again — while the slider went on offering half an hour.
    for (const seconds of [LIMITS.bufferSeconds.min, 180, 900, LIMITS.bufferSeconds.max]) {
      expect(
        memoryCeilingFor(seconds),
        `a buffer of ${seconds} s would not fit under the ceiling`,
      ).toBeGreaterThan(oneBuffer(seconds))
    }
  })

  it('is what stood in the frame before it, at the default of §7.4', () => {
    // The number it replaces was 512 MiB, chosen as room for three default buffers and a little.
    // The default has to stay where it was: this is a ceiling that follows the setting, not a
    // ceiling raised for everybody.
    const before = 512 * 1024 * 1024
    expect(memoryCeilingFor(DEFAULTS.recording.bufferSeconds)).toBeGreaterThan(before * 0.95)
    expect(memoryCeilingFor(DEFAULTS.recording.bufferSeconds)).toBeLessThan(before * 1.05)
  })

  it('keeps room for the other sessions of the frame at every length', () => {
    // The half that bounds their number: without it a page opening session after session would
    // be held to one buffer, and the ceiling would be doing the buffer length's job twice.
    expect(memoryCeilingFor(180) - oneBuffer(180)).toBe(SPARE_MEMORY_BYTES)
    expect(memoryCeilingFor(1_800) - oneBuffer(1_800)).toBe(SPARE_MEMORY_BYTES)
  })

  it('answers the spare alone for a length of nothing', () => {
    // Nothing here reads a setting: `merge` holds the buffer inside LIMITS long before this. What
    // this refuses is arithmetic below zero, which would put the ceiling under the spare.
    expect(memoryCeilingFor(0)).toBe(SPARE_MEMORY_BYTES)
    expect(memoryCeilingFor(-60)).toBe(SPARE_MEMORY_BYTES)
  })
})
