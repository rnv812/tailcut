/** Путь к странице моста внутри пакета расширения. */
export const BRIDGE_PATH = 'bridge/bridge.html'

export type PageToBridge =
  | { type: 'tc:append'; sourceId: string; bufferId: string; mime: string; bytes: ArrayBuffer }
  /** objectUrl связывает MediaSource с конкретным элементом <video> на странице */
  | { type: 'tc:source'; sourceId: string; objectUrl: string }
  | { type: 'tc:drm'; sourceId: string }

export type BridgeToPage = { type: 'tc:ready' }

export function isPageToBridge(value: unknown): value is PageToBridge {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return type === 'tc:append' || type === 'tc:source' || type === 'tc:drm'
}
