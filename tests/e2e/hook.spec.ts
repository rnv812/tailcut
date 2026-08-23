import { test, expect, type BrowserContext, type Frame, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchWithExtension, serveLocal } from './helpers'

const PAGE_URL = 'https://tailcut.test/player'
/** Страница без строгой политики: на ней проверяется, что чужие вызовы API не сломаны. */
const PLAIN_URL = 'https://tailcut.test/plain'
/** Обычный http: расширение объявлено на <all_urls>, а контекст здесь незащищённый. */
const INSECURE_URL = 'http://insecure.test/plain'

/** Сегменты в том порядке, в каком их дописывает tests/e2e/page/player.html. */
const APPENDED = [
  'h264/init-stream0.m4s',
  'h264/chunk-stream0-00001.m4s',
  'h264/chunk-stream0-00002.m4s',
  'h264/chunk-stream0-00003.m4s',
]

const MIME = 'video/mp4; codecs="avc1.4d401e"'

/**
 * FNV-1a, 32 бита. Тот же алгоритм считается в браузере: сравниваются не длины, а содержимое —
 * иначе обёртка, отдающая соседний кусок памяти той же длины, прошла бы проверку.
 */
function digest(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return `${bytes.byteLength}:${hash}`
}

async function fixtureDigests(): Promise<string[]> {
  const files = await Promise.all(
    APPENDED.map((rel) => fs.readFile(path.resolve('tests/fixtures', rel))),
  )
  return files.map((file) => digest(new Uint8Array(file)))
}

type SeenAppend = { sourceId: string; bufferId: string; mime: string; digest: string }
type SeenSource = { sourceId: string; objectUrl: string }

/** Что собрал слушатель, поставленный тестом в каждом документе страницы. */
type Probe = {
  tcAppend: SeenAppend[]
  tcSource: SeenSource[]
  tcDrm: string[]
  tcDigest: (bytes: ArrayBuffer) => string
}

type PlayerState = { appended: number; allAppended?: boolean }

/**
 * Открывает страницу с расширением и слушателем сообщений хука, поставленным до любого
 * скрипта страницы: иначе первые сообщения пройдут мимо и тест окажется ложноотрицательным.
 * Слушатель ставится во всех документах страницы, включая фрейм моста, — так виден весь путь.
 */
async function open(url: string, html?: string) {
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  const consoleLog: string[] = []
  page.on('console', (msg) => consoleLog.push(`${msg.type()}: ${msg.text()}`))
  page.on('pageerror', (err) => consoleLog.push(`pageerror: ${err.message}`))

  await page.addInitScript(() => {
    const target = window as unknown as Probe
    target.tcAppend = []
    target.tcSource = []
    target.tcDrm = []
    target.tcDigest = (buffer: ArrayBuffer) => {
      const bytes = new Uint8Array(buffer)
      let hash = 0x811c9dc5
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
      return `${bytes.byteLength}:${hash}`
    }

    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data !== 'object') return

      if (data.type === 'tc:append') {
        target.tcAppend.push({
          sourceId: String(data.sourceId),
          bufferId: String(data.bufferId),
          mime: String(data.mime),
          digest: target.tcDigest(data.bytes as ArrayBuffer),
        })
      } else if (data.type === 'tc:source') {
        target.tcSource.push({
          sourceId: String(data.sourceId),
          objectUrl: String(data.objectUrl),
        })
      } else if (data.type === 'tc:drm') {
        target.tcDrm.push(String(data.sourceId))
      }
    })
  })

  if (html !== undefined) {
    await page.route(url, (route) => route.fulfill({ body: html, contentType: 'text/html' }))
    await page.goto(url)
  } else {
    await serveLocal(page, 'player.html', url)
  }

  return {
    context,
    page,
    extensionId,
    log: () => consoleLog.join(' | ') || '(пусто)',
  }
}

const openPlayer = () => open(PAGE_URL)

/** Ждёт, пока плеер допишет все свои сегменты. */
const playerDone = (page: Page) =>
  page.waitForFunction(() => (window as unknown as PlayerState).allAppended === true, undefined, {
    timeout: 15_000,
  })

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

const close = (context: BrowserContext) => context.close()

test('хук видит каждый appendBuffer и не мешает плееру', async () => {
  const { context, page, log } = await openPlayer()
  await playerDone(page)

  const seen = await page.evaluate(() => (window as unknown as Probe).tcAppend)
  const appended = await page.evaluate(() => (window as unknown as PlayerState).appended)

  expect(seen.length, `хук пропустил вызовы appendBuffer; консоль страницы: ${log()}`).toBe(
    appended,
  )
  // Содержимое, а не только число сообщений: копия обязана нести те же байты и в том же порядке.
  expect(seen.map((item) => item.digest)).toEqual(await fixtureDigests())

  // Один MediaSource и один SourceBuffer: без общего идентификатора мост не соберёт дорожку.
  expect(new Set(seen.map((item) => item.sourceId)).size).toBe(1)
  expect(new Set(seen.map((item) => item.bufferId)).size).toBe(1)
  expect(new Set(seen.map((item) => item.mime))).toEqual(new Set([MIME]))

  const error = await page.evaluate(() => {
    const video = document.querySelector('video')!
    return video.error ? video.error.code : null
  })
  expect(error, 'плеер не должен получить ошибку из-за обёрток').toBeNull()

  await close(context)
})

test('источник связан с адресом, попавшим в video.src', async () => {
  const { context, page, log } = await openPlayer()
  await playerDone(page)

  const observed = await page.evaluate(() => {
    const seen = window as unknown as Probe
    return {
      sources: seen.tcSource,
      appendSourceId: seen.tcAppend[0]?.sourceId ?? '',
      videoSrc: document.querySelector('video')!.src,
    }
  })

  // Ровно один источник, и его адрес — тот самый, что плеер поставил элементу: по нему
  // наблюдатель в изолированном мире находит, какому <video> принадлежит поток.
  expect(observed.sources, `консоль страницы: ${log()}`).toEqual([
    { sourceId: observed.appendSourceId, objectUrl: observed.videoSrc },
  ])
  expect(observed.videoSrc.startsWith('blob:')).toBe(true)

  await close(context)
})

test('копия снимается синхронно, до возврата из appendBuffer', async () => {
  const { context, page, log } = await openPlayer()
  await playerDone(page)

  // Отдельный MediaSource: сегмент дописывается видом с ненулевым смещением, а сразу после
  // возврата из appendBuffer исходный буфер затирается. Плеер вправе так делать — MSE копирует
  // данные синхронно. Если обёртка отложит копирование до микрозадачи, до моста доедет мусор.
  const scribbled = await page.evaluate(async (mime) => {
    const seen = window as unknown as Probe
    const before = seen.tcAppend.length
    const source = new MediaSource()
    const video = document.createElement('video')
    video.src = URL.createObjectURL(source)
    document.body.appendChild(video)

    await new Promise((resolve) => source.addEventListener('sourceopen', resolve, { once: true }))
    const sourceBuffer = source.addSourceBuffer(mime)

    const segment = new Uint8Array(
      await (await fetch('/fixtures/h264/init-stream0.m4s')).arrayBuffer(),
    )
    // Смещение и хвост вокруг сегмента: обёртка обязана взять именно его окно в буфере.
    const padded = new Uint8Array(segment.byteLength + 11)
    padded.set(segment, 7)
    const view = new Uint8Array(padded.buffer, 7, segment.byteLength)

    const expected = seen.tcDigest(segment.slice().buffer)

    await new Promise((resolve) => {
      sourceBuffer.addEventListener('updateend', resolve, { once: true })
      sourceBuffer.appendBuffer(view)
      padded.fill(0xff)
    })

    const deadline = Date.now() + 3_000
    while (seen.tcAppend.length === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    return { expected, captured: seen.tcAppend.slice(before).map((item) => item.digest) }
  }, MIME)

  expect(scribbled.captured, `консоль страницы: ${log()}`).toEqual([scribbled.expected])

  await close(context)
})

test('буфер страницы переживает отправку: тот же ArrayBuffer дописывается повторно', async () => {
  const { context, page, log } = await openPlayer()
  await playerDone(page)

  // Плееры дописывают голый ArrayBuffer из (await fetch(...)).arrayBuffer(), и тот же буфер идёт
  // в дело второй раз, когда кеш сегментов дописывает его после перемотки. Отдай обёртка наружу
  // сам буфер страницы, transferable-отправка отсоединила бы его. Это отказ хуже исключения:
  // повторный appendBuffer отсоединённого буфера штатно резолвит updateend, ничего не дописав, —
  // плеер молча встаёт без ошибки.
  const replay = await page.evaluate(async (mime) => {
    const seen = window as unknown as Probe
    const before = seen.tcAppend.length
    const source = new MediaSource()
    const video = document.createElement('video')
    video.src = URL.createObjectURL(source)
    document.body.appendChild(video)

    await new Promise((resolve) => source.addEventListener('sourceopen', resolve, { once: true }))
    const sourceBuffer = source.addSourceBuffer(mime)

    const update = (act: () => void): Promise<unknown> =>
      new Promise((resolve) => {
        sourceBuffer.addEventListener('updateend', resolve, { once: true })
        act()
      })
    const fetchBuffer = async (path: string): Promise<ArrayBuffer> =>
      (await fetch(path)).arrayBuffer()
    const bufferedEnd = (): number =>
      sourceBuffer.buffered.length ? sourceBuffer.buffered.end(0) : 0
    const settle = async (count: number): Promise<void> => {
      const deadline = Date.now() + 3_000
      while (seen.tcAppend.length < before + count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    const init = await fetchBuffer('/fixtures/h264/init-stream0.m4s')
    const chunk = await fetchBuffer('/fixtures/h264/chunk-stream0-00001.m4s')
    const size = chunk.byteLength
    const expected = seen.tcDigest(chunk.slice(0))

    await update(() => sourceBuffer.appendBuffer(init))
    await update(() => sourceBuffer.appendBuffer(chunk))
    const firstPass = bufferedEnd()

    // Отсоединение случилось бы именно на отправке: ждём, пока хук отдаст оба сегмента.
    await settle(2)
    const sizeAfterSend = chunk.byteLength

    // Перемотка: плеер выкидывает накопленное и дописывает тот же кусок заново из своего кеша.
    await update(() => sourceBuffer.remove(0, Infinity))
    const cleared = sourceBuffer.buffered.length
    await update(() => sourceBuffer.appendBuffer(chunk))
    const secondPass = bufferedEnd()
    await settle(3)

    return {
      size,
      sizeAfterSend,
      firstPass,
      cleared,
      secondPass,
      expected,
      digests: seen.tcAppend.slice(before + 1).map((item) => item.digest),
      error: video.error ? video.error.code : null,
    }
  }, MIME)

  expect(replay.sizeAfterSend, `отправка мосту отсоединила буфер страницы; консоль: ${log()}`).toBe(
    replay.size,
  )
  expect(replay.cleared, 'подготовка: перед повтором буфер должен был опустеть').toBe(0)
  expect(replay.firstPass, 'подготовка: первый проход ничего не набрал').toBeGreaterThan(0)
  expect(replay.secondPass, 'повторный appendBuffer не дописал ничего — плеер встал молча').toBe(
    replay.firstPass,
  )
  expect(replay.digests, 'мосту доехали не те байты').toEqual([replay.expected, replay.expected])
  expect(replay.error, 'плеер не должен получить ошибку из-за обёрток').toBeNull()

  await close(context)
})

test('сегменты доезжают до фрейма моста', async () => {
  const { context, page, extensionId, log } = await openPlayer()
  await playerDone(page)

  const bridge = await bridgeFrame(page, extensionId, log)
  await bridge
    .waitForFunction((count) => (window as unknown as Probe).tcAppend.length >= count, APPENDED.length, {
      timeout: 5_000,
    })
    .catch(() => undefined)

  const delivered = await bridge.evaluate(() =>
    (window as unknown as Probe).tcAppend.map((item) => item.digest),
  )
  expect(delivered, `мост не получил сегменты; консоль страницы: ${log()}`).toEqual(
    await fixtureDigests(),
  )

  await close(context)
})

test('createObjectURL остаётся рабочим для обычных Blob', async () => {
  const { context, page, log } = await open(
    PLAIN_URL,
    '<!doctype html><meta charset="utf-8"><title>plain</title>',
  )

  const result = await page.evaluate(async () => {
    const url = URL.createObjectURL(new Blob(['tailcut'], { type: 'text/plain' }))
    const text = await (await fetch(url)).text()
    URL.revokeObjectURL(url)
    return { url, text, sources: (window as unknown as Probe).tcSource.length }
  })

  expect(result.text, `blob-адрес перестал читаться; консоль страницы: ${log()}`).toBe('tailcut')
  expect(result.url.startsWith('blob:')).toBe(true)
  // Blob — не MediaSource: сессии на нём заводиться не должно.
  expect(result.sources).toBe(0)

  await close(context)
})

test('обращение к DRM видно, а сам вызов работает', async () => {
  const { context, page, log } = await openPlayer()

  const access = await page.evaluate(async (mime) => {
    try {
      const result = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [
        { initDataTypes: ['keyids'], videoCapabilities: [{ contentType: mime }] },
      ])
      return { keySystem: result.keySystem, failed: '' }
    } catch (error) {
      return { keySystem: '', failed: String(error) }
    }
  }, MIME)

  await page
    .waitForFunction(() => (window as unknown as Probe).tcDrm.length > 0, undefined, {
      timeout: 3_000,
    })
    .catch(() => undefined)

  expect(
    await page.evaluate(() => (window as unknown as Probe).tcDrm),
    `хук должен сообщить об обращении к DRM; консоль страницы: ${log()}`,
  ).toEqual(['page'])
  expect(access, 'обёртка не должна ломать выдачу ключей').toEqual({
    keySystem: 'org.w3.clearkey',
    failed: '',
  })

  await close(context)
})

test('на http-странице EME не выдумывается', async () => {
  const { context, page, log } = await open(
    INSECURE_URL,
    '<!doctype html><meta charset="utf-8"><title>insecure</title>',
  )

  const observed = await page.evaluate(async () => {
    const seen = window as unknown as Probe
    // Сперва — доказательство, что хук на этой странице вообще стоит: иначе проверка ниже
    // прошла бы и на странице без расширения, то есть не значила бы ничего.
    URL.createObjectURL(new MediaSource())
    await new Promise((resolve) => setTimeout(resolve, 100))

    return {
      hooked: seen.tcSource.length,
      // Ровно та последовательность, что делают shaka, dash.js и hls.js: проверили наличие
      // метода — и только потом зовут.
      eme: typeof navigator.requestMediaKeySystemAccess,
      secure: window.isSecureContext,
    }
  })

  expect(observed.hooked, `хук не встал на http-страницу; консоль страницы: ${log()}`).toBe(1)
  expect(observed.secure, 'подготовка: страница должна быть незащищённым контекстом').toBe(false)
  // Вне защищённого контекста Chrome не отдаёт requestMediaKeySystemAccess вовсе. Обёртка,
  // поставленная поверх пустого места, выдумала бы возможность, которой у браузера нет:
  // проверка наличия прошла бы, а вызов упал бы уже внутри обёртки.
  expect(observed.eme, 'хук объявил EME там, где браузер его не даёт').toBe('undefined')

  await close(context)
})
