// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render } from 'preact'
import { ExportQueue, type ExportQueueProps } from '../../src/editor/inspector/queue'
import { EMPTY_QUEUE, reduceQueue, type Queue, type QueueEvent } from '../../src/core/export/queue'

const host = document.createElement('div')
document.body.append(host)
afterEach(() => render(null, host))

const play = (events: QueueEvent[]): Queue => events.reduce(reduceQueue, EMPTY_QUEUE)

const props = (over: Partial<ExportQueueProps> = {}): ExportQueueProps => ({
  queue: EMPTY_QUEUE,
  ready: true,
  clips: 2,
  estimate: 4_200_000,
  onExport: vi.fn(),
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
  jobs: [{ id: 'j1', clipId: 'c1', name: 'One', fileName: 'One.mp4' }],
}

describe('the export panel', () => {
  it('offers to export the clips there are and says how big one would be', () => {
    const one = props()
    render(<ExportQueue {...one} />, host)

    expect(at('export').textContent).toContain('Export 2 clips')
    expect(at('estimate').textContent).toContain('4.0 MB')

    at('export').click()
    expect(one.onExport).toHaveBeenCalledTimes(1)

    // One clip is not "Export 1 clips": the two are different strings and the panel says both.
    render(<ExportQueue {...props({ clips: 1 })} />, host)
    expect(at('export').textContent).toBe('Export 1 clip')
  })

  it('offers nothing while there is nothing to export or nothing to export from', () => {
    render(<ExportQueue {...props({ clips: 0 })} />, host)
    expect(at('export').hasAttribute('disabled')).toBe(true)

    render(<ExportQueue {...props({ ready: false })} />, host)
    expect(at('export').hasAttribute('disabled')).toBe(true)
    expect(at('export-note').textContent).toContain('Reading the recording')
  })

  it('shows every job with the state it is in', () => {
    const queue = play([
      {
        type: 'enqueue',
        jobs: [
          { id: 'j1', clipId: 'c1', name: 'One', fileName: 'One.mp4' },
          { id: 'j2', clipId: 'c2', name: 'Two', fileName: 'Two.mp4' },
          { id: 'j3', clipId: 'c3', name: 'Three', fileName: 'Three.mp4' },
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
