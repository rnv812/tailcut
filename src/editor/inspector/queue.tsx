import { etaOf, type Job, type Queue } from '../../core/export/queue'

export interface ExportQueueProps {
  queue: Queue
  /** The material has been indexed; false while the tab is still reading it. */
  ready: boolean
  clips: number
  /** Coded bytes of the selected clip, or null when nothing is selected. */
  estimate: number | null
  onExport(): void
  onRetry(id: string): void
  onCancel(id: string): void
}

const weight = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const STATE_TEXT: Record<Job['state'], string> = {
  queued: 'Waiting',
  running: 'Writing',
  done: 'Saved',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function Row({
  job,
  onRetry,
  onCancel,
}: {
  job: Job
  onRetry: (id: string) => void
  onCancel: (id: string) => void
}) {
  const left = etaOf(job, Date.now())

  return (
    <li class={`tc-job ${job.state}`} data-testid="job">
      <span class="tc-job-name">{job.name}</span>
      <span class="tc-job-state" data-testid="job-state">
        {STATE_TEXT[job.state]}
      </span>

      {job.state === 'running' && (
        <span class="muted">
          {Math.round(job.progress * 100)}%
          {left !== null && left > 1 ? ` · ${Math.ceil(left)} s left` : ''}
        </span>
      )}
      {job.state === 'done' && <span class="muted">{weight(job.bytes)}</span>}
      {job.error && (
        <span class="tc-job-error" data-testid="job-error">
          {job.error}
        </span>
      )}

      {(job.state === 'failed' || job.state === 'cancelled') && (
        <button type="button" data-testid={`retry-${job.id}`} onClick={() => onRetry(job.id)}>
          Try again
        </button>
      )}
      {/* A file already handed over belongs to the browser; there is nothing here to call off. */}
      {(job.state === 'queued' || job.state === 'running') && (
        <button type="button" data-testid={`cancel-${job.id}`} onClick={() => onCancel(job.id)}>
          Cancel
        </button>
      )}
    </li>
  )
}

/** The Export button, what the selected clip would weigh, and the queue under it (§8.6, §9.3). */
export function ExportQueue({
  queue,
  ready,
  clips,
  estimate,
  onExport,
  onRetry,
  onCancel,
}: ExportQueueProps) {
  return (
    <section class="tc-export" data-testid="export-panel">
      <h2>Export</h2>

      <button type="button" data-testid="export" disabled={!ready || clips === 0} onClick={onExport}>
        {clips === 1 ? 'Export 1 clip' : `Export ${clips} clips`}
      </button>

      {!ready && (
        <p class="muted" data-testid="export-note">
          Reading the recording…
        </p>
      )}

      {estimate !== null && (
        <p class="muted" data-testid="estimate">
          Selected clip: about {weight(estimate)}, copied from the recording without re-encoding.
        </p>
      )}

      <ul class="tc-jobs">
        {queue.jobs.map((job) => (
          <Row key={job.id} job={job} onRetry={onRetry} onCancel={onCancel} />
        ))}
      </ul>
    </section>
  )
}
