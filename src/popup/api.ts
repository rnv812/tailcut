import { TOP_FRAME, type ExtensionToTab, type SessionSummary } from '../shared/protocol'

// Сводку описывает протокол, а не попап: разойдись эти два описания, попап читал бы поля,
// которых мост не присылает, и молча показывал бы undefined.
export type { SessionSummary }

/**
 * Вкладка, у которой попап взял список. Запоминается, потому что сохранять надо ровно ту
 * сессию, которую попап показывает: активная вкладка успевает смениться прямо под открытым
 * попапом, и «Save all» ушёл бы не туда.
 */
let boundTabId: number | undefined

async function targetTabId(): Promise<number | undefined> {
  if (boundTabId !== undefined) return boundTabId

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  boundTabId = tab?.id
  return boundTabId
}

/**
 * Спрашивает вкладку о накопленном. Попап только показывает ответ: ни разбора, ни сборки
 * здесь нет — открыться он обязан мгновенно.
 */
export async function listSessions(): Promise<SessionSummary[]> {
  const tabId = await targetTabId()
  if (tabId === undefined) return []

  const request: ExtensionToTab = { type: 'tc:list' }
  try {
    return (await chrome.tabs.sendMessage(tabId, request, TOP_FRAME)) ?? []
  } catch {
    // Страница без content script: chrome://, магазин расширений, вкладка старше установки.
    // Пустой список здесь честнее ошибки — записывать там нечего.
    return []
  }
}

/** Просит вкладку собрать накопленное в файл. Сборка и скачивание идут в мосте. */
export async function saveAll(key: string): Promise<void> {
  const tabId = await targetTabId()
  if (tabId === undefined) return

  const request: ExtensionToTab = { type: 'tc:save', key }
  try {
    await chrome.tabs.sendMessage(tabId, request, TOP_FRAME)
  } catch {
    // Вкладку закрыли или увели с той страницы, пока попап был открыт: сохранять нечего,
    // а необработанный отказ промиса попадёт разве что в консоль попапа.
  }
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Адрес страницы в виде, годном для строки под заголовком; непонятный адрес — пустая строка. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
