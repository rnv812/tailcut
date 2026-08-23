import { BRIDGE_PATH, isPageToBridge } from '../shared/protocol'

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

    iframe.addEventListener('load', () => resolve(iframe), { once: true })

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

  const iframe = await ensureBridge()
  const message = event.data

  if (message.type === 'tc:append') {
    iframe.contentWindow?.postMessage(message, '*', [message.bytes])
  } else {
    iframe.contentWindow?.postMessage(message, '*')
  }
})
