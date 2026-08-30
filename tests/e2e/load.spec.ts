import { test, expect } from '@playwright/test'
import { launchWithExtension } from './helpers'

test('extension loads and exposes a service worker', async () => {
  const { context, extensionId } = await launchWithExtension()
  expect(extensionId).toMatch(/^[a-p]{32}$/)
  await context.close()
})

test('service worker applies its install-time setup', async () => {
  const { context } = await launchWithExtension()
  // launchWithExtension already waited for the worker, so this list is non-empty.
  const sw = context.serviceWorkers()[0]!

  // Polled, not read once. The worker appears the moment the browser has evaluated its script,
  // and onInstalled arrives afterwards as an event of its own — a fraction of a millisecond later
  // on an idle machine, and long enough later on a busy one that a single read caught the default
  // black. It went unseen while the suite ran one test at a time and failed on the first run four
  // workers wide. The claim is unchanged: the colour has to become this one and no other.
  await expect
    .poll(() => sw.evaluate(() => chrome.action.getBadgeBackgroundColor({})), { timeout: 10_000 })
    .toEqual([76, 141, 255, 255])

  await context.close()
})
