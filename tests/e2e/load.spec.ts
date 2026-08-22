import { test, expect, chromium, type BrowserContext } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'

const EXT = path.resolve('dist')

export async function launchWithExtension(): Promise<{ context: BrowserContext; extensionId: string }> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tailcut-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  })
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker')
  const extensionId = new URL(sw.url()).host
  return { context, extensionId }
}

test('extension loads and exposes a service worker', async () => {
  const { context, extensionId } = await launchWithExtension()
  expect(extensionId).toMatch(/^[a-p]{32}$/)
  await context.close()
})
