// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULTS, SETTINGS_KEY, type Settings } from '../../src/shared/settings'
import { liveSettings, readSettings, watchSettings, writeSettings } from '../../src/shared/settings-store'

type Listener = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void

const listeners: Listener[] = []
let stored: Record<string, unknown> = {}

beforeEach(() => {
  stored = {}
  listeners.length = 0
  const chromeStub = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {})),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          const before = stored[SETTINGS_KEY]
          Object.assign(stored, patch)
          for (const listener of [...listeners]) {
            listener({ [SETTINGS_KEY]: { newValue: patch[SETTINGS_KEY], oldValue: before } }, 'local')
          }
        }),
      },
      onChanged: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: (listener: Listener) => listeners.splice(listeners.indexOf(listener), 1),
      },
    },
  }
  ;(globalThis as { chrome?: unknown }).chrome = chromeStub
})

describe('readSettings', () => {
  it('gives the defaults when nothing has ever been written', async () => {
    expect(await readSettings()).toEqual(DEFAULTS)
  })

  it('gives the defaults when storage refuses', async () => {
    // A context with no storage at all, or one whose extension was reloaded under it. The
    // recording carries on under the defaults rather than stopping over a failed read.
    ;(globalThis as { chrome: { storage: { local: { get: unknown } } } }).chrome.storage.local.get =
      vi.fn(async () => {
        throw new Error('no storage here')
      })
    expect(await readSettings()).toEqual(DEFAULTS)
  })
})

describe('writeSettings', () => {
  it('edits what is stored and stores the whole of it under one key', async () => {
    await writeSettings((current) => ({
      ...current,
      recording: { ...current.recording, bufferSeconds: 60 },
    }))

    expect(Object.keys(stored)).toEqual([SETTINGS_KEY])
    expect((stored[SETTINGS_KEY] as Settings).recording.bufferSeconds).toBe(60)
    // Everything else came from the defaults: an edit of one group must not drop the other four.
    expect((stored[SETTINGS_KEY] as Settings).history).toEqual(DEFAULTS.history)
  })

  it('edits what is there rather than what the caller last saw', async () => {
    await writeSettings((current) => ({ ...current, history: { ...current.history, keepDays: 30 } }))
    await writeSettings((current) => ({
      ...current,
      recording: { ...current.recording, mode: 'off' },
    }))
    const settings = stored[SETTINGS_KEY] as Settings
    expect(settings.history.keepDays).toBe(30)
    expect(settings.recording.mode).toBe('off')
  })
})

describe('watchSettings', () => {
  it('carries the whole of the settings and what they were before', async () => {
    const seen: Array<[Settings, Settings]> = []
    const stop = watchSettings((next, previous) => seen.push([next, previous]))

    await writeSettings((current) => ({ ...current, history: { ...current.history, toDisk: false } }))

    expect(seen).toHaveLength(1)
    expect(seen[0]![0].history.toDisk).toBe(false)
    expect(seen[0]![1].history.toDisk).toBe(true)

    stop()
    await writeSettings((current) => ({ ...current, history: { ...current.history, toDisk: true } }))
    expect(seen).toHaveLength(1)
  })

  it('ignores a change in another area of storage', async () => {
    const seen: Settings[] = []
    watchSettings((next) => seen.push(next))
    for (const listener of listeners) listener({ [SETTINGS_KEY]: { newValue: {} } }, 'session')
    expect(seen).toHaveLength(0)
  })

  it('ignores a change of another key in this very area', async () => {
    // onChanged fires for every key of local storage, and this key is not the only thing that
    // will ever live there. Read as a change of the settings, a write of somebody else's key
    // would hand `undefined` to merge — that is, the defaults — and quietly reset the live copy
    // of every context to them over a write that has nothing to do with the settings.
    const seen: Settings[] = []
    watchSettings((next) => seen.push(next))
    for (const listener of listeners) listener({ 'undo:deleted': { newValue: ['a'] } }, 'local')
    expect(seen).toHaveLength(0)
  })
})

describe('liveSettings', () => {
  it('works in a context with no chrome at all', async () => {
    // The watcher builds one of these, and the watcher is tested in happy-dom with no extension
    // around it. Throwing here would not be a failing assertion but a file that cannot be
    // imported — see watchSettings.
    delete (globalThis as { chrome?: unknown }).chrome
    const live = liveSettings()
    expect(live.get()).toEqual(DEFAULTS)
    expect(await live.ready).toEqual(DEFAULTS)
    expect(() => live.stop()).not.toThrow()
  })

  it('answers at once with the defaults and catches up without being asked', async () => {
    stored[SETTINGS_KEY] = { recording: { bufferSeconds: 45 } }
    const live = liveSettings()

    // Synchronous from the first line: the callers are a hook on a player's path and a poll twice
    // a second, and neither can await anything.
    expect(live.get()).toEqual(DEFAULTS)
    await live.ready
    expect(live.get().recording.bufferSeconds).toBe(45)

    await writeSettings((current) => ({
      ...current,
      recording: { ...current.recording, bufferSeconds: 90 },
    }))
    expect(live.get().recording.bufferSeconds).toBe(90)

    live.stop()
    await writeSettings((current) => ({
      ...current,
      recording: { ...current.recording, bufferSeconds: 120 },
    }))
    expect(live.get().recording.bufferSeconds).toBe(90)
  })

  it('stops without a word when the extension went away under it', async () => {
    // A page outlives the extension that was injected into it: reloaded or updated, every
    // chrome.* of the old context is gone, and `stop` is called by a page that is closing down
    // over storage that no longer answers. Nothing is left to unsubscribe from, and throwing
    // over that would take the rest of the teardown with it.
    const live = liveSettings()
    await live.ready
    delete (globalThis as { chrome?: unknown }).chrome
    expect(() => live.stop()).not.toThrow()
  })

  it('tells the holder what changed, the first read included', async () => {
    stored[SETTINGS_KEY] = { history: { toDisk: false } }
    const changes: Array<[boolean, boolean]> = []
    const live = liveSettings((next, previous) =>
      changes.push([next.history.toDisk, previous.history.toDisk]),
    )
    await live.ready
    // The first read is a change like any other: what a context does about a setting has to
    // happen when it learns the setting, not only when the user moves it.
    expect(changes).toEqual([[false, true]])
  })
})
