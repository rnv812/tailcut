import { test, expect } from '@playwright/test'
import { launchWithExtension } from './helpers'

test('extension loads and exposes a service worker', async () => {
  const { context, extensionId } = await launchWithExtension()
  expect(extensionId).toMatch(/^[a-p]{32}$/)
  await context.close()
})

test('service worker applies its install-time setup', async () => {
  const { context } = await launchWithExtension()
  // launchWithExtension уже дождался воркера, поэтому список непустой
  const sw = context.serviceWorkers()[0]!

  const color = await sw.evaluate(() => chrome.action.getBadgeBackgroundColor({}))
  expect(color, 'onInstalled должен выставить цвет бейджа').toEqual([76, 141, 255, 255])

  await context.close()
})
