// The same player worker as a module — the shape `new Worker(new URL('./w.js', import.meta.url),
// { type: 'module' })` emits. A module keeps its own address for its own imports even when it is
// loaded from inside a blob, and `import.meta.url` says whether that held.
import './sibling.mjs'

const probes = {}
probes.location = String(self.location.href)
probes.importMeta = import.meta.url
probes.sibling = self.__sibling || 'not loaded'

self.addEventListener('message', async (event) => {
  if (!event.data || event.data.type !== 'play') return

  try {
    const response = await fetch('probe')
    probes.fetch = `${response.url} ${response.status}`
  } catch (error) {
    probes.fetch = `throw ${String(error).slice(0, 60)}`
  }

  const source = new MediaSource()
  const handle = source.handle
  self.postMessage({ type: 'handle', handle }, [handle])

  source.addEventListener('sourceopen', async () => {
    const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.4d401e"')
    for (const bytes of event.data.segments) {
      await new Promise((done) => {
        buffer.addEventListener('updateend', done, { once: true })
        buffer.appendBuffer(bytes)
      })
    }
    self.postMessage({ type: 'done', probes })
  })
})
