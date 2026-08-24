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

/**
 * A tree a query can be run against. The document and a shadow root answer the same two questions
 * and differ in nothing else the watcher asks: `video` gives the players of that tree alone, `*`
 * every element of it — the only way to find out which of them hosts a shadow tree of its own.
 */
interface FakeRoot {
  videos: FakeVideo[]
  /** Elements of this tree, each with the shadow root it hosts; null — closed or none at all. */
  elements: Array<{ shadowRoot: FakeRoot | null }>
  querySelectorAll(selector: string): unknown[]
}

function fakeRoot(): FakeRoot {
  const videos: FakeVideo[] = []
  const elements: Array<{ shadowRoot: FakeRoot | null }> = []

  return {
    videos,
    elements,
    querySelectorAll: (selector: string) => (selector === 'video' ? videos : elements),
  }
}

let now = 0
let documentRoot: FakeRoot = fakeRoot()
let videos: FakeVideo[] = []

/**
 * Hangs an open shadow root on the page — or inside another root — and gives back its inside.
 * That is where the player of tv.apple.com plays, and a flat query over the document misses it.
 */
function attachShadow(into: FakeRoot = documentRoot): FakeRoot {
  const root = fakeRoot()
  into.elements.push({ shadowRoot: root })
  return root
}

/**
 * A host whose shadow root is closed: `element.shadowRoot` is null on it and the browser offers
 * nothing else to ask. Whatever plays inside cannot be reached from here by any means.
 */
function attachClosedShadow(into: FakeRoot = documentRoot): void {
  into.elements.push({ shadowRoot: null })
}

/** Модельная страница: живой список <video>, видимая вкладка и управляемые часы. */
function installDom(): void {
  now = 0
  documentRoot = fakeRoot()
  videos = documentRoot.videos

  vi.useFakeTimers()
  // Часы наблюдателя стоят отдельно от таймеров: время двигает tick(), а не сама очередь.
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    documentElement: {},
    querySelectorAll: (selector: string) => documentRoot.querySelectorAll(selector),
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
  root: FakeRoot = documentRoot,
): FakeVideo {
  root.videos.push(element)
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

    // The stream left behind is refused: no element plays it any more, so nothing can be measured
    // about it ever again. What it collected is not lost by that — it had been promoted, and a
    // rejection of a confirmed session is the freeze of §5.5 and keeps the material.
    expect(watcher.seen).toEqual([
      { sourceId: 's1', verdict: 'promote' },
      { sourceId: 's2', verdict: 'promote' },
      { sourceId: 's1', verdict: 'reject' },
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


describe('the watcher and the shadow DOM', () => {
  it('finds a player inside an open shadow root', async () => {
    const watcher = await startWatcher()
    place(watcher, fakeVideo(), 's1', attachShadow())

    tick(13)

    // document.querySelectorAll stops at the boundary of a shadow tree, and tv.apple.com plays a
    // 1265x712 element behind one. Unfound is unmeasured, and unmeasured is a stream the bridge
    // keeps without anybody having judged it.
    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'promote' }])
  })

  it('finds a player two shadow roots deep', async () => {
    const watcher = await startWatcher()
    place(watcher, fakeVideo(), 's1', attachShadow(attachShadow()))

    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'promote' }])
  })

  it('finds a shadow root that was attached after the watcher had started', async () => {
    const watcher = await startWatcher()
    tick(2)

    // Players build their shadow trees lazily — on the first click on a poster, on the move to
    // the next clip. attachShadow changes nothing in the DOM and fires no mutation, so a root can
    // only be noticed by looking again.
    place(watcher, fakeVideo(), 's1', attachShadow())
    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'promote' }])
  })

  it('finds a player put into a shadow root that was already there', async () => {
    const watcher = await startWatcher()
    const root = attachShadow()
    tick(2)

    place(watcher, fakeVideo(), 's1', root)
    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'promote' }])
  })

  it('judges a player in a shadow root on its own merits, not by its neighbour', async () => {
    const watcher = await startWatcher()
    place(watcher, bannerVideo(), 's-banner', attachShadow())
    place(watcher, fakeVideo(), 's-player', attachShadow())

    tick(13)

    expect(watcher.seen).toEqual([
      { sourceId: 's-banner', verdict: 'reject' },
      { sourceId: 's-player', verdict: 'promote' },
    ])
  })
})

describe('the watcher and a stream it cannot reach', () => {
  it('refuses a stream whose element is behind a closed shadow root', async () => {
    const watcher = await startWatcher()
    // A closed root gives out no reference to itself: whatever plays inside will never be
    // measured. Silence here means the bridge keeps the material of a stream nobody judged — and
    // that is how the material of a DRM page came to be offered for saving.
    attachClosedShadow()
    watcher.registerSource('s1', 'blob:hidden')

    tick()

    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'reject' }])
  })

  it('does not repeat the refusal on every poll', async () => {
    const watcher = await startWatcher()
    attachClosedShadow()
    watcher.registerSource('s1', 'blob:hidden')

    tick(40)

    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'reject' }])
  })

  it('takes the refusal back the moment the element turns up', async () => {
    const watcher = await startWatcher()
    watcher.registerSource('s1', 'blob:player')
    tick()
    expect(watcher.seen, 'setup: an unreachable stream is refused first').toEqual([
      { sourceId: 's1', verdict: 'reject' },
    ])

    // The element was late rather than hidden: the page had not attached its shadow tree yet, or
    // had not put the address on the element. What was set aside under the rejection comes back
    // whole — that is what the probation of the session store is for.
    place(watcher, fakeVideo(), 's1', attachShadow())
    tick(13)

    expect(watcher.seen).toEqual([
      { sourceId: 's1', verdict: 'reject' },
      { sourceId: 's1', verdict: 'hold' },
      { sourceId: 's1', verdict: 'promote' },
    ])
  })

  it('refuses the stream of an element that left the page', async () => {
    const watcher = await startWatcher()
    const video = place(watcher, fakeVideo(), 's1')
    tick(13)

    // The player threw the element away — the feed moved on to the next clip. Its stream stays
    // announced, and nothing measurable is playing it any more.
    videos.length = 0
    video.isConnected = false
    tick()

    expect(watcher.seen).toEqual([
      { sourceId: 's1', verdict: 'promote' },
      { sourceId: 's1', verdict: 'reject' },
    ])
  })

  it('says nothing about an element whose stream was never announced', async () => {
    const watcher = await startWatcher()
    videos.push(fakeVideo())

    tick(13)

    // The other way round: here the element is in plain sight and it is the stream that is
    // unknown. A verdict has no addressee, and one sent anyway would land on a stranger's session.
    expect(watcher.seen).toEqual([])
  })
})
