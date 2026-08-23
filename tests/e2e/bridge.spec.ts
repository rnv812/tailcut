import { test, expect, type Frame, type Page } from '@playwright/test'
import { launchWithExtension, serveLocal } from './helpers'

const PAGE_URL = 'https://tailcut.test/player'

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

test('мост встаёт на странице со строгим CSP и принимает бинарные данные', async () => {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  // Нарушение CSP видно только в консоли страницы. Собираем её, чтобы при провале
  // отличить запрет политики от ошибки вставки.
  const consoleLog: string[] = []
  page.on('console', (msg) => consoleLog.push(`${msg.type()}: ${msg.text()}`))
  page.on('pageerror', (err) => consoleLog.push(`pageerror: ${err.message}`))

  await serveLocal(page, 'player.html', PAGE_URL)

  const frame = await waitForExtensionFrame(page, extensionId)
  expect(
    frame,
    `iframe расширения должен появиться несмотря на frame-src none; консоль страницы: ${consoleLog.join(' | ') || '(пусто)'}`,
  ).toBeTruthy()
  await frame!.waitForLoadState('domcontentloaded')

  const echoed = await page.evaluate(async () => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-tailcut]')!
    const payload = new Uint8Array([1, 2, 3, 4]).buffer
    return new Promise<number>((resolve) => {
      window.addEventListener('message', function onMsg(e) {
        if (e.data?.type === 'tc:echo') {
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
  })

  expect(echoed, `мост должен подтвердить приём байтов; консоль страницы: ${consoleLog.join(' | ') || '(пусто)'}`).toBe(4)

  // Страница со строгим CSP должна продолжать играть: мост не мешает её собственному MSE.
  await page.waitForFunction(() => (window as unknown as { allAppended?: boolean }).allAppended === true)
  expect(await page.evaluate(() => (window as unknown as { appended: number }).appended)).toBe(4)

  await context.close()
})
