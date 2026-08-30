import { etaOf, type Job, type Queue } from '../../core/export/queue'
import type { Estimate } from '../../core/encode/estimate'
import { formatBytes } from '../../shared/format'

export interface ExportQueueProps {
  queue: Queue
  /** The material has been indexed; false while the tab is still reading it. */
  ready: boolean
  clips: number
  /**
   * What the selected clip will weigh, as data (Task 8); null when nothing is selected.
   *
   * The panel prints the **weight** and nothing else about the price. The rung, the frames, the
   * geometry and the seconds are written under the clip row by `costNote` (clips.tsx), and a
   * number printed in both places is two sentences about one clip, free to disagree the day one
   * of them is edited.
   */
  estimate: Estimate | null
  /**
   * The ladder has not answered for every geometry the document holds (§8.6).
   *
   * The button waits for it rather than sending clips into a queue that would answer "no encoder"
   * about geometries nobody asked about. It is milliseconds — `isConfigSupported` answers at
   * once — and it is said out loud rather than left as a button that does nothing.
   */
  probing: boolean
  onExport(): void
  onRetry(id: string): void
  onCancel(id: string): void
}

/**
 * What the selected clip will weigh, in one sentence — and never a number that does not exist.
 *
 * Four kinds of answer, because there are four kinds of truth here (see the convention table).
 * A copy is exact. The software rung is a floor, so "no smaller than". The hardware rungs promise
 * a picture and not a size, so the only number is the weight of the material itself, and the
 * sentence says what is known about the file: it comes out under that. WebP is measured on real
 * frames of this clip and says nothing at all until the probe has answered.
 *
 * `none` is silent on purpose: there is nothing to weigh, and the line under the clip row
 * already says why in full.
 */
function weightNote(estimate: Estimate): string | null {
  switch (estimate.kind) {
    case 'copy':
      return `Selected clip: about ${formatBytes(estimate.bytes)}, copied from the recording as it is.`

    case 'encode':
      return estimate.bytes === null
        ? `Selected clip: ${formatBytes(estimate.sourceBytes)} in the recording, and smaller than that once re-encoded — constant quality promises a picture, not a size.`
        : `Selected clip: no smaller than ${formatBytes(estimate.bytes)}, against ${formatBytes(estimate.sourceBytes)} in the recording.`

    case 'webp':
      return estimate.bytes === null
        ? 'Selected clip: weighing a few of its frames…'
        : `Selected clip: about ${formatBytes(estimate.bytes)} as an animation, against ${formatBytes(estimate.sourceBytes)} in the recording.`

    case 'none':
      return null
  }
}

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
          {job.frames
            ? `${Math.round(job.progress * job.frames)} of ${job.frames} frames`
            : `${Math.round(job.progress * 100)}%`}
          {left !== null && left > 1 ? ` · ${Math.ceil(left)} s left` : ''}
        </span>
      )}
      {job.state === 'done' && <span class="muted">{formatBytes(job.bytes)}</span>}
      {job.state === 'queued' && job.kind === 'encode' && (
        // Said out loud because it is the one thing about this queue that surprises: a clip that
        // needs the encoder waits for the one before it, while a copy beside it does not wait at
        // all. Without the line the row looks stuck.
        <span class="muted" data-testid={`waiting-${job.id}`}>
          Waiting for the encoder
        </span>
      )}
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
  probing,
  onExport,
  onRetry,
  onCancel,
}: ExportQueueProps) {
  const note = estimate && weightNote(estimate)

  return (
    <section class="tc-export" data-testid="export-panel">
      <h2>Export</h2>

      {/* Disabled while the ladder is still answering: §8.6 asks whether there is an encoder for
          this picture **before** the queue starts, and a press that lands a millisecond early
          would send every clip of an unasked geometry down `blocked`. */}
      <button
        type="button"
        data-testid="export"
        disabled={!ready || probing || clips === 0}
        onClick={onExport}
      >
        {probing ? 'Checking the encoder…' : clips === 1 ? 'Export 1 clip' : `Export ${clips} clips`}
      </button>

      {!ready && (
        <p class="muted" data-testid="export-note">
          Reading the recording…
        </p>
      )}

      {note && (
        <p class="muted" data-testid="estimate">
          {note}
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
