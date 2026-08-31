// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render } from 'preact'
import { ExportQueue, type ExportQueueProps } from '../../src/editor/inspector/queue'
import { EMPTY_QUEUE, reduceQueue, type Queue, type QueueEvent } from '../../src/core/export/queue'
import type { Estimate } from '../../src/core/encode/estimate'

const host = document.createElement('div')
document.body.append(host)
afterEach(() => render(null, host))

const play = (events: QueueEvent[]): Queue => events.reduce(reduceQueue, EMPTY_QUEUE)

const props = (over: Partial<ExportQueueProps> = {}): ExportQueueProps => ({
  queue: EMPTY_QUEUE,
  ready: true,
  clips: 2,
  selected: true,
  estimate: { kind: 'copy', bytes: 4_200_000 },
  probing: false,
  selectedProbing: false,
  onExportSelected: vi.fn(),
  onExportAll: vi.fn(),
  onRetry: vi.fn(),
  onCancel: vi.fn(),
  ...over,
})

const at = (testid: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!

const allAt = (testid: string): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`),
]

const ONE_JOB: QueueEvent = {
  type: 'enqueue',
  jobs: [{ id: 'j1', clipId: 'c1', kind: 'copy', name: 'One', fileName: 'One.mp4' }],
}

describe('the export panel', () => {
  it('offers distinct selected and batch exports and says how big the selection would be', () => {
    const one = props()
    render(<ExportQueue {...one} />, host)

    expect(at('export-selected').textContent).toBe('Export selected clip')
    expect(at('export-all').textContent).toBe('Export all (2)')
    expect(at('estimate').textContent).toBe(
      'Selected clip: about 4.0 MB, copied from the recording as it is.',
    )

    at('export-selected').click()
    expect(one.onExportSelected).toHaveBeenCalledTimes(1)
    expect(one.onExportAll).not.toHaveBeenCalled()

    at('export-all').click()
    expect(one.onExportAll).toHaveBeenCalledTimes(1)
  })

  it('disables each export action for the work that action cannot perform', () => {
    render(<ExportQueue {...props({ selected: false })} />, host)
    expect(at('export-selected').hasAttribute('disabled')).toBe(true)
    expect(at('export-all').hasAttribute('disabled')).toBe(false)

    render(<ExportQueue {...props({ selectedProbing: true })} />, host)
    expect(at('export-selected').hasAttribute('disabled')).toBe(true)
    expect(at('export-all').hasAttribute('disabled')).toBe(false)

    render(<ExportQueue {...props({ probing: true })} />, host)
    expect(at('export-selected').hasAttribute('disabled')).toBe(false)
    expect(at('export-all').hasAttribute('disabled')).toBe(true)
  })

  it('uses the recorded weight without inventing a hardware encoded weight', () => {
    const estimate: Estimate = {
      kind: 'encode',
      rung: 'h264-hw',
      geometry: { width: 1920, height: 1080, framerate: 30 },
      frames: 300,
      seconds: 10,
      bytes: null,
      sourceCodec: 'avc1',
      inflates: false,
      sourceBytes: 4_200_000,
    }

    render(<ExportQueue {...props({ estimate })} />, host)

    expect(at('estimate').textContent).toBe(
      'Selected clip: 4.0 MB in the recording, and smaller than that once re-encoded — constant quality promises a picture, not a size.',
    )
    expect(at('estimate').textContent).not.toContain('about')
  })

  it('calls the software encoded weight a floor against the recording', () => {
    const estimate: Estimate = {
      kind: 'encode',
      rung: 'h264-sw',
      geometry: { width: 1920, height: 1080, framerate: 30 },
      frames: 300,
      seconds: 10,
      bytes: 1_200_000,
      sourceCodec: 'avc1',
      inflates: false,
      sourceBytes: 4_200_000,
    }

    render(<ExportQueue {...props({ estimate })} />, host)

    expect(at('estimate').textContent).toBe(
      'Selected clip: no smaller than 1.1 MB, against 4.0 MB in the recording.',
    )
  })

  it('waits for a WebP probe before naming a weight', () => {
    const estimate: Estimate = {
      kind: 'webp',
      geometry: { width: 640, height: 360, framerate: 15 },
      frames: 150,
      seconds: null,
      bytes: null,
      sourceBytes: 4_200_000,
    }

    render(<ExportQueue {...props({ estimate })} />, host)

    expect(at('estimate').textContent).toBe('Selected clip: weighing a few of its frames…')
  })

  it('compares a measured WebP animation with its recorded material', () => {
    const estimate: Estimate = {
      kind: 'webp',
      geometry: { width: 640, height: 360, framerate: 15 },
      frames: 150,
      seconds: 10,
      bytes: 900_000,
      sourceBytes: 4_200_000,
    }

    render(<ExportQueue {...props({ estimate })} />, host)

    expect(at('estimate').textContent).toBe(
      'Selected clip: about 879 KB as an animation, against 4.0 MB in the recording.',
    )
  })

  it('draws no weight line for a clip with no export path', () => {
    const estimate: Estimate = {
      kind: 'none',
      reason: 'no-encoder',
      geometry: { width: 1920, height: 1080, framerate: 30 },
    }

    render(<ExportQueue {...props({ estimate })} />, host)

    expect(host.querySelector('[data-testid="estimate"]')).toBeNull()
  })

  it('waits for the encoder probe before allowing export', () => {
    render(<ExportQueue {...props({ probing: true, selectedProbing: true })} />, host)

    expect(at('export-selected').hasAttribute('disabled')).toBe(true)
    expect(at('export-all').hasAttribute('disabled')).toBe(true)
    expect(at('export-selected').textContent).toBe('Checking…')
    expect(at('export-all').textContent).toBe('Checking…')
  })

  it('offers nothing while there is nothing to export or nothing to export from', () => {
    render(<ExportQueue {...props({ clips: 0 })} />, host)
    expect(at('export-all').hasAttribute('disabled')).toBe(true)

    render(<ExportQueue {...props({ ready: false })} />, host)
    expect(at('export-selected').hasAttribute('disabled')).toBe(true)
    expect(at('export-all').hasAttribute('disabled')).toBe(true)
    expect(at('export-note').textContent).toContain('Reading the recording')
  })

  it('shows every job with the state it is in', () => {
    const queue = play([
      {
        type: 'enqueue',
        jobs: [
          { id: 'j1', clipId: 'c1', kind: 'copy', name: 'One', fileName: 'One.mp4' },
          { id: 'j2', clipId: 'c2', kind: 'copy', name: 'Two', fileName: 'Two.mp4' },
          { id: 'j3', clipId: 'c3', kind: 'copy', name: 'Three', fileName: 'Three.mp4' },
        ],
      },
      { type: 'start', id: 'j1', now: 0 },
      { type: 'finish', id: 'j1', bytes: 2_400_000, now: 500 },
      { type: 'start', id: 'j2', now: 500 },
      { type: 'progress', id: 'j2', done: 30, total: 100 },
    ])

    render(<ExportQueue {...props({ queue })} />, host)

    expect(allAt('job')).toHaveLength(3)
    expect(allAt('job-state').map((one) => one.textContent)).toEqual(['Saved', 'Writing', 'Waiting'])
    expect(allAt('job')[0]!.textContent).toContain('2.3 MB')
    expect(allAt('job')[1]!.textContent).toContain('30%')
  })

  it('counts frames for a running encode instead of showing byte progress', () => {
    const queue = play([
      {
        type: 'enqueue',
        jobs: [
          {
            id: 'j1',
            clipId: 'c1',
            kind: 'encode',
            name: 'One',
            fileName: 'One.mp4',
            frames: 200,
          },
        ],
      },
      { type: 'start', id: 'j1', now: 0 },
      { type: 'progress', id: 'j1', done: 30, total: 100 },
    ])

    render(<ExportQueue {...props({ queue })} />, host)

    expect(at('job').textContent).toContain('60 of 200 frames')
    expect(at('job').textContent).not.toContain('30%')
    expect(host.querySelector('[data-testid="waiting-j1"]')).toBeNull()
  })

  it('explains why an encode is waiting without saying a queued copy is stuck', () => {
    const queue = play([
      {
        type: 'enqueue',
        jobs: [
          { id: 'j1', clipId: 'c1', kind: 'copy', name: 'One', fileName: 'One.mp4' },
          {
            id: 'j2',
            clipId: 'c2',
            kind: 'encode',
            name: 'Two',
            fileName: 'Two.mp4',
            frames: 200,
          },
        ],
      },
    ])

    render(<ExportQueue {...props({ queue })} />, host)

    expect(at('waiting-j2').textContent).toBe('Waiting for the encoder')
    expect(host.querySelector('[data-testid="waiting-j1"]')).toBeNull()
  })

  it('uses the shared size units for a completed job', () => {
    const queue = play([
      ONE_JOB,
      { type: 'start', id: 'j1', now: 0 },
      { type: 'finish', id: 'j1', bytes: 2 * 1024 * 1024 * 1024, now: 1 },
    ])

    render(<ExportQueue {...props({ queue })} />, host)

    expect(at('job').textContent).toContain('2.00 GB')
  })

  it('says how much longer the job it is on has to run', () => {
    // The one number here that moves, and it comes off the speed the job has actually shown: a
    // third of the way in two and a half seconds leaves about six. A job that has shown no speed
    // yet says nothing at all rather than a guess the user would watch being wrong.
    vi.useFakeTimers()
    vi.setSystemTime(3_000)

    try {
      const running = play([
        ONE_JOB,
        { type: 'start', id: 'j1', now: 500 },
        { type: 'progress', id: 'j1', done: 30, total: 100 },
      ])
      render(<ExportQueue {...props({ queue: running })} />, host)
      expect(at('job').textContent).toContain('6 s left')

      const fresh = play([ONE_JOB, { type: 'start', id: 'j1', now: 500 }])
      render(<ExportQueue {...props({ queue: fresh })} />, host)
      expect(at('job').textContent).not.toContain('left')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says why a job failed and offers it again', () => {
    const queue = play([
      ONE_JOB,
      { type: 'start', id: 'j1', now: 0 },
      { type: 'fail', id: 'j1', error: 'The recording is no longer in storage.', now: 5 },
    ])
    const one = props({ queue })
    render(<ExportQueue {...one} />, host)

    expect(at('job-error').textContent).toBe('The recording is no longer in storage.')
    at('retry-j1').click()
    expect(one.onRetry).toHaveBeenCalledWith('j1')
  })

  it('lets a job that has not been handed over yet be called off', () => {
    const one = props({ queue: play([ONE_JOB]) })
    render(<ExportQueue {...one} />, host)

    at('cancel-j1').click()
    expect(one.onCancel).toHaveBeenCalledWith('j1')
  })

  it('does not offer to call off a file the browser already has', () => {
    const queue = play([
      ONE_JOB,
      { type: 'start', id: 'j1', now: 0 },
      { type: 'finish', id: 'j1', bytes: 10, now: 1 },
    ])
    render(<ExportQueue {...props({ queue })} />, host)

    expect(host.querySelector('[data-testid="cancel-j1"]')).toBeNull()
    expect(host.querySelector('[data-testid="retry-j1"]')).toBeNull()
  })

  it('says nothing at all when nothing has been exported', () => {
    render(<ExportQueue {...props()} />, host)
    expect(allAt('job')).toHaveLength(0)
  })
})
