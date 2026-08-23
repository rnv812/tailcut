import { test, expect, type BrowserContext } from '@playwright/test'
import { launchWithExtension, launchWithoutExtension, serveLocal } from './helpers'

const PAGE_URL = 'https://tailcut.test/measured'

/**
 * Сколько раз повторяется каждый замер. Разница, которую мы ищем, — десятки микросекунд на
 * вызов, а одиночный срыв планировщика стоит вдвое больше; трёх прогонов хватает, чтобы хотя
 * бы один прошёл без помех.
 */
const ROUNDS = 3

/**
 * Потолок накладных расходов, выраженный в копиях сегмента. Обёртка обязана стоить одну копию
 * (`copyOf` в `src/page/main-hook.ts`) плюс постановку в очередь; на машине разработки за
 * двадцать пять прогонов вышло от 1.45 до 2.52 копии (среднее 1.91) — разницу дают выделение
 * памяти под копию, поиск в WeakMap и постановка микрозадачи.
 *
 * Четыре — это запас в 1.6 к худшему из измеренных, и запас нужен настоящий: разброс здесь
 * ±25 %, и берётся он с машины, а не из кода. Порог ловит всё, что дороже нынешнего примерно
 * вдвое с половиной: перекладку через обычный массив (63–69 копий), любое ожидание в
 * синхронном пути. Побайтовое копирование вместо `set` (4.2–5.4) он ловит впритык — на удачной
 * калибровке может и проскочить. Одну лишнюю копию (3.4) не ловит вовсе: она тонет в разбросе,
 * и делать вид, что ловит, значит завести тест, который падает по вторникам.
 *
 * Порог именно в копиях, а не в миллисекундах: на вдвое более медленной машине растут обе
 * величины, и отношение остаётся тем же.
 */
const COPY_BUDGET = 4

interface Measurement {
  /** Суммарное время внутри appendBuffer, мс. */
  appendMs: number
  /** Сколько замеров в этой сумме. */
  appends: number
  /** Цена `copyCount` копий тех же байтов на этой машине, мс. */
  copyMs: number
  copyCount: number
}

declare global {
  interface Window {
    measured: boolean
    failure: string | null
    appendSamples: number[]
    copyBaselineMs: number
    copyCount: number
  }
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)

async function measure(withExtension: boolean): Promise<Measurement> {
  let context: BrowserContext
  if (withExtension) ({ context } = await launchWithExtension())
  else context = await launchWithoutExtension()

  try {
    const page = await context.newPage()
    await serveLocal(page, 'measured.html', PAGE_URL)

    // Отказ ждём наравне с успехом: без этого сорвавшаяся страница молчала бы до таймаута,
    // и падение рассказывало бы про таймаут, а не про причину.
    await page.waitForFunction(() => window.measured || window.failure !== null, null, {
      timeout: 120_000,
    })

    const result = await page.evaluate(() => ({
      failure: window.failure,
      samples: window.appendSamples,
      copyMs: window.copyBaselineMs,
      copyCount: window.copyCount,
    }))

    expect(result.failure, 'измеряющая страница не доработала до конца').toBeNull()

    return {
      appendMs: sum(result.samples),
      appends: result.samples.length,
      copyMs: result.copyMs,
      copyCount: result.copyCount,
    }
  } finally {
    await context.close()
  }
}

test('обёртки не удорожают синхронный путь appendBuffer', async () => {
  // Шесть запусков браузера по сотне сегментов каждый: в тридцать секунд по умолчанию не лезет.
  test.setTimeout(300_000)

  const clean: Measurement[] = []
  const hooked: Measurement[] = []

  // Режимы чередуются, а не идут блоками: машина за время прогона разгоняется и остывает, и
  // порядок «сначала все чистые, потом все с расширением» подарил бы этот дрейф целиком одной
  // стороне.
  for (let round = 0; round < ROUNDS; round++) {
    clean.push(await measure(false))
    hooked.push(await measure(true))
  }

  const appends = clean[0]!.appends
  expect(appends, 'страница обязана отдать замеры').toBeGreaterThan(0)
  for (const round of [...clean, ...hooked]) {
    expect(round.appends, 'все прогоны обязаны быть одинаковой длины').toBe(appends)
  }

  // Минимум, а не медиана: прогон, которому меньше всех мешали, и есть настоящая цена вызова.
  // Всё сверх неё — чужая работа на той же машине, и в обоих режимах она своя. Регрессия
  // поднимает и минимум тоже, а вот случайная помеха его не трогает.
  const perAppendUs = (rounds: Measurement[]): number =>
    (Math.min(...rounds.map((round) => round.appendMs)) / appends) * 1000

  const cleanUs = perAppendUs(clean)
  const hookedUs = perAppendUs(hooked)
  // Цена копии берётся из чистых прогонов: это свойство машины, и мерить его надо там, где
  // расширение не отнимает у страницы такты.
  const copyUs = Math.min(...clean.map((round) => (round.copyMs / round.copyCount) * 1000))
  const copies = (hookedUs - cleanUs) / copyUs

  // Поимённо по прогонам: при падении сразу видно, сорвался один замер или подорожали все.
  for (const [name, rounds] of [
    ['без расширения', clean],
    ['с расширением', hooked],
  ] as const) {
    const perRound = rounds.map(
      (round) =>
        `${((round.appendMs / appends) * 1000).toFixed(1)}/${(
          (round.copyMs / round.copyCount) *
          1000
        ).toFixed(1)}`,
    )
    console.log(`  ${name} (мкс на вызов / мкс на копию): ${perRound.join('  ')}`)
  }
  console.log(
    `appendBuffer за ${appends} вызовов: без расширения ${cleanUs.toFixed(1)} мкс/вызов, ` +
      `с расширением ${hookedUs.toFixed(1)} мкс/вызов; ` +
      `надбавка ${(hookedUs - cleanUs).toFixed(1)} мкс = ${copies.toFixed(2)} копии сегмента ` +
      `(копия — ${copyUs.toFixed(1)} мкс)`,
  )

  expect(copies).toBeLessThan(COPY_BUDGET)
})
