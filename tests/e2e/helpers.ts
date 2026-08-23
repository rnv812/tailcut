import { chromium, type BrowserContext, type Page } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'

const EXT = path.resolve('dist')

/**
 * Общий запуск для обоих режимов. Всё, кроме двух аргументов загрузки расширения, обязано
 * совпадать: измерение накладных расходов в `overhead.spec.ts` сравнивает эти два запуска
 * между собой, и любое другое расхождение в настройках оно припишет расширению.
 */
async function launch(args: string[]): Promise<BrowserContext> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tailcut-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    acceptDownloads: true,
  })

  // Профиль весит мегабайты, а запусков за прогон набора десятки: без уборки во временном
  // каталоге за месяц копятся гигабайты, и первым это замечает `overhead.spec.ts` — забитый
  // /tmp меняет измеряемые им величины.
  context.on('close', () => {
    // Событие приходит раньше, чем браузер дописывает профиль, поэтому с повторами; отказ
    // глушится намеренно — уборка не повод ронять тест.
    void fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      .catch(() => {})
  })

  return context
}

export async function launchWithExtension(): Promise<{
  context: BrowserContext
  extensionId: string
}> {
  const context = await launch([`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`])

  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker')

  return { context, extensionId: new URL(sw.url()).host }
}

/** Тот же браузер без расширения — точка отсчёта для измерения накладных расходов. */
export async function launchWithoutExtension(): Promise<BrowserContext> {
  return launch([])
}

/**
 * Готовит локальную страницу и фикстуры к выдаче по вымышленному адресу, не открывая её.
 * Отдельно от перехода это нужно странице, которая встраивает другую: обе раскладываются
 * по своим адресам заранее, а открывается только внешняя.
 */
export async function routeLocal(page: Page, htmlFile: string, url: string): Promise<void> {
  await page.route('**/fixtures/**', async (route) => {
    const rel = new URL(route.request().url()).pathname.replace('/fixtures/', '')
    const body = await fs.readFile(path.resolve('tests/fixtures', rel))
    await route.fulfill({ body, contentType: 'video/mp4' })
  })

  await page.route(url, async (route) => {
    const body = await fs.readFile(path.resolve('tests/e2e/page', htmlFile), 'utf8')
    await route.fulfill({ body, contentType: 'text/html' })
  })
}

/** Отдаёт локальную страницу и фикстуры по вымышленному адресу и открывает её. */
export async function serveLocal(page: Page, htmlFile: string, url: string): Promise<void> {
  await routeLocal(page, htmlFile, url)
  await page.goto(url)
}
