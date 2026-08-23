import { describe, it, expect, afterEach, vi } from 'vitest'
import type { TriageVerdict } from '../../src/core/triage'

/** Шаг опроса наблюдателя: столько модельного времени проходит за один tick(). */
const POLL_MS = 500

/** Прямоугольник элемента на экране; наблюдатель читает только эти поля. */
type Box = { width: number; height: number; top: number; left: number; bottom: number; right: number }

const box = (width: number, height: number): Box => ({
  width,
  height,
  top: 0,
  left: 0,
  bottom: height,
  right: width,
})

/**
 * Минимальный <video>: наблюдатель читает только перечисленное здесь. Значения по умолчанию —
 * настоящий плеер, который прямо сейчас играет; мусорные раскладки собираются переопределением.
 */
function fakeVideo(overrides: Record<string, unknown> = {}) {
  return {
    src: 'blob:player',
    currentSrc: 'blob:player',
    muted: false,
    volume: 1,
    loop: false,
    controls: true,
    paused: false,
    ended: false,
    readyState: 4,
    isConnected: true,
    mediaKeys: null,
    box: box(640, 360),
    getBoundingClientRect(): Box {
      return (this as { box: Box }).box
    },
    ...overrides,
  }
}

type FakeVideo = ReturnType<typeof fakeVideo>

/** Беззвучное зациклённое превью без панели управления — типичный баннер. */
const bannerVideo = () =>
  fakeVideo({
    src: 'blob:banner',
    currentSrc: 'blob:banner',
    muted: true,
    loop: true,
    controls: false,
    box: box(160, 90),
  })

let now = 0
let videos: FakeVideo[] = []

/** Модельная страница: живой список <video>, видимая вкладка и управляемые часы. */
function installDom(): void {
  now = 0
  videos = []

  vi.useFakeTimers()
  // Часы наблюдателя стоят отдельно от таймеров: время двигает tick(), а не сама очередь.
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    documentElement: {},
    querySelectorAll: () => videos,
  })
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  )
}

/** Прогоняет указанное число опросов, двигая часы наблюдателя вместе с таймерами. */
function tick(times = 1): void {
  for (let index = 0; index < times; index++) {
    now += POLL_MS
    vi.advanceTimersByTime(POLL_MS)
  }
}

type Reported = { sourceId: string; verdict: TriageVerdict }

/** Поднимает наблюдателя на чистом модуле и отдаёт его вместе с журналом вердиктов. */
async function startWatcher() {
  installDom()
  vi.resetModules()

  const seen: Reported[] = []
  const watcher = await import('../../src/page/watcher')
  watcher.startWatching((sourceId, verdict) => seen.push({ sourceId, verdict }))

  return { ...watcher, seen }
}

/** Ставит на страницу элемент и связывает его поток с адресом, как это делает хук. */
function place(
  watcher: { registerSource: (sourceId: string, objectUrl: string) => void },
  element: FakeVideo,
  sourceId: string,
): FakeVideo {
  videos.push(element)
  watcher.registerSource(sourceId, element.src)
  return element
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('наблюдатель: адресность вердикта', () => {
  it('отказ уходит с идентификатором того потока, чей элемент его получил', async () => {
    const watcher = await startWatcher()
    place(watcher, bannerVideo(), 's-banner')

    tick()

    expect(watcher.seen).toEqual([{ sourceId: 's-banner', verdict: 'reject' }])
  })

  it('отказ по баннеру не мешает соседнему плееру дожить до повышения', async () => {
    const watcher = await startWatcher()
    place(watcher, bannerVideo(), 's-banner')
    place(watcher, fakeVideo(), 's-player')

    tick(13)

    // Два элемента на одной странице: у каждого свой поток и свой вердикт. Вердикт без
    // адреса убил бы запись обоих — по первому же баннеру.
    expect(watcher.seen).toEqual([
      { sourceId: 's-banner', verdict: 'reject' },
      { sourceId: 's-player', verdict: 'promote' },
    ])
  })

  it('элемент с незнакомым адресом молчит, пока его поток не назвали', async () => {
    const watcher = await startWatcher()
    videos.push(bannerVideo())

    // Адрес из createObjectURL мог ещё не дойти до изолированного мира: сообщение хука
    // и опрос наблюдателя ничем не связаны.
    tick(4)
    expect(watcher.seen, 'вердикт без адресата отправлять некому').toEqual([])

    watcher.registerSource('s-banner', 'blob:banner')
    tick()

    // Вердикт с тех пор не менялся, но адресат наконец известен: промолчи наблюдатель
    // и здесь — мусорный поток остался бы в реестре навсегда.
    expect(watcher.seen).toEqual([{ sourceId: 's-banner', verdict: 'reject' }])
  })
})

describe('наблюдатель: испытательный срок', () => {
  it('повышение приходит не раньше порога сыгранного времени', async () => {
    const watcher = await startWatcher()
    place(watcher, fakeVideo(), 's1')

    // Порог сбалансированного пресета — шесть секунд; отсчёт идёт с первого опроса,
    // на котором элемент найден.
    tick(12)
    expect(watcher.seen, 'до порога плеер остаётся в ожидании').toEqual([])

    tick()
    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'promote' }])
  })

  it('на паузе время не копится', async () => {
    const watcher = await startWatcher()
    const video = place(watcher, fakeVideo({ paused: true }), 's1')

    tick(40)
    expect(watcher.seen, 'пауза не должна приближать повышение').toEqual([])

    video.paused = false
    tick(11)
    expect(watcher.seen, 'после паузы отсчёт продолжается, а не начинается заново').toEqual([])

    tick()
    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'promote' }])
  })

  it('пока вкладка скрыта, запись отклоняется и время не копится', async () => {
    const watcher = await startWatcher()
    place(watcher, fakeVideo(), 's1')
    ;(document as unknown as { visibilityState: string }).visibilityState = 'hidden'

    tick(40)

    // Скрытая вкладка — отказ, и сыгранное в ней не идёт в зачёт: десять открытых вкладок
    // с видео не должны превращаться в десять пишущих буферов.
    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'reject' }])
    ;(document as unknown as { visibilityState: string }).visibilityState = 'visible'
    tick(11)
    expect(watcher.seen.at(-1), 'время скрытой вкладки зачлось в испытательный срок').toEqual({
      sourceId: 's1',
      verdict: 'hold',
    })
  })

  it('элемент вне видимой области получает отказ', async () => {
    const watcher = await startWatcher()
    const offscreen = { width: 640, height: 360, top: 900, left: 0, bottom: 1260, right: 640 }
    place(watcher, fakeVideo({ box: offscreen }), 's1')

    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'reject' }])
  })
})

describe('наблюдатель: что уходит мосту', () => {
  it('один и тот же вердикт не повторяется', async () => {
    const watcher = await startWatcher()
    place(watcher, bannerVideo(), 's1')

    tick(40)

    // Опрос идёт дважды в секунду; повторный вердикт на каждом такте залил бы мост
    // сообщениями, а на стороне реестра ничего бы не изменил.
    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'reject' }])
  })

  it('смена вердикта уходит мосту в обе стороны', async () => {
    const watcher = await startWatcher()
    const video = place(watcher, fakeVideo(), 's1')

    tick(13)
    // Плеер увели с экрана: накопленное остаётся, но писать дальше незачем.
    video.box = { width: 640, height: 360, top: -700, left: 0, bottom: -340, right: 640 }
    tick()
    video.box = box(640, 360)
    tick()

    expect(watcher.seen).toEqual([
      { sourceId: 's1', verdict: 'promote' },
      { sourceId: 's1', verdict: 'reject' },
      { sourceId: 's1', verdict: 'promote' },
    ])
  })

  it('новый поток у того же элемента получает вердикт заново', async () => {
    const watcher = await startWatcher()
    const video = place(watcher, fakeVideo(), 's1')

    tick(13)

    // Смена качества: плеер отдаёт элементу новый MediaSource, и это новый поток со своей
    // сессией в реестре. Вердикт элемента с тех пор не менялся, но сказан он был про старый
    // поток — промолчи наблюдатель, и новый остался бы навсегда неподтверждённым.
    video.src = 'blob:player-2'
    video.currentSrc = 'blob:player-2'
    watcher.registerSource('s2', 'blob:player-2')
    tick()

    expect(watcher.seen).toEqual([
      { sourceId: 's1', verdict: 'promote' },
      { sourceId: 's2', verdict: 'promote' },
    ])
  })

  it('элемент, удалённый со страницы, больше не наблюдается', async () => {
    const watcher = await startWatcher()
    const video = place(watcher, bannerVideo(), 's1')

    tick()
    // Плеер выбросил элемент из документа. Наблюдатель, оставивший его в своём списке,
    // продолжал бы мерить выброшенный — и рано или поздно выдал бы по нему повышение.
    videos.length = 0
    video.isConnected = false
    video.box = box(640, 360)
    video.muted = false
    video.loop = false
    tick(40)

    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'reject' }])
  })

  it('DRM отменяет запись на всей странице', async () => {
    const watcher = await startWatcher()
    place(watcher, fakeVideo(), 's1')

    tick(2)
    watcher.markDrmSeen()
    tick()

    // Запрос ключей приходит от плеера, а не от элемента: связать его с конкретным <video>
    // нечем, поэтому отказ получает всё, что на странице есть.
    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'reject' }])
  })

  it('ключи, выданные самому элементу, тоже означают отказ', async () => {
    const watcher = await startWatcher()
    place(watcher, fakeVideo({ mediaKeys: {} }), 's1')

    tick()

    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'reject' }])
  })
})
