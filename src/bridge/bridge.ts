import {
  isPageToBridge,
  type BridgeToPage,
  type SaveResult,
  type SessionSummary,
} from '../shared/protocol'
import { assembleFragmentedMp4 } from '../core/assemble'
import { SessionStore } from './session-store'
import type { Run } from '../shared/types'

const store = new SessionStore()

/**
 * Столько блоб живёт после начала скачивания. Chrome читает его не мгновенно, и адрес,
 * снятый сразу после вызова, обрывает уже начатое скачивание на полпути.
 */
const REVOKE_DELAY_MS = 60_000

/** Предел длины имени файла: у файловых систем он есть, и заголовок страницы бывает длиннее. */
const MAX_NAME_LENGTH = 100

interface PageContext {
  url: string
  title: string
}

/**
 * Мост живёт на origin расширения и адреса страницы, которая его вставила, сам не знает.
 * До первого tc:context остаётся referrer: он есть не всегда, но лучше пустой строки.
 */
let pageContext: PageContext = { url: document.referrer, title: '' }

function summaries(): SessionSummary[] {
  return store.list().map((s) => ({
    key: s.key,
    url: s.url,
    title: s.title,
    duration: s.map.duration(),
    bytes: s.map.totalBytes(),
    runs: s.map.runs().length,
  }))
}

/** Самый длинный прогон: файлом уходит непрерывный кусок, а не склейка через разрывы. */
function longestRun(runs: Run[]): Run | undefined {
  let longest: Run | undefined
  for (const run of runs) {
    if (!longest || run.end - run.start > longest.end - longest.start) longest = run
  }
  return longest
}

/**
 * Имя файла из заголовка страницы. Запрещённое в именах файлов вычищается, остальное остаётся
 * как есть: заголовок на любом языке — не повод отдать пользователю файл из подчёркиваний.
 */
function fileNameFor(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Имя, начатое точкой, Chrome считает скрытым файлом, а «..» — путём наверх. Точки
    // с краёв снимаются после схлопывания пробелов: «../../.bashrc» иначе оставит их
    // за первым же пробелом.
    .replace(/^[.\s]+/, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[.\s]+$/, '')

  return `${base || 'tailcut'}.mp4`
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data

  if (data?.type === 'tc:context') {
    pageContext = { url: String(data.url), title: String(data.title) }
    return
  }

  // Запросы от попапа приходят через порт: chrome.runtime.sendMessage
  // до этого iframe не доходит, он адресуется content script'у.
  if (data?.type === 'tc:list') {
    // Через объявленный союз, а не напрямую: postMessage принимает что угодно, и молча
    // разошедшийся с BridgeToPage ответ обнаружился бы только у получателя.
    const reply: BridgeToPage = summaries()
    event.ports[0]?.postMessage(reply)
    return
  }

  // Сборка идёт здесь, а не в попапе: байты лежат в этом фрейме, и гнать мегабайты
  // сообщениями расширения значило бы копировать их дважды и через JSON.
  if (data?.type === 'tc:save') {
    const port = event.ports[0]
    const session = store.get(String(data.key))
    const run = session && longestRun(session.map.runs())

    // Сессию мог вытеснить отбор, а страница — перезагрузиться, пока попап был открыт:
    // ключ у попапа тогда указывает в пустоту. Сохранять нечего и у сессии из одного
    // init-сегмента: прогонов в ней нет.
    if (!session || !run) {
      const empty: SaveResult = { ok: false }
      port?.postMessage(empty)
      return
    }

    // Blob принимает вид только над обычным ArrayBuffer, а Uint8Array по типу допускает и
    // разделяемую память. Сборка выделяет буфер сама и разделяемым он не бывает.
    const file = assembleFragmentedMp4(session.initBytes, run) as Uint8Array<ArrayBuffer>
    const url = URL.createObjectURL(new Blob([file], { type: 'video/mp4' }))

    chrome.downloads.download({ url, filename: fileNameFor(session.title) }, (downloadId) => {
      const failed = downloadId === undefined
      // Отказ надо прочитать, иначе Chrome пишет о нём в консоль сам.
      if (failed) void chrome.runtime.lastError

      setTimeout(() => URL.revokeObjectURL(url), failed ? 0 : REVOKE_DELAY_MS)

      const result: SaveResult = { ok: !failed }
      port?.postMessage(result)
    })
    return
  }

  // Вердикт отбора выносит content script по сигналам <video>: хук в MAIN world копирует
  // байты всегда, а решать, что из них остаётся, — работа изолированного мира. Вердикт
  // адресный, поэтому и отказ действует ровно на свой источник.
  if (data?.type === 'tc:verdict') {
    const sourceId = String(data.sourceId)
    if (data.verdict === 'reject') store.dropPending(sourceId)
    if (data.verdict === 'hold') store.resumePending(sourceId)
    if (data.verdict === 'promote') store.promotePending(sourceId)
    return
  }

  if (!isPageToBridge(data)) return

  if (data.type === 'tc:append') {
    store.append({
      sourceId: data.sourceId,
      url: pageContext.url,
      title: pageContext.title,
      bytes: new Uint8Array(data.bytes),
      now: Date.now(),
    })
  }
})

// Рукопожатие — окну своего фрейма, а не window.top: мост встаёт в каждом фрейме страницы
// (all_frames в манифесте), и для плеера во вложенном фрейме верхняя страница посторонняя —
// о мосте должен узнать тот документ, который его и вставил.
const handshake: BridgeToPage = { type: 'tc:ready' }
window.parent.postMessage(handshake, '*')
