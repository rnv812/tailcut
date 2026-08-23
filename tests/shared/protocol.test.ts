import { describe, it, expect } from 'vitest'
import { isPageToBridge, type PageToBridge } from '../../src/shared/protocol'

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
  ['рукопожатие моста', { type: 'tc:ready' }],
  // Служебные сообщения самого расширения. Content script пересылает мосту всё, что признал
  // здесь своим, а прилетают они из окна страницы — то есть и от её собственных скриптов.
  // Признай он контекст, любая страница переписала бы мосту адрес и заголовок чужой сессии;
  // признай запрос списка — выманила бы историю просмотра.
  [
    'контекст страницы: его шлёт сам content script',
    { type: 'tc:context', url: 'https://site.example/', title: 'Clip' },
  ],
  ['запрос списка сессий: он адресуется мосту напрямую', { type: 'tc:list' }],
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
