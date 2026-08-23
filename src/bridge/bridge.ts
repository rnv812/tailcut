import { isPageToBridge } from '../shared/protocol'

window.addEventListener('message', (event: MessageEvent) => {
  if (!isPageToBridge(event.data)) return

  if (event.data.type === 'tc:append') {
    const length = event.data.bytes.byteLength
    event.source?.postMessage({ type: 'tc:echo', length }, { targetOrigin: '*' })
  }
})

// Рукопожатие — окну своего фрейма, а не window.top: мост встаёт в каждом фрейме страницы
// (all_frames в манифесте), и для плеера во вложенном фрейме верхняя страница посторонняя —
// о мосте должен узнать тот документ, который его и вставил.
window.parent.postMessage({ type: 'tc:ready' }, '*')
