import type { Choice, EncodeGeometry } from '../../core/encode/codec'

/**
 * How long the set of geometries has to stay still before the browser is asked about it.
 *
 * Long enough to swallow a burst — a crop dragged again and again, Ctrl+Z held down, a ratio
 * button pressed in a row — and short enough that a rectangle placed once is answered before the
 * hand has reached the Export button.
 */
export const PROBE_SETTLE_MS = 200

/** One ladder walked for one geometry: `chooseCodec` with the tab's cached probe bound in. */
export type ChooseFor = (geometry: EncodeGeometry) => Promise<Choice>

export interface ProbeQueue {
  /**
   * The geometries the document holds now, keyed by `geometryKey`. Replaces the previous set.
   *
   * Called on every change of the document, cheap when nothing new is in it.
   */
  want(wanted: ReadonlyMap<string, EncodeGeometry>): void
  /** Every answer so far. A new map per answer, so a hook can hold it as state. */
  answers(): ReadonlyMap<string, Choice>
  subscribe(listener: (answers: ReadonlyMap<string, Choice>) => void): () => void
  /** Stops asking. A ladder already in flight finishes, and its answer is dropped. */
  dispose(): void
}

/**
 * The codec ladder, asked about one settled geometry at a time.
 *
 * `VideoEncoder.isConfigSupported` is not a table lookup in Chromium: a software H.264 question
 * creates and initializes a real OpenH264 encoder to answer it, and nothing about the question
 * can be called back once it is asked. Asked once per geometry the document held, as the tab used
 * to, forty crop rectangles produced forty encoders in flight at once and took a 1080p60
 * renderer from 34 MB to 845 MB; two hundred took it to about 3 GB.
 *
 * Three rules keep that bounded, and each one is needed on its own:
 *
 * - **Settle.** A geometry that has just appeared is not asked about until the wanted set has
 *   gone `PROBE_SETTLE_MS` without a new one. A burst of rectangles is one question, about where
 *   the burst ended.
 * - **Serialize.** At most one ladder runs. Inside a ladder the rungs are already asked one by
 *   one (`chooseCodec`), so the browser holds at most one probe encoder at any moment.
 * - **Drop.** What is asked next is picked from the set wanted *now*, never from a backlog. A
 *   rectangle that was wanted for a moment while another was being asked is never asked at all.
 *
 * The Export button stays correct under all three: it waits until every geometry of the
 * document has an answer (workbench.tsx), and every geometry still wanted is asked eventually —
 * only the ones nobody wants any more are skipped. Answers are kept for the life of the queue,
 * so a crop reset and redone is answered at once.
 */
export function createProbeQueue(
  choose: ChooseFor,
  options: { settleMs?: number } = {},
): ProbeQueue {
  const settleMs = options.settleMs ?? PROBE_SETTLE_MS
  const listeners = new Set<(answers: ReadonlyMap<string, Choice>) => void>()

  let answers: ReadonlyMap<string, Choice> = new Map()
  /** The wanted set, in the order its keys first arrived: the queue is first come, first asked. */
  let wanted = new Map<string, EncodeGeometry>()
  let running: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const next = (): [string, EncodeGeometry] | undefined =>
    [...wanted].find(([key]) => !answers.has(key))

  function settle(): void {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      pump()
    }, settleMs)
  }

  function pump(): void {
    if (disposed || running !== null || timer !== null) return
    const entry = next()
    if (!entry) return

    const [key, geometry] = entry
    running = key
    void choose(geometry)
      // A ladder that throws has answered no. Leaving the key unanswered instead would hold the
      // Export button down for the life of the tab, over a question nobody will ask again.
      .catch((): Choice => ({ kind: 'none', tried: [] }))
      .then((choice) => {
        running = null
        if (disposed) return
        answers = new Map(answers).set(key, choice)
        for (const listener of listeners) listener(answers)
        pump()
      })
  }

  return {
    want(next) {
      if (disposed) return
      // Only a geometry the queue has neither seen wanted nor answered restarts the wait. A trim
      // or a rename rebuilds the same map, and that is not a rectangle in motion.
      const arrived = [...next.keys()].some((key) => !wanted.has(key) && !answers.has(key))

      const ordered = new Map<string, EncodeGeometry>()
      for (const [key, geometry] of wanted) if (next.has(key)) ordered.set(key, geometry)
      for (const [key, geometry] of next) if (!ordered.has(key)) ordered.set(key, geometry)
      wanted = ordered

      if (arrived) settle()
      else pump()
    },

    answers: () => answers,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      listeners.clear()
    },
  }
}
