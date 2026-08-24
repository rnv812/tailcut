import { triage, BALANCED, type TriageVerdict, type VideoSignals } from '../core/triage'

/** Как часто пересматриваются сигналы каждого <video>. */
const POLL_INTERVAL_MS = 500

interface Watched {
  element: HTMLVideoElement
  playedSeconds: number
  lastTick: number
}

const watched = new Map<HTMLVideoElement, Watched>()
/** адрес из createObjectURL → идентификатор потока */
const sourcesByUrl = new Map<string, string>()
/**
 * Every stream the hook has named, addressed or not.
 *
 * A stream nobody is playing is refused (see startWatching), and to be refused it first has to be
 * known. An address is not what makes it known: a MediaSource built inside a worker has none at
 * all, and the only thing that ties it to the page is the handle its element was given.
 */
const announced = new Set<string>()
/** element → the stream out of a worker it was named as playing */
const boundSources = new WeakMap<object, string>()
/**
 * Elements playing a stream out of a worker that nothing could name, and how many polls each has
 * been in that state. See bindSource: this is the page tailcut has to refuse out loud.
 */
const unnamed = new Map<object, number>()

/**
 * How long an element is given to have its stream named before the page is called unrecordable.
 *
 * The naming crosses from the main world in the same task the handle is assigned in, or a
 * millisecond later if the worker's own message is still on its way; a second is far more than
 * either needs, and the cost of being hasty is telling the user a page cannot be recorded while
 * it is being recorded.
 */
const UNNAMED_POLLS = 2
/**
 * What the bridge has already been told about each stream.
 *
 * By stream and not by element: one element plays several streams in turn — a switch of quality
 * hands it a new MediaSource — and a stream may end up with no element to speak for it at all,
 * which is a verdict of its own (see startWatching).
 */
const told = new Map<string, TriageVerdict>()
let drmSeen = false

export function markDrmSeen(): void {
  drmSeen = true
}

/**
 * The hook has opened a MediaSource and named the address it handed the page for it.
 *
 * A stream with no address is not remembered: it is tied to nothing, and nothing here can find
 * the element playing it. It is not refused either, for the same reason — the watcher never hears
 * of it (see the unclaimed streams in startWatching). The hook only reports one for a MediaSource
 * of a realm it did not wrap; a MediaSource inside a worker has no address of its own and comes
 * in through registerWorkerSource instead, where it is remembered and can therefore be refused.
 */
export function registerSource(sourceId: string, objectUrl: string): void {
  if (!objectUrl) return
  sourcesByUrl.set(objectUrl, sourceId)
  announced.add(sourceId)
}

/**
 * The hook has opened a MediaSource inside a worker — twitch, live and VOD.
 *
 * There is no address to remember: what the page is given is a MediaSourceHandle, and on the
 * element `currentSrc` stays empty. The stream is remembered all the same, because a stream that
 * is known can be refused, and one that is not would be recorded with no verdict ever spoken
 * about it. The element playing it, if there is one, arrives separately through bindSource.
 */
export function registerWorkerSource(sourceId: string): void {
  announced.add(sourceId)
}

/**
 * The main world says which stream an element is playing.
 *
 * Only for streams out of a worker: the two worlds share the DOM and nothing else, so the hook
 * cannot hand this side a stream identifier by any other route than an event on the element
 * itself (SOURCE_EVENT in the protocol).
 *
 * An empty identifier is the other half of the message: the element is playing a handle and the
 * hook cannot say whose — its worker was never wrapped. Nothing of that stream will ever be
 * recorded, and after UNNAMED_POLLS the page is declared unrecordable rather than left looking
 * empty.
 */
export function bindSource(element: object, sourceId: string): void {
  if (!sourceId) {
    if (!boundSources.has(element)) unnamed.set(element, 0)
    return
  }

  boundSources.set(element, sourceId)
  announced.add(sourceId)
  unnamed.delete(element)
}

/**
 * Поток, чей адрес стоит у элемента. Связь односторонняя: хук в MAIN world знает только
 * адрес из createObjectURL, а какому <video> его присвоили — видно лишь отсюда.
 */
function sourceIdOf(element: HTMLVideoElement): string | null {
  return (
    boundSources.get(element) ??
    sourcesByUrl.get(element.currentSrc) ??
    sourcesByUrl.get(element.src) ??
    null
  )
}

function signalsOf(state: Watched): VideoSignals {
  const element = state.element
  const rect = element.getBoundingClientRect()
  const onScreen =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < innerHeight &&
    rect.left < innerWidth

  return {
    widthPx: Math.round(rect.width),
    muted: element.muted || element.volume === 0,
    loop: element.loop,
    controls: element.controls,
    visible: onScreen && document.visibilityState === 'visible',
    playing: !element.paused && !element.ended && element.readyState >= 2,
    playedSeconds: state.playedSeconds,
    // Запрос ключей приходит от плеера, а не от элемента, и связать его с конкретным
    // <video> нечем: DRM на странице означает отказ по всему, что на ней есть.
    hasDrm: drmSeen || element.mediaKeys != null,
  }
}

/**
 * Every open shadow root reachable from this one, the roots nested inside them included.
 *
 * A query stops at the boundary of a shadow tree, and players do live behind one: tv.apple.com
 * plays a 1265x712 element inside an open shadow root, and `document.querySelectorAll('video')`
 * finds nothing at all on that page. So the trees are gathered first and each is asked in turn.
 *
 * Every element has to be looked at, because no selector matches "a host of a shadow tree", and
 * this is also the only way to notice one: attachShadow changes nothing in the document and fires
 * no mutation, so a tree hung on an element that was there all along shows up on a poll and
 * nowhere else. That is what keeps this out of the mutation path — a walk of the whole page twice
 * a second costs a fraction of a millisecond, the same walk on every mutation of a busy page
 * would not.
 *
 * A closed shadow root cannot be entered: `element.shadowRoot` is null on its host and the browser
 * offers nothing else to ask. Whatever plays inside is never measured — and a stream nobody can
 * measure is refused rather than quietly recorded, which is settled in startWatching.
 */
function reachRoots(root: ParentNode, found: ShadowRoot[]): void {
  for (const element of root.querySelectorAll('*')) {
    const shadow = element.shadowRoot
    if (!shadow) continue
    found.push(shadow)
    reachRoots(shadow, found)
  }
}

export function startWatching(
  onVerdict: (sourceId: string, verdict: TriageVerdict) => void,
  /** Said once, when this page holds a stream no verdict can ever be spoken about. */
  onUnreachable: () => void = () => {},
): void {
  /** Whether the page has already been declared unrecordable. */
  let saidUnreachable = false

  /** Shadow roots already under observation: a weak set, so a detached tree can still be freed. */
  const observed = new WeakSet<ShadowRoot>()

  /** Puts one element under watch; one already watched keeps the time it has played. */
  const take = (video: HTMLVideoElement) => {
    if (watched.has(video)) return
    watched.set(video, { element: video, playedSeconds: 0, lastTick: performance.now() })
  }

  const takeTree = (root: ParentNode) => {
    for (const video of root.querySelectorAll('video')) take(video)
  }

  /** The whole page: the document and every open shadow tree in it, however deep. */
  const discover = () => {
    const roots: ShadowRoot[] = []
    reachRoots(document, roots)

    for (const root of roots) {
      if (!observed.has(root)) {
        observed.add(root)
        // A mutation inside a shadow tree does not reach an observer of the document: the tree is
        // a root of its own and has to be watched as one. One observer serves all of them.
        observer.observe(root, { childList: true, subtree: true })
      }
      takeTree(root)
    }

    takeTree(document)
  }

  // Плееры вставляют <video> когда угодно: по клику на превью, при переходе на следующий
  // ролик, при смене раскладки. Опрос нашёл бы такой элемент и сам, но на полтакта позже.
  // Смотрим на то, что действительно добавили, а не пересматриваем страницу целиком: на живой
  // странице мутации идут пачками десятки раз в секунду, и полный обход на каждую — это цена,
  // которую расширение по §5.5 платить не должно.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.localName === 'video') take(node as HTMLVideoElement)
        takeTree(node)
      }
    }
  })

  /** Says a verdict to the bridge unless the bridge has heard that one already. */
  const tell = (sourceId: string, verdict: TriageVerdict) => {
    // Пока мосту не сказали иного, он считает поток ожидающим, так что первое «hold» —
    // не новость.
    if ((told.get(sourceId) ?? 'hold') === verdict) return
    told.set(sourceId, verdict)
    onVerdict(sourceId, verdict)
  }

  const tick = () => {
    discover()
    const now = performance.now()
    /** Streams an element of the page is playing right now: everything else is out of reach. */
    const claimed = new Set<string>()

    for (const [element, state] of watched) {
      // Элемент, выброшенный со страницы, продолжал бы считаться живым: ссылка на него
      // держится здесь, и никакой другой уборки у наблюдателя нет.
      if (!element.isConnected) {
        watched.delete(element)
        continue
      }

      const elapsed = (now - state.lastTick) / 1000
      state.lastTick = now

      const signals = signalsOf(state)
      // Сыгранное с прошлого опроса — уже сыгранное, и в вердикт оно идёт сразу: начисли
      // его после, и порог пересекался бы опросом позже, чем на самом деле. Пауза, скрытая
      // вкладка и уход с экрана просто останавливают счётчик, не сбрасывая накопленное.
      if (signals.playing && signals.visible) {
        state.playedSeconds += elapsed
        signals.playedSeconds = state.playedSeconds
      }

      const sourceId = sourceIdOf(element)
      // Адреса может ещё не быть: сообщение хука с адресом из createObjectURL и опрос
      // наблюдателя ничем не связаны. Сказать вердикт пока некому — скажем, как появится.
      if (!sourceId) continue

      claimed.add(sourceId)
      tell(sourceId, triage(signals, BALANCED))
    }

    // A stream no element of the page is playing. The address from createObjectURL was announced,
    // so an element carrying it exists somewhere — behind a closed shadow root, on an <audio>, in
    // a document this watcher is not in, or simply not attached yet. None of them can be
    // measured, and the bridge keeps whatever it is not told to drop: silence here would mean
    // recording a stream that triage never judged. That is exactly how 149.6 MB of a page that
    // had reported DRM four times came to be offered for saving.
    //
    // A refusal costs nothing when the element does turn up. What was collected under an
    // unconfirmed rejection waits out of sight and comes back whole the moment the verdict turns
    // — see Probation in the session store.
    for (const sourceId of announced) {
      if (!claimed.has(sourceId)) tell(sourceId, 'reject')
    }

    // An element playing a stream out of a worker that nothing could name. There is no stream
    // identifier to refuse and nothing to record: the worker was never wrapped, so not one byte
    // of it was ever copied. What is left is to say so — an honest refusal beats a popup that
    // shows nothing and looks broken.
    for (const [element, polls] of unnamed) {
      if (!(element as { isConnected?: boolean }).isConnected) {
        unnamed.delete(element)
        continue
      }
      if (polls + 1 < UNNAMED_POLLS) {
        unnamed.set(element, polls + 1)
        continue
      }

      unnamed.delete(element)
      if (saidUnreachable) continue
      saidUnreachable = true
      onUnreachable()
    }
  }

  tick()
  setInterval(tick, POLL_INTERVAL_MS)
  observer.observe(document.documentElement, { childList: true, subtree: true })
}
