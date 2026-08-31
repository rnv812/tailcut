// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render } from 'preact'
import type { Clip } from '../../src/core/edit/clip'
import type { EditContext } from '../../src/core/edit/context'
import type { Doc } from '../../src/core/edit/project'
import { Clips } from '../../src/editor/inspector/clips'
import { ctx } from '../core/edit-fixture'

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c1',
  name: 'Talk — 00:00:05',
  in: 5,
  out: 9,
  representation: 'video:avc1:1280x720',
  sound: true,
  crop: null,
  format: 'mp4',
  mode: 'original',
  ...over,
})

const host = document.createElement('div')
document.body.append(host)
afterEach(() => render(null, host))

/** Preact queues renders and defers effects; see timecode-field.test.tsx for why both waits. */
const settled = async (): Promise<void> => {
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const show = async (
  doc: Doc,
  selectedId: string | null = 'c1',
  material: EditContext = ctx,
) => {
  const dispatch = vi.fn()
  render(
    <Clips
      doc={doc}
      ctx={material}
      selectedId={selectedId}
      playhead={7}
      fps={25}
      dispatch={dispatch}
    />,
    host,
  )
  await settled()
  return dispatch
}

const docOf = (clips: Clip[], markers: Doc['markers'] = []): Doc => ({
  clips,
  markers,
  nextId: clips.length + markers.length + 1,
})

const at = (id: string): HTMLInputElement => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!

const selectAt = (id: string): HTMLSelectElement =>
  host.querySelector<HTMLSelectElement>(`[data-testid="${id}"]`)!

const type = async (id: string, text: string): Promise<void> => {
  const input = at(id)
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settled()
}

const enter = async (id: string): Promise<void> => {
  at(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settled()
}

describe('Clips', () => {
  it('says how a clip is made and how a marker is dropped, and only while there are none', async () => {
    await show(docOf([]))

    expect(host.querySelector('[data-testid="no-clips"]')!.textContent).toContain('I marks')
    expect(host.querySelector('[data-testid="no-markers"]')!.textContent).toContain('Shift+M')

    // And the panel stops explaining once there is something to look at, or the explanation sits
    // above the very list it is telling the reader how to fill.
    await show(docOf([clip()], [{ id: 'm1', time: 2, label: 'M1' }]))
    expect(host.querySelector('[data-testid="no-clips"]')).toBeNull()
    expect(host.querySelector('[data-testid="no-markers"]')).toBeNull()
  })

  it('sends a typed boundary through the same action the timeline sends', async () => {
    const dispatch = await show(docOf([clip()]))
    await type('in-c1', '0:06')
    await enter('in-c1')

    expect(dispatch).toHaveBeenCalledWith({ type: 'trim', id: 'c1', edge: 'in', time: 6, typed: true })
  })

  it('sends the other edge under its own name', async () => {
    // Two boxes wired to one edge would agree with each other on every test above and would put
    // the out point where the in point belongs on the very first use.
    const dispatch = await show(docOf([clip()]))
    await type('out-c1', '0:08')
    await enter('out-c1')

    expect(dispatch).toHaveBeenCalledWith({ type: 'trim', id: 'c1', edge: 'out', time: 8, typed: true })
  })

  it('shows the boundaries the clip already has', async () => {
    await show(docOf([clip()]))

    expect(at('in-c1').value).toBe('00:00:05:00')
    expect(at('out-c1').value).toBe('00:00:09:00')
  })

  it('sends nothing at all when the entry cannot be read', async () => {
    const dispatch = await show(docOf([clip()]))
    await type('out-c1', 'later, please')
    await enter('out-c1')

    expect(dispatch).not.toHaveBeenCalled()
    expect(at('out-c1').value).toBe('later, please')
    expect(at('out-c1').getAttribute('aria-invalid')).toBe('true')
  })

  it('moves the playhead from its own field', async () => {
    const dispatch = await show(docOf([clip()]))
    await type('playhead-field', '+2')
    await enter('playhead-field')

    expect(dispatch).toHaveBeenCalledWith({ type: 'seek', time: 9 })
  })

  it('shows how long the clip is', async () => {
    await show(docOf([clip()]))

    expect(host.querySelector('[data-testid="length-c1"]')!.textContent).toBe('00:00:04:00')
  })

  it('groups identity, range, and output into a clear settings hierarchy', async () => {
    await show(docOf([clip()]))

    const card = host.querySelector('[data-testid="clip"]')!
    expect(card.querySelector('[data-testid="clip-header-c1"] [data-testid="name-c1"]')).not.toBeNull()

    const range = card.querySelector('[data-testid="clip-range-c1"]')!
    expect(range.querySelector('[data-testid="in-c1"]')).not.toBeNull()
    expect(range.querySelector('[data-testid="out-c1"]')).not.toBeNull()
    expect(range.querySelector('[data-testid="length-c1"]')!.parentElement?.textContent).toContain(
      'Duration',
    )

    const output = card.querySelector('[data-testid="clip-output-c1"]')!
    expect(output.querySelector('[data-testid="format-c1"]')).not.toBeNull()
    expect(output.querySelector('[data-testid="mode-c1"]')).toBeNull()
    expect(output.querySelector('[data-testid="sound-c1"]')).not.toBeNull()
    expect(card.querySelector('[data-testid="cost-c1"]')).toBeNull()

    const remove = card.querySelector<HTMLButtonElement>('[data-testid="remove-c1"]')!
    expect(remove.classList.contains('tc-clip-remove')).toBe(true)
    expect(remove.querySelector('svg')).not.toBeNull()
    expect(remove.getAttribute('aria-label')).toBe('Remove clip')
  })

  it('renames as the name is typed, and refuses to send an empty one', async () => {
    const dispatch = await show(docOf([clip()]))
    await type('name-c1', 'Intro')
    expect(dispatch).toHaveBeenCalledWith({ type: 'renameClip', id: 'c1', name: 'Intro' })

    dispatch.mockClear()
    await type('name-c1', '')
    // The model refuses an empty name, and a field that sent it would be snapped back mid-word.
    expect(dispatch).not.toHaveBeenCalled()
    expect(at('name-c1').value).toBe('')
  })

  it('turns the sound of a clip off and takes a clip away, without also selecting the row', async () => {
    const dispatch = await show(docOf([clip()]), null)

    at('sound-c1').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    at('sound-c1').dispatchEvent(new Event('change', { bubbles: true }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'toggleSound', id: 'c1' })

    at('remove-c1').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'removeClip', id: 'c1' })

    // The row selects the clip; the controls on it do not. One press is one action, and
    // «remove, then select what was removed» is not a pair worth having in the history.
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'selectClip', id: 'c1' })
  })

  it('shows the tick where the model has it', async () => {
    // A box hard-wired to «on» agrees with the model on every clip until somebody mutes one, and
    // then it says the clip will carry sound while the export drops it.
    await show(docOf([clip()]))
    expect(at('sound-c1').checked).toBe(true)

    await show(docOf([clip({ sound: false })]))
    expect(at('sound-c1').checked).toBe(false)
  })

  it('changes the format without exposing an encode mode or selecting the row', async () => {
    const dispatch = await show(docOf([clip()]), null)

    const format = selectAt('format-c1')
    expect(format.value).toBe('mp4')
    expect([...format.options].map((option) => option.value)).toEqual(['mp4', 'webp'])
    format.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    format.value = 'webp'
    format.dispatchEvent(new Event('change', { bubbles: true }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'setFormat', id: 'c1', format: 'webp' })

    expect(host.querySelector('[data-testid="mode-c1"]')).toBeNull()
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'selectClip', id: 'c1' })
  })

  it('keeps sound available for cropped MP4 and out of WebP', async () => {
    await show(
      docOf([
        clip({ crop: { x: 0, y: 0, width: 640, height: 360 }, mode: 'optimize' }),
      ]),
    )
    expect(host.querySelector('[data-testid="mode-c1"]')).toBeNull()
    expect(at('sound-c1').disabled).toBe(false)

    await show(docOf([clip({ format: 'webp', sound: true })]))
    expect(selectAt('format-c1').value).toBe('webp')
    expect(at('sound-c1').disabled).toBe(true)
    expect(at('sound-c1').checked).toBe(false)
  })

  it('says which quality a clip is stopped by, and offers no way past it', async () => {
    // One output track cannot cross a resolution change without re-encoding. The fixture is 480p
    // to second four and 720p from six, so a clip that ends on the
    // boundary has a wall in front of it. The panel explains the wall and leaves it standing:
    // two resolutions in one track need an encoder.
    const dispatch = await show(docOf([clip({ representation: '480p', in: 1, out: 4 })]))

    const note = host.querySelector('[data-testid="held-c1"]')!
    expect(note.textContent).toContain('720p')
    expect(note.querySelector('button')).toBeNull()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('names the quality in the way a person reads it, not in the way a zone is keyed', async () => {
    // A representation in real material is a codec string. The fixture above happens to be named
    // «720p», so a line that printed the key would read right there and read
    // «switches to video:avc1.640028:1280x720» on everything that ever came off a page.
    const coded: EditContext = {
      ...ctx,
      zones: ctx.zones.map((zone) => ({
        ...zone,
        representation: `video:avc1.640028:${zone.width}x${zone.height}`,
      })),
    }
    await show(docOf([clip({ representation: 'video:avc1.640028:854x480', in: 1, out: 4 })]), 'c1', coded)

    expect(host.querySelector('[data-testid="held-c1"]')!.textContent).toContain('720p')
  })

  it('says nothing about a clip standing in the middle of its own quality', async () => {
    await show(docOf([clip({ representation: '480p', in: 1, out: 3 })]))

    expect(host.querySelector('[data-testid="held-c1"]')).toBeNull()
  })

  it('lists the markers, goes to one and takes one away', async () => {
    // The only way to a marker that is not the keyboard: without it a marker dropped by mistake
    // would stay in the project for good.
    const dispatch = await show(docOf([clip()], [{ id: 'm1', time: 2, label: 'M1' }]))

    expect(host.querySelectorAll('[data-testid="marker"]')).toHaveLength(1)
    host.querySelector<HTMLButtonElement>('[data-testid="marker-m1"]')!.click()
    expect(dispatch).toHaveBeenCalledWith({ type: 'seek', time: 2 })

    host.querySelector<HTMLButtonElement>('[data-testid="drop-m1"]')!.click()
    expect(dispatch).toHaveBeenCalledWith({ type: 'removeMarker', id: 'm1' })
  })

  it('names the marker and says when it stands', async () => {
    await show(docOf([], [{ id: 'm1', time: 2, label: 'M1' }]))

    expect(host.querySelector('[data-testid="marker-m1"]')!.textContent).toBe('M1 · 00:00:02:00')
  })

  it('selects the clip that is clicked and marks the one selected', async () => {
    const dispatch = await show(docOf([clip(), clip({ id: 'c2', name: 'Second', in: 10, out: 12 })]), 'c2')

    const rows = host.querySelectorAll('[data-testid="clip"]')
    expect(rows[1]!.className).toContain('selected')

    rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'selectClip', id: 'c1' })
  })
})
