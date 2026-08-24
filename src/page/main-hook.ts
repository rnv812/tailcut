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

// The length of the whole video, as the page states it on its MediaSource once it has read its
// manifest. It is the third component of the merge key (§6.1) and the one thing that tells two
// videos of a feed apart where the address cannot: measured on tiktok.com/foryou, whose address
// stays «https://www.tiktok.com/foryou» through a whole scroll — seven clips, a MediaSource each,
// came out as one session and one file that Chromium stopped playing at 2.28 seconds.
//
// What the page states, and never what the browser works out. Left unset, MSE grows the duration
// to the end of whatever has been buffered, so a value read off the media element would climb with
// every segment and move the session to a new key on every poll of the watcher.
//
// A MediaSource built inside a worker is not covered here and is left keyed by its address and its
// codecs: the shim in worker-hook.ts crosses realms as text and every line of it is a line that
// can take a page's player down, and the one site measured to use one plays live, where there is
// no length to state.
const durationProperty = Object.getOwnPropertyDescriptor(MediaSource.prototype, 'duration')
if (durationProperty?.set && durationProperty.get) {
  const declare = durationProperty.set
  const read = durationProperty.get

  Object.defineProperty(MediaSource.prototype, 'duration', {
    configurable: true,
    enumerable: durationProperty.enumerable,
    get: read,
    set(this: MediaSource, value: number) {
      // The browser first, and nothing before it: the setter throws on a source that is not open
      // and on a buffer still updating, and the page has to feel that exactly as it would without
      // us. Told about a length the page never managed to set, the registry would key a session
      // by a number that is not true of it.
      declare.call(this, value)

      const sourceId = sourceIds.get(this)
      if (!sourceId) return

      // Read back rather than passed on: what the source now holds is what the element will
      // report, and the setter coerces what it was given.
      const seconds = read.call(this) as number
      // Infinity is a live stream, NaN is a length the player has cleared: neither says anything
      // a key could be built on, and both mean the same as never having been told.
      if (Number.isFinite(seconds) && seconds > 0) send({ type: 'tc:duration', sourceId, seconds })
    },
  })
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

// navigator.requestMediaKeySystemAccess is deliberately left alone.
//
// It used to be wrapped, and every call to it — a refused capability probe included — took the
// recording of the whole page with it. Measured on an article of edition.cnn.com: sixteen probes
// inside the first two seconds, three of them granted, setMediaKeys called with null alone, and
// not one encryption box anywhere in the stream. The page was playing an ordinary video, 367x648
// with sound, watched for forty seconds — and it was thrown away for asking a question.
//
// Asking is intent; protection is a property of the material. The extension reads it out of the
// boxes it parses anyway (src/core/container.ts) and hears it from the element itself through the
// `encrypted` event (src/page/watcher.ts). Neither can be brought about by a probe, and both are
// true of a protected stream whose negotiation we never saw. So there is nothing for a hook to do
// here, and one monkey patch fewer is laid on the page.
