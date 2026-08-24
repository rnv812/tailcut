import type { PageToBridge } from '../shared/protocol'
import { installWorkerHook } from './worker-hook'

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
  // Именно копия, а не сам буфер страницы: наружу он уходит передачей и у страницы
  // отсоединяется. Плеер, который дописывает свой сегмент повторно (кеш после перемотки),
  // получил бы тогда отсоединённый буфер, а это отказ хуже исключения — appendBuffer штатно
  // резолвит updateend, не дописав ничего, и воспроизведение молча встаёт.
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
    // MediaSource, не проходивший через обёрнутый createObjectURL: адреса у него нет.
    // В этом реалме такого не бывает и тестом не воспроизводится: srcObject для MediaSource
    // здесь не работает (MediaSource.prototype.handle отсутствует, а video.srcObject =
    // mediaSource бросает TypeError), addSourceBuffer на неприсоединённом MediaSource бросает
    // InvalidStateError — значит, всё дошедшее сюда уже получило адрес. Ветка держится для
    // объектов из чужого реалма (кадр about:blank, куда хук не попал) и для браузеров, где
    // srcObject у MediaSource заработает: без адреса наблюдатель не свяжет поток с <video>,
    // но байты продолжат доезжать до моста.
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

  // Записи нет только у SourceBuffer из чужого реалма — например, если страница дёрнет этот
  // appendBuffer на объекте из кадра about:blank, куда хук не попал: свои приходят из
  // обёрнутого addSourceBuffer. Без охраны такой вызов сыпал бы TypeError из микрозадачи —
  // необъяснимой ошибкой в консоли на каждый сегмент.
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
        // Список передачи: копия принадлежит нам, и лишний проход по каждому сегменту не нужен.
        [bytes],
      )
    })
  }

  return originalAppendBuffer.call(this, data)
}

// The wrappers above see a MediaSource of this realm and nothing else. A player that builds its
// own inside a worker — twitch, both live and VOD — passes every one of these by, and the whole
// of its material with them; the worker is reached from src/page/worker-hook.ts.
installWorkerHook(send)

const originalRequestMediaKeySystemAccess = navigator.requestMediaKeySystemAccess
// Охрана обязательна: расширение объявлено на <all_urls>, а на http-страницах Chrome не отдаёт
// navigator.requestMediaKeySystemAccess вовсе. Обёртка без проверки выдумала бы возможность,
// которой у браузера нет: плееры сперва проверяют наличие метода, а потом зовут его — и вызов
// упал бы внутри обёртки, на пустом оригинале.
if (originalRequestMediaKeySystemAccess) {
  navigator.requestMediaKeySystemAccess = function (
    keySystem: string,
    configs: MediaKeySystemConfiguration[],
  ) {
    send({ type: 'tc:drm', sourceId: 'page' })
    return originalRequestMediaKeySystemAccess.call(navigator, keySystem, configs)
  }
}
