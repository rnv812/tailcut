import { BRIDGE_PATH } from '../shared/protocol'

let bridgePromise: Promise<HTMLIFrameElement> | null = null

/** Вставляет невидимый iframe с origin расширения и отдаёт его после загрузки. */
export function ensureBridge(): Promise<HTMLIFrameElement> {
  if (bridgePromise) return bridgePromise

  bridgePromise = new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.src = chrome.runtime.getURL(BRIDGE_PATH)
    iframe.dataset.tailcut = 'bridge'
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText =
      'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none;left:-9999px'

    const attach = () => {
      const root = document.documentElement
      root.appendChild(iframe)
    }

    iframe.addEventListener('load', () => resolve(iframe), { once: true })

    if (document.documentElement) attach()
    else document.addEventListener('DOMContentLoaded', attach, { once: true })
  })

  return bridgePromise
}

ensureBridge()
