// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { DEFAULTS } from '../../src/shared/settings'

const opening = vi.hoisted(() => ({
  load: 'reject' as 'reject' | 'ready',
  preview: 'reject' as 'reject' | 'none',
  picture: false,
  secondPicture: false,
}))

vi.mock('../../src/editor/source/snapshot', () => ({
  loadSnapshot: async () => {
    if (opening.load === 'reject') throw new Error('storage read failed')
    const track = {
      id: 'v',
      bufferId: 'sb-v',
      representation: 'video:avc1:320x240',
      kinds: ['video'] as const,
      info: {
        tracks: [
          {
            trackId: 1,
            kind: 'video' as const,
            timescale: 1_000,
            codec: 'avc1',
            width: 320,
            height: 240,
          },
        ],
      },
      init: { at: 0, length: 0 },
      chunks: [],
    }
    const video = opening.picture
      ? {
          track,
          kinds: ['video'] as const,
          runs: [],
          duration: 1,
          bytes: 0,
          span: { start: 0, end: 1 },
        }
      : null
    const secondTrack = {
      ...track,
      id: 'v-second',
      bufferId: 'sb-v-second',
      representation: 'video:avc1:640x360',
      info: {
        tracks: [{ ...track.info.tracks[0], width: 640, height: 360 }],
      },
    }
    const secondVideo = opening.secondPicture && video
      ? {
          ...video,
          track: secondTrack,
          duration: 2,
          span: { start: 1, end: 3 },
        }
      : null
    return {
      ok: true as const,
      reader: {
        index: {
          page: {
            sessionKey: 'k',
            url: 'https://site.example/watch',
            title: 'Clip',
            createdAt: 1,
            lastSeenAt: 2,
            refusedTracks: false,
          },
          tracks: video ? [track, ...(secondVideo ? [secondTrack] : [])] : [],
        },
        bytesOf: async () => new Uint8Array(),
        bytesOfMany: async () => [],
      },
      material: {
        tracks: video ? [video, ...(secondVideo ? [secondVideo] : [])] : [],
        video,
        audio: null,
        representations: [],
        duration: 0,
        bytes: 0,
      },
    }
  },
}))

vi.mock('../../src/shared/settings-store', () => ({
  readSettings: async () => DEFAULTS,
}))

vi.mock('../../src/editor/source/preview', () => ({
  buildPreview: async () => {
    if (opening.preview === 'reject') throw new Error('preview build failed')
    return null
  },
}))

const until = async (condition: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 20; turn++) {
    if (condition()) return
    await new Promise((done) => setTimeout(done, 0))
  }
  throw new Error('the editor did not settle')
}

async function start(): Promise<void> {
  vi.resetModules()
  await import('../../src/editor/main')
}

afterEach(() => {
  render(null, document.body)
  document.body.innerHTML = ''
  opening.load = 'reject'
  opening.preview = 'reject'
  opening.picture = false
  opening.secondPicture = false
})

describe('editor startup failures', () => {
  it('leaves the opening state when reading the recording rejects', async () => {
    await start()
    await until(() => document.querySelector('[data-testid="failure"]') !== null)

    expect(document.body.textContent).toContain('could not open this recording')
    expect(document.body.textContent).not.toContain('Opening the recording')
  })

  it('leaves the building state without discarding loaded material when preview assembly rejects', async () => {
    opening.load = 'ready'
    opening.picture = true

    await start()
    await until(() => document.body.textContent?.includes('could not build a preview') ?? false)

    expect(document.querySelector('[data-testid="failure"]')).toBeNull()
    expect(document.querySelector('[data-testid="player"]')).not.toBeNull()
    expect(document.body.textContent).toContain('could not build a preview')
    expect(document.body.textContent).not.toContain('Building the preview')
  })

  it('keeps the representation picker when the default picture preview rejects', async () => {
    opening.load = 'ready'
    opening.picture = true
    opening.secondPicture = true

    await start()
    await until(() => document.body.textContent?.includes('could not build a preview') ?? false)

    expect(document.querySelector('[data-testid="failure"]')).toBeNull()
    const picker = document.querySelector<HTMLSelectElement>('[data-testid="representation"]')
    expect(picker, 'the other picture disappeared with the failed default preview').not.toBeNull()
    expect([...picker!.options].map((option) => option.value)).toEqual(['v', 'v-second'])
  })

  it('calls a null preview an assembly failure when the recording has picture material', async () => {
    opening.load = 'ready'
    opening.preview = 'none'
    opening.picture = true

    await start()
    await until(() => document.body.textContent?.includes('could not build a preview') ?? false)

    expect(document.body.textContent).not.toContain('no picture in this recording')
  })
})
