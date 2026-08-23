import { isPageToBridge } from '../shared/protocol'

window.addEventListener('message', (event: MessageEvent) => {
  if (!isPageToBridge(event.data)) return

  if (event.data.type === 'tc:append') {
    const length = event.data.bytes.byteLength
    event.source?.postMessage({ type: 'tc:echo', length }, { targetOrigin: '*' })
  }
})

window.parent.postMessage({ type: 'tc:ready' }, '*')
