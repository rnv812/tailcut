// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SessionSummary } from '../../src/shared/protocol'

/**
 * Самая свежая сессия вкладки: список приходит от свежих к старым, и показывать попап
 * обязан именно её — то, что пишется прямо сейчас.
 */
const fresh: SessionSummary = {
  key: 'https://site.example/watch|avc1|inf',
  url: 'https://site.example/watch?v=abc',
  title: 'Clip — site.example',
  duration: 6,
  bytes: 1_543_210,
  runs: 1,
}

/**
 * Вторая сессия той же вкладки. Двумя сессиями страница обзаводится буднично: DASH-плеер
 * заводит отдельные SourceBuffer под звук и картинку, ключ сессии считается по адресу и
 * кодекам, и в реестре их сразу две.
 */
const older: SessionSummary = {
  key: 'https://site.example/watch|mp4a|inf',
  url: 'https://other.example/watch',
  title: 'Старая сессия',
  duration: 300,
  bytes: 90_000_000,
  runs: 4,
}

type Sent = { tabId: number; message: unknown }

/** Ответ вкладки: список сводок либо молчание — вкладка ещё не ответила. */
type Reply = { sessions: SessionSummary[] } | 'silent'

/**
 * Подменяет chrome для попапа: вкладка одна, отвечает она тем, что задал тест. Модуль api
 * при этом настоящий — проверяется весь путь от ответа вкладки до разметки.
 */
function installChrome(reply: Reply) {
  const sent: Sent[] = []

  vi.stubGlobal('chrome', {
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: (tabId: number, message: unknown) => {
        sent.push({ tabId, message })
        // Молчание вкладки — не отказ: промис просто не разрешается, и попап ждёт.
        if (reply === 'silent') return new Promise(() => {})
        return Promise.resolve(reply.sessions)
      },
    },
  })

  return sent
}

/**
 * Даёт попапу дорисоваться. Кадр — не перестраховка: preact откладывает эффекты до него,
 * а до эффекта попап вкладку ещё не спрашивал. Микрозадачи следом — на ответ вкладки и
 * перерисовку по нему.
 */
const flush = async () => {
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Поднимает попап так же, как его поднимает Chrome: загрузкой модуля страницы. */
async function mount(reply: Reply): Promise<Sent[]> {
  const sent = installChrome(reply)
  // Новое тело страницы, а не очистка старого: в прежнем остаётся дерево preact от
  // прошлой отрисовки, и следующая сверялась бы с ним.
  document.documentElement.replaceChild(document.createElement('body'), document.body)
  // Модуль рисует себя при загрузке и помнит вкладку между вызовами: каждой отрисовке
  // нужен свежий импорт.
  vi.resetModules()
  await import('../../src/popup/popup')
  await flush()
  return sent
}

const at = (testId: string) => document.body.querySelector(`[data-testid="${testId}"]`)
const textAt = (testId: string) => at(testId)?.textContent ?? null
const bodyText = () => document.body.textContent?.trim() ?? ''

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('попап', () => {
  it('пока вкладка не ответила, ждёт', async () => {
    await mount('silent')

    expect(bodyText()).toBe('Loading…')
  })

  it('на странице без записи говорит, что записывать было нечего', async () => {
    await mount({ sessions: [] })

    // Пустой список отличается от «ответа ещё нет»: без этой развилки попап читает поля
    // несуществующей сводки, отрисовка падает, и он навсегда остаётся в «Loading…».
    expect(bodyText()).toBe('Nothing recorded on this page yet.')
    expect(at('title'), 'попап показывает сводку там, где сводок нет').toBeNull()
  })

  it('показывает самую свежую сессию вкладки', async () => {
    await mount({ sessions: [fresh, older] })

    // Сессий у страницы бывает несколько, и порядок в списке значащий: сверху та, что
    // пишется сейчас. Возьми попап другую — покажет и сохранит давно брошенную.
    expect(textAt('title')).toBe(fresh.title)
    expect(textAt('host')).toBe('site.example')
    expect(textAt('duration')).toBe('0:06')
  })

  it('показывает объём записанного', async () => {
    await mount({ sessions: [fresh, older] })

    // Подпись рядом с длительностью — про байты: перепутай поле, и полтора мегабайта
    // превратятся в «0 KB», а пользователь решит, что записывать нечего.
    expect(textAt('bytes')).toBe('1.5 MB')
  })

  it('о повторных прогонах говорит, а о единственном молчит', async () => {
    await mount({ sessions: [{ ...fresh, runs: 3 }] })
    expect(textAt('runs')).toBe('3 runs')

    await mount({ sessions: [fresh] })
    // Прогон один — говорить не о чем: «1 runs» и врёт числом, и путает.
    expect(at('runs')).toBeNull()
  })

  it('сохраняет ту сессию, которую показал', async () => {
    const sent = await mount({ sessions: [fresh, older] })

    document.body.querySelector('button')!.click()
    await flush()

    // Ключ показанной сессии и ключ сохраняемой — один и тот же: разойдись они, кнопка
    // сохранила бы соседнюю дорожку той же страницы.
    expect(sent.map((item) => item.message)).toEqual([
      { type: 'tc:list' },
      { type: 'tc:save', key: fresh.key },
    ])
  })
})
