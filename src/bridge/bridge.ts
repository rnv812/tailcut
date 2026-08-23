import { isPageToBridge } from '../shared/protocol'
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

function summaries() {
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
    event.ports[0]?.postMessage(summaries())
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
window.parent.postMessage({ type: 'tc:ready' }, '*')
