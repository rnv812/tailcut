import { EXTENSION_ORIGIN_PREFIX, type PageToBridge } from '../shared/protocol'
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

/**
 * The registry has refused this page for good, so there is nothing here worth copying.
 *
 * Set by the bridge and never cleared, because the refusal behind it is never cleared either: it
 * is the protected-media refusal, it covers the whole page, and no later moment turns it (see
 * `PageRefused` in the protocol for why a triage rejection may not arrive here). Until this word
 * comes the hook copies everything and asks nothing — it stands on a player's synchronous path,
 * and a hook that reasoned about material would be a hook that costs more than it is allowed to.
 *
 * Reading it costs the appendBuffer wrapper one boolean beside a WeakMap lookup it was doing
 * anyway, and when it is set the wrapper stops making the copy altogether — so the synchronous
 * path is never heavier for this and is lighter on exactly the pages that were paying for
 * nothing. Measured before it existed: 29.7 MB copied and thrown away on dash.js ClearKey in
 * forty seconds, 34.7 MB on Widevine.
 */
let refused = false

/**
 * Recording is switched off for this page by the recording mode or a site list that excludes it.
 * Nothing is copied while it stands.
 *
 * Unlike `refused`, this one turns — the user may switch recording back on without reloading the
 * page — and what comes back after it is the middle of somebody's byte stream. That is handled on
 * the other side: the registry lets its half-read readers go when intake resumes, and they find
 * their place at the next header (see SessionStore.pauseIntake). Here there is nothing to do
 * about it: a hook that tried to resume at a boundary would have to parse, and it must not.
 */
let paused = false

window.addEventListener('message', (event: MessageEvent) => {
  // Only the bridge may say this. Its frame stands on the extension origin, and a document of the
  // site cannot carry that scheme however it posts — while a page may put anything at all into
  // its own window, and a refusal it could imitate would be a switch for turning recording off.
  if (!event.origin.startsWith(EXTENSION_ORIGIN_PREFIX)) return
  const message = event.data as { type?: unknown; on?: unknown } | null
  if (message?.type === 'tc:refused') refused = true
  if (message?.type === 'tc:record') paused = message.on === false
})

function send(message: PageToBridge, transfer: Transferable[] = []): void {
  // The last stop for everything, the appends a wrapped worker forwards included: those are
  // copied in a realm of their own, out of reach of the guard below, and the page is refused all
  // the same.
  if (refused || paused) return
  window.postMessage(message, '*', transfer)
}

function copyOf(data: BufferSource): ArrayBuffer {
  // Copy rather than transfer the page's own buffer, because transfer would detach it. A player
  // that appends a cached segment again after a seek would then receive a detached buffer, and
  // appendBuffer can complete updateend without appending anything, silently stalling playback.
  if (data instanceof ArrayBuffer) return data.slice(0)

  // Copy only the view window, not its entire backing buffer. Use a fresh ArrayBuffer rather than
  // a slice because a SharedArrayBuffer slice remains shared and cannot be transferred.
  const view = data as ArrayBufferView
  const copy = new ArrayBuffer(view.byteLength)
  new Uint8Array(copy).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
  return copy
}

// This hook links a MediaSource to its <video>. The URL from createObjectURL enters video.src, so
// the isolated-world watcher can use it to identify which element owns the stream.
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
    // A MediaSource that did not pass through the wrapped createObjectURL has no address. This
    // cannot happen in this realm today: MediaSource has no usable srcObject path here, and
    // addSourceBuffer throws on an unattached source. Keep the branch for objects from another
    // realm, such as an unhooked about:blank frame, and for browsers that later support MediaSource
    // through srcObject. The watcher cannot bind an addressless stream to a <video>, but its bytes
    // can still reach the bridge.
    sourceId = nextId('s')
    sourceIds.set(this, sourceId)
    send({ type: 'tc:source', sourceId, objectUrl: '' })
  }

  buffers.set(sourceBuffer, { sourceId, bufferId: nextId('b'), mime })
  return sourceBuffer
}

// The length of the whole video, as the page states it on its MediaSource once it has read its
// manifest. It is the third component of the merge key and the one thing that tells two
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

  // Only a SourceBuffer from another realm can be untracked, for example if the page invokes this
  // wrapper on an object from an unhooked about:blank frame. Local buffers pass through the
  // wrapped addSourceBuffer. The guard prevents an unexplained microtask TypeError per segment.
  //
  // `refused` means the far side will discard the copy, so making one is pointless. `paused`
  // applies the same rule to user settings: disabled recording must not make the page pay for a
  // segment copy. These are boolean reads beside a WeakMap lookup already performed.
  if (tracked && !refused && !paused) {
    const bytes = copyOf(data)
    // Send from a microtask so the player's synchronous path stays empty.
    queueMicrotask(() => {
      send(
        {
          type: 'tc:append',
          sourceId: tracked.sourceId,
          bufferId: tracked.bufferId,
          mime: tracked.mime,
          bytes,
        },
        // Transfer the copy we own to avoid another pass over every segment.
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
