import { describe, it, expect } from 'vitest'
import { sessionKey, normalizeUrl } from '../../src/core/session-key'

describe('normalizeUrl', () => {
  it('removes timestamps and tracking parameters', () => {
    const a = normalizeUrl('https://site.example/watch?v=abc&t=42s&utm_source=x&si=zz')
    const b = normalizeUrl('https://site.example/watch?v=abc')
    expect(a).toBe(b)
  })

  it('preserves a parameter that identifies the video itself', () => {
    const a = normalizeUrl('https://site.example/watch?v=abc')
    const b = normalizeUrl('https://site.example/watch?v=xyz')
    expect(a).not.toBe(b)
  })

  it('drops the fragment', () => {
    expect(normalizeUrl('https://site.example/v/1#comments')).toBe(
      normalizeUrl('https://site.example/v/1'),
    )
  })

  it('handles garbage in place of a URL', () => {
    expect(normalizeUrl('not a url')).toBe('not a url')
  })
})

describe('sessionKey', () => {
  const input = { url: 'https://site.example/watch?v=abc', codecs: ['avc1'], durationSeconds: 600 }

  it('returns the same key after a page reload', () => {
    expect(sessionKey(input)).toBe(sessionKey({ ...input, url: input.url + '&t=90' }))
  })

  it('returns a different key for a different video', () => {
    expect(sessionKey(input)).not.toBe(
      sessionKey({ ...input, url: 'https://site.example/watch?v=zzz' }),
    )
  })

  it('returns a different key for a different duration at the same URL', () => {
    expect(sessionKey(input)).not.toBe(sessionKey({ ...input, durationSeconds: 61 }))
  })

  it('ignores codec order', () => {
    expect(sessionKey({ ...input, codecs: ['avc1', 'mp4a'] })).toBe(
      sessionKey({ ...input, codecs: ['mp4a', 'avc1'] }),
    )
  })

  it('does not split a session over a fractional duration difference', () => {
    expect(sessionKey(input)).toBe(sessionKey({ ...input, durationSeconds: 600.4 }))
  })

  it('returns a stable key for a live stream with unknown duration', () => {
    const live = { ...input, durationSeconds: Infinity }
    expect(sessionKey(live)).toBe(sessionKey({ ...live }))
  })
})

// These checks pin parameter sorting, auxiliary-parameter parsing, key-component boundaries, the
// unknown-duration branch, and the requirement to survive a string that is not a URL.

describe('normalizeUrl: string that is not a URL', () => {
  const garbage = [
    '',
    '   ',
    'not a url',
    'watch?v=abc',
    '//site.example/v/1',
    'https://',
    'http://[',
    'https://site.example:99999/v/1',
  ]

  for (const input of garbage) {
    it(`returns unchanged without throwing: ${JSON.stringify(input)}`, () => {
      expect(() => normalizeUrl(input)).not.toThrow()
      expect(normalizeUrl(input)).toBe(input)
    })
  }

  it('leaves garbage unchanged on a second pass', () => {
    for (const input of garbage) {
      expect(normalizeUrl(normalizeUrl(input))).toBe(input)
    }
  })

  it('computes a key for a garbage URL and distinguishes sources', () => {
    const base = { codecs: ['avc1'], durationSeconds: 600 }
    expect(() => sessionKey({ ...base, url: 'not a url' })).not.toThrow()
    expect(sessionKey({ ...base, url: 'not a url' })).toBe(sessionKey({ ...base, url: 'not a url' }))
    expect(sessionKey({ ...base, url: 'not a url' })).not.toBe(
      sessionKey({ ...base, url: 'also not a url' }),
    )
  })
})

describe('normalizeUrl: auxiliary parameters', () => {
  const bare = 'https://site.example/watch?v=abc'

  // Test different routes to the same video, not an implementation-defined list of names. Reaching
  // the same video by another route must produce the same session.

  it('normalizes a share link to the canonical URL', () => {
    expect(normalizeUrl(`${bare}&t=42s&si=Kx9pQ&pp=ygUFdGVzdA&feature=shared`)).toBe(
      normalizeUrl(bare),
    )
  })

  it('normalizes a return from a playlist to the canonical URL', () => {
    expect(normalizeUrl(`${bare}&list=PLxyz&index=7&start=120&time_continue=15`)).toBe(
      normalizeUrl(bare),
    )
  })

  it('normalizes campaign and referrer traffic to the canonical URL', () => {
    expect(
      normalizeUrl(
        `${bare}&utm_source=newsletter&utm_medium=email&utm_campaign=august&utm_content=hero` +
          '&ref=twitter&ref_src=twsrc&referrer=t.co&source=share&share_id=99',
      ),
    ).toBe(normalizeUrl(bare))
  })

  it('normalizes two different routes to one video to the same URL', () => {
    expect(normalizeUrl(`${bare}&t=42s&si=Kx9pQ&ref=twitter`)).toBe(
      normalizeUrl(`${bare}&t=903s&list=PLxyz&index=2&utm_source=newsletter`),
    )
  })

  it('treats utm_ as a prefix rather than a list of four known names', () => {
    expect(normalizeUrl(`${bare}&utm_id=7&utm_term=clip&utm_whatever=1`)).toBe(normalizeUrl(bare))
  })

  const meaningful = ['v', 'id', 'video_id', 'clip', 'file', 'p']

  for (const key of meaningful) {
    const path = 'https://site.example/v/1'
    it(`preserves "${key}"`, () => {
      expect(normalizeUrl(`${path}?${key}=abc`)).not.toBe(normalizeUrl(path))
      expect(normalizeUrl(`${path}?${key}=abc`)).not.toBe(normalizeUrl(`${path}?${key}=xyz`))
    })
  }

  it('ignores the order of meaningful parameters', () => {
    expect(normalizeUrl(`${bare}&quality=hd`)).toBe(
      normalizeUrl('https://site.example/watch?quality=hd&v=abc'),
    )
  })

  it('ignores an auxiliary parameter between meaningful parameters', () => {
    expect(normalizeUrl(`${bare}&t=42&quality=hd`)).toBe(
      normalizeUrl('https://site.example/watch?quality=hd&v=abc'),
    )
  })

  it('normalizes a URL with only auxiliary parameters to the bare URL', () => {
    expect(normalizeUrl('https://site.example/v/1?t=42&utm_source=x')).toBe(
      normalizeUrl('https://site.example/v/1'),
    )
  })
})

describe('normalizeUrl: a name starting with an auxiliary name is not auxiliary', () => {
  const bare = 'https://site.example/v/1'

  // Each tuple has a meaningful parameter name and two different values. Every name starts with
  // an auxiliary parameter name: title with t, sig with si, and source_id with source.
  const meaningful: Array<[string, string, string]> = [
    ['title', 'ep1', 'ep2'],
    ['token', 'A', 'B'],
    ['type', 'hls', 'dash'],
    ['sig', 'aaa', 'bbb'],
    ['source_id', '10', '11'],
    ['list_id', '4', '5'],
  ]

  for (const [key, one, two] of meaningful) {
    it(`preserves "${key}"`, () => {
      expect(normalizeUrl(`${bare}?${key}=${one}`)).not.toBe(normalizeUrl(bare))
      expect(normalizeUrl(`${bare}?${key}=${one}`)).not.toBe(normalizeUrl(`${bare}?${key}=${two}`))
    })
  }

  it('does not merge videos distinguished only by title into one session', () => {
    const base = { codecs: ['avc1'], durationSeconds: 600 }
    expect(sessionKey({ ...base, url: `${bare}?title=ep1` })).not.toBe(
      sessionKey({ ...base, url: `${bare}?title=ep2` }),
    )
  })

  it('does not merge signed URLs with different tokens into one session', () => {
    const base = { codecs: ['avc1'], durationSeconds: 600 }
    expect(sessionKey({ ...base, url: `${bare}?token=A` })).not.toBe(
      sessionKey({ ...base, url: `${bare}?token=B` }),
    )
  })

  it('removes utm_ only at the start of a name', () => {
    expect(normalizeUrl(`${bare}?x_utm_id=1`)).not.toBe(normalizeUrl(bare))
    expect(normalizeUrl(`${bare}?x_utm_id=1`)).not.toBe(normalizeUrl(`${bare}?x_utm_id=2`))
  })

  it('preserves a name that merely starts with the letters utm', () => {
    expect(normalizeUrl(`${bare}?utmost=1`)).not.toBe(normalizeUrl(bare))
    expect(normalizeUrl(`${bare}?utmost=1`)).not.toBe(normalizeUrl(`${bare}?utmost=2`))
  })
})

describe('normalizeUrl: language', () => {
  const bare = 'https://site.example/watch?v=abc'

  it('preserves lang because some sites use it to select an audio track', () => {
    expect(normalizeUrl(`${bare}&lang=ru`)).not.toBe(normalizeUrl(`${bare}&lang=en`))
    expect(normalizeUrl(`${bare}&lang=ru`)).not.toBe(normalizeUrl(bare))
  })

  it('does not merge dubbed versions of one video into a single session', () => {
    const base = { codecs: ['avc1', 'mp4a'], durationSeconds: 1800 }
    expect(sessionKey({ ...base, url: `${bare}&lang=ru` })).not.toBe(
      sessionKey({ ...base, url: `${bare}&lang=en` }),
    )
  })
})

describe('normalizeUrl: what is normalized and what is not', () => {
  const bare = 'https://site.example/v/1'

  it('removes an auxiliary parameter regardless of name casing', () => {
    expect(normalizeUrl(`${bare}?v=abc&T=42`)).toBe(normalizeUrl(`${bare}?v=abc`))
    expect(normalizeUrl(`${bare}?v=abc&UTM_Source=x`)).toBe(normalizeUrl(`${bare}?v=abc`))
  })

  it('preserves meaningful parameter name casing rather than normalizing it for the site', () => {
    expect(normalizeUrl(`${bare}?V=abc`)).not.toBe(normalizeUrl(`${bare}?v=abc`))
  })

  it('ignores the value casing of an auxiliary parameter', () => {
    expect(normalizeUrl(`${bare}?v=abc&t=42S`)).toBe(normalizeUrl(`${bare}?v=abc`))
  })

  it('treats a trailing slash as a different URL because the path belongs to the site', () => {
    expect(normalizeUrl(`${bare}/`)).not.toBe(normalizeUrl(bare))
  })

  it('treats http and https as different URLs', () => {
    expect(normalizeUrl('http://site.example/v/1')).not.toBe(normalizeUrl('https://site.example/v/1'))
  })

  it('relies on URL parsing to normalize host casing', () => {
    expect(normalizeUrl('https://SITE.example/v/1')).toBe(normalizeUrl('https://site.example/v/1'))
  })

  it('preserves path casing', () => {
    expect(normalizeUrl('https://site.example/V/1')).not.toBe(normalizeUrl('https://site.example/v/1'))
  })
})

describe('normalizeUrl: non-HTTP URLs', () => {
  it('preserves a blob URL through keying and distinguishes sources', () => {
    expect(normalizeUrl('blob:https://site.example/uuid-1')).toBe(
      'blob:https://site.example/uuid-1',
    )
    expect(normalizeUrl('blob:https://site.example/uuid-1')).not.toBe(
      normalizeUrl('blob:https://site.example/uuid-2'),
    )
  })
})

describe('sessionKey: duration', () => {
  const input = { url: 'https://site.example/watch?v=abc', codecs: ['avc1'], durationSeconds: 600 }

  it('treats an unknown duration as a live stream rather than a separate video', () => {
    expect(sessionKey({ ...input, durationSeconds: NaN })).toBe(
      sessionKey({ ...input, durationSeconds: Infinity }),
    )
  })

  it('does not merge a live stream with a video of known duration', () => {
    expect(sessionKey({ ...input, durationSeconds: Infinity })).not.toBe(sessionKey(input))
  })

  it('changes the key when a real duration appears after loadedmetadata', () => {
    expect(sessionKey({ ...input, durationSeconds: NaN })).not.toBe(
      sessionKey({ ...input, durationSeconds: 600 }),
    )
  })

  it('does not split a session over a fractional difference across a second boundary', () => {
    expect(sessionKey({ ...input, durationSeconds: 600.9 })).toBe(
      sessionKey({ ...input, durationSeconds: 601.1 }),
    )
  })

  it('includes the codec set in the key', () => {
    expect(sessionKey({ ...input, codecs: ['avc1'] })).not.toBe(
      sessionKey({ ...input, codecs: ['avc1', 'mp4a'] }),
    )
  })
})

describe('sessionKey: key components do not bleed into each other', () => {
  it('keeps a shifted URL-codec boundary from giving two sessions one key', () => {
    expect(
      sessionKey({ url: 'https://site.example/v/1', codecs: ['avc1'], durationSeconds: 600 }),
    ).not.toBe(
      sessionKey({ url: 'https://site.example/v/1a', codecs: ['vc1'], durationSeconds: 600 }),
    )
  })

  it('keeps a shifted codec-duration boundary from giving two sessions one key', () => {
    const url = 'https://site.example/v/1'
    expect(sessionKey({ url, codecs: ['avc1'], durationSeconds: 12 })).not.toBe(
      sessionKey({ url, codecs: ['avc11'], durationSeconds: 2 }),
    )
  })

  // A comma is valid in a path and also separates codecs, so the URL-codec boundary must use a
  // character that cannot occur in a URL. Otherwise `…/v/1` + [avc1, mp4a] and `…/v/1,avc1` +
  // [mp4a] produce one key, putting fragments from two videos in one map.
  it('keeps a comma in the URL from consuming the URL-codec boundary', () => {
    expect(
      sessionKey({ url: 'https://cdn.example/v/1', codecs: ['avc1', 'mp4a'], durationSeconds: 600 }),
    ).not.toBe(
      sessionKey({ url: 'https://cdn.example/v/1,avc1', codecs: ['mp4a'], durationSeconds: 600 }),
    )
  })

  it('preserves a comma through keying and distinguishes two URLs', () => {
    const base = { codecs: ['avc1'], durationSeconds: 600 }
    expect(sessionKey({ ...base, url: 'https://cdn.example/v/1,avc1' })).not.toBe(
      sessionKey({ ...base, url: 'https://cdn.example/v/1' }),
    )
    expect(sessionKey({ ...base, url: 'https://cdn.example/v/1,avc1' })).toBe(
      sessionKey({ ...base, url: 'https://cdn.example/v/1,avc1' }),
    )
  })

  // Codec boundaries inside the list matter. Joining without a separator erases them and turns
  // two different track sets into one session.
  const glued: Array<[string[], string[]]> = [
    [['avc1', 'mp4a'], ['avc1m', 'p4a']],
    [['a', 'bc'], ['ab', 'c']],
    [
      ['avc1.640028', 'mp4a.40.2'],
      ['avc1.640028m', 'p4a.40.2'],
    ],
  ]

  for (const [one, two] of glued) {
    it(`gives different keys to codec lists with the same concatenation: ${one.join('+')} and ${two.join('+')}`, () => {
      expect(one.join('')).toBe(two.join(''))
      const base = { url: 'https://site.example/v/1', durationSeconds: 600 }
      expect(sessionKey({ ...base, codecs: one })).not.toBe(sessionKey({ ...base, codecs: two }))
    })
  }
})

describe('sessionKey: input remains unchanged', () => {
  it('does not reorder codecs in the caller\'s array', () => {
    const codecs = ['mp4a', 'avc1']
    sessionKey({ url: 'https://site.example/v/1', codecs, durationSeconds: 600 })
    expect(codecs).toEqual(['mp4a', 'avc1'])
  })
})
