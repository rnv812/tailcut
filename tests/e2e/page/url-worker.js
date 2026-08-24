// A player worker started from an address of its own rather than from a blob. Wrapping it means
// loading it out of a blob, which moves the ground its relative addresses stand on — so it says
// out loud where it thinks it is and what its relative addresses came to.
const probes = {}

probes.location = String(self.location.href)

try {
  probes.relative = new URL('./sibling.js', self.location.href).href
} catch (error) {
  probes.relative = `throw ${String(error).slice(0, 60)}`
}

try {
  self.importScripts('./sibling.js')
  probes.sibling = self.__sibling || 'loaded, no flag'
} catch (error) {
  probes.sibling = `throw ${String(error).slice(0, 60)}`
}

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
