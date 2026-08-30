import { DEFAULTS, SETTINGS_KEY, merge, type Settings } from './settings'

/**
 * The one place in the extension that touches chrome.storage.
 *
 * Everything else takes settings as data (see settings.ts) and gets them from here. That is what
 * keeps the settings testable without a browser and what keeps the number of places that know the
 * key at one.
 */

/** What is stored right now, complete whatever is actually in storage. */
export async function readSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY)
    return merge(stored[SETTINGS_KEY])
  } catch {
    // No storage in this context, or an extension reloaded under a page that outlived it. The
    // defaults are a working answer and stopping is not: this is on the path of a recording.
    return DEFAULTS
  }
}

/**
 * Reads, edits and stores the whole of the settings under one key.
 *
 * The edit is a function of what is stored rather than of what the caller last saw: the settings
 * page and the popup both write, and a patch built on a stale copy would put back the value the
 * other one had just changed.
 */
export async function writeSettings(edit: (current: Settings) => Settings): Promise<Settings> {
  const next = merge(edit(await readSettings()))
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}

/**
 * Calls back on every change of the settings, wherever it was made. Gives back the way to stop.
 *
 * Guarded the same way `readSettings` is, and for the same reason: this runs in the watcher of
 * an ordinary page and in the tests of it, and a context with no `chrome` at all must get the
 * defaults and carry on rather than throw on the line that subscribes. Without the guard the
 * failure is not even where it happens — a module that builds a live copy as it loads takes the
 * whole file down at import.
 */
export function watchSettings(
  onChange: (next: Settings, previous: Settings) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'local') return
    const change = changes[SETTINGS_KEY]
    if (!change) return
    onChange(merge(change.newValue), merge(change.oldValue))
  }

  try {
    chrome.storage.onChanged.addListener(listener)
  } catch {
    return () => undefined
  }

  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener)
    } catch {
      // The extension was reloaded under this page: there is nothing left to unsubscribe from.
    }
  }
}

export interface LiveSettings {
  /** What the settings are, right now, synchronously. */
  get(): Settings
  /** Settled once the first read has come back; for tests and for start-up order. */
  ready: Promise<Settings>
  stop(): void
}

/**
 * A copy of the settings that answers synchronously and keeps itself up to date.
 *
 * Every context that reads a setting on a hot path holds one: the watcher polls elements twice a
 * second, the registry takes segments in dozens of times a minute, the hook stands on a player's
 * synchronous path. None of them can await a read of storage, and none of them should have to
 * — the value changes when a human moves a control, which is never.
 *
 * It answers the defaults until the first read comes back, a few milliseconds after start-up, and
 * `onChange` is called for that first read as well as for every change after it: acting on a
 * setting has to happen when the context learns it, not only when somebody moves it.
 */
export function liveSettings(
  onChange?: (next: Settings, previous: Settings) => void,
): LiveSettings {
  let current = DEFAULTS
  let stopped = false

  const apply = (next: Settings): void => {
    if (stopped) return
    const previous = current
    current = next
    onChange?.(next, previous)
  }

  const ready = readSettings().then((settings) => {
    apply(settings)
    return settings
  })

  const stopWatching = watchSettings((next) => apply(next))
  const stop = (): void => {
    stopped = true
    stopWatching()
  }

  return { get: () => current, ready, stop }
}
