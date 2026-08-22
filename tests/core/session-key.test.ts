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
// (сортировку параметров, разбор служебных параметров, границы компонентов ключа,
// ветку «длительность неизвестна») и требование пережить строку, которая адресом не является.

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
  const bare = 'https://site.example/watch?v=abc'

  // Проверяются заходы к одному и тому же видео, а не список имён из реализации:
  // требование звучит как «пришёл к тому же ролику другой дорогой — та же сессия».

  it('ссылка «поделиться» сходится с каноническим адресом', () => {
    expect(normalizeUrl(`${bare}&t=42s&si=Kx9pQ&pp=ygUFdGVzdA&feature=shared`)).toBe(
      normalizeUrl(bare),
    )
  })

  it('возврат к ролику из плейлиста сходится с каноническим адресом', () => {
    expect(normalizeUrl(`${bare}&list=PLxyz&index=7&start=120&time_continue=15`)).toBe(
      normalizeUrl(bare),
    )
  })

  it('приход по кампании и с чужого сайта сходится с каноническим адресом', () => {
    expect(
      normalizeUrl(
        `${bare}&utm_source=newsletter&utm_medium=email&utm_campaign=august&utm_content=hero` +
          '&ref=twitter&ref_src=twsrc&referrer=t.co&source=share&share_id=99',
      ),
    ).toBe(normalizeUrl(bare))
  })

  it('два разных захода к одному ролику дают один адрес', () => {
    expect(normalizeUrl(`${bare}&t=42s&si=Kx9pQ&ref=twitter`)).toBe(
      normalizeUrl(`${bare}&t=903s&list=PLxyz&index=2&utm_source=newsletter`),
    )
  })

  it('utm_ — это префикс, а не список из четырёх известных имён', () => {
    expect(normalizeUrl(`${bare}&utm_id=7&utm_term=clip&utm_whatever=1`)).toBe(normalizeUrl(bare))
  })

  const meaningful = ['v', 'id', 'video_id', 'clip', 'file', 'p']

  for (const key of meaningful) {
    const path = 'https://site.example/v/1'
    it(`сохраняет «${key}»`, () => {
      expect(normalizeUrl(`${path}?${key}=abc`)).not.toBe(normalizeUrl(path))
      expect(normalizeUrl(`${path}?${key}=abc`)).not.toBe(normalizeUrl(`${path}?${key}=xyz`))
    })
  }

  it('порядок значимых параметров не влияет', () => {
    expect(normalizeUrl(`${bare}&quality=hd`)).toBe(
      normalizeUrl('https://site.example/watch?quality=hd&v=abc'),
    )
  })

  it('служебный параметр посреди значимых не сдвигает результат', () => {
    expect(normalizeUrl(`${bare}&t=42&quality=hd`)).toBe(
      normalizeUrl('https://site.example/watch?quality=hd&v=abc'),
    )
  })

  it('адрес из одних служебных параметров сходится с голым адресом', () => {
    expect(normalizeUrl('https://site.example/v/1?t=42&utm_source=x')).toBe(
      normalizeUrl('https://site.example/v/1'),
    )
  })
})

describe('normalizeUrl: имя, начинающееся со служебного, служебным не считается', () => {
  const bare = 'https://site.example/v/1'

  // Каждая пара: имя значимого параметра и два его разных значения. Все имена начинаются
  // с имени служебного параметра — «title» с «t», «sig» с «si», «source_id» с «source».
  const meaningful: Array<[string, string, string]> = [
    ['title', 'ep1', 'ep2'],
    ['token', 'A', 'B'],
    ['type', 'hls', 'dash'],
    ['sig', 'aaa', 'bbb'],
    ['source_id', '10', '11'],
    ['list_id', '4', '5'],
  ]

  for (const [key, one, two] of meaningful) {
    it(`сохраняет «${key}»`, () => {
      expect(normalizeUrl(`${bare}?${key}=${one}`)).not.toBe(normalizeUrl(bare))
      expect(normalizeUrl(`${bare}?${key}=${one}`)).not.toBe(normalizeUrl(`${bare}?${key}=${two}`))
    })
  }

  it('два ролика, различимые только по title, не сливаются в одну сессию', () => {
    const base = { codecs: ['avc1'], durationSeconds: 600 }
    expect(sessionKey({ ...base, url: `${bare}?title=ep1` })).not.toBe(
      sessionKey({ ...base, url: `${bare}?title=ep2` }),
    )
  })

  it('подписанные ссылки с разными token не сливаются в одну сессию', () => {
    const base = { codecs: ['avc1'], durationSeconds: 600 }
    expect(sessionKey({ ...base, url: `${bare}?token=A` })).not.toBe(
      sessionKey({ ...base, url: `${bare}?token=B` }),
    )
  })

  it('utm_ срезается только в начале имени', () => {
    expect(normalizeUrl(`${bare}?x_utm_id=1`)).not.toBe(normalizeUrl(bare))
    expect(normalizeUrl(`${bare}?x_utm_id=1`)).not.toBe(normalizeUrl(`${bare}?x_utm_id=2`))
  })

  it('имя, лишь начинающееся с букв utm, сохраняется', () => {
    expect(normalizeUrl(`${bare}?utmost=1`)).not.toBe(normalizeUrl(bare))
    expect(normalizeUrl(`${bare}?utmost=1`)).not.toBe(normalizeUrl(`${bare}?utmost=2`))
  })
})

describe('normalizeUrl: язык', () => {
  const bare = 'https://site.example/watch?v=abc'

  it('lang сохраняется — на части сайтов он выбирает звуковую дорожку, а не подписи', () => {
    expect(normalizeUrl(`${bare}&lang=ru`)).not.toBe(normalizeUrl(`${bare}&lang=en`))
    expect(normalizeUrl(`${bare}&lang=ru`)).not.toBe(normalizeUrl(bare))
  })

  it('дубляжи одного ролика не сливаются в одну сессию', () => {
    const base = { codecs: ['avc1', 'mp4a'], durationSeconds: 1800 }
    expect(sessionKey({ ...base, url: `${bare}&lang=ru` })).not.toBe(
      sessionKey({ ...base, url: `${bare}&lang=en` }),
    )
  })
})

describe('normalizeUrl: что схлопывается, а что нет', () => {
  const bare = 'https://site.example/v/1'

  it('регистр имени не спасает служебный параметр от среза', () => {
    expect(normalizeUrl(`${bare}?v=abc&T=42`)).toBe(normalizeUrl(`${bare}?v=abc`))
    expect(normalizeUrl(`${bare}?v=abc&UTM_Source=x`)).toBe(normalizeUrl(`${bare}?v=abc`))
  })

  it('регистр имени значимого параметра сохраняется — за сайт мы их не схлопываем', () => {
    expect(normalizeUrl(`${bare}?V=abc`)).not.toBe(normalizeUrl(`${bare}?v=abc`))
  })

  it('регистр значения служебного параметра ни на что не влияет', () => {
    expect(normalizeUrl(`${bare}?v=abc&t=42S`)).toBe(normalizeUrl(`${bare}?v=abc`))
  })

  it('завершающий слэш даёт другой адрес — путь принадлежит сайту', () => {
    expect(normalizeUrl(`${bare}/`)).not.toBe(normalizeUrl(bare))
  })

  it('http и https — разные адреса', () => {
    expect(normalizeUrl('http://site.example/v/1')).not.toBe(normalizeUrl('https://site.example/v/1'))
  })

  it('регистр хоста снимает сам разбор адреса', () => {
    expect(normalizeUrl('https://SITE.example/v/1')).toBe(normalizeUrl('https://site.example/v/1'))
  })

  it('регистр пути сохраняется', () => {
    expect(normalizeUrl('https://site.example/V/1')).not.toBe(normalizeUrl('https://site.example/v/1'))
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

  it('появление настоящей длительности меняет ключ — считать его до loadedmetadata нельзя', () => {
    expect(sessionKey({ ...input, durationSeconds: NaN })).not.toBe(
      sessionKey({ ...input, durationSeconds: 600 }),
    )
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

describe('sessionKey: компоненты ключа не перетекают друг в друга', () => {
  it('сдвиг границы между адресом и кодеками не даёт двум сессиям общий ключ', () => {
    expect(
      sessionKey({ url: 'https://site.example/v/1', codecs: ['avc1'], durationSeconds: 600 }),
    ).not.toBe(
      sessionKey({ url: 'https://site.example/v/1a', codecs: ['vc1'], durationSeconds: 600 }),
    )
  })

  it('сдвиг границы между кодеками и длительностью не даёт двум сессиям общий ключ', () => {
    const url = 'https://site.example/v/1'
    expect(sessionKey({ url, codecs: ['avc1'], durationSeconds: 12 })).not.toBe(
      sessionKey({ url, codecs: ['avc11'], durationSeconds: 2 }),
    )
  })
})

describe('sessionKey: вход остаётся нетронутым', () => {
  it('не переставляет кодеки в массиве вызывающей стороны', () => {
    const codecs = ['mp4a', 'avc1']
    sessionKey({ url: 'https://site.example/v/1', codecs, durationSeconds: 600 })
    expect(codecs).toEqual(['mp4a', 'avc1'])
  })
})
