import { test, expect, type Frame, type Page } from '@playwright/test'
import { launchWithExtension, serveLocal } from './helpers'

const PAGE_URL = 'https://tailcut.test/player'
/** Второй адрес отличает «ответить отправителю» от «ответить на заранее известный хост». */
const OTHER_PAGE_URL = 'https://some-random-site.example/player'

type Probe = { bridgeAtScriptStart?: boolean; bridgeReady?: string[] }
type PlayerState = { appended: number; allAppended?: boolean }

/** Ждёт появления фрейма с origin расширения; возвращает undefined, если он так и не встал. */
async function waitForExtensionFrame(
  page: Page,
  extensionId: string,
  timeout = 5_000,
): Promise<Frame | undefined> {
  const deadline = Date.now() + timeout
  for (;;) {
    const frame = page.frames().find((f) => f.url().includes(extensionId))
    if (frame) return frame
    if (Date.now() > deadline) return undefined
    await page.waitForTimeout(100)
  }
}

/**
 * Открывает тестовый плеер по указанному адресу.
 * Нарушение CSP видно только в консоли страницы. Собираем её, чтобы при провале
 * отличить запрет политики от ошибки вставки.
 */
async function openPlayer(url: string) {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  const consoleLog: string[] = []
  page.on('console', (msg) => consoleLog.push(`${msg.type()}: ${msg.text()}`))
  page.on('pageerror', (err) => consoleLog.push(`pageerror: ${err.message}`))

  await serveLocal(page, 'player.html', url)

  return { context, page, extensionId, consoleLog, log: () => consoleLog.join(' | ') || '(пусто)' }
}

async function bridgeFrame(page: Page, extensionId: string, log: () => string): Promise<Frame> {
  const frame = await waitForExtensionFrame(page, extensionId)
  expect(
    frame,
    `iframe расширения должен появиться несмотря на frame-src none; консоль страницы: ${log()}`,
  ).toBeTruthy()
  await frame!.waitForLoadState('domcontentloaded')
  return frame!
}

/** Шлёт мосту transferable-буфер и ждёт подтверждения. -1 означает «ответа не было». */
async function echoRoundTrip(page: Page, timeout = 3_000): Promise<number> {
  return page.evaluate(async (limit) => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-tailcut]')!
    const payload = new Uint8Array([1, 2, 3, 4]).buffer
    return new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(-1), limit)
      window.addEventListener('message', function onMsg(e) {
        if (e.data?.type === 'tc:echo') {
          clearTimeout(timer)
          window.removeEventListener('message', onMsg)
          resolve(e.data.length)
        }
      })
      iframe.contentWindow!.postMessage(
        { type: 'tc:append', sourceId: 's', bufferId: 'b', mime: 'video/mp4', bytes: payload },
        '*',
        [payload],
      )
    })
  }, timeout)
}

test('мост встаёт на странице со строгим CSP и принимает бинарные данные', async () => {
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)

  expect(
    await echoRoundTrip(page),
    `мост должен подтвердить приём байтов; консоль страницы: ${log()}`,
  ).toBe(4)

  // Страница со строгим CSP должна продолжать играть: мост не мешает её собственному MSE.
  await page.waitForFunction(() => (window as unknown as PlayerState).allAppended === true)
  expect(await page.evaluate(() => (window as unknown as PlayerState).appended)).toBe(4)

  await context.close()
})

test('мост отвечает отправителю, а не заранее известному адресу', async () => {
  // Тот же плеер на постороннем origin: ответ, прибитый к адресу из первого теста,
  // сюда не дойдёт, и подтверждение приёма байтов потеряется молча.
  const { context, page, extensionId, log } = await openPlayer(OTHER_PAGE_URL)
  await bridgeFrame(page, extensionId, log)

  expect(
    await echoRoundTrip(page),
    `мост должен подтвердить приём байтов на любом origin; консоль страницы: ${log()}`,
  ).toBe(4)

  await context.close()
})

test('мост не виден на странице и не занимает места', async () => {
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)

  const placement = await page.evaluate(() => {
    const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-tailcut]')
    const iframe = frames[0]!
    const rect = iframe.getBoundingClientRect()
    const style = getComputedStyle(iframe)
    return {
      count: frames.length,
      width: rect.width,
      height: rect.height,
      visibility: style.visibility,
      position: style.position,
      pointerEvents: style.pointerEvents,
      inDocumentElement: iframe.parentElement === document.documentElement,
      ariaHidden: iframe.getAttribute('aria-hidden'),
    }
  })

  expect(placement).toEqual({
    count: 1,
    width: 0,
    height: 0,
    visibility: 'hidden',
    position: 'fixed',
    pointerEvents: 'none',
    inDocumentElement: true,
    ariaHidden: 'true',
  })

  await context.close()
})

test('мост встаёт раньше первого скрипта страницы', async () => {
  // Ожидание фрейма «когда-нибудь» ничего не стоит: плеер начинает буферизацию
  // из своего же скрипта, и мост, вставший после DOMContentLoaded, пропустит начало.
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)

  expect(
    await page.evaluate(() => (window as unknown as Probe).bridgeAtScriptStart),
    `мост должен стоять в DOM к моменту первого скрипта страницы; консоль страницы: ${log()}`,
  ).toBe(true)

  await context.close()
})

test('мост здоровается со страницей после загрузки', async () => {
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)

  const handshake = await page
    .waitForFunction(
      () => {
        const ready = (window as unknown as Probe).bridgeReady
        return ready && ready.length > 0 ? ready : null
      },
      undefined,
      { timeout: 5_000 },
    )
    .then((value) => value.jsonValue())
    .catch(() => null)

  expect(handshake, `мост должен прислать tc:ready странице; консоль страницы: ${log()}`).toEqual([
    `chrome-extension://${extensionId}`,
  ])

  await context.close()
})

test('мост отвечает только на tc:append и не спотыкается о чужие сообщения', async () => {
  const { context, page, extensionId, consoleLog, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)

  // Порядок доставки postMessage сохраняется: эхо на мусор пришло бы раньше эха на tc:append.
  const echoes = await page.evaluate(async () => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-tailcut]')!
    const target = iframe.contentWindow!
    const seen: unknown[] = []
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'tc:echo') seen.push(e.data)
    })

    target.postMessage(null, '*')
    target.postMessage({ type: 'tc:drm', sourceId: 's' }, '*')
    target.postMessage({ type: 'tc:source', sourceId: 's', objectUrl: 'blob:x' }, '*')
    target.postMessage({ type: 'webpackHotUpdate' }, '*')

    const payload = new Uint8Array([1, 2, 3, 4]).buffer
    target.postMessage(
      { type: 'tc:append', sourceId: 's', bufferId: 'b', mime: 'video/mp4', bytes: payload },
      '*',
      [payload],
    )

    await new Promise((resolve) => setTimeout(resolve, 500))
    return seen
  })

  expect(echoes, `лишнее эхо; консоль страницы: ${log()}`).toEqual([{ type: 'tc:echo', length: 4 }])
  expect(
    consoleLog.filter((line) => line.startsWith('pageerror')),
    `мост не должен падать на чужих сообщениях; консоль страницы: ${log()}`,
  ).toEqual([])

  await context.close()
})
