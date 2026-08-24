import { describe, it, expect } from 'vitest'
import {
  isExtensionToTab,
  isPageToBridge,
  type BridgeToPage,
  type ExtensionToTab,
  type PageToBridge,
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
const accepted: [string, PageToBridge][] = [
  ['tc:append', append],
  ['tc:source', source],
  ['tc:worker', worker],
]

/** Both variants of the other side of the protocol: the bridge sends these, it does not take them. */
const bridgeToPage: [string, BridgeToPage][] = [
  ['the handshake', { type: 'tc:ready' }],
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
    // The page's side: these messages travel through window.postMessage and reach the content
    // script by another road. Recognise them here and the popup would get the answer to a request
    // that was never its own.
    ['a message of the hook', { type: 'tc:append', sourceId: 's', bufferId: 'b', mime: 'video/mp4' }],
    ['a triage verdict', { type: 'tc:verdict', sourceId: 's', verdict: 'reject' }],
    ['the handshake of the bridge', { type: 'tc:ready' }],
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
