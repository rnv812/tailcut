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
const drm: PageToBridge = { type: 'tc:drm', sourceId: 's' }

const accepted: [string, PageToBridge][] = [
  ['tc:append', append],
  ['tc:source', source],
  ['tc:drm', drm],
]

/** Оба варианта обратной стороны протокола: это мост отправляет, а не принимает. */
const bridgeToPage: [string, BridgeToPage][] = [
  ['рукопожатие', { type: 'tc:ready' }],
  [
    'список сессий',
    [
      {
        key: 'https://site.example/watch|avc1|inf',
        url: 'https://site.example/watch',
        title: 'Clip',
        duration: 6,
        bytes: 1543,
        runs: 1,
      },
    ],
  ],
]

/** Мост слушает окно страницы: туда прилетает всё, что шлёт сама страница и её скрипты. */
const rejected: [string, unknown][] = [
  ['null', null],
  ['undefined', undefined],
  ['строку', 'tc:append'],
  ['число', 42],
  ['массив', ['tc:append']],
  ['объект без type', { sourceId: 's' }],
  ['нестроковый type', { type: 1 }],
  ['чужой type', { type: 'webpackHotUpdate' }],
  // Служебные сообщения самого расширения. Content script пересылает мосту всё, что признал
  // здесь своим, а прилетают они из окна страницы — то есть и от её собственных скриптов.
  // Признай он контекст, любая страница переписала бы мосту адрес и заголовок чужой сессии;
  // признай запрос списка — выманила бы историю просмотра.
  [
    'контекст страницы: его шлёт сам content script',
    { type: 'tc:context', url: 'https://site.example/', title: 'Clip' },
  ],
  ['запрос списка сессий: он адресуется мосту напрямую', { type: 'tc:list' }],
  // Вердикт отбора выносит content script по сигналам элемента; страница о нём знать не
  // должна вовсе. Признай он вердикт своим — любой скрипт страницы стёр бы чужую сессию,
  // прислав в своё же окно отказ по чужому источнику.
  [
    'вердикт отбора: его выносит content script',
    { type: 'tc:verdict', sourceId: 's', verdict: 'reject' },
  ],
  // Обратная сторона протокола целиком: всё, что мост отправляет, к мосту не адресуется.
  // Content script пересылает мосту то, что признал здесь своим, а рукопожатие и сводки
  // прилетают в то же окно страницы — признай он их, ответ моста поехал бы обратно в мост.
  ...bridgeToPage.map(([name, message]): [string, unknown] => [`ответ моста: ${name}`, message]),
]

describe('isPageToBridge', () => {
  it.each(accepted)('пропускает %s', (_name, message) => {
    expect(isPageToBridge(message)).toBe(true)
  })

  it.each(rejected)('отбивает %s', (_name, value) => {
    expect(isPageToBridge(value)).toBe(false)
  })

  it('отбивает функцию с подходящим type: постороннее значение не объект', () => {
    const fn = Object.assign(() => {}, { type: 'tc:append' })
    expect(isPageToBridge(fn)).toBe(false)
  })

  it('сужает тип до объединения PageToBridge', () => {
    const value: unknown = append
    if (!isPageToBridge(value)) throw new Error('ожидался tc:append')
    if (value.type !== 'tc:append') throw new Error('ожидался tc:append')
    expect(value.bytes.byteLength).toBe(4)
  })
})

/** Запросы попапа и service worker к content script вкладки. */
const tabRequests: [string, ExtensionToTab][] = [
  ['запрос списка', { type: 'tc:list' }],
  ['запрос сохранения', { type: 'tc:save', key: 'https://site.example/watch|avc1|inf' }],
]

describe('isExtensionToTab', () => {
  it.each(tabRequests)('пропускает %s', (_name, message) => {
    expect(isExtensionToTab(message)).toBe(true)
  })

  // Content script слушает chrome.runtime.onMessage: туда приходит всё, что шлют попап и
  // service worker, включая сообщения будущих этапов. Непонятное он обязан оставить другим
  // слушателям, а не отвечать на него от имени моста.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['строку', 'tc:list'],
    ['массив', [{ type: 'tc:list' }]],
    ['объект без type', { key: 'k' }],
    ['чужой type', { type: 'tc:ping' }],
    ['сохранение без ключа', { type: 'tc:save' }],
    ['сохранение с нестроковым ключом', { type: 'tc:save', key: 42 }],
    // Сторона страницы: эти сообщения ходят через window.postMessage и до content script'а
    // приезжают другим путём. Признай он их здесь — попап получил бы ответ на чужой запрос.
    ['сообщение хука', { type: 'tc:append', sourceId: 's', bufferId: 'b', mime: 'video/mp4' }],
    ['вердикт отбора', { type: 'tc:verdict', sourceId: 's', verdict: 'reject' }],
    ['рукопожатие моста', { type: 'tc:ready' }],
  ])('отбивает %s', (_name, value) => {
    expect(isExtensionToTab(value)).toBe(false)
  })

  it('сужает тип до объединения ExtensionToTab', () => {
    const value: unknown = { type: 'tc:save', key: 'k' }
    if (!isExtensionToTab(value)) throw new Error('ожидался tc:save')
    if (value.type !== 'tc:save') throw new Error('ожидался tc:save')
    expect(value.key).toBe('k')
  })
})
