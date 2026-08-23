import { chromium, test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { launchWithExtension, serveLocal } from './helpers'
import type { SessionSummary } from '../../src/shared/protocol'

const PLAYER_URL = 'https://tailcut.test/player'

/**
 * Сколько плеер обязан отыграть, чтобы отбор пропустил его дальше испытательного срока
 * (BALANCED.gracePeriodSeconds = 6). Запас в секунду — на неточность опроса наблюдателя.
 */
const PLAY_MS = 7_000

type PageState = { allAppended?: boolean }

/** Открывает страницу с плеером и даёт ей набрать материал: три фрагмента по две секунды. */
async function recorded(): Promise<{ context: BrowserContext; page: Page; extensionId: string }> {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()
  await serveLocal(page, 'player.html', PLAYER_URL)

  await page.waitForFunction(() => (window as unknown as PageState).allAppended === true, undefined, {
    timeout: 15_000,
  })

  // Зацикливание — как в triage.spec.ts: материала у страницы ровно шесть секунд, впритык
  // к порогу, и без повтора счётчик сыгранного до него не дотягивается.
  await page.evaluate(() => {
    const video = document.querySelector('video')!
    video.loop = true
    return video.play()
  })
  await page.waitForTimeout(PLAY_MS)

  return { context, page, extensionId }
}

/**
 * Открывает попап. Настоящий попап расширения вкладкой не является: активной остаётся
 * страница пользователя, у неё попап и спрашивает список. Playwright открывает его обычной
 * вкладкой, поэтому активную возвращаем плееру — иначе попап спросил бы список у самого себя.
 */
async function openPopup(context: BrowserContext, page: Page, extensionId: string): Promise<Page> {
  const popup = await context.newPage()
  await page.bringToFront()
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`)
  return popup
}

/** Адрес, по которому попапу отдаётся его же сборка из dist. Вымышленный, как и у плеера. */
const POPUP_URL = 'https://tailcut.test/popup/popup.html'

/** Сводка, которой «вкладка» отвечает попапу по команде теста. */
const SUMMARY: SessionSummary = {
  key: 'https://site.example/watch|avc1|inf',
  url: 'https://site.example/watch?v=abc',
  title: 'Clip — site.example',
  duration: 6,
  bytes: 1_543_210,
  runs: 1,
}

type Answer = (sessions: SessionSummary[]) => Promise<void>

/**
 * Открывает попап из dist без запуска расширения и оставляет ответ вкладки за тестом:
 * состояние ожидания здесь не мгновенное, как с живым content script, а держится ровно до
 * вызова answer. Меряется при этом настоящая вёрстка попапа настоящим движком — высоту,
 * которой Chrome открывает окно попапа, взять больше неоткуда.
 */
async function offlinePopup(): Promise<{ browser: Browser; popup: Page; answer: Answer }> {
  const browser = await chromium.launch()
  const popup = await browser.newPage()

  await popup.route('**/popup/*', async (route) => {
    const file = path.basename(new URL(route.request().url()).pathname)
    const body = await readFile(path.resolve('dist/popup', file), 'utf8')
    const contentType = file.endsWith('.js') ? 'text/javascript' : 'text/html'
    await route.fulfill({ body, contentType })
  })

  await popup.addInitScript(() => {
    const asked = new Promise((resolve) => {
      Object.assign(window, { __answer: resolve })
    })
    // Из всего chrome.* попапу нужна одна вкладка и её ответ: остальное к вёрстке отношения
    // не имеет, а живой вкладке нечем растянуть молчание на время замера.
    Object.assign(window, {
      chrome: { tabs: { query: async () => [{ id: 1 }], sendMessage: () => asked } },
    })
  })

  await popup.goto(POPUP_URL)

  const answer: Answer = (sessions) =>
    popup.evaluate((list) => {
      ;(window as unknown as { __answer: (value: unknown) => void }).__answer(list)
    }, sessions)

  return { browser, popup, answer }
}

test('попап показывает накопленное и сохраняет его файлом mp4', async () => {
  const { context, page, extensionId } = await recorded()
  const popup = await openPopup(context, page, extensionId)

  await expect(popup.getByTestId('duration')).toHaveText('0:06')
  await expect(popup.getByTestId('title')).toHaveText('test player')
  await expect(popup.getByTestId('host')).toHaveText('tailcut.test')

  const button = popup.getByRole('button', { name: 'Save all' })
  await expect(button).toBeEnabled()

  // Скачивание начинает мост — фрейм расширения внутри вкладки плеера, а не сам попап.
  const started = page.waitForEvent('download')
  await button.click()
  const download = await started

  // Расширение файла Chrome берёт из типа блоба, а имя под Playwright подменяется на GUID:
  // проверяется здесь именно расширение — то, с чем файл ляжет пользователю на диск.
  // Правила имени разобраны отдельно, в tests/bridge/bridge.test.ts.
  expect(download.suggestedFilename(), 'файл сохранён не с расширением mp4').toMatch(/\.mp4$/)

  const file = await download.path()
  const probe = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-count_frames',
      '-show_entries', 'format=duration:stream=nb_read_frames',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )

  expect(probe.error).toBeUndefined()
  expect(probe.status, probe.stderr).toBe(0)
  expect(probe.stderr, 'ffprobe жалуется на разбор сохранённого файла').toBe('')

  const probed = JSON.parse(probe.stdout) as {
    format: { duration: string }
    streams: Array<{ nb_read_frames: string }>
  }

  // Шесть секунд материала при 24 кадрах в секунду: сохранено всё накопленное, целиком.
  expect(Number(probed.format.duration)).toBeGreaterThan(5.5)
  expect(Number(probed.format.duration)).toBeLessThan(6.5)
  expect(probed.streams.map((stream) => Number(stream.nb_read_frames))).toEqual([144])

  // То же скачивание глазами Chrome: начало его расширение, дошло оно до конца и записало
  // ровно столько байтов, сколько собрал мост. Адрес блоба, снятый слишком рано, оставил бы
  // здесь interrupted и файл в половину длины.
  const [sw] = context.serviceWorkers()
  const item = await sw!.evaluate(
    async () => (await chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] }))[0] ?? null,
  )
  expect(item, 'Chrome не знает ни одного скачивания').not.toBeNull()
  expect(item).toMatchObject({ state: 'complete', mime: 'video/mp4', byExtensionName: 'tailcut' })
  expect(item!.fileSize, 'на диск легло не всё').toBe(statSync(file).size)

  await context.close()
})

test('бейдж показывает накопленное на вкладке', async () => {
  const { context, page } = await recorded()
  const [sw] = context.serviceWorkers()

  // Пересчёт заведён будильником и переживает сон service worker: setInterval уснул бы
  // вместе с ним, и бейдж замер бы на первом же значении.
  const period = await sw!.evaluate(async () => (await chrome.alarms.get('tc:badge'))?.periodInMinutes ?? null)
  expect(period, 'бейдж некому пересчитывать: будильник не заведён').toBeCloseTo(1 / 6, 5)

  await page.bringToFront()
  // Тот же обработчик, что и по расписанию, только без ожидания следующего срока.
  await sw!.evaluate(() => chrome.alarms.create('tc:badge', { when: Date.now() }))

  const badgeText = async () =>
    sw!.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      return chrome.action.getBadgeText({ tabId: tab!.id! })
    })

  await expect.poll(badgeText, { timeout: 10_000 }).toBe('6s')

  await context.close()
})

test('попап открывается в свой рост, а не полоской «Loading…»', async () => {
  const { browser, popup, answer } = await offlinePopup()
  const bodyHeight = () => popup.evaluate(() => document.body.getBoundingClientRect().height)

  const loading = popup.getByText('Loading…')
  await expect(loading).toBeVisible()
  const strip = (await loading.boundingBox())!.height
  const waiting = await bodyHeight()

  await answer([SUMMARY])
  await expect(popup.getByTestId('title')).toHaveText(SUMMARY.title)
  const ready = await bodyHeight()

  // Без пола высоты тело попапа обжимает единственную строку «Loading…»: окно открывается
  // в её рост и подпрыгивает, когда приходит ответ вкладки.
  expect(waiting, 'попап открылся полоской в одну строку').toBeGreaterThan(strip)
  // Точный рост готового попапа зависит от шрифта системы, поэтому сверяется не равенство,
  // а порядок: открылся попап примерно в свой рост, а не вырос на ответе вдвое.
  expect(ready, 'на ответе вкладки попап вырос вдвое').toBeLessThan(waiting * 2)

  await browser.close()
})
