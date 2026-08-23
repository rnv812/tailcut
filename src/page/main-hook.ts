import type { PageToBridge } from '../shared/protocol'

interface TrackedBuffer {
  sourceId: string
  bufferId: string
  mime: string
}

const buffers = new WeakMap<SourceBuffer, TrackedBuffer>()
const sourceIds = new WeakMap<MediaSource, string>()
let counter = 0

const nextId = (prefix: string): string => `${prefix}${++counter}`

function send(message: PageToBridge, transfer: Transferable[] = []): void {
  window.postMessage(message, '*', transfer)
}

function copyOf(data: BufferSource): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data.slice(0)

  // Только окно вида, а не весь буфер под ним. Копия делается в свой ArrayBuffer, а не срезом
  // исходного: у SharedArrayBuffer срез остаётся общим и transferable-передачу не переживёт.
  const view = data as ArrayBufferView
  const copy = new ArrayBuffer(view.byteLength)
  new Uint8Array(copy).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
  return copy
}

// Перехват нужен, чтобы связать MediaSource с конкретным <video>:
// адрес из createObjectURL попадает в video.src, и по нему наблюдатель
// в изолированном мире находит, какому элементу принадлежит поток.
const originalCreateObjectURL = URL.createObjectURL
URL.createObjectURL = function (object: Blob | MediaSource): string {
  const url = originalCreateObjectURL.call(URL, object as Blob)

  if (object instanceof MediaSource) {
    const sourceId = nextId('s')
    sourceIds.set(object, sourceId)
    send({ type: 'tc:source', sourceId, objectUrl: url })
  }

  return url
}

const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer
MediaSource.prototype.addSourceBuffer = function (mime: string): SourceBuffer {
  const sourceBuffer = originalAddSourceBuffer.call(this, mime)

  let sourceId = sourceIds.get(this)
  if (!sourceId) {
    // MediaSource, привязанный через srcObject: адреса у него нет.
    sourceId = nextId('s')
    sourceIds.set(this, sourceId)
    send({ type: 'tc:source', sourceId, objectUrl: '' })
  }

  buffers.set(sourceBuffer, { sourceId, bufferId: nextId('b'), mime })
  return sourceBuffer
}

const originalAppendBuffer = SourceBuffer.prototype.appendBuffer
SourceBuffer.prototype.appendBuffer = function (data: BufferSource): void {
  const tracked = buffers.get(this)

  if (tracked) {
    const bytes = copyOf(data)
    // Отправляем в микрозадаче: синхронный путь плеера остаётся пустым.
    queueMicrotask(() => {
      send(
        {
          type: 'tc:append',
          sourceId: tracked.sourceId,
          bufferId: tracked.bufferId,
          mime: tracked.mime,
          bytes,
        },
        [bytes],
      )
    })
  }

  return originalAppendBuffer.call(this, data)
}

const originalRequestMediaKeySystemAccess = navigator.requestMediaKeySystemAccess
if (originalRequestMediaKeySystemAccess) {
  navigator.requestMediaKeySystemAccess = function (
    keySystem: string,
    configs: MediaKeySystemConfiguration[],
  ) {
    send({ type: 'tc:drm', sourceId: 'page' })
    return originalRequestMediaKeySystemAccess.call(navigator, keySystem, configs)
  }
}
