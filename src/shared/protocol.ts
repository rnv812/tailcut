/** Путь к странице моста внутри пакета расширения. */
export const BRIDGE_PATH = 'bridge/bridge.html'

export type PageToBridge =
  | { type: 'tc:append'; sourceId: string; bufferId: string; mime: string; bytes: ArrayBuffer }
  /** objectUrl связывает MediaSource с конкретным элементом <video> на странице */
  | { type: 'tc:source'; sourceId: string; objectUrl: string }
  | { type: 'tc:drm'; sourceId: string }

/**
 * Сводка одной сессии реестра: этим мост отвечает на запрос списка, и этим же попап
 * подписывает строку в списке. Ключ — ручка, которой сессия запрашивается у реестра;
 * адресом страницы он не является.
 */
export interface SessionSummary {
  key: string
  url: string
  title: string
  duration: number
  bytes: number
  runs: number
}

/**
 * Всё, что мост отправляет наружу, и ничего сверх того. Каналов два, и союз описывает оба:
 * рукопожатие уходит окну, вставившему мост, а список сессий — только в порт MessageChannel,
 * пришедший вместе с запросом. Сообщение, не описанное здесь, — необъявленная часть протокола:
 * получатель о ней не знает, а следующий читатель кода узнаёт о ней не из типа, а из мостовой
 * реализации.
 */
export type BridgeToPage = { type: 'tc:ready' } | SessionSummary[]

/**
 * Запросы к content script вкладки: их шлёт попап и service worker через
 * `chrome.tabs.sendMessage`. Реестр сессий живёт во фрейме моста, до которого сообщение
 * расширения само не доходит, — content script проводит запрос туда и возвращает ответ.
 */
export type ExtensionToTab = { type: 'tc:list' } | { type: 'tc:save'; key: string }

/** Чем мост отвечает на tc:save. */
export interface SaveResult {
  ok: boolean
}

/**
 * Адресат запросов расширения — главный фрейм вкладки. Без этого сообщение уходит во все
 * фреймы разом (content-скрипты объявлены с all_frames), отвечает каждый со своим реестром,
 * и попапу достаётся ответ того, кто успел первым: на странице с рекламными фреймами это
 * чей угодно пустой список. Плеер, встроенный во фрейм, попапу на этом этапе не виден —
 * его сессии живут в реестре своего фрейма.
 */
export const TOP_FRAME = { frameId: 0 } as const

export function isPageToBridge(value: unknown): value is PageToBridge {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return type === 'tc:append' || type === 'tc:source' || type === 'tc:drm'
}

export function isExtensionToTab(value: unknown): value is ExtensionToTab {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; key?: unknown }
  if (message.type === 'tc:list') return true
  return message.type === 'tc:save' && typeof message.key === 'string'
}
