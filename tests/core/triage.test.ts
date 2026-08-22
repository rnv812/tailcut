import { describe, it, expect } from 'vitest'
import { triage, BALANCED, LOOSE, STRICT, type VideoSignals } from '../../src/core/triage'

const base: VideoSignals = {
  widthPx: 640,
  muted: false,
  loop: false,
  controls: true,
  visible: true,
  playing: true,
  playedSeconds: 0,
  hasDrm: false,
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

describe('triage — пауза', () => {
  it('на паузе накопленное не выбрасывается, но и не повышается', () => {
    expect(triage({ ...base, playing: false, playedSeconds: 2 }, BALANCED)).toBe('hold')
  })

  it('пауза после порога не отменяет уже заработанного повышения', () => {
    expect(triage({ ...base, playing: false, playedSeconds: 30 }, BALANCED)).toBe('promote')
  })
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
