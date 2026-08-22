import { describe, it, expect } from 'vitest'
import { sessionKey, normalizeUrl } from '../../src/core/session-key'

describe('normalizeUrl', () => {
  it('срезает метку времени и параметры отслеживания', () => {
    const a = normalizeUrl('https://site.example/watch?v=abc&t=42s&utm_source=x&si=zz')
    const b = normalizeUrl('https://site.example/watch?v=abc')
    expect(a).toBe(b)
  })

  it('сохраняет параметр, определяющий само видео', () => {
    const a = normalizeUrl('https://site.example/watch?v=abc')
    const b = normalizeUrl('https://site.example/watch?v=xyz')
    expect(a).not.toBe(b)
  })

  it('отбрасывает якорь', () => {
    expect(normalizeUrl('https://site.example/v/1#comments')).toBe(
      normalizeUrl('https://site.example/v/1'),
    )
  })

  it('не спотыкается о мусор вместо адреса', () => {
    expect(normalizeUrl('not a url')).toBe('not a url')
  })
})

describe('sessionKey', () => {
  const input = { url: 'https://site.example/watch?v=abc', codecs: ['avc1'], durationSeconds: 600 }

  it('перезагрузка страницы даёт тот же ключ', () => {
    expect(sessionKey(input)).toBe(sessionKey({ ...input, url: input.url + '&t=90' }))
  })

  it('другое видео даёт другой ключ', () => {
    expect(sessionKey(input)).not.toBe(
      sessionKey({ ...input, url: 'https://site.example/watch?v=zzz' }),
    )
  })

  it('другая длительность на том же адресе даёт другой ключ — это другой ролик', () => {
    expect(sessionKey(input)).not.toBe(sessionKey({ ...input, durationSeconds: 61 }))
  })

  it('порядок кодеков не влияет', () => {
    expect(sessionKey({ ...input, codecs: ['avc1', 'mp4a'] })).toBe(
      sessionKey({ ...input, codecs: ['mp4a', 'avc1'] }),
    )
  })

  it('дробная разница в длительности не расщепляет сессию', () => {
    expect(sessionKey(input)).toBe(sessionKey({ ...input, durationSeconds: 600.4 }))
  })

  it('прямой эфир без известной длительности даёт стабильный ключ', () => {
    const live = { ...input, durationSeconds: Infinity }
    expect(sessionKey(live)).toBe(sessionKey({ ...live }))
  })
})

// Дальше — проверки сверх плана: они закрывают то, что плановые десять не пиннят
// (сортировку параметров, каждый служебный параметр по отдельности, ветку «длительность
// неизвестна») и требование пережить строку, которая адресом не является.

describe('normalizeUrl: строка, которая не является адресом', () => {
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
    it(`возвращает как есть и не бросает: ${JSON.stringify(input)}`, () => {
      expect(() => normalizeUrl(input)).not.toThrow()
      expect(normalizeUrl(input)).toBe(input)
    })
  }

  it('повторный проход по мусору ничего не меняет', () => {
    for (const input of garbage) {
      expect(normalizeUrl(normalizeUrl(input))).toBe(input)
    }
  })

  it('ключ на мусорном адресе считается и различает источники', () => {
    const base = { codecs: ['avc1'], durationSeconds: 600 }
    expect(() => sessionKey({ ...base, url: 'not a url' })).not.toThrow()
    expect(sessionKey({ ...base, url: 'not a url' })).toBe(sessionKey({ ...base, url: 'not a url' }))
    expect(sessionKey({ ...base, url: 'not a url' })).not.toBe(
      sessionKey({ ...base, url: 'also not a url' }),
    )
  })
})

describe('normalizeUrl: служебные параметры', () => {
  const bare = 'https://site.example/v/1'
  const noise = [
    't', 'time_continue', 'start', 'index', 'list', 'si', 'feature', 'pp',
    'ref', 'ref_src', 'referrer', 'source', 'share_id', 'lang',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content',
  ]

  for (const key of noise) {
    it(`отбрасывает «${key}»`, () => {
      expect(normalizeUrl(`${bare}?${key}=whatever`)).toBe(normalizeUrl(bare))
    })
  }

  const meaningful = ['v', 'id', 'video_id', 'clip', 'file', 'p']

  for (const key of meaningful) {
    it(`сохраняет «${key}»`, () => {
      expect(normalizeUrl(`${bare}?${key}=abc`)).not.toBe(normalizeUrl(bare))
      expect(normalizeUrl(`${bare}?${key}=abc`)).not.toBe(normalizeUrl(`${bare}?${key}=xyz`))
    })
  }

  it('порядок значимых параметров не влияет', () => {
    expect(normalizeUrl(`${bare}?v=abc&quality=hd`)).toBe(normalizeUrl(`${bare}?quality=hd&v=abc`))
  })

  it('служебный параметр посреди значимых не сдвигает результат', () => {
    expect(normalizeUrl(`${bare}?v=abc&t=42&quality=hd`)).toBe(
      normalizeUrl(`${bare}?quality=hd&v=abc`),
    )
  })

  it('адрес из одних служебных параметров сходится с голым адресом', () => {
    expect(normalizeUrl(`${bare}?t=42&utm_source=x`)).toBe(normalizeUrl(bare))
  })
})

describe('normalizeUrl: адреса не из http', () => {
  it('blob-адрес доживает до ключа и различает источники', () => {
    expect(normalizeUrl('blob:https://site.example/uuid-1')).toBe(
      'blob:https://site.example/uuid-1',
    )
    expect(normalizeUrl('blob:https://site.example/uuid-1')).not.toBe(
      normalizeUrl('blob:https://site.example/uuid-2'),
    )
  })
})

describe('sessionKey: длительность', () => {
  const input = { url: 'https://site.example/watch?v=abc', codecs: ['avc1'], durationSeconds: 600 }

  it('неизвестная длительность считается прямым эфиром, а не отдельным роликом', () => {
    expect(sessionKey({ ...input, durationSeconds: NaN })).toBe(
      sessionKey({ ...input, durationSeconds: Infinity }),
    )
  })

  it('прямой эфир не сливается с роликом известной длины', () => {
    expect(sessionKey({ ...input, durationSeconds: Infinity })).not.toBe(sessionKey(input))
  })

  it('дробная разница через границу секунды не расщепляет сессию', () => {
    expect(sessionKey({ ...input, durationSeconds: 600.9 })).toBe(
      sessionKey({ ...input, durationSeconds: 601.1 }),
    )
  })

  it('состав кодеков входит в ключ', () => {
    expect(sessionKey({ ...input, codecs: ['avc1'] })).not.toBe(
      sessionKey({ ...input, codecs: ['avc1', 'mp4a'] }),
    )
  })
})
