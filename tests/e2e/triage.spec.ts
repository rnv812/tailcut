import { test, expect, type Frame, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchWithExtension, serveLocal } from './helpers'
import { sessionKey } from '../../src/core/session-key'

const BANNER_URL = 'https://tailcut.test/banner'
const PLAYER_URL = 'https://tailcut.test/player'
/** Баннер и настоящий плеер на одной странице: вердикт по одному не должен трогать второй. */
const MIXED_URL = 'https://tailcut.test/mixed'

/** Вердикт в том виде, в каком content script отправляет его мосту. */
type SeenVerdict = { sourceId: string; verdict: string }
/** Связка потока с адресом из createObjectURL: по ней вердикт сводится с элементом. */
type SeenSource = { sourceId: string; objectUrl: string }

/** Что собрал слушатель, поставленный тестом в каждом документе страницы. */
type Probe = { tcVerdict: SeenVerdict[]; tcSource: SeenSource[]; tcAppend: number }
type PageState = { allAppended?: boolean }

/** Сводка сессии в том виде, в каком мост отдаёт её на запрос tc:list. */
type Summary = {
  key: string
  url: string
  title: string
  duration: number
  bytes: number
  runs: number
}

/** Медиафрагменты, которые дописывает плеер тестовых страниц. */
const CHUNKS = [
  'h264/chunk-stream0-00001.m4s',
  'h264/chunk-stream0-00002.m4s',
  'h264/chunk-stream0-00003.m4s',
]

/** Суммарный объём фрагментов на диске: столько байтов обязано остаться в реестре. */
async function chunkBytes(): Promise<number> {
  const sizes = await Promise.all(
    CHUNKS.map(async (rel) => (await fs.stat(path.resolve('tests/fixtures', rel))).size),
  )
  return sizes.reduce((total, size) => total + size, 0)
}

/**
 * Открывает страницу с расширением и слушателем сообщений, поставленным до любого её скрипта.
 * Слушатель ставится во всех документах, включая фрейм моста: вердикт уходит туда, а связка
 * источника с адресом видна только в окне самой страницы.
 */
async function open(htmlFile: string, url: string) {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  const consoleLog: string[] = []
  page.on('console', (msg) => consoleLog.push(`${msg.type()}: ${msg.text()}`))
  page.on('pageerror', (err) => consoleLog.push(`pageerror: ${err.message}`))

  await page.addInitScript(() => {
    const probe = window as unknown as Probe
    probe.tcVerdict = []
    probe.tcSource = []
    probe.tcAppend = 0

    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data !== 'object') return

      if (data.type === 'tc:verdict') {
        probe.tcVerdict.push({ sourceId: String(data.sourceId), verdict: String(data.verdict) })
      } else if (data.type === 'tc:source') {
        probe.tcSource.push({ sourceId: String(data.sourceId), objectUrl: String(data.objectUrl) })
      } else if (data.type === 'tc:append') {
        probe.tcAppend++
      }
    })
  })

  await serveLocal(page, htmlFile, url)

  return {
    context,
    page,
    extensionId,
    log: () => consoleLog.join(' | ') || '(пусто)',
  }
}

/** Отдаёт документ моста; тест ставит в него тот же слушатель, что и в страницу. */
async function bridgeFrame(page: Page, extensionId: string, log: () => string): Promise<Frame> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const frame = page.frames().find((candidate) => candidate.url().includes(extensionId))
    if (frame) return frame
    expect(Date.now(), `фрейм моста не появился; консоль страницы: ${log()}`).toBeLessThan(deadline)
    await page.waitForTimeout(50)
  }
}

/** Ждёт, пока страница допишет все свои сегменты. */
const pageDone = (page: Page) =>
  page.waitForFunction(() => (window as unknown as PageState).allAppended === true, undefined, {
    timeout: 15_000,
  })

/** Идентификатор потока того <video>, что стоит под указанным селектором. */
function sourceIdOf(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const probe = window as unknown as Probe
    const video = document.querySelector<HTMLVideoElement>(sel)!
    return probe.tcSource.find((source) => source.objectUrl === video.src)?.sourceId ?? ''
  }, selector)
}

/** Последний вердикт по указанному источнику; undefined — по нему не приходило ничего. */
const latest = (seen: SeenVerdict[], sourceId: string): string | undefined =>
  [...seen].reverse().find((item) => item.sourceId === sourceId)?.verdict

/**
 * Ждёт, пока вердикты у моста придут в ожидаемый вид, и отдаёт последнее увиденное. Ожидание
 * нужно только на испытательный срок; вердикт выносит проверка в самом тесте — на срыв
 * ожидания она получит то, что мост успел услышать, и покажет это в сообщении.
 */
async function verdictsWhen(
  bridge: Frame,
  ready: (seen: SeenVerdict[]) => boolean,
  timeout = 15_000,
): Promise<SeenVerdict[]> {
  const deadline = Date.now() + timeout
  for (;;) {
    const seen = await bridge.evaluate(() => (window as unknown as Probe).tcVerdict)
    if (ready(seen) || Date.now() > deadline) return seen
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
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

/** Ждёт, пока реестр придёт в ожидаемый вид, и отдаёт последнее увиденное. */
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

/** Сессия, набранная плеером тестовой страницы: три фрагмента по две секунды подряд. */
async function playerSession(url: string, title: string): Promise<Summary> {
  return {
    key: sessionKey({ url, codecs: ['avc1'], durationSeconds: Infinity }),
    url,
    title,
    duration: 6,
    bytes: await chunkBytes(),
    runs: 1,
  }
}

const oneCompleteSession = (sessions: Summary[]): boolean =>
  sessions.length === 1 && sessions[0]!.runs === 1 && sessions[0]!.duration === 6

test('баннер не оставляет в реестре следа', async () => {
  const { context, page, extensionId, log } = await open('banner.html', BANNER_URL)
  const bridge = await bridgeFrame(page, extensionId, log)
  await pageDone(page)

  // Байты баннера обязаны доехать до моста: хук в MAIN world копирует всегда, решение
  // принимает изолированный мир. Не проверь мы этого — пустой реестр ничего не доказывал бы.
  await bridge
    .waitForFunction(() => (window as unknown as Probe).tcAppend >= 2, undefined, { timeout: 5_000 })
    .catch(() => undefined)
  expect(
    await bridge.evaluate(() => (window as unknown as Probe).tcAppend),
    `сегменты баннера не доехали до моста; консоль страницы: ${log()}`,
  ).toBe(2)

  const banner = await sourceIdOf(page, '#v')
  expect(banner, `поток баннера не связан с его адресом; консоль страницы: ${log()}`).not.toBe('')

  const seen = await verdictsWhen(bridge, (list) => latest(list, banner) === 'reject', 5_000)
  expect(latest(seen, banner), `баннер не получил отказа; консоль страницы: ${log()}`).toBe('reject')
  expect(
    seen.map((item) => item.verdict),
    'беззвучный зациклённый автоплей размером с превью не должен доживать до повышения',
  ).not.toContain('promote')

  // Отказ стирает набранное: сессия, заведённая первым init-сегментом, до попапа не доживает.
  expect(
    await sessionsWhen(page, (sessions) => sessions.length === 0),
    `материал баннера остался в реестре; консоль страницы: ${log()}`,
  ).toEqual([])

  await context.close()
})

test('настоящий плеер доживает до сессии', async () => {
  const { context, page, extensionId, log } = await open('player.html', PLAYER_URL)
  const bridge = await bridgeFrame(page, extensionId, log)
  await pageDone(page)

  // Испытательный срок отмеряется реально сыгранным временем, а материала у страницы ровно
  // на шесть секунд — впритык к порогу. Зацикливание оставляет запас, а панель управления
  // на месте, так что баннерное правило (беззвучное + зациклённое + без панели) не сработает.
  await page.evaluate(() => {
    const video = document.querySelector('video')!
    video.loop = true
    return video.play()
  })

  const player = await sourceIdOf(page, 'video')
  const seen = await verdictsWhen(bridge, (list) => latest(list, player) === 'promote')

  expect(latest(seen, player), `плеер не дожил до повышения; консоль страницы: ${log()}`).toBe(
    'promote',
  )
  expect(
    seen.filter((item) => item.verdict === 'reject'),
    'настоящему плееру отказ приходить не должен',
  ).toEqual([])

  expect(
    await sessionsWhen(page, oneCompleteSession),
    `мост должен сохранить сессию плеера; консоль страницы: ${log()}`,
  ).toEqual([await playerSession(PLAYER_URL, 'test player')])

  await context.close()
})

test('отказ по баннеру не задевает плеер на той же странице', async () => {
  const { context, page, extensionId, log } = await open('mixed.html', MIXED_URL)
  const bridge = await bridgeFrame(page, extensionId, log)
  await pageDone(page)

  await page.evaluate(() => document.querySelector<HTMLVideoElement>('#player')!.play())

  const banner = await sourceIdOf(page, '#banner')
  const player = await sourceIdOf(page, '#player')
  expect(
    new Set([banner, player]).size,
    `два плеера страницы должны получить разные потоки; консоль страницы: ${log()}`,
  ).toBe(2)

  const seen = await verdictsWhen(
    bridge,
    (list) => latest(list, banner) === 'reject' && latest(list, player) === 'promote',
  )
  expect(latest(seen, banner), `баннер не получил отказа; консоль страницы: ${log()}`).toBe('reject')
  expect(latest(seen, player), `плеер не дожил до повышения; консоль страницы: ${log()}`).toBe(
    'promote',
  )

  // Вердикт адресный: у баннера свой поток и своя сессия (кодеки в ключе разные), и стереть
  // его материал мост обязан, не тронув материал соседа. Отказ, снимающий заодно и соседа,
  // оставил бы реестр пустым; отказ, не снимающий ничего, — двумя сессиями.
  expect(
    await sessionsWhen(page, oneCompleteSession),
    `отказ по баннеру не должен был трогать сессию плеера; консоль страницы: ${log()}`,
  ).toEqual([await playerSession(MIXED_URL, 'banner and player')])

  await context.close()
})
