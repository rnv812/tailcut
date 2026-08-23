import { test, expect, type Frame, type Page } from '@playwright/test'
import { launchWithExtension, routeLocal, serveLocal } from './helpers'

const PAGE_URL = 'https://tailcut.test/player'
/** Второй адрес отличает «ответить отправителю» от «ответить на заранее известный хост». */
const OTHER_PAGE_URL = 'https://some-random-site.example/player'
/** Чужая верхняя страница, встраивающая тот же плеер во вложенный фрейм. */
const EMBED_URL = 'https://embedder.example/watch'

type Probe = { bridgeAtScriptStart?: boolean; bridgeReady?: string[] }
type PlayerState = { appended: number; allAppended?: boolean }

/** Ждёт фрейм, подходящий под условие; возвращает undefined, если он так и не появился. */
async function waitForFrame(
  page: Page,
  match: (frame: Frame) => boolean,
  timeout = 5_000,
): Promise<Frame | undefined> {
  const deadline = Date.now() + timeout
  for (;;) {
    const frame = page.frames().find(match)
    if (frame) return frame
    if (Date.now() > deadline) return undefined
    await page.waitForTimeout(100)
  }
}

/** Ждёт появления фрейма с origin расширения; возвращает undefined, если он так и не встал. */
const waitForExtensionFrame = (page: Page, extensionId: string) =>
  waitForFrame(page, (frame) => frame.url().includes(extensionId))

type LocalPage = { url: string; html: string }

/**
 * Открывает локальную страницу; остальные раскладываются по своим адресам, чтобы страница
 * могла их встроить. Нарушение CSP видно только в консоли страницы. Собираем её, чтобы при
 * провале отличить запрет политики от ошибки вставки.
 */
async function openPage(entry: LocalPage, ...embedded: LocalPage[]) {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  const consoleLog: string[] = []
  page.on('console', (msg) => consoleLog.push(`${msg.type()}: ${msg.text()}`))
  page.on('pageerror', (err) => consoleLog.push(`pageerror: ${err.message}`))

  for (const inner of embedded) await routeLocal(page, inner.html, inner.url)
  await serveLocal(page, entry.html, entry.url)

  return { context, page, extensionId, consoleLog, log: () => consoleLog.join(' | ') || '(пусто)' }
}

/** Открывает тестовый плеер верхним документом по указанному адресу. */
const openPlayer = (url: string) => openPage({ url, html: 'player.html' })

/** Открывает чужую страницу, встраивающую тот же плеер во вложенный фрейм. */
const openEmbeddedPlayer = () =>
  openPage({ url: EMBED_URL, html: 'embed.html' }, { url: PAGE_URL, html: 'player.html' })

/**
 * Ждёт рукопожатий в указанном документе и отдаёт origin их отправителей;
 * null — за отведённое время не пришло ни одного.
 */
async function handshakes(target: Page | Frame, timeout = 5_000): Promise<string[] | null> {
  return target
    .waitForFunction(
      () => {
        const ready = (window as unknown as Probe).bridgeReady
        return ready && ready.length > 0 ? ready : null
      },
      undefined,
      { timeout },
    )
    .then((value) => value.jsonValue())
    .catch(() => null)
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

/** Итог обмена: длина из эха (-1 — ответа не было) и судьба буфера у отправителя. */
type Echo = { length: number; detachedAtSender: boolean }

/**
 * Шлёт мосту transferable-буфер заданного размера и ждёт подтверждения. Размер у каждого
 * вызова свой: подтверждение обязано повторять длину пришедшего буфера, а не какое-то число,
 * и только это доказывает, что байты доехали до моста, а не потерялись по дороге.
 */
async function echoRoundTrip(page: Page, size: number, timeout = 3_000): Promise<Echo> {
  return page.evaluate(
    async ({ size, limit }) => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-tailcut]')!
      const payload = new ArrayBuffer(size)
      new Uint8Array(payload).fill(0xa5)

      const length = await new Promise<number>((resolve) => {
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

      // Отсоединённый буфер у отправителя — признак настоящей передачи, а не копии:
      // на реальных сегментах копия стоила бы плееру лишней работы на каждом appendBuffer.
      return { length, detachedAtSender: payload.byteLength === 0 }
    },
    { size, limit: timeout },
  )
}

test('мост встаёт на странице со строгим CSP и принимает бинарные данные', async () => {
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)

  // Размер порядка реального сегмента, а не четыре байта: подтверждение должно нести
  // длину именно этого буфера.
  expect(
    await echoRoundTrip(page, 4096),
    `мост должен подтвердить приём 4096 байт; консоль страницы: ${log()}`,
  ).toEqual({ length: 4096, detachedAtSender: true })

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

  // Размер отличается от первого теста: длина в эхе обязана следовать за буфером.
  expect(
    await echoRoundTrip(page, 7),
    `мост должен подтвердить приём 7 байт на любом origin; консоль страницы: ${log()}`,
  ).toEqual({ length: 7, detachedAtSender: true })

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

// Расширение объявлено на <all_urls>, поэтому рукопожатие проверяется на обоих адресах:
// на одном тестовом адресе прибитый targetOrigin неотличим от «любого родителя», а страница
// узнаёт о мосте только из этого сообщения — на всех прочих сайтах оно пропало бы молча.
for (const url of [PAGE_URL, OTHER_PAGE_URL]) {
  const host = new URL(url).host

  test(`мост здоровается со страницей после загрузки (${host})`, async () => {
    const { context, page, extensionId, log } = await openPlayer(url)
    await bridgeFrame(page, extensionId, log)

    expect(
      await handshakes(page),
      `мост должен прислать tc:ready странице на ${host}; консоль страницы: ${log()}`,
    ).toEqual([`chrome-extension://${extensionId}`])

    await context.close()
  })
}

test('мост вложенного фрейма здоровается со своим фреймом, а не с верхней страницей', async () => {
  // Плеер во вложенном фрейме — обычнейшая раскладка (встроенные YouTube, Vimeo, JW).
  // Мост объявлен на all_frames и встаёт внутри такого фрейма; знать о нём должен тот
  // документ, который его и вставил, — иначе плеер о мосте не узнает никогда, а верхняя
  // страница получит рукопожатие от моста, к которому ей не за чем обращаться.
  const { context, page, extensionId, log } = await openEmbeddedPlayer()

  const player = await waitForFrame(page, (frame) => frame.url() === PAGE_URL)
  expect(player, `фрейм с плеером должен появиться; консоль страницы: ${log()}`).toBeTruthy()

  expect(
    await handshakes(player!),
    `мост должен прислать tc:ready своему фрейму; консоль страницы: ${log()}`,
  ).toEqual([`chrome-extension://${extensionId}`])

  // Верхняя страница слышит только собственный мост: второе рукопожатие означало бы,
  // что мост вложенного фрейма стучится наверх, мимо своего документа.
  expect(
    await handshakes(page),
    `верхняя страница получила чужое рукопожатие; консоль страницы: ${log()}`,
  ).toEqual([`chrome-extension://${extensionId}`])

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

    // Ещё один размер, ни с чем не совпадающий: единственное эхо обязано нести его длину.
    const payload = new ArrayBuffer(1543)
    target.postMessage(
      { type: 'tc:append', sourceId: 's', bufferId: 'b', mime: 'video/mp4', bytes: payload },
      '*',
      [payload],
    )

    await new Promise((resolve) => setTimeout(resolve, 500))
    return seen
  })

  expect(echoes, `лишнее эхо; консоль страницы: ${log()}`).toEqual([
    { type: 'tc:echo', length: 1543 },
  ])
  expect(
    consoleLog.filter((line) => line.startsWith('pageerror')),
    `мост не должен падать на чужих сообщениях; консоль страницы: ${log()}`,
  ).toEqual([])

  await context.close()
})
