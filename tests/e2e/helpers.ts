import { chromium, type BrowserContext, type Page } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'

const EXT = path.resolve('dist')

export async function launchWithExtension(): Promise<{
  context: BrowserContext
  extensionId: string
}> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tailcut-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    acceptDownloads: true,
  })

  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker')

  return { context, extensionId: new URL(sw.url()).host }
}

/** Отдаёт локальную страницу и фикстуры по вымышленному адресу. */
export async function serveLocal(page: Page, htmlFile: string, url: string): Promise<void> {
  await page.route('**/fixtures/**', async (route) => {
    const rel = new URL(route.request().url()).pathname.replace('/fixtures/', '')
    const body = await fs.readFile(path.resolve('tests/fixtures', rel))
    await route.fulfill({ body, contentType: 'video/mp4' })
  })

  await page.route(url, async (route) => {
    const body = await fs.readFile(path.resolve('tests/e2e/page', htmlFile), 'utf8')
    await route.fulfill({ body, contentType: 'text/html' })
  })

  await page.goto(url)
}
