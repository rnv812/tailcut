import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { sessionKey } from '../../src/core/session-key'
import { boxBody, childBoxes, topLevelBoxes } from '../../src/core/iso/reader'
import { movieTracksOf } from '../../src/core/export/source'
import { isSnapshotId, snapshotPath } from '../../src/shared/protocol'
import { decodeFooter, decodeIndex, FOOTER_BYTES } from '../../src/core/snapshot/format'
import type { BridgeToPage, EditResult, SessionList, SessionSummary } from '../../src/shared/protocol'
import {
  LIMITS,
  REFERENCE_BITS_PER_SECOND,
  SETTINGS_KEY,
  memoryCeilingFor,
  type Settings,
} from '../../src/shared/settings'
import { writeSettings } from '../../src/shared/settings-store'

/** An ordinary complete file, the shape a page delivers when it uses no MediaSource at all. */
const plainBytes = new Uint8Array(readFileSync('tests/fixtures/plain/whole.mp4'))

const initBytes = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const seg1Bytes = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))
const seg2Bytes = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00002.m4s'))
/** The fragment after next: together with the first it makes a buffer with a gap between. */
const seg3Bytes = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00003.m4s'))

/**
 * The audio track of the same fixture. It is needed where the runs have to come out of
 * different lengths: video fragments all last the same, and a run made of one of them is
 * indistinguishable from a run made of another.
 */
/** The header of a protected stream: `encv` with `sinf` inside it, in place of `avc1`. */
const cencInitBytes = new Uint8Array(readFileSync('tests/fixtures/cenc/init-stream0.m4s'))
const audioInitBytes = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream1.m4s'))
/** Pieces of sound: 0…1.95, 1.95…3.95, 3.95…5.97, 5.97…6.02 seconds. */
const audioBytes = [1, 2, 3, 4].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/h264/chunk-stream1-0000${n}.m4s`)),
)

/**
 * One buffer carrying both kinds: two traks in the moov, two trafs in every segment.
 *
 * Used for the one shape where a session is full of material the writer can make nothing of —
 * see the refusal below.
 */
const muxedInitBytes = new Uint8Array(readFileSync('tests/fixtures/muxed/init-stream0.m4s'))
const muxedBytes = [1, 2, 3].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/muxed/chunk-stream0-0000${n}.m4s`)),
)

/** The same segment with every traf in it calling the track something the moov never declared. */
function trafsRenumbered(segment: Uint8Array, trackId: number): Uint8Array {
  const copy = new Uint8Array(segment)
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
  const moof = topLevelBoxes(copy).find((box) => box.type === 'moof')!

  for (const traf of childBoxes(copy, moof).filter((box) => box.type === 'traf')) {
    const tfhd = childBoxes(copy, traf).find((box) => box.type === 'tfhd')!
    // The header of the box, then its version and flags, then the number of the track.
    view.setUint32(tfhd.start + tfhd.headerSize + 4, trackId)
  }

  return copy
}

/**
 * Media data of a file: the bodies of its mdat boxes in the order they lie there. The muxer
 * rewrites the boxes around the material and never the material itself, so this is what says
 * which segments went into a file and in what order — the boxes around them differ from the
 * captured segments by design.
 */
const mediaOf = (file: Uint8Array): Uint8Array[] =>
  topLevelBoxes(file)
    .filter((box) => box.type === 'mdat')
    .map((box) => boxBody(file, box))

/** A digest of bytes: comparing whole buffers without flooding the output on a mismatch. */
function digest(...parts: Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

/** Bytes reach the bridge by transfer: an ArrayBuffer of their own, not a view on the fixture. */
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer

/** The address and the title of the page that inserted the bridge. */
const PAGE_URL = 'https://site.example/watch?v=abc'
const PAGE_TITLE = 'Clip — site.example'
const REFERRER = 'https://referrer.example/from'

/**
 * The key the registry holds the session of this page under. It is never an address:
 * normalizeUrl cuts the referral marks off, and the codecs and the duration are appended.
 */
const keyFor = (url: string, codecs: string[] = ['avc1']): string =>
  sessionKey({ url, codecs, durationSeconds: Infinity })

/**
 * The second argument of postMessage as it is: both a targetOrigin string and an options object
 * are legal forms of it. targetOriginOf takes them apart; it is kept untouched here so that the
 * form of the argument does not dictate the implementation.
 */
type Post = { message: unknown; to: unknown }

/** A download request in the shape the bridge hands it to Chrome. */
type Download = { url: string; filename: string; conflictAction?: string }

/** A receiving window: the bridge sends messages to it, the test looks at what arrived. */
function receiver() {
  const posts: Post[] = []
  return {
    posts,
    postMessage(message: unknown, to: unknown) {
      posts.push({ message, to })
    },
  }
}

/** A port of a MessageChannel: the bridge answers a session list request through it. */
function port() {
  const received: unknown[] = []
  return {
    received,
    postMessage(message: unknown) {
      received.push(message)
    },
  }
}

type Receiver = ReturnType<typeof receiver>
type MessageListener = (event: MessageEvent) => void

/**
 * What the bridge returns for tc:list. The type comes from the protocol instead of being
 * rewritten here: otherwise the set would check the bridge against its own idea of it rather
 * than against the declared protocol, and a drift between the two would go unnoticed.
 */
type Summary = SessionSummary

/** The reasons a summary may give for the file holding less than the session does. */
const OMISSIONS = ['track', 'rendition', 'alternate', 'gap']

/** A session summary by the facts: postMessage has no types, so the value has to be checked. */
function isSummary(value: unknown): value is SessionSummary {
  if (typeof value !== 'object' || value === null) return false
  const summary = value as Record<string, unknown>
  const known = ['key', 'url', 'title', 'lastAt', 'duration', 'bytes', 'omits']
  return (
    Object.keys(summary).every((field) => known.includes(field)) &&
    typeof summary.key === 'string' &&
    typeof summary.url === 'string' &&
    typeof summary.title === 'string' &&
    // The clock the popup merges the registries of every frame of the tab by.
    typeof summary.lastAt === 'number' &&
    typeof summary.duration === 'number' &&
    typeof summary.bytes === 'number' &&
    // Absent on a session the file will hold whole; one of the declared reasons otherwise.
    (summary.omits === undefined || OMISSIONS.includes(summary.omits as string))
  )
}

/** The variant of the BridgeToPage union a value fits; null — it fits none of them. */
function variantOf(
  value: unknown,
): 'tc:ready' | 'tc:refused' | 'tc:recording' | 'tc:record' | 'session list' | null {
  if (typeof value !== 'object' || value === null) return null
  const fields = value as Record<string, unknown>

  if (fields.type === 'tc:ready' && Object.keys(fields).length === 1) return 'tc:ready'
  if (fields.type === 'tc:refused' && Object.keys(fields).length === 1) return 'tc:refused'
  if (fields.type === 'tc:recording' && Object.keys(fields).length === 1) return 'tc:recording'
  // The one bit of the settings the hook is given, and the one message of this side that turns.
  // Its shape is checked as strictly as the others': anything more than the bit would be the
  // page reading a list of what its user watches.
  if (
    fields.type === 'tc:record' &&
    typeof fields.on === 'boolean' &&
    Object.keys(fields).length === 2
  ) {
    return 'tc:record'
  }

  const known = ['sessions', 'unreachable', 'unreadableFile']
  const fits =
    Array.isArray(fields.sessions) &&
    fields.sessions.every(isSummary) &&
    Object.keys(fields).every((field) => known.includes(field)) &&
    (fields.unreachable === undefined || typeof fields.unreachable === 'boolean') &&
    (fields.unreadableFile === undefined || typeof fields.unreadableFile === 'boolean')
  return fits ? 'session list' : null
}

/**
 * The address of the receiver out of the second argument of postMessage: a window takes both a
 * targetOrigin string and an options object with the same field. The forms are equal, so the
 * extracted address is what gets checked and not which of them the bridge used.
 */
function targetOriginOf(to: unknown): unknown {
  if (typeof to === 'object' && to !== null) return (to as { targetOrigin?: unknown }).targetOrigin
  return to
}

/**
 * Replaces the window the bridge lives in: it hangs its listener on window and sends the
 * handshake to window.parent. The parent, the top page and the sender are different objects
 * here: only that way is it visible who the bridge actually answered.
 *
 * The hierarchy is not invented: both content scripts are declared with all_frames, so the
 * bridge stands up in a nested frame too, where window.parent (the window of that very frame)
 * and window.top (the top page) are different windows.
 */
function installWindow(referrer = REFERRER, stored?: unknown) {
  const listeners: MessageListener[] = []
  const parent = receiver()
  const top = receiver()

  /**
   * chrome.storage.local, which is where the settings live and the only thing in the extension
   * that keeps any.
   *
   * The frame holds a live copy of them and acts on every change without a reload (§9.4), so the
   * set has to be able to move a setting under a page that is already recording — which is the
   * whole shape of the feature and cannot be asked of a constant.
   */
  const storage: Record<string, unknown> = stored === undefined ? {} : { [SETTINGS_KEY]: stored }
  type StorageListener = (
    changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
    area: string,
  ) => void
  const storageListeners: StorageListener[] = []

  vi.stubGlobal('window', {
    addEventListener(type: string, listener: MessageListener) {
      if (type === 'message') listeners.push(listener)
    },
    parent,
    top,
  })
  // The document of the bridge lives on the extension origin; the referrer is the only thing it
  // knows about the page that inserted it before tc:context arrives.
  vi.stubGlobal('document', { referrer })

  /** Downloads that were started, in the shape the bridge orders them from Chrome. */
  const downloads: Download[] = []
  /** Blobs the bridge handed out addresses for, and the revoked addresses — one per download. */
  const blobs = new Map<string, Blob>()
  const revoked: string[] = []
  /** The download id; undefined — Chrome refused, as it does when writing is forbidden. */
  let downloadId: number | undefined = 1
  /** What Chrome puts into runtime.lastError when it refuses; empty — it said nothing. */
  let failureMessage = 'Download failed'

  // URL stays the real one: its constructor is called by the session key on every init segment.
  // Only the static blob methods, which Node does not have, are added.
  class TestURL extends URL {
    static createObjectURL(blob: Blob): string {
      const url = `blob:chrome-extension://tailcut/${blobs.size + 1}`
      blobs.set(url, blob)
      return url
    }

    static revokeObjectURL(url: string): void {
      revoked.push(url)
    }
  }
  vi.stubGlobal('URL', TestURL)

  /**
   * Failures Chrome would write to the console as "Unchecked runtime.lastError": the download
   * callback returned without ever reading chrome.runtime.lastError.
   */
  const uncheckedErrors: string[] = []
  /** A failure lives exactly as long as the callback — that is how Chrome hands it over too. */
  let lastError: { message: string } | undefined
  let lastErrorRead = false

  /**
   * The snapshot writer, standing in for the worker the bridge really writes through.
   *
   * Only a dedicated worker may open a synchronous access handle, so the frame hands the whole
   * snapshot to one and waits for a word back (src/bridge/snapshot-worker.ts). What is recorded
   * here is that word's request — the path and the bytes — and what is answered is whatever the
   * test wants the storage to say: OPFS refuses a write for reasons no page controls, and a
   * refusal has to reach the popup as a refusal rather than as a tab opened over nothing.
   */
  const writes: Array<{ path: string; bytes: Uint8Array }> = []
  /** What the storage answers: the bytes it took, or a refusal. */
  let storageTakes = true

  class TestWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: unknown) => void) | null = null

    constructor(readonly url: string) {}

    postMessage(request: { type: string; path: string; bytes: ArrayBuffer }): void {
      const bytes = new Uint8Array(request.bytes)
      writes.push({ path: request.path, bytes })

      // The worker answers in a turn of its own, as a worker does.
      queueMicrotask(() => {
        const answer = storageTakes
          ? { type: 'written', bytes: bytes.byteLength }
          : { type: 'failed', error: 'QuotaExceededError' }
        this.onmessage?.({ data: answer } as MessageEvent)
      })
    }

    terminate(): void {}
  }
  vi.stubGlobal('Worker', TestWorker)

  vi.stubGlobal('chrome', {
    runtime: {
      get lastError() {
        lastErrorRead = true
        return lastError
      },
      getURL: (path: string) => `chrome-extension://tailcut/${path}`,
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: async () => undefined,
    },
    storage: {
      local: {
        get: async (key: string) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (patch: Record<string, unknown>) => {
          const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {}
          for (const [key, value] of Object.entries(patch)) {
            changes[key] = { newValue: value, oldValue: storage[key] }
            storage[key] = value
          }
          for (const listener of [...storageListeners]) listener(changes, 'local')
        },
      },
      onChanged: {
        addListener: (listener: StorageListener) => storageListeners.push(listener),
        removeListener: (listener: StorageListener) => {
          storageListeners.splice(storageListeners.indexOf(listener), 1)
        },
      },
    },
    downloads: {
      download(options: Download, done: (id?: number) => void) {
        downloads.push(options)
        lastError = downloadId === undefined ? { message: failureMessage } : undefined
        lastErrorRead = false

        done(downloadId)

        if (lastError && !lastErrorRead) uncheckedErrors.push(lastError.message)
        lastError = undefined
      },
    },
  })

  const deliver = (
    data: unknown,
    options: { from?: Receiver; ports?: ReturnType<typeof port>[] } = {},
  ): Receiver => {
    const from = options.from ?? receiver()
    const event = { data, source: from, ports: options.ports ?? [] }
    for (const listener of listeners) listener(event as unknown as MessageEvent)
    return from
  }

  return {
    parent,
    top,
    deliver,
    /** Asks the bridge the way the popup does: through a message channel. */
    answer(): SessionList {
      const reply = port()
      deliver({ type: 'tc:list' }, { ports: [reply] })
      expect(reply.received, 'the bridge did not answer the session list request').toHaveLength(1)
      return reply.received[0] as SessionList
    },
    /** The sessions out of that answer, which is what most of this set is about. */
    list(): Summary[] {
      return this.answer().sessions
    },
    /** Hands the bridge a segment the way the content script sends it. */
    append(bytes: Uint8Array, sourceId = 's1', bufferId = 'b1'): void {
      deliver({
        type: 'tc:append',
        sourceId,
        bufferId,
        mime: 'video/mp4',
        bytes: buffer(bytes),
      })
    },
    /** Tells the bridge which page it stands on. */
    context(url = PAGE_URL, title = PAGE_TITLE): void {
      deliver({ type: 'tc:context', url, title })
    },
    /**
     * Changes a setting the way the settings page does: through storage, from another document.
     *
     * The frame hears it over chrome.storage.onChanged and acts on it where it stands — no
     * reload, no navigation, and no message of the protocol involved. That is the promise of
     * §9.4 and it is what this drives.
     */
    async settings(edit: (current: Settings) => Settings): Promise<void> {
      await writeSettings(edit)
      // The live copy is updated inside the write; the frame's own work behind it — the switch to
      // the hook, the registry — is synchronous, and this is for anything the read chained on.
      for (let turn = 0; turn < 4; turn++) await Promise.resolve()
    },
    /** Everything the bridge posted to the window that inserted it, in order. */
    said(): unknown[] {
      return parent.posts.map((post) => post.message)
    },
    /** The switches the bridge told the hook about, oldest first. */
    switches(): boolean[] {
      return parent.posts
        .map((post) => post.message as { type?: unknown; on?: unknown })
        .filter((message) => message?.type === 'tc:record')
        .map((message) => message.on === true)
    },
    /**
     * Asks the bridge to build a file — the way the popup does through the content script.
     *
     * Awaited, because building one is: a session whose material is still on somebody's server
     * has to read it before there is a file, and the bridge answers when it has one either way.
     * The wait is for the microtask queue and not for a clock — nothing here touches a network.
     */
    async save(key: string): Promise<ReturnType<typeof port>> {
      const reply = port()
      deliver({ type: 'tc:save', key }, { ports: [reply] })
      await Promise.resolve()
      await Promise.resolve()
      return reply
    },
    /**
     * Asks the bridge to freeze a session, the way the popup does through the content script.
     *
     * Awaited past the write: the layout of the snapshot is one synchronous turn, and the worker
     * that puts it on disk answers in a turn of its own. Nothing here touches a clock either.
     */
    async edit(key: string): Promise<ReturnType<typeof port>> {
      const reply = port()
      deliver({ type: 'tc:edit', key }, { ports: [reply] })
      for (let turn = 0; turn < 8; turn++) await Promise.resolve()
      return reply
    },
    /** Snapshots that reached the storage, in the order they were written. */
    writes,
    /** The storage refuses the write: no quota left, a handle it would not open. */
    refuseStorage(): void {
      storageTakes = false
    },
    downloads,
    revoked,
    uncheckedErrors,
    /** The bytes of the file the bridge handed Chrome to download. */
    async savedBytes(index = 0): Promise<Uint8Array> {
      const started = downloads[index]
      expect(started, 'no download was started').toBeDefined()
      const blob = blobs.get(started!.url)
      expect(blob, 'the bridge gave Chrome an address with no blob behind it').toBeDefined()
      return new Uint8Array(await blob!.arrayBuffer())
    },
    /** The type of the blob the bridge handed Chrome. */
    savedType(index = 0): string | undefined {
      return blobs.get(downloads[index]?.url ?? '')?.type
    },
    /**
     * Chrome refuses the download: writing forbidden, no space, a name the file system will not
     * take, cancelled by the user. What it says about it comes back through runtime.lastError,
     * and a refusal without a word to it is a shape the caller has to survive too.
     */
    failDownloads(message = 'Download failed'): void {
      downloadId = undefined
      failureMessage = message
    },
  }
}

/**
 * A host answering ranged reads, for the one kind of session whose material is not in this frame.
 *
 * The bridge reads such a file itself, through `fetch` on the extension origin, so the global has
 * to answer. Every range it is asked for is recorded: what a plain source costs in requests is
 * part of what the bridge is answerable for.
 */
function installHost(file: Uint8Array = plainBytes) {
  const asked: string[] = []
  let refusing = false

  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range') ?? ''
    asked.push(range)

    if (refusing) return new Response(null, { status: 403 })

    const match = /bytes=(\d+)-(\d+)/.exec(range)
    if (!match) return new Response(null, { status: 400 })

    const from = Number(match[1])
    const to = Math.min(Number(match[2]), file.byteLength - 1)
    const part = file.slice(from, to + 1)

    return new Response(part.buffer as ArrayBuffer, {
      status: 206,
      headers: { 'content-range': `bytes ${from}-${to}/${file.byteLength}` },
    })
  })

  return {
    asked,
    /** The host stops answering: an expired signed URL, a session that ended, a node gone away. */
    refuse: () => {
      refusing = true
    },
  }
}

/**
 * The bridge sets its listener and says hello right when the module loads.
 *
 * `stored` is what chrome.storage.local already holds under the settings key when the frame comes
 * up — a user who set something in an earlier session, which is every user after the first. The
 * frame reads it a turn or two after loading, so the turns are given here rather than left to
 * every caller to remember.
 */
async function loadBridge(referrer?: string, stored?: unknown) {
  const win = installWindow(referrer, stored)
  vi.resetModules()
  await import('../../src/bridge/bridge')
  for (let turn = 0; turn < 4; turn++) await Promise.resolve()
  return win
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the handshake of the bridge', () => {
  it('goes to the parent window right at load', async () => {
    const win = await loadBridge()

    expect(win.parent.posts.map((p) => p.message)).toEqual([{ type: 'tc:ready' }])
  })

  it('goes to the window of its own frame, not to the top page', async () => {
    const win = await loadBridge()

    // The bridge lives in every frame of the page, and for a player embedded through an iframe
    // the frame window and the top page are different windows. A handshake sent upwards never
    // reaches the one that inserted the bridge: that frame never learns about it.
    expect(win.top.posts, 'the handshake went to the top page instead of its frame').toEqual([])
    expect(win.parent.posts.map((p) => p.message)).toEqual([{ type: 'tc:ready' }])
  })

  it('is addressed to any origin: the extension works on every site', async () => {
    const win = await loadBridge()

    // A nailed-down address silently loses the handshake on every page but that one, and the
    // page learns about the bridge from this message alone.
    expect(
      targetOriginOf(win.parent.posts[0]?.to),
      'the handshake is nailed to a particular address',
    ).toBe('*')
  })
})

describe('the bridge puts segments into the session registry', () => {
  it('returns an empty list from an empty registry', async () => {
    const win = await loadBridge()

    expect(win.list()).toEqual([])
  })

  it('opens a session under the address and title of the page on an init', async () => {
    const win = await loadBridge()
    win.context()

    win.append(initBytes)

    expect(win.list()).toEqual([
      {
        key: keyFor(PAGE_URL),
        url: PAGE_URL,
        title: PAGE_TITLE,
        lastAt: expect.any(Number),
        duration: 0,
        bytes: 0,
      },
    ])
  })

  it('collects duration and volume from media fragments', async () => {
    const win = await loadBridge()
    win.context()

    win.append(initBytes)
    win.append(seg1Bytes)
    win.append(seg2Bytes)

    // Fixture: two seconds per fragment, both in a row — four seconds of clip, and all of it
    // reaches the file.
    expect(win.list()).toMatchObject([
      { duration: 4, bytes: seg1Bytes.byteLength + seg2Bytes.byteLength },
    ])
    expect(win.list()[0]!.omits).toBeUndefined()
  })

  it('signs a summary with the moment material last reached it', async () => {
    const win = await loadBridge()
    win.context()

    win.append(initBytes)
    win.append(seg1Bytes)
    const afterFirst = win.list()[0]!.lastAt

    const before = Date.now()
    win.append(seg2Bytes)
    const after = Date.now()

    // The registry of one frame sorts its own sessions and knows of no other; a tab holds one
    // registry per frame and the popup shows a single list. This is the only thing the sessions
    // of two frames can be put in order by, so it has to mean the arrival of material and not
    // the opening of the session — the popup calls the head of the list the recording being
    // watched right now.
    const lastAt = win.list()[0]!.lastAt
    expect(lastAt).toBeGreaterThanOrEqual(before)
    expect(lastAt).toBeLessThanOrEqual(after)
    expect(lastAt).toBeGreaterThanOrEqual(afterFirst)
  })

  it('promises the piece a gapped buffer can be saved as, and says a piece was left out', async () => {
    const win = await loadBridge()
    win.context()

    win.append(initBytes)
    win.append(seg1Bytes)
    // The second fragment is missing: the user skipped forward, or the tab was throttled and the
    // player went on loading from a new position. A two-second gap is a gap, not rounding.
    win.append(seg3Bytes)

    // The popup draws the file from this summary. Six seconds from start to end would promise
    // material that does not exist — between the 2nd and the 4th second the registry is empty —
    // and four seconds would promise both pieces where a save writes one continuous clip.
    expect(win.list()).toEqual([
      {
        key: keyFor(PAGE_URL),
        url: PAGE_URL,
        title: PAGE_TITLE,
        lastAt: expect.any(Number),
        duration: 2,
        bytes: seg1Bytes.byteLength,
        omits: 'gap',
      },
    ])
  })

  it('carries the registry key in the summary, not the page address', async () => {
    const win = await loadBridge()
    // A live address almost always carries referral marks: ?t= from a rewind, utm_ from a mail.
    const url = `${PAGE_URL}&t=42&utm_source=tg`
    win.context(url, PAGE_TITLE)

    win.append(initBytes)

    const summary = win.list()[0]!

    // key is the handle the popup asks the registry for this session with. The page address is
    // not one: the referral marks are cut out of the key and the codecs are appended to it, so a
    // request by address would find nothing and there would be no clip to save.
    expect(summary.key).toBe(keyFor(PAGE_URL))
    expect(summary.url).toBe(url)
  })

  it('gives a session to the referrer before the context arrives', async () => {
    const win = await loadBridge()

    // The content script sends the context right after the bridge loads, but the hook segments
    // travel the same road: should one outrun the context, the session must stay recognisable.
    win.append(initBytes)

    expect(win.list()).toMatchObject([{ url: REFERRER, title: '' }])
  })

  it('signs an already open session with the title that arrives later', async () => {
    const win = await loadBridge()
    // The page knows its address from the first moment and its title only later: at
    // document_start <head> is not parsed yet, and on a single-page application the next video
    // arrives without a navigation at all.
    win.context(PAGE_URL, '')
    win.append(initBytes)
    expect(win.list()).toMatchObject([{ title: '' }])

    win.context(PAGE_URL, PAGE_TITLE)

    // The bridge is told the title, so the sessions of that page must carry it: otherwise the
    // popup shows "Untitled" for a video that has a perfectly good name, and the saved file is
    // named after nothing.
    expect(win.list()).toMatchObject([{ title: PAGE_TITLE }])
  })

  it('names the file after the title that arrived after the session opened', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, '')
    win.append(initBytes)
    win.append(seg1Bytes)

    win.context(PAGE_URL, 'Night broadcast')
    await win.save(keyFor(PAGE_URL))

    // The name is read off the session at the moment of saving, and this is the whole point of
    // the title reaching it at all.
    expect(win.downloads[0]!.filename).toBe('Night broadcast.mp4')
  })

  it('coerces a non-string context to strings instead of passing it on', async () => {
    const win = await loadBridge()

    // The bridge takes tc:context from anyone on the page: any script can address it, not only
    // our content script. Nobody checked the fields, so anything at all could travel into the
    // summary of the session — the very thing the popup signs it with — and a URL object beside
    // a number is exactly what a script that means no harm would send.
    win.deliver({ type: 'tc:context', url: new URL(PAGE_URL), title: 42 })
    win.append(initBytes)

    expect(win.list()).toMatchObject([{ url: PAGE_URL, title: '42' }])
  })

  it('records nothing at all under an address that is not one', async () => {
    const win = await loadBridge()

    // Coerced, this address reads "[object Object]", which no list of domains can be weighed
    // against — and the same is true of about:blank and of a data: document. A recording the
    // settings page cannot turn off is worse than no recording (see siteAllows), so there is
    // none, and the hook is told to stop copying for good measure.
    win.deliver({ type: 'tc:context', url: { href: PAGE_URL }, title: 42 })
    win.append(initBytes)

    expect(win.list()).toEqual([])
    expect(win.switches()).toEqual([false])
  })

  it('does not merge segments of different sources into one session', async () => {
    const win = await loadBridge()
    win.context()

    win.append(initBytes, 's1')
    win.context('https://site.example/watch?v=second', 'Second')
    win.append(initBytes, 's2')
    // The first player goes on playing: its fragment has to land in its own session.
    win.append(seg1Bytes, 's1')

    expect(win.list().map((s) => [s.url, s.duration])).toEqual(
      expect.arrayContaining([
        [PAGE_URL, 2],
        ['https://site.example/watch?v=second', 0],
      ]),
    )
  })

  it('lists a fresh session first', async () => {
    vi.useFakeTimers()
    const win = await loadBridge()

    vi.setSystemTime(new Date('2026-08-22T10:00:00Z'))
    win.context(PAGE_URL, 'First')
    win.append(initBytes, 's1')

    vi.setSystemTime(new Date('2026-08-22T10:05:00Z'))
    win.context('https://site.example/watch?v=later', 'Second')
    win.append(initBytes, 's2')

    // The session time is the bridge clock: without it the popup order is the insertion order.
    expect(win.list().map((s) => s.title)).toEqual(['Second', 'First'])
  })

  it('keys a session by the length the page stated for its media source', async () => {
    const win = await loadBridge()
    win.context()
    win.deliver({ type: 'tc:duration', sourceId: 's1', seconds: 23.581 })
    win.append(initBytes)

    // The length is the third component of the merge key (§6.1). Without it two videos of a feed
    // whose address does not change are one session and one unplayable file.
    expect(win.list().map((s) => s.key)).toEqual([
      sessionKey({ url: PAGE_URL, codecs: ['avc1'], durationSeconds: 23.581 }),
    ])
  })

  it('keeps two clips of a feed apart when the address stays the same', async () => {
    const win = await loadBridge()
    const feed = 'https://feed.example/foryou'
    win.context(feed, 'Watch trending videos for you')

    win.deliver({ type: 'tc:duration', sourceId: 's1', seconds: 6.845 })
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')

    // The next clip of the scroll: its own MediaSource, the same address, the same codecs.
    win.deliver({ type: 'tc:duration', sourceId: 's2', seconds: 64.943 })
    win.append(initBytes, 's2')
    win.append(seg1Bytes, 's2')

    expect(win.list(), 'two clips of the feed came out as one session').toHaveLength(2)
  })

  it('does not answer the sender of a stated length', async () => {
    const win = await loadBridge()
    win.context()

    const sender = win.deliver({ type: 'tc:duration', sourceId: 's1', seconds: 12 })

    // An answer into the page window would tell any script that the extension is here.
    expect(sender.posts).toEqual([])
  })
})

describe('the bridge and foreign messages', () => {
  const foreign: [string, unknown][] = [
    ['tc:source', { type: 'tc:source', sourceId: 's', objectUrl: 'blob:x' }],
    ['a foreign type', { type: 'webpackHotUpdate' }],
    ['null', null],
    ['a string', 'tc:append'],
    ['a number', 42],
  ]

  it.each(foreign)('neither answers %s nor opens a session', async (_name, data) => {
    const win = await loadBridge()
    win.context()

    const sender = win.deliver(data)

    expect(sender.posts, 'the bridge answered a message of a foreign type').toEqual([])
    expect(win.list()).toEqual([])
  })

  const junk: [string, Uint8Array][] = [
    ['an empty buffer', new Uint8Array(0)],
    ['an error page instead of a segment', new Uint8Array([60, 33, 100, 111, 99])],
  ]

  it.each(junk)('%s in tc:append does not break the bridge', async (_name, bytes) => {
    const win = await loadBridge()
    win.context()

    // The bytes come from an arbitrary site, and an exception here would stop everything that
    // follows from being received: the bridge has a single listener.
    expect(() => win.append(bytes)).not.toThrow()
    win.append(initBytes)

    expect(win.list(), 'the bridge stopped taking segments after junk').toHaveLength(1)
  })

  it('does not break on a list request without a channel to answer through', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)

    expect(() => win.deliver({ type: 'tc:list' })).not.toThrow()
    expect(win.list(), 'the registry suffered from a request without a port').toHaveLength(1)
  })

  it('answers tc:list into the channel alone, not into the sender window', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)

    const reply = port()
    const sender = win.deliver({ type: 'tc:list' }, { ports: [reply] })

    // The session list is a watch history. An answer into the window would hand it to any page
    // that thinks of sending the bridge a tc:list.
    expect(sender.posts, 'the session list went into the page window').toEqual([])
    expect(reply.received).toHaveLength(1)
  })
})

describe('the bridge takes triage verdicts', () => {
  /** A verdict in the shape the content script sends it to the bridge. */
  const verdict = (win: ReturnType<typeof installWindow>, sourceId: string, value: string) =>
    win.deliver({ type: 'tc:verdict', sourceId, verdict: value })

  it('erases what a screened-out source collected on rejection', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')

    verdict(win, 's1', 'reject')

    expect(win.list()).toEqual([])
  })

  it('does not touch the session of a neighbour on a rejection of one source', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')
    win.context('https://site.example/watch?v=second', 'Second')
    win.append(initBytes, 's2')

    // A banner and the real player on one page: the verdict is addressed, and a rejection of the
    // first has to leave the second alone.
    verdict(win, 's1', 'reject')

    expect(win.list().map((s) => s.title)).toEqual(['Second'])
  })

  it('protects a session from a later rejection on promotion', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')

    verdict(win, 's1', 'promote')
    // A pause or the element leaving the screen: recording freezes, what was collected stays.
    verdict(win, 's1', 'reject')

    expect(win.list()).toMatchObject([{ duration: 2 }])
  })

  it('returns recording to a screened-out source on a hold', async () => {
    const win = await loadBridge()
    win.context()

    verdict(win, 's1', 'reject')
    win.append(initBytes, 's1')
    expect(win.list(), 'setup: there must be no session after a rejection').toEqual([])

    verdict(win, 's1', 'hold')
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')

    expect(win.list()).toMatchObject([{ duration: 2 }])
  })

  it('does not answer the sender of a verdict', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')

    const sender = win.deliver({ type: 'tc:verdict', sourceId: 's1', verdict: 'promote' })

    expect(sender.posts, 'the bridge answered a verdict').toEqual([])
  })
})

describe('the bridge refuses a page that plays encrypted media', () => {
  /**
   * The isolated world has heard a media element fire `encrypted` over what it was being fed.
   *
   * The stream saying so itself, and not the page saying it means to: what the page asks the
   * browser about key systems is no longer part of this protocol at all, because a news article
   * was measured asking about sixteen of them over a video that was in the clear.
   */
  const encrypted = (win: ReturnType<typeof installWindow>) => win.deliver({ type: 'tc:encrypted' })

  it('erases what the page had collected in the clear before it', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')
    expect(win.list(), 'setup: the material has to be in the registry first').toHaveLength(1)

    encrypted(win)

    // The refusal comes in on its own and not through a verdict. On a page whose element the
    // watcher cannot reach — tv.apple.com plays inside a shadow root — no verdict is ever spoken,
    // and the promise "we do not record protected media" would rest on nothing.
    expect(win.list()).toEqual([])
  })

  it('refuses a page whose segments arrive encrypted, told by nobody', async () => {
    const win = await loadBridge()
    win.context()

    // Nothing announced this page as protected: the boxes of the init segment say it, and the
    // bridge is the one that reads them.
    win.append(cencInitBytes, 's1')
    win.append(seg1Bytes, 's1')

    expect(win.list()).toEqual([])
    expect(win.answer().encrypted).toBe(true)
  })

  it('keeps nothing the page appends after it', async () => {
    const win = await loadBridge()
    win.context()

    encrypted(win)
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')

    expect(win.list()).toEqual([])
  })

  it('has nothing left to hand a save', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')
    const key = win.list()[0]!.key

    encrypted(win)
    const reply = await win.save(key)

    // The popup keeps the key of a session it listed a moment ago: a save by that key must find
    // nothing, and no file may reach the disk. It is gone from the registry, and that is exactly
    // what the popup is told — the same words a session evicted by triage earns.
    expect(reply.received).toEqual([{ ok: false, reason: 'gone' }])
    expect(win.downloads, 'a file of a protected page was written').toEqual([])
  })

  it('says so in the answer, and says nothing of the sort before it is told', async () => {
    const win = await loadBridge()
    win.context()

    expect(win.answer().encrypted, 'setup: nothing has been said about this page yet').toBe(
      undefined,
    )

    encrypted(win)

    // An empty list is the same emptiness on a page with no video and on a page that may not be
    // recorded, and the user is owed the difference in words.
    expect(win.answer().encrypted).toBe(true)
  })

  it('leaves an ordinary page unprotected in the answer', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')

    expect(win.answer().encrypted).toBe(undefined)
    expect(win.answer().sessions).toHaveLength(1)
  })

  it('does not answer the sender of tc:encrypted', async () => {
    const win = await loadBridge()
    win.context()

    const sender = win.deliver({ type: 'tc:encrypted' })

    expect(sender.posts, 'the bridge answered a report of encryption').toEqual([])
  })

  /**
   * The refusal has to travel back out to the world that does the copying.
   *
   * Everything above is about what the registry keeps, and the answer is nothing. What the hook
   * in the main world does meanwhile is copy every append and post it here to be dropped:
   * measured on dash.js ClearKey, 53 messages and 29.7 MB thrown away, and on Widevine 40 and
   * 34.7 MB, over forty seconds apiece. The cost of refusing equalled the cost of recording.
   *
   * It is the one refusal that may be sent: it never turns (see refuseEncrypted) and it covers
   * the whole page. A triage rejection must not go out this way — it turns as often as not, and
   * a reader that missed the middle of a byte stream cannot find its place again.
   */
  it('tells the page that the copying may stop', async () => {
    const win = await loadBridge()
    win.context()

    encrypted(win)

    expect(win.said()).toEqual([
      { type: 'tc:ready' },
      // The address arrived, so the frame worked out whether this page is recorded at all and
      // said so. It stands before the refusal because the refusal came of what the page sent
      // afterwards.
      { type: 'tc:record', on: true },
      { type: 'tc:refused' },
    ])
  })

  it('tells it just as plainly when nobody announced the page and the boxes did', async () => {
    const win = await loadBridge()
    win.context()

    win.append(cencInitBytes, 's1')

    expect(win.said()).toEqual([
      { type: 'tc:ready' },
      { type: 'tc:record', on: true },
      { type: 'tc:refused' },
    ])
  })

  it('says it once, however much the page goes on sending', async () => {
    const win = await loadBridge()
    win.context()

    encrypted(win)
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')
    encrypted(win)
    win.answer()

    // Repeating it would put a message on every append of a page that is already refused, which
    // is the very traffic this is here to end.
    expect(win.parent.posts.filter((post) => variantOf(post.message) === 'tc:refused')).toHaveLength(
      1,
    )
  })

  it('says nothing of the sort on a page in the clear', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')
    win.answer()

    // The word that this frame is recording goes out beside the handshake and belongs there: the
    // page is being recorded, which is the opposite of refused.
    expect(win.said()).toEqual([
      { type: 'tc:ready' },
      { type: 'tc:record', on: true },
      { type: 'tc:recording' },
    ])
  })
})

describe('a page holding a player the extension could not reach', () => {
  it('says so in the answer, and says nothing of the sort before it is told', async () => {
    const win = await loadBridge()
    win.context()

    expect(win.answer().unreachable, 'setup: nothing has been said about this page yet').toBe(
      undefined,
    )

    // The isolated world has found an element playing a MediaSourceHandle whose worker was never
    // wrapped. Nothing of that player was ever copied and nothing ever will be: the popup has to
    // be able to tell that apart from a page with nothing worth recording on it.
    win.deliver({ type: 'tc:unreachable' })

    expect(win.answer().unreachable).toBe(true)
  })

  it('goes on offering what it did record beside it', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    win.deliver({ type: 'tc:unreachable' })

    // A page can hold both: one player in the main world and another in a worker out of reach.
    // The recording of the first is not taken away by the refusal of the second.
    const answer = win.answer()
    expect(answer.sessions).toHaveLength(1)
    expect(answer.unreachable).toBe(true)
  })
})

describe('BridgeToPage describes everything the bridge sends', () => {
  it('fits both the handshake and the tc:list answer into the declared union', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    const reply = port()
    win.deliver({ type: 'tc:list' }, { ports: [reply] })

    // The bridge sends through two channels: to the parent window and into the port of the
    // request. Both ends are gathered here because one type is declared for both: a message sent
    // past the union is unknown to the receiver and to the next reader of the protocol alike.
    const sent: unknown[] = [...win.said(), ...reply.received]
    expect(sent.map(variantOf), 'the bridge sent a message not described in BridgeToPage').toEqual([
      'tc:ready',
      'tc:record',
      'tc:recording',
      'session list',
    ])
  })

  it('takes every variant from the union, not from the ideas of the set about it', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)

    // A check by the compiler: the assignment will not pass typecheck if the union loses a
    // variant (`BridgeToPage = { type: 'tc:ready' }`, as it was before this change) or drifts
    // away from the summary the bridge actually returns.
    const handshake: BridgeToPage = { type: 'tc:ready' }
    const refusal: BridgeToPage = { type: 'tc:refused' }
    const recording: BridgeToPage = { type: 'tc:recording' }
    const record: BridgeToPage = { type: 'tc:record', on: false }
    const list: BridgeToPage = win.answer()

    expect([
      variantOf(handshake),
      variantOf(refusal),
      variantOf(recording),
      variantOf(record),
      variantOf(list),
    ]).toEqual(['tc:ready', 'tc:refused', 'tc:recording', 'tc:record', 'session list'])
  })
})

describe('the bridge saves what it collected as a file', () => {
  /** The key of the audio session: its runs come out of different lengths. */
  const audioKey = keyFor(PAGE_URL, ['mp4a'])

  /** Collects an audio session out of the listed pieces; a skipped piece makes a gap. */
  async function withAudio(...indexes: number[]) {
    const win = await loadBridge()
    win.context()
    win.append(audioInitBytes)
    for (const index of indexes) win.append(audioBytes[index]!)
    return win
  }

  it('hands Chrome the init and the longest run, not the first one around', async () => {
    // Runs 0…1.95 and 3.95…6.02: the second one is longer.
    const win = await withAudio(0, 2, 3)

    await win.save(audioKey)

    expect(digest(...mediaOf(await win.savedBytes()))).toBe(
      digest(...mediaOf(audioBytes[2]!), ...mediaOf(audioBytes[3]!)),
    )
  })

  it('takes the long run when it is not the last one either', async () => {
    // Runs 0…3.95 and 5.97…6.02: the first one is longer. A tail of half a second is ordinary:
    // the player loaded a piece after a rewind and stopped.
    const win = await withAudio(0, 1, 3)

    await win.save(audioKey)

    expect(digest(...mediaOf(await win.savedBytes()))).toBe(
      digest(...mediaOf(audioBytes[0]!), ...mediaOf(audioBytes[1]!)),
    )
  })

  it('declares the file a video, not a stream of bytes', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    await win.save(keyFor(PAGE_URL))

    // Chrome picks what to open the download with by the type of the blob;
    // application/octet-stream would send the clip into an "unknown file".
    expect(win.savedType()).toBe('video/mp4')
  })

  it('names the file after the page title with an mp4 extension', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, 'Ночной эфир')
    win.append(initBytes)
    win.append(seg1Bytes)

    await win.save(keyFor(PAGE_URL))

    // A title not in Latin is no reason to hand the user a file made of underscores.
    expect(win.downloads.map((item) => item.filename)).toEqual(['Ночной эфир.mp4'])
  })

  it('leaves no forbidden characters in the file name', async () => {
    const win = await loadBridge()
    // The title is set by the page and reaches the file system here: the whole forbidden set is
    // in the check at once, because a character dropped from it would get there silently.
    win.context(PAGE_URL, 'A/B: "C" <D> | E? AC\\DC * F\u0001G')
    win.append(initBytes)
    win.append(seg1Bytes)

    await win.save(keyFor(PAGE_URL))

    // Chrome reads both slashes as a path separator: "AC\DC.mp4" goes out not as a file but as
    // a directory AC with a file DC.mp4 inside — the user pressed "Save all" and found no clip.
    // Windows does not take a star or a colon in a name at all: the download is rejected and the
    // popup says nothing about it. Control characters come from the same place.
    expect(win.downloads[0]!.filename).toBe('A B C D E AC DC F G.mp4')
  })

  it('does not turn a title of nothing but dots into a hidden file', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, '../../.bashrc')
    win.append(initBytes)
    win.append(seg1Bytes)

    await win.save(keyFor(PAGE_URL))

    // The title is set by the page and through the file name it leads straight into the file
    // system: Chrome reads dots at the edges as a path upwards and rejects the download whole.
    const filename = win.downloads[0]!.filename
    expect(filename.startsWith('.'), `the file name starts with a dot: ${filename}`).toBe(false)
    expect(filename).not.toContain('..')
  })

  it('strips a dot and a space off the tail of the name before the extension', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, 'Серия 1.')
    win.append(initBytes)
    win.append(seg1Bytes)

    await win.save(keyFor(PAGE_URL))

    // The extension is appended right after, and a trailing dot in the title doubles the
    // separator: «Серия 1..mp4». Windows also cuts dots and spaces off the end of a name itself.
    expect(win.downloads[0]!.filename).toBe('Серия 1.mp4')
  })

  it('leaves no space before the extension when a long title is cut on one', async () => {
    const win = await loadBridge()
    // The space is the hundredth character: the cut by the length limit falls exactly on it.
    win.context(PAGE_URL, `${'ц'.repeat(99)} and some more words`)
    win.append(initBytes)
    win.append(seg1Bytes)

    await win.save(keyFor(PAGE_URL))

    expect(win.downloads[0]!.filename).toBe(`${'ц'.repeat(99)}.mp4`)
  })

  it('saves a page without a title under the name of the extension', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, '   ')
    win.append(initBytes)
    win.append(seg1Bytes)

    await win.save(keyFor(PAGE_URL))

    expect(win.downloads[0]!.filename).toBe('tailcut.mp4')
  })

  it('cuts a long title down to a name the file system will take', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, 'ц'.repeat(300))
    win.append(initBytes)
    win.append(seg1Bytes)

    await win.save(keyFor(PAGE_URL))

    expect(win.downloads[0]!.filename.length).toBeLessThanOrEqual(104)
    expect(win.downloads[0]!.filename.endsWith('.mp4')).toBe(true)
  })

  /**
   * Titles as real pages write them.
   *
   * A page title travels into the file system through this name, and Chrome refuses a name it
   * does not like by refusing the whole download — a refusal the popup used to answer by blaming
   * the session for being gone. Measured: a title carrying U+200E LEFT-TO-RIGHT MARK, which is
   * neither whitespace nor in the forbidden set, survived every step and took the save with it.
   */
  describe('a title that a file system will not take as it stands', () => {
    /** Saves a session of this page under this title and gives back the name Chrome was handed. */
    async function nameFor(title: string): Promise<string> {
      const win = await loadBridge()
      win.context(PAGE_URL, title)
      win.append(initBytes)
      win.append(seg1Bytes)

      await win.save(keyFor(PAGE_URL))

      expect(win.downloads, 'no download was started').toHaveLength(1)
      return win.downloads[0]!.filename
    }

    it('leaves no bidirectional mark in the name', async () => {
      // A title in Arabic or Hebrew carries these by the handful, and a page writes them into a
      // Latin title too — YouTube marks the direction around a channel name.
      const name = await nameFor('\u200eНовости\u200f — \u202bэфир\u202c')

      expect(name).toBe('Новости — эфир.mp4')
    })

    it('leaves no zero-width character in the name', async () => {
      const name = await nameFor('A\u200bB\u200cC\u200dD\ufeffE')

      // Invisible and removed rather than turned into a space: they stand between letters of one
      // word as often as between words, and a gap where the eye sees none is a name nobody asked
      // for.
      expect(name).toBe('ABCDE.mp4')
    })

    it('leaves no control character in the name, of either range', async () => {
      // C0 is already cut; C1 — the range above DEL — arrives from pages served in a legacy
      // encoding and is refused by Chrome exactly as C0 is.
      const name = await nameFor('Se\u0001rie\u007fs\u0085 o\u009fne')

      expect(name).toBe('Se rie s o ne.mp4')
    })

    it('saves a title of nothing but invisible characters under the name of the extension', async () => {
      const name = await nameFor('\u200e\u200b\u202a\u202c\ufeff')

      // Cleaned out, such a title is an empty name, and an empty name is no name for a file.
      expect(name).toBe('tailcut.mp4')
    })

    it('does not cut a title of emoji in the middle of a character', async () => {
      // One letter and then emoji, so that the hundredth code unit falls between the halves of
      // one of them: every emoji is a pair of surrogates, and a name holding half a pair is not
      // valid Unicode — Chrome refuses it exactly as it refuses a control character.
      const name = await nameFor(`a${'🎬'.repeat(200)}`)

      expect(name, `a lone surrogate in the name: ${JSON.stringify(name)}`).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      )
      expect(name.endsWith('.mp4')).toBe(true)
    })

    it('keeps a name inside the byte limit of a file system, not only the character limit', async () => {
      const name = await nameFor('語'.repeat(300))

      // A file system counts its limit in bytes and a page title is counted in characters: one
      // character of this title is three bytes, so a hundred of them are three hundred — past
      // what the common limits allow, and the download is refused with the popup saying nothing
      // to the point.
      expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(204)
      expect(name.endsWith('.mp4')).toBe(true)
      expect(name.length, 'the title was thrown away instead of being cut').toBeGreaterThan(10)
    })

    it('keeps the emoji that do fit, rather than throwing the title away', async () => {
      const name = await nameFor('🎬 Ночной эфир')

      expect(name).toBe('🎬 Ночной эфир.mp4')
    })
  })

  it('lets Chrome make a name of its own for the second file of the same title', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, 'Clip')
    win.append(initBytes)
    win.append(seg1Bytes)

    await win.save(keyFor(PAGE_URL))

    // A feed leaves a session per video behind and their titles collide as a matter of course —
    // and so do two long titles that differ past the length limit. Said out loud rather than left
    // to the default: the alternative is the second save overwriting the first file in silence.
    expect(win.downloads[0]).toMatchObject({ conflictAction: 'uniquify' })
  })

  it('reports a started download into the port of the request', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    const reply = await win.save(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: true }])
  })

  it('refuses an unknown key instead of trying to download nothing, and says which refusal it is', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    // The page was reloaded while the popup was open: its key points at nothing.
    const reply = await win.save('no such session')

    expect(reply.received).toEqual([{ ok: false, reason: 'gone' }])
    expect(win.downloads, 'the bridge downloaded a session that does not exist').toEqual([])
  })

  it('refuses a session of one init segment instead of a file without a frame', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)

    // The player opened the stream and loaded nothing: there are no runs on the map. There is
    // nowhere to take the longest one from, and the file would come out of a header alone. The
    // session is right there in the registry, so «it may be gone from the page» would be a lie.
    const reply = await win.save(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: false, reason: 'empty' }])
    expect(win.downloads).toEqual([])
  })

  it('refuses a session it can make no file of instead of downloading nothing', async () => {
    const win = await loadBridge()
    win.context()
    win.append(muxedInitBytes)
    for (const segment of muxedBytes) win.append(trafsRenumbered(segment, 9))

    // Material the parser can make nothing of: every fragment names a track the init never
    // declared, so not one sample can be placed. The map knows nothing of that — it reads the
    // times out of the moof and reports sixteen kilobytes to save — and the writer answers with
    // no bytes at all. Handed on, that is a file of zero length: no player opens it and nothing
    // is said. It is not the empty session either, so it is owed the other word of the two.
    const reply = await win.save(keyFor(PAGE_URL, ['avc1', 'mp4a']))

    expect(reply.received).toEqual([
      { ok: false, reason: 'refused', detail: 'the recorded material could not be read' },
    ])
    expect(win.downloads, 'the bridge downloaded a file of nothing').toEqual([])
  })

  it('carries a refusal by Chrome to the popup as a refusal by Chrome', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    win.failDownloads()

    // No space on the disk, no write permission for the downloads directory, a name the file
    // system will not take, a user cancel. Answered as a plain «false» it was indistinguishable
    // from a session that had been evicted, and the popup told the user the recording was gone
    // while it sat in the registry untouched.
    const reply = await win.save(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: false, reason: 'refused', detail: 'Download failed' }])
  })

  it('says what Chrome said, and does not invent a detail when Chrome gave none', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    win.failDownloads('')

    const reply = await win.save(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: false, reason: 'refused' }])
  })

  it('reads a refusal by Chrome instead of leaving it to the frame console', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    win.failDownloads()

    await win.save(keyFor(PAGE_URL))

    // Chrome hands a refusal over through chrome.runtime.lastError and, if the callback did not
    // read it, writes about it itself: the console of the bridge frame fills with "Unchecked
    // runtime.lastError" — errors of the extension by the look of them, where all is handled.
    expect(win.uncheckedErrors, 'the download refusal was left unread').toEqual([])
  })

  it('keeps the blob address alive while Chrome reads the file and revokes it after', async () => {
    vi.useFakeTimers()
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    await win.save(keyFor(PAGE_URL))

    // An address revoked at once cuts a started download off: Chrome reads a blob slowly.
    vi.advanceTimersByTime(59_000)
    expect(win.revoked, 'the blob address was revoked while Chrome was still reading').toEqual([])

    vi.advanceTimersByTime(1_000)
    // One never revoked at all keeps the built file in the frame memory for the page lifetime.
    expect(win.revoked, 'the blob address was not revoked: the file stayed in memory').toEqual([
      win.downloads[0]!.url,
    ])
  })

  it('revokes the blob address at once after a refusal', async () => {
    vi.useFakeTimers()
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    win.failDownloads()

    await win.save(keyFor(PAGE_URL))
    vi.advanceTimersByTime(0)

    // There will be no download and nobody to read the blob — no reason to hold it a minute.
    expect(win.revoked).toEqual([win.downloads[0]!.url])
  })

  it('does not break on a save request without a channel to answer through', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    expect(() => win.deliver({ type: 'tc:save', key: keyFor(PAGE_URL) })).not.toThrow()
    // The build is awaited inside the bridge, so the download starts a microtask later; what is
    // under test is that nobody threw for want of somebody to answer.
    await Promise.resolve()
    await Promise.resolve()
    expect(win.downloads, 'the download did not start').toHaveLength(1)
  })

  it('answers tc:save into the channel alone, not into the sender window', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    const reply = port()
    const sender = win.deliver({ type: 'tc:save', key: keyFor(PAGE_URL) }, { ports: [reply] })
    await Promise.resolve()
    await Promise.resolve()

    // An answer into the window would tell any page that the extension has something on it.
    expect(sender.posts, 'the save answer went into the page window').toEqual([])
    expect(reply.received).toEqual([{ ok: true }])
  })
})

/**
 * The other button, and the refusals nobody was reading.
 *
 * A freeze answers three different noes — the session is gone, it holds nothing to cut, the
 * storage would not take the file — and the popup has a sentence for each. Not one of the three
 * was executed by any test: the branches could all be deleted and the set stayed green, while
 * the user would be shown the wrong sentence about a session that is recording on.
 */
/** The index of a snapshot the bridge wrote: the footer read back, then the index behind it. */
function indexOf(file: Uint8Array) {
  const footer = decodeFooter(file.subarray(file.byteLength - FOOTER_BYTES), file.byteLength)
  expect(footer, 'the snapshot has no sound footer: the write was cut off').not.toBeNull()
  const at = footer!.index
  const index = decodeIndex(file.subarray(at.at, at.at + at.length))
  expect(index, 'the index of the snapshot does not parse').not.toBeNull()
  return index!
}

describe('the bridge freezes a session into a snapshot', () => {
  it('writes the material out and answers with the name of the file', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    win.append(seg2Bytes)

    const reply = await win.edit(keyFor(PAGE_URL))
    const answer = reply.received[0] as EditResult

    expect(answer.ok, 'the freeze was refused over material a save writes a file from').toBe(true)
    expect(isSnapshotId(answer.snapshotId ?? ''), 'the name is not one the extension mints').toBe(
      true,
    )

    // One file, under the name the answer gave: the editor opens by that name and nothing else.
    expect(win.writes.map((write) => write.path)).toEqual([snapshotPath(answer.snapshotId!)])

    const index = indexOf(win.writes[0]!.bytes)
    expect(index.id).toBe(answer.snapshotId)
    expect(index.page.url).toBe(PAGE_URL)
    expect(index.page.title).toBe(PAGE_TITLE)
    // The two fragments the page poured in, in the order the map holds them.
    expect(index.tracks).toHaveLength(1)
    expect(index.tracks[0]!.chunks).toHaveLength(2)
  })

  it('refuses an unknown key as a session that is gone, and writes nothing', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    // Triage evicted it, or the page reloaded under the open popup: the key points at nothing.
    const reply = await win.edit('no such session')

    expect(reply.received).toEqual([{ ok: false, reason: 'gone' }])
    expect(win.writes, 'a snapshot of a session that does not exist reached the storage').toEqual(
      [],
    )
  })

  it('refuses a session of one init segment as empty, and writes nothing', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)

    // The player opened the stream and loaded nothing. The session is right there in the
    // registry, so "it may be gone from the page" would be a lie; and a snapshot of it would
    // open the editor on an empty timeline.
    const reply = await win.edit(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: false, reason: 'empty' }])
    expect(win.writes, 'a snapshot with nothing in it reached the storage').toEqual([])
  })

  it('says the storage refused when the write did not land', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    win.refuseStorage()

    // OPFS is best-effort and refuses for reasons no page controls: no quota left, a handle it
    // would not open, a worker that died. Answered as anything else, the popup would send the
    // user to a tab addressed to a file that was never written.
    const reply = await win.edit(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: false, reason: 'storage' }])
    // The attempt was made: this is a refusal by the storage and not a refusal to try.
    expect(win.writes).toHaveLength(1)
  })

  it('leaves the recording running, and the material behind it whole', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    await win.edit(keyFor(PAGE_URL))
    win.append(seg2Bytes)
    await win.save(keyFor(PAGE_URL))

    // The snapshot is copied out of the map and the copy is what the worker gets. Hand over the
    // captured segments themselves and the transfer neuters them: the page goes on recording
    // into buffers of zero length, and the next Save all writes a file of nothing.
    const saved = await win.savedBytes()
    // One mdat and not one per fragment: the progressive writer lays every sample of a track down
    // in a single chunk. What the digest watches is that the coded bytes are still there at all —
    // a neutered buffer comes back as a fragment of nothing, and the file is short by its length.
    const media = mediaOf(saved)
    expect(media).toHaveLength(1)
    expect(digest(...media), 'the saved file is not the two fragments the page poured in').toBe(
      digest(mediaOf(seg1Bytes)[0]!, mediaOf(seg2Bytes)[0]!),
    )
  })
})

describe('the bridge tells apart the buffers of one media source', () => {
  /** Both tracks of one clip, appended the way a player does it. */
  function feedBothTracks(win: ReturnType<typeof installWindow>): void {
    // The order of real YouTube: the SourceBuffer for sound is created first, and the init of
    // the picture arrives second.
    win.append(audioInitBytes, 's1', 'b2')
    win.append(initBytes, 's1', 'b1')
    for (const [index, video] of [seg1Bytes, seg2Bytes, seg3Bytes].entries()) {
      win.append(video, 's1', 'b1')
      win.append(audioBytes[index]!, 's1', 'b2')
    }
    win.append(audioBytes[3]!, 's1', 'b2')
  }

  /** Everything the two tracks of the fixture add up to. */
  const allBytes = [seg1Bytes, seg2Bytes, seg3Bytes, ...audioBytes].reduce(
    (total, part) => total + part.byteLength,
    0,
  )

  it('collects both tracks of one video into one session', async () => {
    const win = await loadBridge()
    win.context()

    feedBothTracks(win)

    // bufferId is in the protocol and the hook sets one per SourceBuffer; drop it on the way to
    // the registry and the two tracks of one clip fall apart into two sessions, of which the
    // popup shows one — and the fragments of both pile onto its single map.
    //
    // Six seconds is what can be cut out: the picture holds 0…6, the sound 0…6.0232. The
    // fragments of the sound counted by the timescale of the picture would stretch the same six
    // seconds into twenty-two.
    expect(win.list()).toEqual([
      {
        key: keyFor(PAGE_URL, ['avc1', 'mp4a']),
        url: PAGE_URL,
        title: PAGE_TITLE,
        lastAt: expect.any(Number),
        duration: 6,
        bytes: allBytes,
      },
    ])
  })

  it('keeps every byte of both tracks', async () => {
    const win = await loadBridge()
    win.context()

    feedBothTracks(win)

    // On one shared map the first fragment of the picture and the first fragment of the sound
    // both start at zero, and the deduplication rule of the map destroys one of them.
    expect(win.list()[0]!.bytes).toBe(allBytes)
  })

  it('saves both tracks of a two-track session, described by one moov', async () => {
    const win = await loadBridge()
    win.context()
    feedBothTracks(win)

    await win.save(keyFor(PAGE_URL, ['avc1', 'mp4a']))

    const file = await win.savedBytes()
    const moov = topLevelBoxes(file).find((box) => box.type === 'moov')!

    // The moov of one track with the material of both is what made the decoder fall over on the
    // first mdat of the sound: the file has to describe every track it carries.
    expect(childBoxes(file, moov).filter((box) => box.type === 'trak')).toHaveLength(2)

    // One mdat and not one per fragment, and the writer gives each track a chunk of its own:
    // the picture whole, then the sound whole. On a file opened from disk this costs nothing —
    // a player reads it by range — and every coded byte is still there, in decode order.
    const media = mediaOf(file)
    expect(media).toHaveLength(1)
    expect(digest(...media)).toBe(
      digest(
        ...mediaOf(seg1Bytes),
        ...mediaOf(seg2Bytes),
        ...mediaOf(seg3Bytes),
        ...mediaOf(audioBytes[0]!),
        ...mediaOf(audioBytes[1]!),
        ...mediaOf(audioBytes[2]!),
        ...mediaOf(audioBytes[3]!),
      ),
    )
  })
})

describe('the bridge and a page playing an ordinary file', () => {
  const CLIP = 'https://cdn.example/clip.mp4'
  const SOURCE = `plain:${CLIP}`

  /** What the content script sends on for such an element; see PlainSource in the protocol. */
  const plain = (buffered: Array<[number, number]> = [[0, 6]]) => ({
    type: 'tc:plain',
    sourceId: SOURCE,
    url: CLIP,
    durationSeconds: 6,
    buffered,
  })

  /**
   * Lets whatever reads the bridge has started land before the list is asked for.
   *
   * Turns of the timer queue and not of the microtask queue: reading a body off a Response is
   * real asynchronous work, and a wait made of resolved promises alone comes back before the
   * first read has finished.
   */
  const settle = async () => {
    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 1))
  }

  it('reads nothing of the file until triage has promoted it', async () => {
    const host = installHost()
    const win = await loadBridge()
    win.context()

    win.deliver(plain())
    win.deliver(plain([[0, 4]]))
    await settle()

    // The page said it is playing a file; nothing was fetched and nothing is offered. Ten of the
    // eighteen measured pages that deliver a plain file hold nothing but muted looping previews.
    expect(host.asked).toEqual([])
    expect(win.list()).toEqual([])
  })

  it('says in the answer that a file it was watching could not be read', async () => {
    const host = installHost()
    const win = await loadBridge()
    win.context()

    host.refuse()
    win.deliver(plain())
    win.deliver({ type: 'tc:verdict', sourceId: SOURCE, verdict: 'promote' })
    await settle()

    // Somebody watched a video and there is nothing to offer for it. Answered with an empty list
    // alone, the popup says "nothing recorded on this page yet" — the words for a page that holds
    // no video at all — and the user waits for a recording that is never coming.
    const answer = win.answer()
    expect(answer.sessions).toEqual([])
    expect(answer.unreadableFile).toBe(true)
  })

  it('says nothing of the sort while every file it opened could be read', async () => {
    installHost()
    const win = await loadBridge()
    win.context()

    win.deliver(plain())
    win.deliver({ type: 'tc:verdict', sourceId: SOURCE, verdict: 'promote' })
    await settle()

    expect(win.answer().unreadableFile).toBe(undefined)
  })

  it('turns a promoted file into a session the popup can save', async () => {
    const host = installHost()
    const win = await loadBridge()
    win.context()

    win.deliver(plain())
    win.deliver({ type: 'tc:verdict', sourceId: SOURCE, verdict: 'promote' })
    await settle()

    // Two ranged reads of a few kilobytes: the front of the file, and the movie box behind the
    // material. Not a byte of the material itself until somebody asks for a file.
    expect(host.asked).toEqual(['bytes=0-8191', 'bytes=14681-18002'])

    const [session] = win.list()
    expect(session).toBeDefined()
    // Signed with the page, like any other session, and keyed by the address of the material.
    expect(session!.url).toBe(PAGE_URL)
    expect(session!.title).toBe(PAGE_TITLE)
    expect(session!.key).toBe(sessionKey({ url: CLIP, codecs: ['avc1', 'mp4a'], durationSeconds: 6 }))
    expect(session!.duration).toBeGreaterThan(5.5)

    const reply = await win.save(session!.key)
    await settle()

    // One more read for the material, and a file. Nothing above this line asked which kind of
    // session it was looking at.
    expect(host.asked).toHaveLength(3)
    expect(reply.received).toEqual([{ ok: true }])
    expect(win.downloads[0]!.filename).toBe(`${PAGE_TITLE}.mp4`)

    const saved = await win.savedBytes()
    expect(topLevelBoxes(saved).map((box) => box.type)).toEqual(['ftyp', 'moov', 'mdat'])
  })

  /**
   * Edit, on the kind of session eighteen of twenty-one measured pages actually deliver.
   *
   * It used to answer "there is nothing to edit in this session yet" over every one of them,
   * beside a Save all button that saved the same file perfectly: a plain session keeps no tracks
   * in the registry — the material was never intercepted — so the freeze laid out nothing and
   * called the session empty. The material is fetched instead, exactly as a save fetches it, and
   * the file goes into the snapshot whole.
   */
  describe('freezing one for the editor', () => {
    /** Opens a page playing the file and lets triage promote it, as the tests above do. */
    const watching = async () => {
      const host = installHost()
      const win = await loadBridge()
      win.context()

      win.deliver(plain())
      win.deliver({ type: 'tc:verdict', sourceId: SOURCE, verdict: 'promote' })
      await settle()

      return { host, win, key: win.list()[0]!.key }
    }

    it('writes the file into the snapshot, with the tables the editor reads', async () => {
      const { host, win, key } = await watching()

      const reply = await win.edit(key)
      await settle()
      const answer = reply.received[0] as EditResult

      expect(answer.ok, 'Edit refused a file that Save all writes perfectly').toBe(true)
      expect(win.writes.map((write) => write.path)).toEqual([snapshotPath(answer.snapshotId!)])
      // One read of the material on top of the two the tables cost, and no more: the freeze
      // fetches what the popup already promised to save, once.
      expect(host.asked).toHaveLength(3)

      const index = indexOf(win.writes[0]!.bytes)
      expect(index.tracks).toHaveLength(1)

      const track = index.tracks[0]!
      expect(track.kinds).toEqual(['video', 'audio'])
      // One stretch of media time, on the clock of the file that was written: it is continuous
      // from end to end, because the cut behind it took one unbroken run of the material.
      expect(track.chunks).toHaveLength(1)
      expect(track.chunks[0]!.start).toBe(0)
      expect(track.chunks[0]!.end).toBeGreaterThan(5.5)

      const whole = track.whole
      expect(whole, 'the snapshot does not say it holds a whole file').toBeDefined()
      expect(track.chunks[0]!.data).toEqual(whole)

      const file = win.writes[0]!.bytes.subarray(whole!.at, whole!.at + whole!.length)
      expect(topLevelBoxes(file).map((box) => box.type)).toEqual(['ftyp', 'moov', 'mdat'])

      // And the tables are where the index says, and they describe the material where it lies in
      // the snapshot. This is the whole of what the editor does with such a track.
      const moov = win.writes[0]!.bytes.subarray(track.init.at, track.init.at + track.init.length)
      const tracks = movieTracksOf(moov, whole!.length, whole!.at)
      expect(tracks.map((one) => one.kind)).toEqual(['video', 'audio'])
      expect(tracks[0]!.samples).toHaveLength(60)
      for (const sample of tracks[0]!.samples) {
        expect(sample.source.at).toBeGreaterThanOrEqual(whole!.at)
        expect(sample.source.at + sample.source.length).toBeLessThanOrEqual(whole!.at + whole!.length)
      }
    })

    it('says a file it could not read could not be read, and writes nothing', async () => {
      const { host, win, key } = await watching()

      // The host goes away between the listing and the button: an expired signed URL, a session
      // that ended. Neither "gone" — the session is right there — nor "empty": the material
      // exists and it was the fetching of it that failed.
      host.refuse()
      const reply = await win.edit(key)
      await settle()

      expect(reply.received).toEqual([{ ok: false, reason: 'unread' }])
      expect(win.writes).toEqual([])
    })

    it('refuses a file the element holds not one frame of, as an empty session', async () => {
      const host = installHost()
      const win = await loadBridge()
      win.context()

      // The metadata arrived and the material has not: the tables are readable and there is no
      // stretch of them the element actually holds.
      win.deliver(plain([]))
      win.deliver({ type: 'tc:verdict', sourceId: SOURCE, verdict: 'promote' })
      await settle()

      const key = win.list()[0]!.key
      const before = host.asked.length
      const reply = await win.edit(key)
      await settle()

      expect(reply.received).toEqual([{ ok: false, reason: 'empty' }])
      expect(win.writes).toEqual([])
      // Refused before anything was fetched: a freeze that cannot produce a file must not pay
      // for the material first.
      expect(host.asked).toHaveLength(before)
    })

    it('says the storage refused when the write did not land', async () => {
      const { win, key } = await watching()
      win.refuseStorage()

      const reply = await win.edit(key)
      await settle()

      expect(reply.received).toEqual([{ ok: false, reason: 'storage' }])
      expect(win.writes, 'the attempt was never made').toHaveLength(1)
    })
  })

  it('answers a save it cannot read with a refusal and not with an empty session', async () => {
    const host = installHost()
    const win = await loadBridge()
    win.context()

    win.deliver(plain())
    win.deliver({ type: 'tc:verdict', sourceId: SOURCE, verdict: 'promote' })
    await settle()

    const key = win.list()[0]!.key
    // The host goes away between the listing and the button — an expired signed URL, a session
    // that ended. The recording is still there and what failed was fetching it, so the words are
    // those of a refused download and not those of an empty session.
    host.refuse()

    const reply = await win.save(key)
    await settle()

    expect(win.downloads).toEqual([])
    expect(reply.received).toEqual([
      { ok: false, reason: 'refused', detail: 'the file could not be read' },
    ])
  })
})

describe('the word that this frame is recording', () => {
  /** Every tc:recording the bridge has sent its parent, in order. */
  const notices = (win: ReturnType<typeof installWindow>): unknown[] =>
    win.parent.posts.map((post) => post.message).filter((message) => variantOf(message) === 'tc:recording')

  it('goes out as soon as the registry holds something', async () => {
    const win = await loadBridge()
    win.context()

    win.append(initBytes)

    // The badge is counted out of the registries of a tab's frames, and asking every frame of
    // every tab cost 154 injections and 154 messages on one news page. A frame that has something
    // says so, and the badge asks those and the main one.
    expect(notices(win)).toEqual([{ type: 'tc:recording' }])
  })

  it('stays unsaid while there is nothing in here to count', async () => {
    const win = await loadBridge()
    win.context()

    // A frame with no player in it — 153 of the 154 on that page. The check costs one comparison
    // per message and nothing at all goes out.
    expect(notices(win)).toEqual([])
  })

  it('stays unsaid on the clock as well, in a frame that holds nothing', async () => {
    vi.useFakeTimers()
    const win = await loadBridge()
    win.context()

    await vi.advanceTimersByTimeAsync(60_000)

    // 153 of the 154 frames of that news page. A clock that spoke out of every one of them would
    // wake the service worker six times a minute per frame — the very cost this mechanism was
    // put in to remove, paid again from the other end.
    expect(notices(win)).toEqual([])
  })

  it('is not repeated for every segment of a page that is playing', async () => {
    const win = await loadBridge()
    win.context()

    win.append(initBytes)
    win.append(seg1Bytes)
    win.append(seg2Bytes)

    // The badge is recounted every ten seconds, so a word per segment would be a word nobody
    // acts on — and this is the very traffic the change was made to end.
    expect(notices(win)).toHaveLength(1)
  })

  it('stays unsaid on a page that was refused', async () => {
    const win = await loadBridge()
    win.context()

    win.append(cencInitBytes, 's1')

    // Everything gathered is dropped and nothing more is taken in (§5.4): there is no session
    // here, and a frame the badge asked would answer with the refusal and nothing to count.
    expect(notices(win)).toEqual([])
  })

  it('is said again while nothing arrives, for the worker that has forgotten it', async () => {
    vi.useFakeTimers()
    const win = await loadBridge()
    win.context()

    win.append(initBytes)
    expect(notices(win)).toHaveLength(1)

    // Nothing more arrives here: the clip is buffered to its end, or the user has paused it. That
    // is the ordinary state of a page somebody is about to save from, and it used to be the state
    // in which the badge quietly lost the recording.
    //
    // The service worker keeps what it is told in memory and nowhere else. Chrome stops it after
    // half a minute of idling and starts it again on the next alarm, and the instance that comes
    // back has been told nothing: it asks the main frame, which on a page whose player sits in an
    // embed has nothing to answer. So the word has to be repeated by the clock and not by the
    // traffic — a frame that has gone quiet is exactly the frame that has to keep saying it.
    await vi.advanceTimersByTimeAsync(30_000)

    expect(
      notices(win).length,
      'a frame that has stopped appending never says again that it is recording',
    ).toBeGreaterThan(1)
  })

  it('goes out when a file becomes a session after its tables have been read', async () => {
    installHost()
    const win = await loadBridge()
    win.context()

    const clip = 'https://cdn.example/clip.mp4'
    const source = `plain:${clip}`
    win.deliver({ type: 'tc:plain', sourceId: source, url: clip, durationSeconds: 6, buffered: [[0, 6]] })
    win.deliver({ type: 'tc:verdict', sourceId: source, verdict: 'promote' })
    // The read is the one step of the registry that is not immediate.
    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 1))

    // A file fully downloaded before triage promoted it: the page says nothing more about it
    // afterwards, so the read landing is the last moment there is to say anything at all. Without
    // it a file watched to the end is recorded, offered in the popup, and never counted.
    expect(notices(win)).toEqual([{ type: 'tc:recording' }])
    expect(win.list()).toHaveLength(1)
  })
})

describe('the recording switch of §9.4', () => {
  /** The settings as the settings page would store them: one key, the whole of them under it. */
  const denying = (...hosts: string[]) => ({
    recording: { mode: 'all', bufferSeconds: 180, allow: [], deny: hosts },
  })

  it('works out whether this page is recorded when the address arrives, and says so', async () => {
    const win = await loadBridge()

    expect(win.switches(), 'setup: nothing is decided before the address is known').toEqual([])

    win.context()

    // The hook copies until it is told otherwise, so this is the frame answering for the page it
    // turned out to be standing on.
    expect(win.switches()).toEqual([true])
  })

  it('says nothing before the address has arrived, whatever the settings say', async () => {
    // A page with a strict referrer policy: the frame stands on the extension origin and knows
    // nothing at all about where it is until tc:context.
    const win = await loadBridge('', denying('site.example'))

    // "Not known yet" and "cannot be read" are two different states. siteAllows refuses an
    // address it cannot read — rightly, for about:blank — and answering that refusal before the
    // handshake has landed would switch the frame off on every page that strips its referrer.
    expect(win.switches()).toEqual([])
  })

  it('keeps the material that arrived before the address did', async () => {
    const win = await loadBridge('')

    // The order of a real page: the hook copies from document_start, and the init segment of a
    // track goes past in the first second — once, never repeated. The content script's context
    // arrives when it arrives.
    win.append(initBytes)
    win.append(seg1Bytes)
    win.context()

    // Switched off on `settings.ready` instead, the frame would have paused intake over an empty
    // address, and letting the readers go on the way back in would have taken this init with it:
    // the session would be unreadable for good over a message ordering.
    expect(win.list()).toHaveLength(1)
    expect(win.list()[0]!.bytes).toBeGreaterThan(0)
  })

  it('records nothing on a page the settings forbid, and says so once', async () => {
    const win = await loadBridge(REFERRER, denying('site.example'))

    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    expect(win.switches()).toEqual([false])
    expect(win.list(), 'a forbidden page was recorded all the same').toEqual([])
  })

  it('turns the recording back on inside the page when the user allows the site again', async () => {
    const win = await loadBridge(REFERRER, denying('site.example'))
    win.context()
    win.append(initBytes)
    expect(win.list(), 'setup: the page was recorded while it was forbidden').toEqual([])

    await win.settings((current) => ({
      ...current,
      recording: { ...current.recording, deny: [] },
    }))

    win.append(initBytes)
    win.append(seg1Bytes)

    // No reload and no navigation: the settings page is a tab of its own, and a user who changes
    // a setting while a video is playing is changing it about that video.
    expect(win.switches()).toEqual([false, true])
    expect(win.list()).toHaveLength(1)
  })

  it('stops the recording inside the page when the user forbids the site', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    const before = win.list()[0]!

    await win.settings((current) => ({
      ...current,
      recording: { ...current.recording, deny: ['site.example'] },
    }))

    win.append(seg2Bytes)

    // What was recorded stays exactly where it was (§7.2): a switch is not an erasure, and the
    // user who turns recording off over a video they have been watching still has that video.
    const after = win.list()
    expect(win.switches()).toEqual([true, false])
    expect(after).toHaveLength(1)
    expect(after[0]!.bytes).toBe(before.bytes)
    expect(after[0]!.duration).toBe(before.duration)
  })

  it('keeps recording into memory when the history to disk is switched off', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    const before = win.list()[0]!

    await win.settings((current) => ({
      ...current,
      history: { ...current.history, toDisk: false },
    }))

    win.append(seg2Bytes)

    // `Save recordings to disk` is about the disk and about nothing else. What the frame is
    // holding stays where it is, what arrives after the switch is still taken in, and the hook is
    // not told to stop copying — the buffer of §7.2 is the popup's to offer whether or not any of
    // it outlives the tab. What does go is the batch the writer had gathered and not yet written,
    // which is the one thing that would otherwise become a file created after the user said no
    // (see HistoryWriter.setEnabled).
    //
    // Both numbers are named, and the sum is written out rather than compared: seg2 alone weighs
    // more than the init and seg1 together, so "heavier than before" is also what a registry
    // wiped on the switch and refilled by the next segment would say. What tells the two apart is
    // that the material before the switch is still in the total.
    const after = win.list()
    expect(after).toHaveLength(1)
    expect(after[0]!.bytes).toBe(before.bytes + seg2Bytes.byteLength)
    expect(after[0]!.duration).toBe(before.duration + 2)
    expect(win.switches(), 'the hook was told to stop copying').toEqual([true])
  })

  it('answers again when the page walks to a forbidden address without a navigation', async () => {
    const win = await loadBridge(REFERRER, denying('other.example'))
    win.context()
    expect(win.switches(), 'setup: this address is allowed').toEqual([true])

    // A single-page application loading the next video: no navigation, no reload, and the hook
    // has no idea where it now stands.
    win.context('https://other.example/watch', 'Elsewhere')

    expect(win.switches()).toEqual([true, false])
  })

  it('says it once while the answer does not change', async () => {
    const win = await loadBridge()

    win.context()
    win.context(`${PAGE_URL}&t=42`, 'The same clip, rewound')
    await win.settings((current) => ({
      ...current,
      history: { ...current.history, keepDays: 30 },
    }))

    // A word per context poll would be a message twice a second into the page's own window, and
    // a word per unrelated setting would put one there every time a slider moves.
    expect(win.switches()).toEqual([true])
  })

  it('carries the bit and never the settings', async () => {
    const win = await loadBridge(REFERRER, {
      recording: { mode: 'allowlist', bufferSeconds: 180, allow: ['site.example'], deny: [] },
    })

    win.context()

    // The MAIN world is the page's own realm: everything that reaches it, the page can read. The
    // list of domains a user allowed or forbade is a list of what they watch, and the hook needs
    // none of it — it needs "copy or do not".
    expect(win.said().filter((message) => variantOf(message) === 'tc:record')).toEqual([
      { type: 'tc:record', on: true },
    ])
  })
})

describe('the frame keeps the buffer length and the memory ceiling on its own clock', () => {
  it('trims to the length the settings say and drops what is over the ceiling, every tick', async () => {
    vi.useFakeTimers()
    const win = await loadBridge()
    // The registry the frame built is an instance of this very class: `loadBridge` resets the
    // module registry and imports the bridge, so an import made after it lands in the same one.
    // Watched from the prototype, because the store itself belongs to the bridge and to nobody
    // else — what is checked here is that the tick asks for both halves of §7.2 and with what.
    const { SessionStore } = await import('../../src/bridge/session-store')
    const trims = vi.spyOn(SessionStore.prototype, 'trimToBuffer')
    const drops = vi.spyOn(SessionStore.prototype, 'dropOverCeiling')

    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    await win.settings((current) => ({
      ...current,
      recording: { ...current.recording, bufferSeconds: 30 },
    }))

    // One period of the frame's eviction clock (EVICT_INTERVAL_MS in the bridge).
    vi.advanceTimersByTime(2_000)

    // The buffer length as it stands now, and no position: the newest end of each session is the
    // position, and the frame has no playhead to offer (see trimToBuffer).
    expect(trims.mock.calls, 'the buffer length is not enforced anywhere else').toEqual([[30]])

    // And the other half of the same tick. Nothing takes the ceiling for it, and nothing else in
    // the frame is watching how much it holds — without this call a page opening session after
    // session grows until the tab dies.
    expect(drops).toHaveBeenCalledTimes(1)
    const [ceiling, now] = drops.mock.calls[0]!
    expect(now, 'the value of a session is ranked by the wall clock').toBe(Date.now())
    // Room for several sessions of a default buffer, and not a number that would empty the frame
    // every two seconds: the two lines under it are what that would look like from the outside.
    expect(ceiling).toBeGreaterThan(128 * 1024 * 1024)
    expect(win.list()).toHaveLength(1)
    expect(win.list()[0]!.duration).toBe(2)
  })

  it('raises the ceiling with the buffer, so the length the user set can be held', async () => {
    vi.useFakeTimers()
    const win = await loadBridge()
    const { SessionStore } = await import('../../src/bridge/session-store')
    const drops = vi.spyOn(SessionStore.prototype, 'dropOverCeiling')

    win.context()
    // The longest buffer the setting takes, which the slider of §9.4 offers.
    await win.settings((current) => ({
      ...current,
      recording: { ...current.recording, bufferSeconds: LIMITS.bufferSeconds.max },
    }))

    vi.advanceTimersByTime(2_000)

    // A flat ceiling is a promise the frame then refuses to keep: at 512 MiB one ordinary 1080p
    // session passes it at about eleven minutes, and half an hour of buffer meant the recording
    // being thrown away and begun again every few minutes while the page showed the length as
    // set. The ceiling is that length in bytes plus room for the other sessions of the frame.
    const [ceiling] = drops.mock.calls.at(-1)!
    expect(ceiling).toBe(memoryCeilingFor(LIMITS.bufferSeconds.max))
    expect(ceiling).toBeGreaterThan((LIMITS.bufferSeconds.max * REFERENCE_BITS_PER_SECOND) / 8)
  })
})
