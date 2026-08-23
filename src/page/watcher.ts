import { triage, BALANCED, type TriageVerdict, type VideoSignals } from '../core/triage'

/** Как часто пересматриваются сигналы каждого <video>. */
const POLL_INTERVAL_MS = 500

interface Watched {
  element: HTMLVideoElement
  playedSeconds: number
  lastTick: number
  /** Что уже сказано мосту про этот элемент; null — не сказано ничего. */
  told: { sourceId: string; verdict: TriageVerdict } | null
}

const watched = new Map<HTMLVideoElement, Watched>()
/** адрес из createObjectURL → идентификатор потока */
const sourcesByUrl = new Map<string, string>()
let drmSeen = false

export function markDrmSeen(): void {
  drmSeen = true
}

export function registerSource(sourceId: string, objectUrl: string): void {
  if (objectUrl) sourcesByUrl.set(objectUrl, sourceId)
}

/**
 * Поток, чей адрес стоит у элемента. Связь односторонняя: хук в MAIN world знает только
 * адрес из createObjectURL, а какому <video> его присвоили — видно лишь отсюда.
 */
function sourceIdOf(element: HTMLVideoElement): string | null {
  return sourcesByUrl.get(element.currentSrc) ?? sourcesByUrl.get(element.src) ?? null
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

export function startWatching(onVerdict: (sourceId: string, verdict: TriageVerdict) => void): void {
  const discover = () => {
    for (const element of document.querySelectorAll('video')) {
      if (watched.has(element)) continue
      watched.set(element, {
        element,
        playedSeconds: 0,
        lastTick: performance.now(),
        told: null,
      })
    }
  }

  const tick = () => {
    discover()
    const now = performance.now()

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

      const verdict = triage(signals, BALANCED)
      const sourceId = sourceIdOf(element)
      // Адреса может ещё не быть: сообщение хука с адресом из createObjectURL и опрос
      // наблюдателя ничем не связаны. Сказать вердикт пока некому — скажем, как появится.
      if (!sourceId) continue

      // Пока мосту не сказали иного, он считает поток ожидающим, так что первое «hold» —
      // не новость. Смена адреса при том же вердикте новость: у нового потока своя судьба.
      const told = state.told ?? { sourceId, verdict: 'hold' as TriageVerdict }
      if (told.sourceId === sourceId && told.verdict === verdict) continue

      state.told = { sourceId, verdict }
      onVerdict(sourceId, verdict)
    }
  }

  tick()
  setInterval(tick, POLL_INTERVAL_MS)

  // Плееры вставляют <video> когда угодно: по клику на превью, при переходе на следующий
  // ролик, при смене раскладки. Опрос нашёл бы такой элемент и сам, но на полтакта позже.
  new MutationObserver(discover).observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
}
