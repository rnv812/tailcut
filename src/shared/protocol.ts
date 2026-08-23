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

export function isPageToBridge(value: unknown): value is PageToBridge {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return type === 'tc:append' || type === 'tc:source' || type === 'tc:drm'
}
