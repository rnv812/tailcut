// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'preact'
import type { SessionAction } from '../../src/core/edit/session'
import { EditToolbar } from '../../src/editor/edit-toolbar'

const host = document.createElement('div')
document.body.append(host)

afterEach(() => render(null, host))

const button = (id: string): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!

const show = (overrides: Partial<Parameters<typeof EditToolbar>[0]> = {}) => {
  const dispatch = vi.fn<(action: SessionAction) => void>()
  const onHelp = vi.fn<() => void>()
  render(
    <EditToolbar
      selected
      snapping
      canUndo
      canRedo
      dispatch={dispatch}
      onHelp={onHelp}
      {...overrides}
    />,
    host,
  )
  return { dispatch, onHelp }
}

describe('EditToolbar', () => {
  it('makes the editing workflow visible without opening help', () => {
    show()

    const toolbar = host.querySelector('[data-testid="edit-toolbar"]')!
    expect(toolbar.getAttribute('aria-label')).toBe('Edit tools')
    expect(host.querySelector('[data-testid="edit-workflow"]')!.textContent).toBe(
      '1. Move the playhead · 2. Mark or split a clip · 3. Export your clips',
    )
    expect(toolbar.textContent).toContain('New clip')
    expect(toolbar.textContent).toContain('Set In')
    expect(toolbar.textContent).toContain('Set Out')
    expect(toolbar.textContent).toContain('Split')
    expect(toolbar.textContent).toContain('Add marker')
  })

  it('shows the selected clip boundaries and duration at frame precision', () => {
    show({ selection: { in: 62 + 1 / 30, out: 125 + 17 / 30 }, fps: 30 })

    const summary = host.querySelector('[data-testid="selection-summary"]')!
    expect(summary.getAttribute('aria-label')).toBe('Selected clip range')
    expect(host.querySelector('[data-testid="selection-in"]')!.textContent).toBe('00:01:02:01')
    expect(host.querySelector('[data-testid="selection-out"]')!.textContent).toBe('00:02:05:17')
    expect(host.querySelector('[data-testid="selection-duration"]')!.textContent).toBe(
      '00:01:03:16',
    )
  })

  it('explains that the whole recording is shown until a clip is selected', () => {
    show({ selection: null, selected: false, fps: 25 })

    expect(host.querySelector('[data-testid="selection-summary"]')).toBeNull()
    expect(host.querySelector('[data-testid="no-selection"]')!.textContent).toBe(
      'Previewing the whole recording. Move the playhead, then use Set In to start a clip.',
    )
  })

  it('dispatches every edit, history, view, and snapping action', () => {
    const { dispatch, onHelp } = show()
    const ids = [
      'new-clip',
      'set-in',
      'set-out',
      'split',
      'add-marker',
      'delete-clip',
      'undo',
      'redo',
      'zoom-out',
      'fit-selection',
      'fit-all',
      'zoom-in',
      'toggle-snapping',
    ]
    for (const id of ids) button(id).click()
    button('keyboard-help').click()

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: 'addClip' },
      { type: 'setIn' },
      { type: 'setOut' },
      { type: 'splitClip' },
      { type: 'addMarker' },
      { type: 'removeClip' },
      { type: 'undo' },
      { type: 'redo' },
      { type: 'zoomStep', factor: 1.4 },
      { type: 'zoomToSelection' },
      { type: 'fitAll' },
      { type: 'zoomStep', factor: 1 / 1.4 },
      { type: 'toggleSnapping' },
    ])
    expect(onHelp).toHaveBeenCalledTimes(1)
  })

  it('disables only commands that require a selected clip or available history', () => {
    const { dispatch } = show({ selected: false, canUndo: false, canRedo: false })

    for (const id of ['split', 'delete-clip', 'fit-selection', 'undo', 'redo']) {
      expect(button(id).disabled, id).toBe(true)
      button(id).click()
    }
    for (const id of ['new-clip', 'set-in', 'set-out', 'add-marker', 'fit-all']) {
      expect(button(id).disabled, id).toBe(false)
    }
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('exposes shortcut hints and the snapping state to assistive technology', () => {
    show({ snapping: false })

    expect(button('set-in').title).toContain('I')
    expect(button('split').title).toContain('S')
    expect(button('undo').title).toContain('Ctrl+Z')
    expect(button('keyboard-help').title).toContain('?')
    expect(button('toggle-snapping').getAttribute('aria-pressed')).toBe('false')

    show({ snapping: true })
    expect(button('toggle-snapping').getAttribute('aria-pressed')).toBe('true')
    expect(button('toggle-snapping').textContent).toContain('Snapping on')
  })
})
