import { describe, it, expect, afterEach, vi } from 'vitest'
import { BRIDGE_PATH } from '../../src/shared/protocol'

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

/** Минимальный элемент: content script трогает только эти свойства. */
function fakeElement(tagName: string) {
  const listeners: Record<string, Array<() => void>> = {}
  const attributes: Record<string, string> = {}
  return {
    tagName,
    src: '',
    dataset: {} as Record<string, string>,
    style: { cssText: '' },
    attributes,
    setAttribute: (name: string, value: string) => {
      attributes[name] = value
    },
    addEventListener: (type: string, listener: () => void) => {
      ;(listeners[type] ??= []).push(listener)
    },
    fire: (type: string) => {
      for (const listener of listeners[type] ?? []) listener()
    },
  }
}

type FakeElement = ReturnType<typeof fakeElement>

function installDom() {
  const created: FakeElement[] = []
  const appended: FakeElement[] = []

  vi.stubGlobal('document', {
    createElement: (tagName: string) => {
      const element = fakeElement(tagName)
      created.push(element)
      return element
    },
    documentElement: {
      appendChild: (element: FakeElement) => {
        appended.push(element)
        return element
      },
    },
  })
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}` },
  })

  return { created, appended }
}

/** Импорт сам вставляет мост: в модуле есть вызов ensureBridge() на верхнем уровне. */
async function importContent() {
  vi.resetModules()
  return import('../../src/page/content')
}

/** Разбирает cssText в набор объявлений, чтобы не привязываться к порядку свойств. */
function declarations(cssText: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of cssText.split(';')) {
    if (!part.trim()) continue
    const colon = part.indexOf(':')
    out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim()
  }
  return out
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ensureBridge', () => {
  it('вставляет фрейм со страницей моста при загрузке модуля', async () => {
    const dom = installDom()
    await importContent()

    expect(dom.created).toHaveLength(1)
    const iframe = dom.created[0]!
    expect(iframe.tagName).toBe('iframe')
    expect(iframe.src).toBe(`${EXTENSION_ORIGIN}/${BRIDGE_PATH}`)
    expect(iframe.dataset.tailcut).toBe('bridge')
    expect(iframe.attributes['aria-hidden']).toBe('true')
    expect(dom.appended).toEqual([iframe])
  })

  it('на повторные вызовы отдаёт тот же промис и не плодит фреймы', async () => {
    const dom = installDom()
    const { ensureBridge } = await importContent()

    const first = ensureBridge()
    const second = ensureBridge()

    expect(second).toBe(first)
    expect(dom.created).toHaveLength(1)
    expect(dom.appended).toHaveLength(1)
  })

  it('объявляет фрейм невидимым и без размера', async () => {
    const dom = installDom()
    await importContent()

    expect(declarations(dom.created[0]!.style.cssText)).toMatchObject({
      position: 'fixed',
      width: '0',
      height: '0',
      border: '0',
      visibility: 'hidden',
      'pointer-events': 'none',
    })
  })

  it('резолвится фреймом только после его загрузки', async () => {
    const dom = installDom()
    const { ensureBridge } = await importContent()

    let settled: unknown = null
    const pending = ensureBridge().then((iframe) => {
      settled = iframe
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBeNull()

    dom.created[0]!.fire('load')
    await pending
    expect(settled).toBe(dom.created[0])
  })
})
