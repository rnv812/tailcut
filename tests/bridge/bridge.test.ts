import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { sessionKey } from '../../src/core/session-key'
import { boxBody, childBoxes, topLevelBoxes } from '../../src/core/iso/reader'
import type { BridgeToPage, SessionList, SessionSummary } from '../../src/shared/protocol'

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
const audioInitBytes = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream1.m4s'))
/** Pieces of sound: 0…1.95, 1.95…3.95, 3.95…5.97, 5.97…6.02 seconds. */
const audioBytes = [1, 2, 3, 4].map(
  (n) => new Uint8Array(readFileSync(`tests/fixtures/h264/chunk-stream1-0000${n}.m4s`)),
)

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
type Download = { url: string; filename: string }

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
const OMISSIONS = ['track', 'rendition', 'gap']

/** A session summary by the facts: postMessage has no types, so the value has to be checked. */
function isSummary(value: unknown): value is SessionSummary {
  if (typeof value !== 'object' || value === null) return false
  const summary = value as Record<string, unknown>
  const known = ['key', 'url', 'title', 'duration', 'bytes', 'omits']
  return (
    Object.keys(summary).every((field) => known.includes(field)) &&
    typeof summary.key === 'string' &&
    typeof summary.url === 'string' &&
    typeof summary.title === 'string' &&
    typeof summary.duration === 'number' &&
    typeof summary.bytes === 'number' &&
    // Absent on a session the file will hold whole; one of the declared reasons otherwise.
    (summary.omits === undefined || OMISSIONS.includes(summary.omits as string))
  )
}

/** The variant of the BridgeToPage union a value fits; null — it fits none of them. */
function variantOf(value: unknown): 'tc:ready' | 'session list' | null {
  if (typeof value !== 'object' || value === null) return null
  const fields = value as Record<string, unknown>

  if (fields.type === 'tc:ready' && Object.keys(fields).length === 1) return 'tc:ready'

  const known = ['sessions', 'unreachable']
  const fits =
    Array.isArray(fields.sessions) &&
    fields.sessions.every(isSummary) &&
    Object.keys(fields).every((field) => known.includes(field)) &&
    (fields.unreachable === undefined || typeof fields.unreachable === 'boolean')
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
function installWindow(referrer = REFERRER) {
  const listeners: MessageListener[] = []
  const parent = receiver()
  const top = receiver()

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

  vi.stubGlobal('chrome', {
    runtime: {
      get lastError() {
        lastErrorRead = true
        return lastError
      },
    },
    downloads: {
      download(options: Download, done: (id?: number) => void) {
        downloads.push(options)
        lastError = downloadId === undefined ? { message: 'Download failed' } : undefined
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
    /** Asks the bridge to build a file — the way the popup does through the content script. */
    save(key: string): ReturnType<typeof port> {
      const reply = port()
      deliver({ type: 'tc:save', key }, { ports: [reply] })
      return reply
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
    /** Chrome refuses the download: writing forbidden, no space, cancelled by the user. */
    failDownloads(): void {
      downloadId = undefined
    },
  }
}

/** The bridge sets its listener and says hello right when the module loads. */
async function loadBridge(referrer?: string) {
  const win = installWindow(referrer)
  vi.resetModules()
  await import('../../src/bridge/bridge')
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
    win.save(keyFor(PAGE_URL))

    // The name is read off the session at the moment of saving, and this is the whole point of
    // the title reaching it at all.
    expect(win.downloads[0]!.filename).toBe('Night broadcast.mp4')
  })

  it('coerces a non-string context to strings instead of passing it on', async () => {
    const win = await loadBridge()

    // The bridge takes tc:context from anyone on the page: any script can address it, not only
    // our content script. Nobody checked the fields, so anything at all could travel into the
    // summary of the session — the very thing the popup signs it with — right down to an object
    // that would render in the list as "[object Object]".
    win.deliver({ type: 'tc:context', url: { href: PAGE_URL }, title: 42 })
    win.append(initBytes)

    expect(win.list()).toMatchObject([{ url: '[object Object]', title: '42' }])
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

describe('the bridge refuses a page with DRM', () => {
  /** The hook reports the request for a key system the moment the player makes it. */
  const drm = (win: ReturnType<typeof installWindow>) =>
    win.deliver({ type: 'tc:drm', sourceId: 'page' })

  it('erases what the page had collected before the keys were asked for', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes, 's1')
    win.append(seg1Bytes, 's1')
    expect(win.list(), 'setup: the material has to be in the registry first').toHaveLength(1)

    drm(win)

    // The refusal comes in on its own and not through a verdict. On a page whose element the
    // watcher cannot reach — tv.apple.com plays inside a shadow root — no verdict is ever spoken,
    // and the whole of the promise "we do not record DRM" rests on this message alone.
    expect(win.list()).toEqual([])
  })

  it('keeps nothing the page appends after it', async () => {
    const win = await loadBridge()
    win.context()

    drm(win)
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

    drm(win)
    const reply = win.save(key)

    // The popup keeps the key of a session it listed a moment ago: a save by that key must find
    // nothing, and no file may reach the disk.
    expect(reply.received).toEqual([{ ok: false }])
    expect(win.downloads, 'a file of a protected page was written').toEqual([])
  })

  it('does not answer the sender of tc:drm', async () => {
    const win = await loadBridge()
    win.context()

    const sender = win.deliver({ type: 'tc:drm', sourceId: 'page' })

    expect(sender.posts, 'the bridge answered a DRM report').toEqual([])
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
    const sent: unknown[] = [...win.parent.posts.map((post) => post.message), ...reply.received]
    expect(sent.map(variantOf), 'the bridge sent a message not described in BridgeToPage').toEqual([
      'tc:ready',
      'session list',
    ])
  })

  it('takes both variants from the union, not from the ideas of the set about it', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)

    // A check by the compiler: the assignment will not pass typecheck if the union loses a
    // variant (`BridgeToPage = { type: 'tc:ready' }`, as it was before this change) or drifts
    // away from the summary the bridge actually returns.
    const handshake: BridgeToPage = { type: 'tc:ready' }
    const list: BridgeToPage = win.answer()

    expect([variantOf(handshake), variantOf(list)]).toEqual(['tc:ready', 'session list'])
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

    win.save(audioKey)

    expect(digest(...mediaOf(await win.savedBytes()))).toBe(
      digest(...mediaOf(audioBytes[2]!), ...mediaOf(audioBytes[3]!)),
    )
  })

  it('takes the long run when it is not the last one either', async () => {
    // Runs 0…3.95 and 5.97…6.02: the first one is longer. A tail of half a second is ordinary:
    // the player loaded a piece after a rewind and stopped.
    const win = await withAudio(0, 1, 3)

    win.save(audioKey)

    expect(digest(...mediaOf(await win.savedBytes()))).toBe(
      digest(...mediaOf(audioBytes[0]!), ...mediaOf(audioBytes[1]!)),
    )
  })

  it('declares the file a video, not a stream of bytes', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    // Chrome picks what to open the download with by the type of the blob;
    // application/octet-stream would send the clip into an "unknown file".
    expect(win.savedType()).toBe('video/mp4')
  })

  it('names the file after the page title with an mp4 extension', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, 'Ночной эфир')
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

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

    win.save(keyFor(PAGE_URL))

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

    win.save(keyFor(PAGE_URL))

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

    win.save(keyFor(PAGE_URL))

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

    win.save(keyFor(PAGE_URL))

    expect(win.downloads[0]!.filename).toBe(`${'ц'.repeat(99)}.mp4`)
  })

  it('saves a page without a title under the name of the extension', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, '   ')
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    expect(win.downloads[0]!.filename).toBe('tailcut.mp4')
  })

  it('cuts a long title down to a name the file system will take', async () => {
    const win = await loadBridge()
    win.context(PAGE_URL, 'ц'.repeat(300))
    win.append(initBytes)
    win.append(seg1Bytes)

    win.save(keyFor(PAGE_URL))

    expect(win.downloads[0]!.filename.length).toBeLessThanOrEqual(104)
    expect(win.downloads[0]!.filename.endsWith('.mp4')).toBe(true)
  })

  it('reports a started download into the port of the request', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    const reply = win.save(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: true }])
  })

  it('refuses an unknown key instead of trying to download nothing', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    // The page was reloaded while the popup was open: its key points at nothing.
    const reply = win.save('no such session')

    expect(reply.received).toEqual([{ ok: false }])
    expect(win.downloads, 'the bridge downloaded a session that does not exist').toEqual([])
  })

  it('refuses a session of one init segment instead of a file without a frame', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)

    // The player opened the stream and loaded nothing: there are no runs on the map. There is
    // nowhere to take the longest one from, and the file would come out of a header alone.
    const reply = win.save(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: false }])
    expect(win.downloads).toEqual([])
  })

  it('carries a refusal by Chrome to the popup as a refusal', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    win.failDownloads()

    // No space on the disk, no write permission for the downloads directory, a user cancel.
    const reply = win.save(keyFor(PAGE_URL))

    expect(reply.received).toEqual([{ ok: false }])
  })

  it('reads a refusal by Chrome instead of leaving it to the frame console', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)
    win.failDownloads()

    win.save(keyFor(PAGE_URL))

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

    win.save(keyFor(PAGE_URL))

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

    win.save(keyFor(PAGE_URL))
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
    expect(win.downloads, 'the download did not start').toHaveLength(1)
  })

  it('answers tc:save into the channel alone, not into the sender window', async () => {
    const win = await loadBridge()
    win.context()
    win.append(initBytes)
    win.append(seg1Bytes)

    const reply = port()
    const sender = win.deliver({ type: 'tc:save', key: keyFor(PAGE_URL) }, { ports: [reply] })

    // An answer into the window would tell any page that the extension has something on it.
    expect(sender.posts, 'the save answer went into the page window').toEqual([])
    expect(reply.received).toEqual([{ ok: true }])
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

  it('saves both tracks of a two-track session, interleaved by time', async () => {
    const win = await loadBridge()
    win.context()
    feedBothTracks(win)

    win.save(keyFor(PAGE_URL, ['avc1', 'mp4a']))

    const file = await win.savedBytes()
    const moov = topLevelBoxes(file).find((box) => box.type === 'moov')!

    // The moov of one track with the fragments of both is what made the decoder fall over on the
    // first mdat of the sound: the file has to describe every track it carries.
    expect(childBoxes(file, moov).filter((box) => box.type === 'trak')).toHaveLength(2)

    // Picture at 0, 2, 4 seconds and sound at 0, 1.95, 3.95, 5.97, laid out in one order of time
    // the way any multiplexed stream is.
    expect(digest(...mediaOf(file))).toBe(
      digest(
        ...mediaOf(seg1Bytes),
        ...mediaOf(audioBytes[0]!),
        ...mediaOf(audioBytes[1]!),
        ...mediaOf(seg2Bytes),
        ...mediaOf(audioBytes[2]!),
        ...mediaOf(seg3Bytes),
        ...mediaOf(audioBytes[3]!),
      ),
    )
  })
})
