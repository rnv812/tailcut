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

describe('triage — мгновенный отказ', () => {
  it('DRM отсекается всегда', () => {
    expect(triage({ ...base, hasDrm: true, playedSeconds: 60 }, BALANCED)).toBe('reject')
  })

  it('мелкий элемент отсекается', () => {
    expect(triage({ ...base, widthPx: 180, playedSeconds: 60 }, BALANCED)).toBe('reject')
  })

  it('беззвучный зациклённый баннер отсекается', () => {
    const banner = { ...base, muted: true, loop: true, controls: false, playedSeconds: 60 }
    expect(triage(banner, BALANCED)).toBe('reject')
  })

  it('невидимое отсекается', () => {
    expect(triage({ ...base, visible: false, playedSeconds: 60 }, BALANCED)).toBe('reject')
  })
})

describe('triage — a page that plays its sound in another element', () => {
  const half = { ...base, muted: true, loop: true, controls: false, playedSeconds: 60 }

  it('records a looping silent picture when the page is playing sound beside it', () => {
    // The banner rule reads this element as decoration, and on nearly every page it is right. On
    // a page whose sound is in an <audio> of its own it is wrong: the picture is not silent, its
    // sound is in the other element, and the two together are the work (§5.6).
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

describe('triage — испытательный срок', () => {
  it('превью под курсором не доживает до сессии', () => {
    expect(triage({ ...base, playedSeconds: 1.5 }, BALANCED)).toBe('hold')
  })

  it('настоящий просмотр повышается', () => {
    expect(triage({ ...base, playedSeconds: 7 }, BALANCED)).toBe('promote')
  })

  it('ровно на пороге уже повышается', () => {
    expect(triage({ ...base, playedSeconds: 6 }, BALANCED)).toBe('promote')
  })
})

describe('triage — беззвучное', () => {
  it('крупное беззвучное без цикла пишется при сбалансированном пресете', () => {
    const silent = { ...base, muted: true, loop: false, playedSeconds: 7 }
    expect(triage(silent, BALANCED)).toBe('promote')
  })

  it('строгая настройка беззвучное не пишет', () => {
    const strict = { ...BALANCED, recordMuted: false }
    const silent = { ...base, muted: true, playedSeconds: 60 }
    expect(triage(silent, strict)).toBe('reject')
  })
})

// Пауза (§5.5 спеки) замораживает НАКОПЛЕНИЕ времени, а не вердикт: playedSeconds
// перестаёт расти, потому что наблюдатель начисляет его только играющему видео.
// Сам triage поле playing не читает — иначе пауза после порога отзывала бы уже
// заработанное повышение, а пауза до порога отменяла бы мгновенный отказ.
// Отсюда контракт, который проверяется ниже: при одних и тех же прочих сигналах
// вердикт обязан совпадать на паузе и на воспроизведении.
describe('triage — пауза', () => {
  it('на паузе вердикт определяется накопленным временем', () => {
    expect(triage({ ...base, playing: false, playedSeconds: 2 }, BALANCED)).toBe('hold')
  })

  it('пауза не отменяет уже заработанного повышения', () => {
    expect(triage({ ...base, playing: false, playedSeconds: 30 }, BALANCED)).toBe('promote')
  })

  const recordMutedOff: TriageConfig = { ...BALANCED, recordMuted: false }

  const invariant: Array<[string, Partial<VideoSignals>, TriageConfig, TriageVerdict]> = [
    ['DRM отсекается', { hasDrm: true, playedSeconds: 60 }, BALANCED, 'reject'],
    ['мелкий элемент отсекается', { widthPx: 180, playedSeconds: 60 }, BALANCED, 'reject'],
    ['невидимое отсекается', { visible: false, playedSeconds: 60 }, BALANCED, 'reject'],
    [
      'беззвучный зациклённый баннер отсекается',
      { muted: true, loop: true, controls: false, playedSeconds: 60 },
      BALANCED,
      'reject',
    ],
    [
      'беззвучное при строгой настройке отсекается',
      { muted: true, playedSeconds: 60 },
      recordMutedOff,
      'reject',
    ],
    ['ничего не накоплено — ждём', { playedSeconds: 0 }, BALANCED, 'hold'],
    ['за миг до порога — ждём', { playedSeconds: 5.999 }, BALANCED, 'hold'],
    ['ровно на пороге — повышаем', { playedSeconds: 6 }, BALANCED, 'promote'],
    ['далеко за порогом — повышаем', { playedSeconds: 30 }, BALANCED, 'promote'],
  ]

  for (const [name, signals, config, expected] of invariant) {
    it(`${name} одинаково на паузе и на воспроизведении`, () => {
      expect(triage({ ...base, ...signals, playing: true }, config)).toBe(expected)
      expect(triage({ ...base, ...signals, playing: false }, config)).toBe(expected)
    })
  }
})

describe('triage — что баннером не является', () => {
  it('зациклённое беззвучное с панелью управления — это плеер, а не баннер', () => {
    const player = { ...base, muted: true, loop: true, controls: true, playedSeconds: 7 }
    expect(triage(player, BALANCED)).toBe('promote')
  })

  it('зациклённое со звуком и без панели — не баннер', () => {
    const looped = { ...base, muted: false, loop: true, controls: false, playedSeconds: 7 }
    expect(triage(looped, BALANCED)).toBe('promote')
  })

  it('беззвучное без цикла и без панели — не баннер', () => {
    const silent = { ...base, muted: true, loop: false, controls: false, playedSeconds: 7 }
    expect(triage(silent, BALANCED)).toBe('promote')
  })
})

describe('triage — порядок проверок', () => {
  it('мгновенный отказ срабатывает раньше испытательного срока', () => {
    expect(triage({ ...base, hasDrm: true, playedSeconds: 0 }, BALANCED)).toBe('reject')
    expect(triage({ ...base, widthPx: 180, playedSeconds: 0 }, BALANCED)).toBe('reject')
    expect(triage({ ...base, visible: false, playedSeconds: 0 }, BALANCED)).toBe('reject')
    const banner = { ...base, muted: true, loop: true, controls: false, playedSeconds: 0 }
    expect(triage(banner, BALANCED)).toBe('reject')
    const strict = { ...BALANCED, recordMuted: false }
    expect(triage({ ...base, muted: true, playedSeconds: 0 }, strict)).toBe('reject')
  })

  it('ровно на минимальной ширине элемент проходит', () => {
    expect(triage({ ...base, widthPx: 320, playedSeconds: 7 }, BALANCED)).toBe('promote')
  })

  it('на пиксель уже минимума — отказ', () => {
    expect(triage({ ...base, widthPx: 319, playedSeconds: 7 }, BALANCED)).toBe('reject')
  })

  it('за миг до порога ещё ждём', () => {
    expect(triage({ ...base, playedSeconds: 5.999 }, BALANCED)).toBe('hold')
  })
})

describe('triage — пресеты', () => {
  it('мягкий пресет повышает раньше сбалансированного и строгого', () => {
    const early = { ...base, playedSeconds: 4 }
    expect(triage(early, LOOSE)).toBe('promote')
    expect(triage(early, BALANCED)).toBe('hold')
    expect(triage(early, STRICT)).toBe('hold')
  })

  it('строгий пресет отсекает по ширине то, что остальные пишут', () => {
    const medium = { ...base, widthPx: 400, playedSeconds: 60 }
    expect(triage(medium, LOOSE)).toBe('promote')
    expect(triage(medium, BALANCED)).toBe('promote')
    expect(triage(medium, STRICT)).toBe('reject')
  })

  it('мягкий пресет: порог 3 секунды, ширина от 200 пикселей', () => {
    expect(triage({ ...base, playedSeconds: 2.9 }, LOOSE)).toBe('hold')
    expect(triage({ ...base, playedSeconds: 3 }, LOOSE)).toBe('promote')
    expect(triage({ ...base, widthPx: 199, playedSeconds: 60 }, LOOSE)).toBe('reject')
    expect(triage({ ...base, widthPx: 200, playedSeconds: 60 }, LOOSE)).toBe('promote')
  })

  it('строгий пресет: порог 12 секунд, ширина от 480 пикселей', () => {
    expect(triage({ ...base, playedSeconds: 11.9 }, STRICT)).toBe('hold')
    expect(triage({ ...base, playedSeconds: 12 }, STRICT)).toBe('promote')
    expect(triage({ ...base, widthPx: 479, playedSeconds: 60 }, STRICT)).toBe('reject')
    expect(triage({ ...base, widthPx: 480, playedSeconds: 60 }, STRICT)).toBe('promote')
  })

  it('строгий пресет беззвучное не пишет, мягкий пишет', () => {
    expect(triage({ ...base, muted: true, playedSeconds: 60 }, STRICT)).toBe('reject')
    expect(triage({ ...base, muted: true, widthPx: 210, playedSeconds: 60 }, LOOSE)).toBe('promote')
  })
})

// getBoundingClientRect почти никогда не возвращает целую ширину, поэтому порог
// обязан сравниваться с реальным дробным значением, а не с округлённым: элемент
// в 319.6 пикселя ниже минимума и должен отсеиваться, хотя округляется до 320.
describe('triage — дробная ширина', () => {
  it('дробная ширина чуть ниже порога отсекается, хотя округляется до порога', () => {
    expect(triage({ ...base, widthPx: 319.6, playedSeconds: 60 }, BALANCED)).toBe('reject')
    expect(triage({ ...base, widthPx: 319.5, playedSeconds: 60 }, BALANCED)).toBe('reject')
  })

  it('дробная ширина чуть выше порога проходит', () => {
    expect(triage({ ...base, widthPx: 320.4, playedSeconds: 60 }, BALANCED)).toBe('promote')
    expect(triage({ ...base, widthPx: 320.01, playedSeconds: 60 }, BALANCED)).toBe('promote')
  })

  it('дробная ширина сравнивается с порогом пресета, а не с округлением', () => {
    expect(triage({ ...base, widthPx: 199.7, playedSeconds: 60 }, LOOSE)).toBe('reject')
    expect(triage({ ...base, widthPx: 200.3, playedSeconds: 60 }, LOOSE)).toBe('promote')
    expect(triage({ ...base, widthPx: 479.8, playedSeconds: 60 }, STRICT)).toBe('reject')
    expect(triage({ ...base, widthPx: 480.2, playedSeconds: 60 }, STRICT)).toBe('promote')
  })
})

// Числовые сигналы приходят из измерений живой страницы и могут оказаться NaN:
// playedSeconds — это разность отметок времени, и первая же разность с ещё не
// проставленной отметкой даёт NaN; widthPx берётся из getBoundingClientRect и
// не определён, пока элемент не попал в раскладку. NaN означает «не измерено»,
// а не «измерено и хорошо»: неизмеренное время не заслуживает повышения,
// неизмеренная ширина не может подтвердить минимум и отсеивается.
describe('triage — неизмеренные числовые сигналы (NaN)', () => {
  it('NaN во времени воспроизведения не повышает — видео ждёт', () => {
    expect(triage({ ...base, playedSeconds: NaN }, BALANCED)).toBe('hold')
    expect(triage({ ...base, playedSeconds: NaN }, LOOSE)).toBe('hold')
    expect(triage({ ...base, playedSeconds: NaN }, STRICT)).toBe('hold')
  })

  it('NaN во времени воспроизведения не отменяет мгновенного отказа', () => {
    expect(triage({ ...base, hasDrm: true, playedSeconds: NaN }, BALANCED)).toBe('reject')
    expect(triage({ ...base, visible: false, playedSeconds: NaN }, BALANCED)).toBe('reject')
  })

  it('NaN в ширине отсекается: минимум не подтверждён', () => {
    expect(triage({ ...base, widthPx: NaN, playedSeconds: 60 }, BALANCED)).toBe('reject')
    expect(triage({ ...base, widthPx: NaN, playedSeconds: 60 }, LOOSE)).toBe('reject')
    expect(triage({ ...base, widthPx: NaN, playedSeconds: 60 }, STRICT)).toBe('reject')
  })

  it('NaN в ширине отсекается раньше испытательного срока', () => {
    expect(triage({ ...base, widthPx: NaN, playedSeconds: 0 }, BALANCED)).toBe('reject')
    expect(triage({ ...base, widthPx: NaN, playedSeconds: NaN }, BALANCED)).toBe('reject')
  })
})
