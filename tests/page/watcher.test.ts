import { describe, it, expect, afterEach, vi } from 'vitest'
import type { TriageVerdict } from '../../src/core/triage'
import type { PlainSource, SoundSource } from '../../src/shared/protocol'
import { SETTINGS_KEY, type Settings } from '../../src/shared/settings'
import { writeSettings } from '../../src/shared/settings-store'

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
 * `HTMLMediaElement.buffered` as the watcher reads it: a length and two accessors, nothing else.
 */
function ranges(...pairs: Array<[number, number]>) {
  return {
    length: pairs.length,
    start: (index: number) => pairs[index]![0],
    end: (index: number) => pairs[index]![1],
  }
}

/**
 * Минимальный <video>: наблюдатель читает только перечисленное здесь. Значения по умолчанию —
 * настоящий плеер, который прямо сейчас играет; мусорные раскладки собираются переопределением.
 */
function fakeVideo(overrides: Record<string, unknown> = {}) {
  return {
    // What tells a picture from a soundtrack: the watcher takes both under watch and judges only
    // the first of them.
    localName: 'video',
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
    /** Unknown until the metadata has arrived — which is what a media element reports as NaN. */
    duration: NaN,
    buffered: ranges(),
    box: box(640, 360),
    getBoundingClientRect(): Box {
      return (this as { box: Box }).box
    },
    /** Listeners the watcher hangs on the element; the test fires them itself. */
    listeners: new Map<string, Array<() => void>>(),
    addEventListener(type: string, handler: () => void): void {
      const map = (this as FakeVideo).listeners
      map.set(type, [...(map.get(type) ?? []), handler])
    },
    ...overrides,
  }
}

type FakeVideo = ReturnType<typeof fakeVideo>

/** The element fires an event of its own — `encrypted` is the one the watcher listens for. */
function fire(video: FakeVideo, type: string): void {
  for (const handler of video.listeners.get(type) ?? []) handler()
}

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
  /** `<audio>` of this tree: watched like a picture and never judged like one. */
  sounds: FakeVideo[]
  /** Elements of this tree, each with the shadow root it hosts; null — closed or none at all. */
  elements: Array<{ shadowRoot: FakeRoot | null }>
  querySelectorAll(selector: string): unknown[]
}

function fakeRoot(): FakeRoot {
  const videos: FakeVideo[] = []
  const sounds: FakeVideo[] = []
  const elements: Array<{ shadowRoot: FakeRoot | null }> = []

  return {
    videos,
    sounds,
    elements,
    querySelectorAll: (selector: string) =>
      selector === 'video,audio' ? [...videos, ...sounds] : elements,
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

/** A player of a stream, measured: what the watcher says about the size of an element. */
type Player = { sourceId: string; widthPx: number }

/**
 * chrome.storage.local, and nothing else of the extension.
 *
 * Installed only for the tests that are about the settings. Everywhere else the realm has no
 * `chrome` in it at all — which is the shape this file has always run in and the shape the
 * watcher has to survive: it lives in the isolated world of an ordinary page, and a live copy of
 * the settings built as the module loads would take the whole file down at import here.
 */
function installSettings(stored: unknown): void {
  const storage: Record<string, unknown> = { [SETTINGS_KEY]: stored }
  type StorageListener = (
    changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
    area: string,
  ) => void
  const listeners: StorageListener[] = []

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (patch: Record<string, unknown>) => {
          const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {}
          for (const [key, value] of Object.entries(patch)) {
            changes[key] = { newValue: value, oldValue: storage[key] }
            storage[key] = value
          }
          for (const listener of [...listeners]) listener(changes, 'local')
        },
      },
      onChanged: {
        addListener: (listener: StorageListener) => listeners.push(listener),
        removeListener: (listener: StorageListener) => {
          listeners.splice(listeners.indexOf(listener), 1)
        },
      },
    },
  })
}

/**
 * Поднимает наблюдателя на чистом модуле и отдаёт его вместе с журналом вердиктов.
 *
 * `stored` — то, что уже лежит в chrome.storage под ключом настроек. Не передан вовсе — в реалме
 * нет и самого `chrome`.
 */
async function startWatcher(...stored: [unknown?]) {
  installDom()
  if (stored.length) installSettings(stored[0])
  vi.resetModules()

  const seen: Reported[] = []
  /**
   * Every player the watcher has measured, in the order the measurements went out. A road of its
   * own and not part of `seen`: the width is a signal of value (§7.3) and not a verdict, and it
   * has to travel when the verdict does not.
   */
  const players: Player[] = []
  /** How many times the watcher has said that this page holds a stream it cannot reach. */
  const unreachable = { times: 0 }
  /** How many times it has said that this page plays media that is encrypted. */
  const encrypted = { times: 0 }
  /** Every ordinary file the watcher has reported, in the order the reports went out. */
  const plain: PlainSource[] = []
  /** Every soundtrack the watcher has reported, in the order the reports went out. */
  const sounds: SoundSource[] = []
  /**
   * Both kinds of report in one list, tagged. A plain source and the verdict about it are two
   * messages about one thing, and the order they leave in is part of what is under test: a bridge
   * that hears a rejection before it has heard of the source has nothing to apply it to.
   */
  const order: string[] = []
  const watcher = await import('../../src/page/watcher')
  watcher.startWatching(
    (sourceId, verdict) => {
      seen.push({ sourceId, verdict })
      order.push(`verdict ${sourceId} ${verdict}`)
    },
    () => unreachable.times++,
    () => encrypted.times++,
    (source) => {
      plain.push(source)
      order.push(`plain ${source.sourceId}`)
    },
    (source) => {
      sounds.push(source)
      order.push(`sound ${source.sourceId}`)
    },
    (sourceId, widthPx) => players.push({ sourceId, widthPx }),
  )

  // The live copy answers the defaults until the first read of storage comes back, a turn or two
  // after start-up. Given here so that a test about a stored setting is about that setting and
  // not about which of the two landed first.
  for (let turn = 0; turn < 4; turn++) await Promise.resolve()

  return {
    ...watcher,
    seen,
    players,
    unreachable,
    encrypted,
    plain,
    sounds,
    order,
    /** Moves a setting the way the settings page does, from another document. */
    async setSettings(edit: (current: Settings) => Settings): Promise<void> {
      await writeSettings(edit)
      for (let turn = 0; turn < 4; turn++) await Promise.resolve()
    },
  }
}

/**
 * An element playing a stream out of a worker: it carries a MediaSourceHandle and no address at
 * all. Measured on twitch — `video.currentSrc` is empty on both the live page and the VOD one.
 */
const handleVideo = (overrides: Record<string, unknown> = {}) =>
  fakeVideo({ src: '', currentSrc: '', ...overrides })

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


describe('the watcher and a MediaSource in a worker', () => {
  it('refuses a stream out of a worker until an element is seen to play it', async () => {
    const watcher = await startWatcher()
    // A MediaSource built in a worker has no address: nothing here can find the element playing
    // it, and until the main world names one the stream is out of reach. Silence would mean the
    // registry keeping material no verdict was ever spoken about.
    watcher.registerWorkerSource('w1s1')

    tick()

    expect(watcher.seen).toEqual([{ sourceId: 'w1s1', verdict: 'reject' }])
  })

  it('judges the element the stream was named on', async () => {
    const watcher = await startWatcher()
    const video = handleVideo()
    videos.push(video)
    watcher.registerWorkerSource('w1s1')
    watcher.bindSource(video as unknown as HTMLMediaElement, 'w1s1')

    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: 'w1s1', verdict: 'promote' }])
  })

  it('takes the name even before the stream is announced', async () => {
    const watcher = await startWatcher()
    const video = handleVideo()
    videos.push(video)
    // The name comes as an event on the element and the announcement as a message through the
    // page: two channels, and neither is behind the other by anything but chance.
    watcher.bindSource(video as unknown as HTMLMediaElement, 'w1s1')

    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: 'w1s1', verdict: 'promote' }])
  })

  it('judges a banner in a worker as a banner', async () => {
    const watcher = await startWatcher()
    const banner = handleVideo({ muted: true, loop: true, controls: false, box: box(160, 90) })
    videos.push(banner)
    watcher.bindSource(banner as unknown as HTMLMediaElement, 'w1s1')

    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: 'w1s1', verdict: 'reject' }])
  })

  it('says the page cannot be recorded when the stream has no name at all', async () => {
    const watcher = await startWatcher()
    const video = handleVideo()
    videos.push(video)
    // An empty name is what a worker the hook was not allowed to wrap looks like from here: the
    // element is playing a handle and nothing can say whose. An empty popup would look broken;
    // the user is told instead.
    watcher.bindSource(video as unknown as HTMLMediaElement, '')

    tick(4)

    expect(watcher.unreachable.times).toBe(1)
    expect(watcher.seen, 'there is no stream to speak about, so no verdict is spoken').toEqual([])
  })

  it('does not say it twice', async () => {
    const watcher = await startWatcher()
    const video = handleVideo()
    videos.push(video)
    watcher.bindSource(video as unknown as HTMLMediaElement, '')

    tick(40)

    expect(watcher.unreachable.times).toBe(1)
  })

  it('says nothing when the name arrives right after the element', async () => {
    const watcher = await startWatcher()
    const video = handleVideo()
    videos.push(video)
    // The assignment is announced without a name first and named a moment later: both come from
    // the main world, and the naming waits for the worker's own message.
    watcher.bindSource(video as unknown as HTMLMediaElement, '')
    watcher.bindSource(video as unknown as HTMLMediaElement, 'w1s1')

    tick(13)

    expect(watcher.unreachable.times).toBe(0)
    expect(watcher.seen).toEqual([{ sourceId: 'w1s1', verdict: 'promote' }])
  })
})

describe('the watcher and a stream that carries protection', () => {
  it('says so for the page when an element fires `encrypted`', async () => {
    const watcher = await startWatcher()
    const video = place(watcher, fakeVideo(), 's1')

    tick(2)
    expect(watcher.encrypted.times, 'nothing has said this page is protected yet').toBe(0)

    // The element is being fed material that carries protection, and it is the element that says
    // so — not the page announcing an intention. A request for a key system means nothing here:
    // a news article was measured making sixteen of them over a video that was in the clear.
    fire(video, 'encrypted')

    expect(watcher.encrypted.times).toBe(1)
  })

  it('says it once, however many elements of the page fire it', async () => {
    const watcher = await startWatcher()
    const first = place(watcher, fakeVideo(), 's1')
    const second = place(watcher, fakeVideo({ src: 'blob:two', currentSrc: 'blob:two' }), 's2')

    tick()
    fire(first, 'encrypted')
    fire(second, 'encrypted')
    fire(first, 'encrypted')

    // The refusal covers the whole page and never turns, so the second telling changes nothing.
    // A protected player fires this for every initialisation header of its stream.
    expect(watcher.encrypted.times).toBe(1)
  })

  it('hears it from a player inside an open shadow root', async () => {
    const watcher = await startWatcher()
    const video = place(watcher, fakeVideo(), 's1', attachShadow())

    // The layout of tv.apple.com, where no verdict is ever spoken about the element and the
    // material of a protected page was left in the registry to be offered for saving.
    tick()
    fire(video, 'encrypted')

    expect(watcher.encrypted.times).toBe(1)
  })

  it('says nothing of the sort about a page that plays in the clear', async () => {
    const watcher = await startWatcher()
    place(watcher, fakeVideo(), 's1')

    tick(13)

    expect(watcher.encrypted.times).toBe(0)
    expect(watcher.seen).toEqual([{ sourceId: 's1', verdict: 'promote' }])
  })
})

/**
 * The address a plain file is reported under. It is derived from the address of the file and
 * nothing else, so the test says it the way the watcher does rather than reading it back out of
 * the report it is checking.
 */
const CLIP_URL = 'https://cdn.example/clip.mp4'
const CLIP_ID = `plain:${CLIP_URL}`

/**
 * A <video> playing an ordinary file: an http address in currentSrc, no MediaSource anywhere.
 * Eighteen of the twenty-one live pages where video arrived at all look like this.
 */
const plainVideo = (overrides: Record<string, unknown> = {}) =>
  fakeVideo({ src: CLIP_URL, currentSrc: CLIP_URL, duration: 9.48, ...overrides })

/** The same file as a muted looping preview with no controls: ten of those eighteen pages. */
const plainBanner = (overrides: Record<string, unknown> = {}) =>
  plainVideo({ muted: true, loop: true, controls: false, box: box(160, 90), ...overrides })

/** Puts an element on the page without naming any stream for it: a plain file has none. */
function stand(element: FakeVideo, root: FakeRoot = documentRoot): FakeVideo {
  root.videos.push(element)
  return element
}

describe('the watcher and an ordinary file', () => {
  it('reports the address of a file an element is playing', async () => {
    const watcher = await startWatcher()
    stand(plainVideo({ buffered: ranges([0, 3.2]) }))

    tick()

    // Everything the page knows about the file and nothing the extension had to fetch to learn:
    // the address to read it from, the length the element measured out of the metadata, and the
    // stretch the browser is already holding.
    expect(watcher.plain).toEqual([
      { sourceId: CLIP_ID, url: CLIP_URL, durationSeconds: 9.48, buffered: [[0, 3.2]] },
    ])
  })

  it('goes through the same filter: a muted looping preview served as a file is refused', async () => {
    const watcher = await startWatcher()
    stand(plainBanner())

    tick(40)

    // Ten of the eighteen pages that deliver a plain file hold nothing but these — hover previews
    // and three-second animations. Triage rejects them today over MSE and must go on rejecting
    // them when the same material arrives as a file.
    expect(watcher.seen).toEqual([{ sourceId: CLIP_ID, verdict: 'reject' }])
  })

  it('promotes a file that was actually watched, like any other source', async () => {
    const watcher = await startWatcher()
    stand(plainVideo())

    tick(12)
    expect(watcher.seen, 'the grace period is the same six seconds').toEqual([])

    tick()
    expect(watcher.seen).toEqual([{ sourceId: CLIP_ID, verdict: 'promote' }])
  })

  it('reports the source before it says anything about it', async () => {
    const watcher = await startWatcher()
    stand(plainBanner())

    tick()

    // The two are one thing said in two messages, and a rejection that arrives first is a
    // rejection of a source the other side has never heard of.
    expect(watcher.order).toEqual([`plain ${CLIP_ID}`, `verdict ${CLIP_ID} reject`])
  })

  it('says nothing about an element playing a MediaSource', async () => {
    const watcher = await startWatcher()
    place(watcher, fakeVideo(), 's1')

    tick(13)

    // A blob address is the address of a MediaSource, and that material is captured as it is
    // appended. Reported as a file it would be fetched a second time, over the network, whole.
    expect(watcher.plain).toEqual([])
  })

  it.each([
    ['a data url', 'data:video/mp4;base64,AAAA'],
    ['a file of the disk', 'file:///home/someone/clip.mp4'],
    ['an address the browser has not resolved', ''],
    ['something that is not an address at all', 'clip.mp4'],
  ])('says nothing about %s', async (_name, currentSrc) => {
    const watcher = await startWatcher()
    stand(fakeVideo({ src: currentSrc, currentSrc }))

    tick(13)

    expect(watcher.plain).toEqual([])
  })

  it('does not repeat itself while the page knows nothing new', async () => {
    const watcher = await startWatcher()
    stand(plainVideo({ buffered: ranges([0, 9.48]) }))

    tick(40)

    // The poll runs twice a second for as long as the page is open. A report per poll would be a
    // message a second per plain video on the page, saying the same thing every time.
    expect(watcher.plain).toHaveLength(1)
  })

  it('says it again when the metadata finally arrives', async () => {
    const watcher = await startWatcher()
    const video = stand(plainVideo({ duration: NaN }))

    tick()
    expect(watcher.plain[0]?.durationSeconds, 'an unmeasured length is no length').toBe(0)

    video.duration = 9.48
    tick()

    expect(watcher.plain).toHaveLength(2)
    expect(watcher.plain[1]?.durationSeconds).toBe(9.48)
  })

  it('says it again when the download makes headway', async () => {
    const watcher = await startWatcher()
    const video = stand(plainVideo({ buffered: ranges([0, 2]) }))

    tick()
    video.buffered = ranges([0, 5.5])
    tick()
    video.buffered = ranges([0, 5.5], [7, 9.48])
    tick()

    expect(watcher.plain.map((source) => source.buffered)).toEqual([
      [[0, 2]],
      [[0, 5.5]],
      [
        [0, 5.5],
        [7, 9.48],
      ],
    ])
  })

  it('treats a live stream of no stated end as a length it does not know', async () => {
    const watcher = await startWatcher()
    stand(plainVideo({ duration: Infinity }))

    tick()

    expect(watcher.plain[0]?.durationSeconds).toBe(0)
  })

  it('gives two elements playing one file one identity', async () => {
    const watcher = await startWatcher()
    stand(plainVideo())
    stand(plainVideo())

    tick(13)

    // One file is one piece of material however many elements the page hangs it on, and the
    // fetch that reads it must not be made twice.
    expect(watcher.plain).toHaveLength(1)
    expect(watcher.seen).toEqual([{ sourceId: CLIP_ID, verdict: 'promote' }])
  })

  it('judges one file by the element playing it and not by the first on the page', async () => {
    const watcher = await startWatcher()

    // A page that shows one file twice. Measured on https://www.w3schools.com/html/html5_video.asp:
    // an example with a control panel stands above, an autoplay example below it, and both point
    // at mov_bbb.mp4. Whichever the reader starts, the file is the same file — but the account of
    // it used to be taken from whichever element the walk of the page reached first.
    stand(plainVideo({ paused: true, buffered: ranges() }))
    stand(plainVideo({ buffered: ranges([0, 9.48]) }))

    tick(13)

    expect(watcher.seen, 'the element that was never started spoke for the file').toEqual([
      { sourceId: CLIP_ID, verdict: 'promote' },
    ])
    // And what is offered is what the element that played it holds, not what the idle copy does.
    expect(watcher.plain.at(-1)?.buffered).toEqual([[0, 9.48]])
  })

  it('does not let a copy nobody can see refuse the file being watched', async () => {
    const watcher = await startWatcher()

    // The same file in a carousel slide scrolled off the screen, and again in the player the
    // reader is watching. An unmeasurable copy is rightly refused; refusing the file itself over
    // it would take the recording away from the element that earned it.
    stand(
      plainVideo({
        box: { width: 640, height: 360, top: 1200, left: 0, bottom: 1560, right: 640 },
      }),
    )
    stand(plainVideo({ buffered: ranges([0, 9.48]) }))

    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: CLIP_ID, verdict: 'promote' }])
  })

  it('does not let a wide banner speak for the file the narrow player is playing', async () => {
    const watcher = await startWatcher()

    // A page shaped the way the rule is written against: a mute autoplaying loop across the whole
    // width of it, and below that the player the reader started, at the smallest size triage will
    // take at all. Both point at the same file.
    //
    // Which of them speaks is decided by the verdict and the watching, and by nothing else — the
    // width is deliberately no part of it (see Standing in the watcher). Let size in and this
    // page is the case that breaks: the banner is six times the player and is refused outright as
    // decoration, so the account of the file would become its account, and a file that is being
    // watched right now would be refused instead of recorded.
    stand(plainBanner({ box: box(1920, 1080) }))
    stand(plainVideo({ buffered: ranges([0, 9.48]), box: box(320, 180) }))

    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: CLIP_ID, verdict: 'promote' }])
    // And the size that goes out is the player's. One file, one account of it: a width taken from
    // the banner would describe an element nobody watched (§7.3).
    expect(watcher.players).toEqual([{ sourceId: CLIP_ID, widthPx: 320 }])
  })

  it('refuses the file an element has moved on from', async () => {
    const watcher = await startWatcher()
    const video = stand(plainVideo())
    tick(13)

    const next = 'https://cdn.example/next.mp4'
    video.src = next
    video.currentSrc = next
    tick()

    // The feed moved to the next clip. Nothing plays the first file any more, so nothing about it
    // can be measured — and a source nobody can measure is refused rather than kept on trust.
    expect(watcher.seen).toEqual([
      { sourceId: CLIP_ID, verdict: 'promote' },
      { sourceId: `plain:${next}`, verdict: 'promote' },
      { sourceId: CLIP_ID, verdict: 'reject' },
    ])
  })

  it('finds a file playing inside an open shadow root', async () => {
    const watcher = await startWatcher()
    stand(plainVideo(), attachShadow())

    tick(13)

    expect(watcher.plain).toHaveLength(1)
    expect(watcher.seen).toEqual([{ sourceId: CLIP_ID, verdict: 'promote' }])
  })
})

/** The soundtrack the page plays beside the picture: seven times as long, on a cycle of its own. */
const TRACK_URL = 'https://cdn.example/track.mp3'
const TRACK_ID = `sound:${TRACK_URL}`

/**
 * An `<audio>` playing that soundtrack.
 *
 * No box on the screen, which is the whole reason a soundtrack can never be judged like a
 * picture: triage weighs an element by how wide it is, and this is nought by nought.
 */
const soundElement = (overrides: Record<string, unknown> = {}) =>
  fakeVideo({
    localName: 'audio',
    src: TRACK_URL,
    currentSrc: TRACK_URL,
    duration: 66.35,
    loop: true,
    box: box(0, 0),
    buffered: ranges([0, 66.35]),
    ...overrides,
  })

/** Puts a soundtrack on the page beside whatever pictures are already there. */
function play(element: FakeVideo, root: FakeRoot = documentRoot): FakeVideo {
  root.sounds.push(element)
  return element
}

/** The picture half of such a page: short, silent, looping, and drawn by the site's own controls. */
const loopingPicture = (overrides: Record<string, unknown> = {}) =>
  plainVideo({ muted: true, loop: true, controls: false, duration: 9.48, ...overrides })

describe('the watcher and a page that plays its sound apart from its picture', () => {
  it('reports the soundtrack an <audio> is playing', async () => {
    const watcher = await startWatcher()
    play(soundElement())

    tick()

    expect(watcher.sounds).toEqual([
      {
        sourceId: TRACK_ID,
        url: TRACK_URL,
        durationSeconds: 66.35,
        buffered: [[0, 66.35]],
        playing: true,
      },
    ])
  })

  it('never judges it and never offers it as a recording of its own', async () => {
    const watcher = await startWatcher()
    play(soundElement())

    tick(20)

    // Ten seconds of playing and not one verdict, because there is nothing to judge: a file of
    // somebody's music with no picture is not a clip of anything. It is also never a plain
    // source, which is what would have made it a session.
    expect(watcher.seen).toEqual([])
    expect(watcher.plain).toEqual([])
  })

  it('says a track that is standing still is not playing', async () => {
    const watcher = await startWatcher()
    play(soundElement({ paused: true }))

    tick()

    // A page holds `<audio>` that never plays — a notification, a hover sound — and one of those
    // says nothing at all about the picture beside it.
    expect(watcher.sounds.at(-1)?.playing).toBe(false)
  })

  it('does not repeat itself while the page knows nothing new', async () => {
    const watcher = await startWatcher()
    play(soundElement())

    tick(20)

    expect(watcher.sounds).toHaveLength(1)
  })

  it('says it again when the track starts or stops', async () => {
    const watcher = await startWatcher()
    const sound = play(soundElement({ paused: true }))

    tick()
    sound.paused = false
    tick()

    expect(watcher.sounds.map((one) => one.playing)).toEqual([false, true])
  })

  it('records the looping silent picture beside it, which alone would be a banner', async () => {
    const watcher = await startWatcher()
    stand(loopingPicture())
    play(soundElement())

    tick(13)

    // Muted, looping, no controls: the shape of a banner, and refused as one on every ordinary
    // page. Here the sound of the page is simply in the other element, and the two together are
    // the work (§5.6).
    expect(watcher.seen).toEqual([{ sourceId: CLIP_ID, verdict: 'promote' }])
  })

  it('keeps that picture when the sound is paused, rather than calling it a banner again', async () => {
    const watcher = await startWatcher()
    stand(loopingPicture())
    const sound = play(soundElement())

    tick(13)
    sound.paused = true
    tick(4)

    // §5.5: a pause freezes a recording and does not erase one. Read live, a page whose viewer
    // has just paused it to open the popup is a silent page, the looping picture is a banner
    // again, and the session goes out from under the popup that was opened to save it.
    expect(watcher.seen).toEqual([{ sourceId: CLIP_ID, verdict: 'promote' }])
    // And the pause itself is reported, because the registry pairs on what is playing where it
    // can and on what has played where it cannot.
    expect(watcher.sounds.map((one) => one.playing)).toEqual([true, false])
  })

  it('goes on refusing a banner on a page whose sound is standing still', async () => {
    const watcher = await startWatcher()
    stand(plainBanner())
    play(soundElement({ paused: true }))

    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: CLIP_ID, verdict: 'reject' }])
  })

  it('finds a soundtrack inside an open shadow root', async () => {
    const watcher = await startWatcher()
    stand(loopingPicture())
    play(soundElement(), attachShadow())

    tick(13)

    expect(watcher.sounds).toHaveLength(1)
    expect(watcher.seen).toEqual([{ sourceId: CLIP_ID, verdict: 'promote' }])
  })

  it('gives two elements playing one track one identity', async () => {
    const watcher = await startWatcher()
    play(soundElement())
    play(soundElement({ paused: true }))

    tick()

    // One track is one track however many elements the page hangs it on, and the one that is
    // playing speaks for it: a paused copy must not make the page look silent.
    expect(watcher.sounds).toHaveLength(1)
    expect(watcher.sounds[0]?.playing).toBe(true)
  })

  it('drops the element of a soundtrack that left the page', async () => {
    const watcher = await startWatcher()
    stand(loopingPicture())
    const sound = play(soundElement())

    tick(13)
    sound.isConnected = false
    documentRoot.sounds.length = 0
    tick(4)

    // The element is gone and nothing is reported for it any more. The picture keeps what it
    // earned: the page did play its sound apart, and a torn-down element does not unmake that.
    expect(watcher.sounds).toHaveLength(1)
    expect(watcher.seen).toEqual([{ sourceId: CLIP_ID, verdict: 'promote' }])
  })
})

describe('the watcher and the size of the player', () => {
  it('reports the player of a stream before any verdict about it is spoken', async () => {
    const watcher = await startWatcher()
    place(watcher, fakeVideo({ box: box(1024, 576) }), 's-player')

    tick()

    // The first poll, half a second in, and long before the promotion at six. That is the whole
    // point of the separate road: a site that hands over its material at once has written the
    // session to disk by then, and a width that arrived with the promotion would arrive after
    // the last piece it could have been written on.
    expect(watcher.players).toEqual([{ sourceId: 's-player', widthPx: 1024 }])
    expect(watcher.seen, 'the grace period is still six seconds').toEqual([])
  })

  it('says it once and then only when the player grows', async () => {
    const watcher = await startWatcher()
    const video = place(watcher, fakeVideo({ box: box(640, 360) }), 's-player')

    tick(4)
    expect(watcher.players).toEqual([{ sourceId: 's-player', widthPx: 640 }])

    // The user opens the video full screen and puts it back into the corner of the page. It was
    // watched full screen, and the corner says nothing about what it was worth (§7.3) — so the
    // growth is news and the shrinking is not.
    video.box = box(1920, 1080)
    tick(2)
    video.box = box(320, 180)
    tick(2)

    expect(watcher.players).toEqual([
      { sourceId: 's-player', widthPx: 640 },
      { sourceId: 's-player', widthPx: 1920 },
    ])
  })

  it('measures the player of a stream it is refusing as readily as one it keeps', async () => {
    const watcher = await startWatcher()
    place(watcher, bannerVideo(), 's-banner')

    tick()

    // A rejection is a freeze and not an erasure (§5.5): the session goes on existing, and how
    // big the player was is a fact about it whichever way the verdict went.
    expect(watcher.players).toEqual([{ sourceId: 's-banner', widthPx: 160 }])
    expect(watcher.seen).toEqual([{ sourceId: 's-banner', verdict: 'reject' }])
  })

  it('claims no size for a stream whose element it never found', async () => {
    const watcher = await startWatcher()
    attachClosedShadow()
    watcher.registerSource('s-hidden', 'blob:hidden')

    tick(40)

    // Nothing was measured, and a made-up number here would be a signal of value read off an
    // element the watcher cannot even see.
    expect(watcher.players).toEqual([])
    expect(watcher.seen).toEqual([{ sourceId: 's-hidden', verdict: 'reject' }])
  })

  it('gives the size of the element that speaks for an ordinary file', async () => {
    const watcher = await startWatcher()
    // One file, two elements: a thumbnail of it above, and the player the reader started. The
    // verdict is taken from the element that is playing (see outranks), and so is the size — or
    // the file would be described by a copy nobody watched.
    stand(plainVideo({ paused: true, buffered: ranges(), box: box(160, 90) }))
    stand(plainVideo({ buffered: ranges([0, 9.48]), box: box(1024, 576) }))

    tick(13)

    // Once, and with the size of the player: the thumbnail stands first on the page and would be
    // measured first, but it never takes the floor — an element triage refuses cannot speak for a
    // file an element beside it is playing.
    expect(watcher.players).toEqual([{ sourceId: CLIP_ID, widthPx: 1024 }])
  })
})

describe('the watcher judges by the settings of §9.4', () => {
  it('watches a page with no extension around it at all', async () => {
    // The isolated world of an ordinary page has chrome.storage; this realm has nothing. A live
    // copy of the settings built beside the module's constants is built in every context that
    // imports the file, and a throw there is not a failing assertion but a file that cannot be
    // imported — so the copy is made where the watching starts, and it answers the defaults when
    // there is no storage to read.
    expect((globalThis as { chrome?: unknown }).chrome, 'setup: this realm has no chrome').toBe(
      undefined,
    )

    const watcher = await startWatcher()
    place(watcher, fakeVideo(), 's-player')
    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: 's-player', verdict: 'promote' }])
  })

  it('refuses a player the tightened filter no longer counts as one', async () => {
    // The same element the balanced preset promotes, under a filter that asks for a wider one.
    // 640 pixels of player against a floor of a thousand: it is not that the element changed.
    const watcher = await startWatcher({
      detection: { gracePeriodSeconds: 6, minWidthPx: 1000, recordMuted: false },
    })
    place(watcher, fakeVideo(), 's-player')
    tick(13)

    expect(watcher.seen).toEqual([{ sourceId: 's-player', verdict: 'reject' }])
  })

  it('promotes what the loosened filter lets through', async () => {
    // A small player with controls on it, playing with sound: the balanced preset refuses it for
    // its width alone, and a user who loosened the filter meant exactly this.
    const watcher = await startWatcher({
      detection: { gracePeriodSeconds: 0, minWidthPx: 200, recordMuted: true },
    })
    place(watcher, fakeVideo({ box: box(240, 135) }), 's-small')
    tick(2)

    expect(watcher.seen.at(-1)).toEqual({ sourceId: 's-small', verdict: 'promote' })
  })

  it('takes a preset moved while a video is playing at the very next poll', async () => {
    const watcher = await startWatcher({})
    place(watcher, fakeVideo(), 's-player')
    tick(13)
    expect(watcher.seen, 'setup: the default preset promotes this player').toEqual([
      { sourceId: 's-player', verdict: 'promote' },
    ])

    // The user tightens the filter over a page full of banners and expects those banners to stop
    // being recorded now — not after a reload. What has already been promoted is not demoted by
    // it: the verdict travels, and §5.5 is kept by the registry, which protects a confirmed
    // session from a later rejection.
    await watcher.setSettings((current) => ({
      ...current,
      detection: { ...current.detection, minWidthPx: 1000 },
    }))
    tick()

    expect(watcher.seen.at(-1)).toEqual({ sourceId: 's-player', verdict: 'reject' })
  })

  it('judges an ordinary file by the same settings as a stream', async () => {
    // The other road a verdict travels: a <video src="…mp4"> with no MediaSource anywhere. Both
    // calls to triage are inside one poll, and a filter that reached one of them and not the
    // other would record what the user forbade on every page outside the video platforms.
    const watcher = await startWatcher({
      detection: { gracePeriodSeconds: 6, minWidthPx: 1000, recordMuted: false },
    })
    videos.push(fakeVideo({ src: '', currentSrc: 'https://cdn.example/clip.mp4', duration: 12 }))
    tick(13)

    expect(watcher.seen).toEqual([
      { sourceId: 'plain:https://cdn.example/clip.mp4', verdict: 'reject' },
    ])
  })
})
