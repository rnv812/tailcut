import { concatBytes } from '../core/iso/writer'
import type { SnapshotPlan } from '../core/snapshot/build'
import type { FromSnapshotWorker, ToSnapshotWorker } from './snapshot-worker'

/** The worker is loaded off the extension origin by a document of that origin: no manifest entry. */
const WORKER_PATH = 'bridge/snapshot-worker.js'

/**
 * How long a write may take before the frame stops waiting. A hundred megabytes go down in about
 * two hundred milliseconds; a minute means the worker died without a word, and the popup deserves
 * a refusal rather than a button that never comes back.
 */
const WRITE_TIMEOUT_MS = 60_000

/**
 * Hands the snapshot to the worker and waits for it to land.
 *
 * The parts are concatenated into one buffer here, and that buffer — not the captured segments —
 * is what gets transferred. The chunks of a map are subarray views over the buffers of the
 * appends that brought them, several chunks to a buffer; transferring those would neuter the
 * live session, and the next "Save all" would write a file of zeroes. One copy costs about a
 * hundred milliseconds on a hundred megabytes and is paid once, on a click.
 *
 * The copy happens before the first await on purpose: the layout and the copy are then one
 * synchronous turn, and eviction cannot run between them.
 */
export async function writeSnapshot(plan: SnapshotPlan, path: string): Promise<boolean> {
  const file = concatBytes(plan.parts)
  const worker = new Worker(chrome.runtime.getURL(WORKER_PATH))

  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), WRITE_TIMEOUT_MS)

      worker.onmessage = (event: MessageEvent) => {
        clearTimeout(timer)
        const result = event.data as FromSnapshotWorker
        resolve(result?.type === 'written' && result.bytes === plan.bytes)
      }
      worker.onerror = () => {
        clearTimeout(timer)
        resolve(false)
      }

      const request: ToSnapshotWorker = { type: 'write', path, bytes: file.buffer as ArrayBuffer }
      worker.postMessage(request, [request.bytes])
    })
  } finally {
    worker.terminate()
  }
}
