// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { DEFAULTS, type Settings } from '../../src/shared/settings'
import type { EditorState } from '../../src/editor/shell'

const harness = vi.hoisted(() => ({
  initial: null as Settings | null,
  listener: null as ((next: Settings, previous: Settings) => void) | null,
  states: [] as EditorState[],
}))

vi.mock('../../src/shared/settings-store', () => ({
  readSettings: async () => harness.initial!,
  watchSettings: (listener: (next: Settings, previous: Settings) => void) => {
    harness.listener = listener
    return () => {
      if (harness.listener === listener) harness.listener = null
    }
  },
}))

vi.mock('../../src/editor/source/snapshot', () => ({
  loadSnapshot: async () => ({
    ok: true as const,
    reader: { index: { page: { title: 'Clip', url: 'https://site.example' }, tracks: [] } },
    material: { tracks: [], video: null, audio: null, representations: [], duration: 0, bytes: 0 },
  }),
}))

vi.mock('../../src/editor/source/preview', () => ({
  buildPreview: async () => null,
}))

vi.mock('../../src/shared/history-db', () => ({
  setUsed: async () => undefined,
}))

vi.mock('../../src/editor/shell', async () => {
  const actual = await vi.importActual<typeof import('../../src/editor/shell')>(
    '../../src/editor/shell',
  )
  return {
    ...actual,
    Shell: ({ state }: { state: EditorState }) => {
      harness.states.push(state)
      return <div data-testid="state">{state.status}</div>
    },
  }
})

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn++) await new Promise((done) => setTimeout(done, 0))
}

afterEach(() => {
  render(null, document.body)
  document.body.innerHTML = ''
  harness.initial = null
  harness.listener = null
  harness.states.length = 0
})

it('keeps live export controls current while preserving clip defaults from opening', async () => {
  harness.initial = {
    ...DEFAULTS,
    export: { ...DEFAULTS.export, format: 'mp4', nameTemplate: 'Opened {in}' },
  }
  vi.resetModules()
  await import('../../src/editor/main')
  await settle()
  expect(harness.listener).not.toBeNull()

  const next: Settings = {
    ...DEFAULTS,
    export: {
      ...DEFAULTS.export,
      format: 'webp',
      nameTemplate: 'Changed {out}',
      codec: 'h264',
      quality: 'low',
      rewriteHead: true,
      askWhere: true,
    },
  }
  harness.listener!(next, harness.initial)
  await settle()

  const ready = [...harness.states]
    .reverse()
    .find(
      (state): state is Extract<EditorState, { status: 'ready' }> => state.status === 'ready',
    )!
  expect(ready.options).toEqual({
    askWhere: true,
    export: {
      ...harness.initial.export,
      codec: 'h264',
      quality: 'low',
      rewriteHead: true,
      askWhere: true,
    },
  })
})
