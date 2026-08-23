import { BRIDGE_PATH, isPageToBridge } from '../shared/protocol'
import { markDrmSeen, registerSource, startWatching } from './watcher'

let bridgePromise: Promise<HTMLIFrameElement> | null = null

/** Вставляет невидимый iframe с origin расширения и отдаёт его после загрузки. */
export function ensureBridge(): Promise<HTMLIFrameElement> {
  if (bridgePromise) return bridgePromise

  bridgePromise = new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    // Адрес — до вставки в документ: фрейм, вставленный без него, сначала грузит about:blank,
    // и слушатель ниже отдал бы промис на этой загрузке, то есть фрейм ещё без моста.
    iframe.src = chrome.runtime.getURL(BRIDGE_PATH)
    iframe.dataset.tailcut = 'bridge'
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText =
      'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none;left:-9999px'

    iframe.addEventListener(
      'load',
      () => {
        // Мост стоит на origin расширения и адреса страницы не знает: заголовок ему взять
        // неоткуда вовсе, а document.referrer у него пустеет при referrer-policy сайта.
        // Контекст уходит до resolve — иначе первые сегменты попали бы в сессию без адреса.
        iframe.contentWindow?.postMessage(
          { type: 'tc:context', url: location.href, title: document.title },
          '*',
        )
        resolve(iframe)
      },
      { once: true },
    )

    // Скрипт работает на document_start: <html> уже разобран, <head> и <body> ещё нет,
    // поэтому мост встаёт прямым ребёнком documentElement сразу. Ждать DOMContentLoaded
    // нельзя — плеер успевает открыть MediaSource и набрать сегментов раньше.
    document.documentElement.appendChild(iframe)
  })

  return bridgePromise
}

ensureBridge()

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window) return
  if (!isPageToBridge(event.data)) return

  const message = event.data

  // Наблюдателю — сразу, до ожидания моста: адрес из createObjectURL нужен ему уже на
  // ближайшем опросе, а мост к этому времени может ещё грузиться.
  if (message.type === 'tc:source') registerSource(message.sourceId, message.objectUrl)
  if (message.type === 'tc:drm') markDrmSeen()

  const iframe = await ensureBridge()

  if (message.type === 'tc:append') {
    iframe.contentWindow?.postMessage(message, '*', [message.bytes])
  } else {
    iframe.contentWindow?.postMessage(message, '*')
  }
})

// Хук в MAIN world копирует байты всегда: про DOM он не знает и знать не должен, а разбор
// на синхронном пути плеера недопустим. Решает, писать ли поток, изолированный мир — здесь,
// по сигналам элемента, — и вердикт уходит мосту адресно, с идентификатором потока. Отказ
// по одному <video> так не задевает соседнее на той же странице.
startWatching(async (sourceId, verdict) => {
  const iframe = await ensureBridge()
  iframe.contentWindow?.postMessage({ type: 'tc:verdict', sourceId, verdict }, '*')
})
