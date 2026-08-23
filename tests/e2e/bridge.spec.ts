import { test, expect, type Frame, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchWithExtension, routeLocal, serveLocal } from './helpers'
import { sessionKey } from '../../src/core/session-key'

const PAGE_URL = 'https://tailcut.test/player'
/** Второй адрес отличает работу «на любом сайте» от работы на одном знакомом хосте. */
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

/** Сводка сессии в том виде, в каком мост отдаёт её на запрос tc:list. */
type Summary = {
  key: string
  url: string
  title: string
  duration: number
  bytes: number
  runs: number
}

/** Медиафрагменты, которые дописывает tests/e2e/page/player.html. */
const CHUNKS = [
  'h264/chunk-stream0-00001.m4s',
  'h264/chunk-stream0-00002.m4s',
  'h264/chunk-stream0-00003.m4s',
]

/** Суммарный объём фрагментов на диске: столько байтов обязано доехать до реестра. */
async function chunkBytes(): Promise<number> {
  const sizes = await Promise.all(
    CHUNKS.map(async (rel) => (await fs.stat(path.resolve('tests/fixtures', rel))).size),
  )
  return sizes.reduce((total, size) => total + size, 0)
}

/**
 * Спрашивает у моста список сессий тем же каналом, каким это делает попап: сообщение с
 * портом MessageChannel, ответ приходит в порт. null — за отведённое время не ответил.
 */
function listSessions(page: Page, timeout = 3_000): Promise<Summary[] | null> {
  return page.evaluate(async (limit) => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-tailcut]')!
    const channel = new MessageChannel()

    return new Promise<Summary[] | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), limit)
      channel.port1.onmessage = (event) => {
        clearTimeout(timer)
        resolve(event.data)
      }
      iframe.contentWindow!.postMessage({ type: 'tc:list' }, '*', [channel.port2])
    })
  }, timeout)
}

/**
 * Ждёт, пока реестр придёт в ожидаемый вид, и отдаёт последнее увиденное. Ожидание нужно
 * только на дорогу сегментов до моста; вердикт выносит проверка в самом тесте — на срыв
 * ожидания она получит то, что реестр успел набрать, и покажет это в сообщении.
 */
async function sessionsWhen(
  page: Page,
  ready: (sessions: Summary[]) => boolean,
  timeout = 5_000,
): Promise<Summary[] | null> {
  const deadline = Date.now() + timeout
  let last: Summary[] | null = null
  for (;;) {
    last = await listSessions(page)
    if (last && ready(last)) return last
    if (Date.now() > deadline) return last
    await page.waitForTimeout(100)
  }
}

/** Ждёт, пока плеер страницы допишет все свои сегменты. */
const playerDone = (page: Page) =>
  page.waitForFunction(() => (window as unknown as PlayerState).allAppended === true)

/** Сессия, набранная плеером тестовой страницы: три фрагмента по две секунды подряд. */
async function playerSession(url: string): Promise<Summary> {
  return {
    // Ключ, которым попап потом запросит эту сессию у реестра: адрес страницы им не
    // является — метки перехода из него срезаны, а кодеки дописаны. Плеер страницы
    // играет одну видеодорожку avc1, длительность на этом этапе ещё неизвестна.
    key: sessionKey({ url, codecs: ['avc1'], durationSeconds: Infinity }),
    url,
    // Заголовок мост может узнать только из tc:context: на своём origin он его не видит,
    // а referrer несёт лишь адрес. Пустая строка здесь означала бы, что контекст не дошёл.
    title: 'test player',
    duration: 6,
    bytes: await chunkBytes(),
    runs: 1,
  }
}

const oneCompleteSession = (sessions: Summary[]): boolean =>
  sessions.length === 1 && sessions[0]!.runs === 1 && sessions[0]!.duration === 6

test('мост встаёт на странице со строгим CSP и складывает её сегменты в сессию', async () => {
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)
  await playerDone(page)

  // Весь путь целиком: обёртки в MAIN world, пересылка content script'ом, разбор боксов в
  // мосте и укладка на шкалу времени. Точные величины, а не «что-то накопилось»: длительность
  // берётся из moof и timescale, объём — из самих байтов. Реестр, набравший мусор, их не даст.
  expect(
    await sessionsWhen(page, oneCompleteSession),
    `мост должен собрать сессию из сегментов страницы; консоль страницы: ${log()}`,
  ).toEqual([await playerSession(PAGE_URL)])

  // Страница со строгим CSP должна продолжать играть: мост не мешает её собственному MSE.
  expect(await page.evaluate(() => (window as unknown as PlayerState).appended)).toBe(4)

  await context.close()
})

test('мост собирает сессию на любом origin, а не только на знакомом', async () => {
  // Тот же плеер на постороннем хосте: расширение объявлено на <all_urls>, и адрес сессии
  // обязан прийти от самой страницы. Реестр, знающий один адрес, здесь выдал бы чужой.
  const { context, page, extensionId, log } = await openPlayer(OTHER_PAGE_URL)
  await bridgeFrame(page, extensionId, log)
  await playerDone(page)

  expect(
    await sessionsWhen(page, oneCompleteSession),
    `мост должен собрать сессию на любом origin; консоль страницы: ${log()}`,
  ).toEqual([await playerSession(OTHER_PAGE_URL)])

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

test('чужие сообщения не заводят сессий и не роняют мост', async () => {
  const { context, page, extensionId, consoleLog, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)
  await playerDone(page)

  const before = await sessionsWhen(page, oneCompleteSession)
  expect(before, `подготовка: мост должен набрать сессию плеера; консоль: ${log()}`).toEqual([
    await playerSession(PAGE_URL),
  ])

  await page.evaluate(async () => {
    const target = document.querySelector<HTMLIFrameElement>('iframe[data-tailcut]')!.contentWindow!

    // На живых страницах в окна летят сообщения сборщиков, аналитики и рекламы, а байты
    // в tc:append приходят с произвольного сайта и сегментом быть не обязаны. Исключение
    // на любом из них остановило бы приём всего последующего: слушатель у моста один.
    target.postMessage(null, '*')
    target.postMessage({ type: 'tc:drm', sourceId: 's' }, '*')
    target.postMessage({ type: 'tc:source', sourceId: 's', objectUrl: 'blob:x' }, '*')
    target.postMessage({ type: 'webpackHotUpdate' }, '*')

    const junk = new ArrayBuffer(1543)
    new Uint8Array(junk).fill(0xa5)
    target.postMessage(
      { type: 'tc:append', sourceId: 'junk', bufferId: 'b', mime: 'video/mp4', bytes: junk },
      '*',
      [junk],
    )

    await new Promise((resolve) => setTimeout(resolve, 500))
  })

  expect(await listSessions(page), `реестр пострадал от чужих сообщений; консоль: ${log()}`).toEqual(
    before,
  )
  expect(
    consoleLog.filter((line) => line.startsWith('pageerror')),
    `мост не должен падать на чужих сообщениях; консоль страницы: ${log()}`,
  ).toEqual([])

  await context.close()
})

test('второй источник того же видео дополняет сессию, а не заводит новую', async () => {
  const { context, page, extensionId, log } = await openPlayer(PAGE_URL)
  await bridgeFrame(page, extensionId, log)
  await playerDone(page)

  const before = await sessionsWhen(page, oneCompleteSession)
  expect(before, `подготовка: мост должен набрать сессию плеера; консоль: ${log()}`).toEqual([
    await playerSession(PAGE_URL),
  ])

  // Второй плеер того же ролика на той же странице — перезапуск после перемотки или второе
  // <video>. Адрес и кодеки те же, значит это та же сессия, а повторный фрагмент в её карте
  // уже лежит. Заодно видно, что байты уходят передачей: у отправителя буфер отсоединяется.
  const detached = await page.evaluate(async () => {
    const target = document.querySelector<HTMLIFrameElement>('iframe[data-tailcut]')!.contentWindow!
    const load = async (rel: string): Promise<ArrayBuffer> =>
      (await fetch(`/fixtures/${rel}`)).arrayBuffer()

    const segments = [
      await load('h264/init-stream0.m4s'),
      await load('h264/chunk-stream0-00001.m4s'),
    ]
    for (const bytes of segments) {
      target.postMessage(
        { type: 'tc:append', sourceId: 'second', bufferId: 'sb', mime: 'video/mp4', bytes },
        '*',
        [bytes],
      )
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
    return segments.every((bytes) => bytes.byteLength === 0)
  })

  expect(detached, `буфер не ушёл передачей; консоль страницы: ${log()}`).toBe(true)
  expect(
    await listSessions(page),
    `материал того же ролика разъехался по сессиям; консоль: ${log()}`,
  ).toEqual(before)

  await context.close()
})
