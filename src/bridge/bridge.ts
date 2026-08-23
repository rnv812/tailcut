import { isPageToBridge, type BridgeToPage, type SessionSummary } from '../shared/protocol'
import { SessionStore } from './session-store'

const store = new SessionStore()

interface PageContext {
  url: string
  title: string
}

/**
 * Мост живёт на origin расширения и адреса страницы, которая его вставила, сам не знает.
 * До первого tc:context остаётся referrer: он есть не всегда, но лучше пустой строки.
 */
let pageContext: PageContext = { url: document.referrer, title: '' }

function summaries(): SessionSummary[] {
  return store.list().map((s) => ({
    key: s.key,
    url: s.url,
    title: s.title,
    duration: s.map.duration(),
    bytes: s.map.totalBytes(),
    runs: s.map.runs().length,
  }))
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data

  if (data?.type === 'tc:context') {
    pageContext = { url: String(data.url), title: String(data.title) }
    return
  }

  // Запросы от попапа приходят через порт: chrome.runtime.sendMessage
  // до этого iframe не доходит, он адресуется content script'у.
  if (data?.type === 'tc:list') {
    // Через объявленный союз, а не напрямую: postMessage принимает что угодно, и молча
    // разошедшийся с BridgeToPage ответ обнаружился бы только у получателя.
    const reply: BridgeToPage = summaries()
    event.ports[0]?.postMessage(reply)
    return
  }

  // Вердикт отбора выносит content script по сигналам <video>: хук в MAIN world копирует
  // байты всегда, а решать, что из них остаётся, — работа изолированного мира. Вердикт
  // адресный, поэтому и отказ действует ровно на свой источник.
  if (data?.type === 'tc:verdict') {
    const sourceId = String(data.sourceId)
    if (data.verdict === 'reject') store.dropPending(sourceId)
    if (data.verdict === 'hold') store.resumePending(sourceId)
    if (data.verdict === 'promote') store.promotePending(sourceId)
    return
  }

  if (!isPageToBridge(data)) return

  if (data.type === 'tc:append') {
    store.append({
      sourceId: data.sourceId,
      url: pageContext.url,
      title: pageContext.title,
      bytes: new Uint8Array(data.bytes),
      now: Date.now(),
    })
  }
})

// Рукопожатие — окну своего фрейма, а не window.top: мост встаёт в каждом фрейме страницы
// (all_frames в манифесте), и для плеера во вложенном фрейме верхняя страница посторонняя —
// о мосте должен узнать тот документ, который его и вставил.
const handshake: BridgeToPage = { type: 'tc:ready' }
window.parent.postMessage(handshake, '*')
