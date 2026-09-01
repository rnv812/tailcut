import { describe, it, expect } from 'vitest'
import {
  bridgeCapabilityKey,
  editorUrl,
  sourceTabIdIn,
  historyUrl,
  isBridgeConnect,
  isContentToBridge,
  isExtensionToTab,
  isExtensionToWorker,
  isPageToBridge,
  isSnapshotId,
  isTabToExtension,
  snapshotFileName,
  snapshotPath,
  type BridgeToPage,
  type ContentToBridge,
  type ExtensionToTab,
  type ExtensionToWorker,
  type PageToBridge,
  type TabToExtension,
} from '../../src/shared/protocol'

const append: PageToBridge = {
  type: 'tc:append',
  sourceId: 's',
  bufferId: 'b',
  mime: 'video/mp4',
  bytes: new ArrayBuffer(4),
}
const source: PageToBridge = { type: 'tc:source', sourceId: 's', objectUrl: 'blob:https://a.test/1' }
/** A MediaSource inside a worker: announced by name, because it has no address of its own. */
const worker: PageToBridge = { type: 'tc:worker', sourceId: 'w1s1' }
/** The length the page stated for a stream: the third component of the merge key. */
const duration: PageToBridge = { type: 'tc:duration', sourceId: 's', seconds: 23.581 }
/** A <video> playing an ordinary file: no MediaSource anywhere, and an http address in currentSrc. */
const plain: PageToBridge = {
  type: 'tc:plain',
  sourceId: 'plain:https://cdn.example/clip.mp4',
  url: 'https://cdn.example/clip.mp4',
  durationSeconds: 9.48,
  buffered: [[0, 9.48]],
}
const accepted: [string, PageToBridge][] = [
  ['tc:append', append],
  ['tc:source', source],
  ['tc:worker', worker],
  ['tc:duration', duration],
  ['tc:plain', plain],
]

/** Every variant of the other side of the protocol: the bridge sends these, it does not take them. */
const bridgeToPage: [string, BridgeToPage][] = [
  ['the handshake', { type: 'tc:ready' }],
  ['the word that this frame is recording', { type: 'tc:recording' }],
  // The one bit of the settings the hook is given. It is the one message of this side that turns,
  // and the page must not be able to say it: recognised here, a site could switch its own
  // recording off — or, worse, back on over a switch the user had turned.
  ['the recording switch turned off', { type: 'tc:record', on: false }],
  ['the recording switch turned back on', { type: 'tc:record', on: true }],
  [
    'an answer with sessions in it',
    {
      sessions: [
        {
          key: 'https://site.example/watch|avc1|inf',
          url: 'https://site.example/watch',
          title: 'Clip',
          duration: 6,
          bytes: 1543,
          lastAt: 1_700_000_000_000,
          omits: 'gap',
        },
      ],
    },
  ],
  ['an answer about a page that cannot be recorded', { sessions: [], unreachable: true }],
  ['an answer about a page that plays protected media', { sessions: [], encrypted: true }],
]

/** The bridge listens to the page's window: everything the page and its scripts send lands there. */
const rejected: [string, unknown][] = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'tc:append'],
  ['a number', 42],
  ['an array', ['tc:append']],
  ['an object without a type', { sourceId: 's' }],
  ['a non-string type', { type: 1 }],
  ["somebody else's type", { type: 'webpackHotUpdate' }],
  // The page's own talk of key systems used to be a message of this protocol, and the whole of a
  // page's recording hung on it. It says nothing about the material — a news article was measured
  // asking about sixteen of them over a video that was in the clear — and a page that could still
  // send it would be able to erase its own recording by asking.
  ['a report of a key system request: the protocol no longer has one', { type: 'tc:drm', sourceId: 's' }],
  // Messages of the extension itself. The content script passes on to the bridge whatever it
  // recognised here as its own, and they arrive from the page's window — that is, from the page's
  // own scripts too. Recognise the context and any page could rewrite the address and the title
  // of a session that is not its own; recognise the list request and it would lure out the
  // browsing history.
  [
    'the page context: the content script sends that itself',
    { type: 'tc:context', url: 'https://site.example/', title: 'Clip' },
  ],
  ['a list request: it is addressed to the bridge directly', { type: 'tc:list' }],
  // The triage verdict is passed by the content script on signals from the element; the page must
  // know nothing of it at all. Recognise a verdict as its own and any page script could erase a
  // session that is not its own by posting a rejection for a foreign source into its own window.
  [
    'a triage verdict: the content script passes that',
    { type: 'tc:verdict', sourceId: 's', verdict: 'reject' },
  ],
  // The size of the player, measured by the same poll of the same isolated world. It travels the
  // same road as the verdict and for the same reason is none of the page's business: the number
  // is a value signal, and allowing a page to state it would let the page inflate a recording
  // of its own at the expense of everybody else's.
  [
    'the size of a player: the content script measures that',
    { type: 'tc:player', sourceId: 's', widthPx: 1280 },
  ],
  // The whole of the other side of the protocol: nothing the bridge sends is addressed to the
  // bridge. The content script passes on what it recognised here as its own, and the handshake
  // and the summaries arrive in that same window of the page — recognise them and the bridge's
  // answer would travel back into the bridge.
  ...bridgeToPage.map(([name, message]): [string, unknown] => [
    `an answer of the bridge: ${name}`,
    message,
  ]),
]

describe('isPageToBridge', () => {
  it.each(accepted)('lets %s through', (_name, message) => {
    expect(isPageToBridge(message)).toBe(true)
  })

  it.each(rejected)('turns %s away', (_name, value) => {
    expect(isPageToBridge(value)).toBe(false)
  })

  it('turns away a function with a fitting type: a stranger is not an object', () => {
    const fn = Object.assign(() => {}, { type: 'tc:append' })
    expect(isPageToBridge(fn)).toBe(false)
  })

  it('narrows the type down to the PageToBridge union', () => {
    const value: unknown = append
    if (!isPageToBridge(value)) throw new Error('expected tc:append')
    if (value.type !== 'tc:append') throw new Error('expected tc:append')
    expect(value.bytes.byteLength).toBe(4)
  })

  it('accepts only a finite SourceBuffer timestamp offset', () => {
    expect(isPageToBridge({ ...append, timestampOffset: 12.5 })).toBe(true)
    expect(isPageToBridge({ ...append, timestampOffset: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isPageToBridge({ ...append, timestampOffset: '12.5' })).toBe(false)
  })

  it('accepts only the sequence-mode marker the hook emits', () => {
    expect(isPageToBridge({ ...append, sequence: true })).toBe(true)
    expect(isPageToBridge({ ...append, sequence: false })).toBe(false)
    expect(isPageToBridge({ ...append, sequence: 'sequence' })).toBe(false)
  })
})

/** Requests of the popup and the service worker to the content script of a tab. */
const tabRequests: [string, ExtensionToTab][] = [
  ['a list request', { type: 'tc:list' }],
  ['a save request', { type: 'tc:save', key: 'https://site.example/watch|avc1|inf' }],
]

describe('isExtensionToTab', () => {
  it.each(tabRequests)('lets %s through', (_name, message) => {
    expect(isExtensionToTab(message)).toBe(true)
  })

  // The content script listens to chrome.runtime.onMessage: everything the popup and the service
  // worker send arrives there, messages of stages yet to come included. What it does not
  // understand it must leave to the other listeners rather than answer for the bridge.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'tc:list'],
    ['an array', [{ type: 'tc:list' }]],
    ['an object without a type', { key: 'k' }],
    ["somebody else's type", { type: 'tc:ping' }],
    ['a save without a key', { type: 'tc:save' }],
    ['a save with a non-string key', { type: 'tc:save', key: 42 }],
    // The one request of this union that carries a claim rather than an address, and the claim is
    // what it is acted on: a pause with nothing in it would be read as "start recording again" by
    // every reader that takes `on` for a boolean.
    ['a pause that says nothing', { type: 'tc:pause' }],
    ['a pause whose claim is a word', { type: 'tc:pause', on: 'true' }],
    // The page's side: these messages travel through window.postMessage and reach the content
    // script by another road. Recognise them here and the popup would get the answer to a request
    // that was never its own.
    ['a message of the hook', { type: 'tc:append', sourceId: 's', bufferId: 'b', mime: 'video/mp4' }],
    ['a triage verdict', { type: 'tc:verdict', sourceId: 's', verdict: 'reject' }],
    ['the handshake of the bridge', { type: 'tc:ready' }],
    // The other direction of the same road: the content script sends this one to the worker, and
    // it must never come back down as a request to be passed on to the bridge.
    ['the word that a frame is recording', { type: 'tc:recording' }],
  ])('turns %s away', (_name, value) => {
    expect(isExtensionToTab(value)).toBe(false)
  })

  it('narrows the type down to the ExtensionToTab union', () => {
    const value: unknown = { type: 'tc:save', key: 'k' }
    if (!isExtensionToTab(value)) throw new Error('expected tc:save')
    if (value.type !== 'tc:save') throw new Error('expected tc:save')
    expect(value.key).toBe('k')
  })
})

/** What a content script says to the service worker of its own accord: the one message there is. */
const workerNotices: [string, TabToExtension][] = [
  ['the word that this frame is recording', { type: 'tc:recording' }],
]

describe('isTabToExtension', () => {
  it.each(workerNotices)('lets %s through', (_name, message) => {
    expect(isTabToExtension(message)).toBe(true)
  })

  // The service worker hears every message any part of the extension sends: the popup's, the
  // bridge's, and those of the stages yet to come. Acting on one that is not this is acting on a
  // message meant for somebody else.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'tc:recording'],
    ['a number', 42],
    ['an array', [{ type: 'tc:recording' }]],
    ['an object without a type', { frameId: 4 }],
    ['a non-string type', { type: 7 }],
    ["somebody else's type", { type: 'tc:ping' }],
    // Requests travelling the other way, from the extension to a tab. Recognise one here and a
    // list request would count as a frame announcing itself.
    ['a list request', { type: 'tc:list' }],
    ['a save request', { type: 'tc:save', key: 'k' }],
    ['the handshake of the bridge', { type: 'tc:ready' }],
  ])('turns %s away', (_name, value) => {
    expect(isTabToExtension(value)).toBe(false)
  })

  it('narrows the type down to the TabToExtension union', () => {
    const value: unknown = { type: 'tc:recording' }
    if (!isTabToExtension(value)) throw new Error('expected tc:recording')
    expect(value.type).toBe('tc:recording')
  })
})

/**
 * One message of every kind `PageToBridge` and `TabToExtension` describe.
 *
 * Exhaustive by type, and that is what the shape is for: a variant added to a union leaves the
 * table short of a key and `npm run typecheck` red, and a variant whose guard was not taught about
 * it leaves the assertion below red as well. Between the two there is no way to add a message to
 * the protocol and keep every set green while the message is thrown away on arrival.
 *
 * `accepted` above is what a hand-kept list becomes: `tc:sound` is a kind of `PageToBridge` and
 * has never been in it.
 */
const sound: PageToBridge = {
  type: 'tc:sound',
  sourceId: 'sound:https://cdn.example/track.m4a',
  url: 'https://cdn.example/track.m4a',
  durationSeconds: 184.2,
  buffered: [[0, 184.2]],
  playing: true,
}

const everyPageToBridge: { [K in PageToBridge['type']]: Extract<PageToBridge, { type: K }> } = {
  'tc:append': append,
  'tc:source': source,
  'tc:worker': worker,
  'tc:duration': duration,
  'tc:plain': plain,
  'tc:sound': sound,
}

const everyTabToExtension: { [K in TabToExtension['type']]: Extract<TabToExtension, { type: K }> } = {
  'tc:recording': { type: 'tc:recording' },
}

const everyExtensionToTab: { [K in ExtensionToTab['type']]: Extract<ExtensionToTab, { type: K }> } = {
  'tc:list': { type: 'tc:list' },
  'tc:save': { type: 'tc:save', key: 'https://site.example/watch|avc1|inf' },
  'tc:edit': { type: 'tc:edit', key: 'https://site.example/watch|avc1|inf' },
  'tc:pause': { type: 'tc:pause', on: true },
}

const everyContentToBridge: {
  [K in ContentToBridge['type']]: Extract<ContentToBridge, { type: K }>
} = {
  'tc:context': { type: 'tc:context', url: 'https://site.example/watch', title: 'Clip' },
  'tc:verdict': { type: 'tc:verdict', sourceId: 's1', verdict: 'promote' },
  'tc:player': { type: 'tc:player', sourceId: 's1', widthPx: 1280 },
  'tc:encrypted': { type: 'tc:encrypted' },
  'tc:unreachable': { type: 'tc:unreachable' },
}

describe('a guard knows every kind its own union describes', () => {
  it.each(Object.entries(everyPageToBridge))('isPageToBridge takes %s', (_type, message) => {
    expect(isPageToBridge(message)).toBe(true)
  })

  it.each(Object.entries(everyExtensionToTab))('isExtensionToTab takes %s', (_type, message) => {
    expect(isExtensionToTab(message)).toBe(true)
  })

  it.each(Object.entries(everyTabToExtension))('isTabToExtension takes %s', (_type, message) => {
    expect(isTabToExtension(message)).toBe(true)
  })

  it.each(Object.entries(everyContentToBridge))('isContentToBridge takes %s', (_type, message) => {
    expect(isContentToBridge(message)).toBe(true)
  })
})

describe('the authenticated bridge control channel', () => {
  const capability = '0123456789abcdef0123456789abcdef'

  it('names the private storage slot from a public random identifier', () => {
    expect(bridgeCapabilityKey('fedcba9876543210fedcba9876543210')).toBe(
      'bridge-capability:fedcba9876543210fedcba9876543210',
    )
  })

  it('takes only a connection carrying a full random capability', () => {
    expect(isBridgeConnect({ type: 'tc:connect', capability })).toBe(true)
    expect(isBridgeConnect({ type: 'tc:connect', capability: 'guess' })).toBe(false)
    expect(isBridgeConnect({ type: 'tc:connect' })).toBe(false)
  })

  it('checks the claims carried by content-script controls', () => {
    expect(isContentToBridge({ type: 'tc:verdict', sourceId: 's1', verdict: 'drop' })).toBe(false)
    expect(isContentToBridge({ type: 'tc:player', sourceId: 's1', widthPx: '1280' })).toBe(false)
    expect(isContentToBridge({ type: 'tc:context', url: 'https://site.example', title: 42 })).toBe(
      false,
    )
  })
})

const everyExtensionToWorker: {
  [K in ExtensionToWorker['type']]: Extract<ExtensionToWorker, { type: K }>
} = {
  'tc:sweep': { type: 'tc:sweep', full: true },
  'tc:clear': { type: 'tc:clear' },
}

describe('isExtensionToWorker', () => {
  it.each(Object.entries(everyExtensionToWorker))('takes %s', (_type, message) => {
    expect(isExtensionToWorker(message)).toBe(true)
  })

  // The service worker hears everything every part of the extension sends: what a tab announces
  // about itself, what the popup asks a tab for, and the answers travelling back. Acting on one
  // of those as if it were a request to sweep is acting on somebody else's message.
  it.each([
    ['null', null],
    ['a string', 'tc:sweep'],
    ['a function with a fitting type', Object.assign(() => {}, { type: 'tc:sweep' })],
    ['an object without a type', { full: true }],
    ["somebody else's type", { type: 'tc:ping' }],
    ['the word that a frame is recording', { type: 'tc:recording' }],
    ['a request addressed to a tab', { type: 'tc:list' }],
  ])('turns %s away', (_name, value) => {
    expect(isExtensionToWorker(value)).toBe(false)
  })
})

describe('addresses of the snapshot and the editor', () => {
  it('names a snapshot file after the identifier and never after the session key', () => {
    // The key carries '/', ':' and '|': no file name can be made of it.
    expect(snapshotFileName('0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31')).toBe(
      '0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31.tcs',
    )
    expect(snapshotPath('0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31')).toBe(
      'snapshots/0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31.tcs',
    )
  })

  it('opens the editor by the name of the snapshot', () => {
    expect(editorUrl('0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31')).toBe(
      'editor/editor.html?s=0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31',
    )
    expect(editorUrl('0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31', 17)).toBe(
      'editor/editor.html?s=0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31&tab=17',
    )
    expect(sourceTabIdIn('?s=recording&tab=17')).toBe(17)
    expect(sourceTabIdIn('?s=recording&tab=-1')).toBeNull()
    expect(sourceTabIdIn('?s=recording&tab=17.5')).toBeNull()
    expect(sourceTabIdIn('?s=recording&tab=anything')).toBeNull()
  })

  it('opens the history of a session by a door of its own', () => {
    // A second door and not the same one: `?s=` is a snapshot file written for one editing, `?h=`
    // is a recording of the history, whose material is the pieces on disk. Told apart in the
    // address, because the editor has to know which of the two it is opening over.
    expect(historyUrl('0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31')).toBe(
      'editor/editor.html?h=0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31',
    )
    expect(historyUrl('0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31')).not.toBe(
      editorUrl('0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31'),
    )
  })

  it('accepts as an identifier only what the extension minted itself', () => {
    expect(isSnapshotId('0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c31')).toBe(true)
    expect(isSnapshotId('../../../etc/passwd')).toBe(false)
    expect(isSnapshotId('0f2c7d1e-4b0a-4a3f-9c2e-9b5a1d6f8c3')).toBe(false)
    expect(isSnapshotId('0F2C7D1E-4B0A-4A3F-9C2E-9B5A1D6F8C31')).toBe(false)
    expect(isSnapshotId('')).toBe(false)
  })

  it('takes tc:edit as a message to the tab, and tc:edit without a key as nothing', () => {
    expect(isExtensionToTab({ type: 'tc:edit', key: 'k' })).toBe(true)
    expect(isExtensionToTab({ type: 'tc:edit' })).toBe(false)
    expect(isExtensionToTab({ type: 'tc:something', key: 'k' })).toBe(false)
  })
})
