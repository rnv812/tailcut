import { triage, BALANCED, type TriageVerdict, type VideoSignals } from '../core/triage'
import type { PlainSource } from '../shared/protocol'

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
/**
 * What has already been said about each ordinary file: see plainSourceOf.
 *
 * A plain source is re-read on every poll, twice a second for as long as the page is open, and
 * almost every reading is the same reading. What is kept here is the last one that went out, so
 * that only a change travels — the metadata arriving and turning a length of NaN into a number,
 * the download making headway and widening what the element holds.
 */
const plainTold = new Map<string, string>()

/** How a file is identified: its address, marked off from the identifiers the hook hands out. */
const PLAIN_PREFIX = 'plain:'

/**
 * The ordinary file this element is playing, or null when it is playing something else.
 *
 * "Something else" is a MediaSource, whose material is captured as it is appended and must never
 * be fetched a second time over the network; the address of one is a blob address and is refused
 * here on that ground alone. So are the addresses no ranged fetch can be made against: a data
 * url carries the material inline, a file url belongs to the disk of the person browsing, and an
 * empty one is an element the browser has not resolved an address for yet.
 *
 * Everything else — an http or https address in `currentSrc` — is a file, which is how eighteen
 * of the twenty-one live pages that delivered any video at all delivered it.
 */
function plainSourceOf(element: HTMLVideoElement): PlainSource | null {
  const url = element.currentSrc
  if (!url) return null

  try {
    const scheme = new URL(url).protocol
    if (scheme !== 'http:' && scheme !== 'https:') return null
  } catch {
    // Not an address at all: `currentSrc` is resolved by the browser and should never be
    // relative, but it is read off a page and is not ours to trust.
    return null
  }

  const buffered: Array<[number, number]> = []
  const ranges = element.buffered
  for (let i = 0; i < ranges.length; i++) buffered.push([ranges.start(i), ranges.end(i)])

  const seconds = element.duration
  return {
    sourceId: `${PLAIN_PREFIX}${url}`,
    url,
    // NaN before the metadata has arrived, Infinity on a stream with no stated end: neither is a
    // length, and both mean the same as saying nothing.
    durationSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
    buffered,
  }
}

/** Everything about a plain source that a report would carry, as one string to compare. */
function plainSignature(source: PlainSource): string {
  return `${source.durationSeconds}|${source.buffered.map((pair) => pair.join('-')).join(',')}`
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
    // Ключи, выданные самому элементу: страница присоединила к нему CDM, и что бы он ни играл
    // дальше, писать это не нужно. Отказ здесь адресный — по элементу, а не по странице; отказ
    // по всей странице выносится по самому материалу, когда в нём находится шифрование
    // (см. onEncrypted ниже и src/core/container.ts).
    hasDrm: element.mediaKeys != null,
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
  /**
   * Said once, when a media element of this page reports that what it is being fed is encrypted.
   *
   * The `encrypted` event is the stream speaking for itself: the browser fires it on finding
   * protection headers in the material, and no probing of key systems, refused or granted, can
   * bring it about. That is the whole difference from what this used to watch for — a page was
   * measured asking about sixteen key systems over a video that was in the clear, and lost its
   * entire recording for asking.
   *
   * It is a second line and not the first: the registry reads the same protection out of the
   * boxes it parses anyway (src/core/container.ts). This catches what never reaches the parser —
   * a stream in a container it does not read, or one whose bytes travel a road of their own.
   */
  onEncrypted: () => void = () => {},
  /**
   * A media element of this page is playing an ordinary file, and here is everything the page
   * knows about it: where it is, how long it is, and how much of it the browser holds.
   *
   * Said whenever any of the three changes and silent while none does. Nothing of the material
   * travels with it — there is none to travel: the browser fetched the file itself and the
   * extension never saw a byte. What is done with the address afterwards is the registry's
   * business (src/bridge/session-store.ts), and it does nothing at all until triage has promoted
   * the source: ten of the eighteen measured pages that deliver a plain file hold nothing but
   * muted looping previews, and a fetch for each of those would be the whole cost of recording
   * paid for material nobody would ever save.
   */
  onPlain: (source: PlainSource) => void = () => {},
): void {
  /** Whether the page has already been declared unrecordable. */
  let saidUnreachable = false
  /** Whether the page has already been declared protected: the refusal never turns. */
  let saidEncrypted = false

  /** Shadow roots already under observation: a weak set, so a detached tree can still be freed. */
  const observed = new WeakSet<ShadowRoot>()

  /** Puts one element under watch; one already watched keeps the time it has played. */
  const take = (video: HTMLVideoElement) => {
    if (watched.has(video)) return
    watched.set(video, { element: video, playedSeconds: 0, lastTick: performance.now() })

    // Hung on the element rather than on the document, because the event does not cross the wall
    // of a shadow tree: it is not composed, and a listener at the document would never hear the
    // player of tv.apple.com. Every element this watcher can reach is reached here, and one it
    // cannot reach is one whose stream is refused anyway (see the unclaimed streams below).
    video.addEventListener('encrypted', () => {
      if (saidEncrypted) return
      saidEncrypted = true
      onEncrypted()
    })
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
      if (sourceId) {
        claimed.add(sourceId)
        tell(sourceId, triage(signals, BALANCED))
        continue
      }

      // No stream of a MediaSource behind this element. Either it is playing an ordinary file —
      // the common case off the video platforms — or the address from createObjectURL has not
      // reached this world yet, in which case there is nobody to say a verdict to and it will be
      // said as soon as there is.
      const plain = plainSourceOf(element)
      if (!plain) continue

      // The second element playing one file adds nothing: one file is one piece of material
      // whatever it is hung on, and the fetch that reads it must not be made twice. It still
      // claims the source, or the loop below would refuse a file that is playing.
      if (claimed.has(plain.sourceId)) continue
      claimed.add(plain.sourceId)
      announced.add(plain.sourceId)

      // The source before the verdict about it, always: the two are one thing said in two
      // messages, and a rejection that arrives first is a rejection of something the other side
      // has never heard of.
      const signature = plainSignature(plain)
      if (plainTold.get(plain.sourceId) !== signature) {
        plainTold.set(plain.sourceId, signature)
        onPlain(plain)
      }

      tell(plain.sourceId, triage(signals, BALANCED))
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
