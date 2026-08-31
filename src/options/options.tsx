import { render, type ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { listSessions, readTotals } from '../shared/history-db'
import { formatBytes, formatSeconds } from '../shared/format'
import {
  DEFAULTS,
  LIMITS,
  REFERENCE_BITS_PER_SECOND,
  memoryCeilingFor,
  merge,
  presetNamed,
  presetOf,
  type DetectionPreset,
  type ExportFormat,
  type RecordingMode,
  type Settings,
} from '../shared/settings'
import { readSettings, watchSettings, writeSettings } from '../shared/settings-store'

/** How long a slider waits before its value is stored; see the note on writing below. */
const SETTLE_MS = 300

/** The rate of what this user actually records, in bits per second. */
export function bitsPerSecondOf(
  sessions: ReadonlyArray<{ bytes: number; seconds: number }>,
): number {
  let bytes = 0
  let seconds = 0
  for (const session of sessions) {
    bytes += session.bytes
    seconds += session.seconds
  }
  // Nothing recorded yet: 6 Mbit/s, an ordinary 1080p, which is the same number the frame sizes
  // its memory ceiling by. One place for it, so that what this page promises and what the frame
  // keeps cannot become two opinions.
  return seconds > 0 ? (bytes * 8) / seconds : REFERENCE_BITS_PER_SECOND
}

/** What a buffer of this length will hold in memory at this rate, in bytes. */
export function memoryFor(bufferSeconds: number, bitsPerSecond: number): number {
  return (bufferSeconds * bitsPerSecond) / 8
}

/**
 * A number out of a field, held to the limits of the setting, and whether it had to be held.
 *
 * `min` and `max` on an input are advice the browser gives and not a rule it enforces: typed or
 * pasted, 9999 arrives in the input event exactly as 90 does, and there is no form here to
 * submit and be refused. Anything that is not a number at all — an emptied field hands over an
 * empty string — is the smallest the setting takes, which is the nearest thing to what clearing
 * it could mean.
 */
export function held(
  raw: string,
  limit: { min: number; max: number },
): { value: number; refused: boolean } {
  const asked = Number(raw)
  if (!raw.trim() || !Number.isFinite(asked)) return { value: limit.min, refused: true }
  const value = Math.min(Math.max(asked, limit.min), limit.max)
  return { value, refused: value !== asked }
}

const PRESET_NAMES: Record<DetectionPreset, string> = {
  loose: 'Loose',
  balanced: 'Balanced',
  strict: 'Strict',
  custom: 'Custom',
}

const MODES: Array<{ value: RecordingMode; label: string; note: string }> = [
  { value: 'all', label: 'All sites', note: 'Record on every site except the ones denied below.' },
  { value: 'allowlist', label: 'Allowlist', note: 'Record only on the sites allowed below.' },
  { value: 'off', label: 'Off', note: 'Record nothing anywhere. Nothing already saved is removed.' },
]

function Group(props: { title: string; children: ComponentChildren }) {
  return (
    <section class="group">
      <h2 data-testid="group-title">{props.title}</h2>
      <div class="group-body">{props.children}</div>
    </section>
  )
}

/** Fine tuning behind the browser's accessible disclosure behavior, with the product's styling. */
function Advanced(props: { label: string; children: ComponentChildren }) {
  return (
    <details class="advanced">
      <summary
        class="advanced-toggle"
        data-testid="advanced-toggle"
        aria-label={props.label}
      >
        Advanced
      </summary>
      <div class="advanced-panel" data-testid="advanced-panel">
        {props.children}
      </div>
    </details>
  )
}

/**
 * A number the user sets: a field or a slider, the limits it is held to, and what it says when it
 * had to hold one.
 *
 * One component for all five of them, because all five have the same problem and one place to
 * solve it is one place to get it right. The message stands beside the control that raised it:
 * a page that corrects a value in silence is a page the user finds out about tomorrow.
 */
function NumberRow(props: {
  id: string
  label: string
  kind: 'number' | 'range'
  limit: { min: number; max: number }
  step?: number
  /** The limits as a person reads them; the message is "Takes 1 to 90 days." */
  bound: string
  /** What stands to the right of the control: the value in words, or the unit it is in. */
  shown: string
  /** Named when the value beside the control is worth reading in a test. */
  shownId?: string
  value: number
  onPick: (value: number) => void
}) {
  const [refused, setRefused] = useState(false)

  return (
    <label class="row">
      <span class="label">{props.label}</span>
      <input
        data-testid={props.id}
        type={props.kind}
        min={props.limit.min}
        max={props.limit.max}
        step={props.step}
        value={props.value}
        onInput={(event) => {
          const answer = held((event.target as HTMLInputElement).value, props.limit)
          setRefused(answer.refused)
          props.onPick(answer.value)
        }}
      />
      <span class="value" data-testid={props.shownId}>
        {props.shown}
      </span>
      {refused && (
        <span class="note limit" data-testid="limit-note">
          Takes {props.bound}.
        </span>
      )}
    </label>
  )
}

/**
 * The domains, allowed and denied, in one list with a mark against each.
 *
 * One list and not two, because a user thinks about a site once: this one, yes or no. Two boxes
 * would let the same host stand in both, and the answer to that ("deny wins") is a rule nobody
 * should have to learn. Sorted by host and not by verdict, so that changing a site's answer does
 * not move its row somewhere else in the list.
 */
export function HostRows(props: {
  allow: string[]
  deny: string[]
  onChange: (allow: string[], deny: string[]) => void
}) {
  const [typed, setTyped] = useState('')
  const rows = [
    ...props.allow.map((host) => ({ host, allowed: true })),
    ...props.deny.map((host) => ({ host, allowed: false })),
  ].sort((a, b) => (a.host < b.host ? -1 : 1))

  const put = (host: string, allowed: boolean) => {
    props.onChange(
      allowed
        ? [...props.allow.filter((one) => one !== host), host]
        : props.allow.filter((one) => one !== host),
      allowed
        ? props.deny.filter((one) => one !== host)
        : [...props.deny.filter((one) => one !== host), host],
    )
  }

  const add = () => {
    if (!typed.trim()) return
    // A host out of whatever was typed is settled in one place, and that place is `merge`: the
    // list goes through it on its way to storage and the page shows what came back, so an
    // address pasted here turns into its host and nonsense turns into nothing at all.
    put(typed, false)
    setTyped('')
  }

  return (
    <div class="hosts">
      <div class="host-add">
        <input
          data-testid="host-input"
          type="text"
          placeholder="site.example"
          value={typed}
          onInput={(event) => setTyped((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => event.key === 'Enter' && add()}
        />
        <button data-testid="host-add" onClick={add}>
          Add
        </button>
      </div>
      {rows.map((row) => (
        <div class="host-row" data-testid="host-row" key={row.host}>
          <span class="host-name">{row.host}</span>
          <button
            data-testid="host-toggle"
            class={row.allowed ? 'allowed' : 'denied'}
            onClick={() => put(row.host, !row.allowed)}
          >
            {row.allowed ? 'Allowed' : 'Denied'}
          </button>
          <button
            data-testid="host-remove"
            class="quiet"
            onClick={() =>
              props.onChange(
                props.allow.filter((one) => one !== row.host),
                props.deny.filter((one) => one !== row.host),
              )
            }
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Asks the service worker to throw away everything on disk, and says whether it did.
 *
 * Deletion has one owner, and it is the sweeper in the service worker (src/sw/sweeper.ts): a
 * page that removed files itself would be a second writer racing the first over the same
 * directories. The answer is carried back rather than swallowed: the worker refuses when the
 * wipe stops halfway — a file another handle is holding open, an index that would not open — and
 * a page that drew a zero over that would be reporting a deletion that did not happen.
 */
async function askToClear(): Promise<boolean> {
  try {
    const answer: unknown = await chrome.runtime.sendMessage({ type: 'tc:clear' })
    return (answer as { ok?: unknown } | undefined)?.ok === true
  } catch {
    // The extension was reloaded under this page, or there is no worker to hear it. Nothing was
    // cleared, and an unhandled rejection here would reach no further than this tab's console.
    return false
  }
}

export function Options() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [volume, setVolume] = useState<number | null>(null)
  /** Storage refused a write below the ceiling below: see the row it is shown in. */
  const [full, setFull] = useState(false)
  /** The last wipe was refused, and what is on disk is whatever it was; see the button. */
  const [clearRefused, setClearRefused] = useState(false)
  const [rate, setRate] = useState(REFERENCE_BITS_PER_SECOND)
  /** What sliders and fields have moved and not yet stored, by control, oldest touched first. */
  const waiting = useRef(new Map<string, (current: Settings) => Settings>())
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The tail of the writes already under way; see `push`. */
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    void readSettings().then(setSettings)
    void readTotals().then((totals) => {
      setVolume(totals.bytes)
      setFull(totals.fullAt > 0)
    })
    void listSessions(50).then((sessions) => setRate(bitsPerSecondOf(sessions)))
    // The popup has quick switches of its own, so somebody else may write the same key. A stale
    // value here would put the old setting back the moment anything on this page is touched.
    return watchSettings((next) => setSettings(next))
  }, [])

  if (!settings) return <div class="loading">Loading…</div>

  /**
   * Stores one edit, after everything already being stored.
   *
   * `writeSettings` reads storage, applies the edit to what came back and stores that. Two of
   * them in flight at once both read the old value, and the later one puts back what the earlier
   * had just changed — a setting the user watched themselves change and finds unchanged a moment
   * later. Queued, and the queue survives a refusal: the settings are one key, and a write that
   * failed is no reason to stop taking the next one.
   */
  const push = (change: (current: Settings) => Settings) => {
    queue.current = queue.current.then(() => writeSettings(change)).catch(() => undefined)
  }

  /**
   * Stores everything the controls have left waiting, in the order they were first moved, and
   * `andThen` after them — as one write, because that is what they amount to.
   */
  const store = (andThen?: (current: Settings) => Settings) => {
    clearTimeout(settle.current)
    settle.current = undefined
    const changes = [...waiting.current.values()]
    waiting.current.clear()
    if (andThen) changes.push(andThen)
    if (changes.length) {
      push((current) => changes.reduce((settings, change) => change(settings), current))
    }
  }

  /**
   * Stores an edit and shows what was stored.
   *
   * Shown through `merge`, which is what the store writes through: an address typed into the
   * list of hosts comes back as its host and a number out of range comes back inside it, and a
   * page showing something else until the next reload would be lying about what it saved. Shown
   * off the state as it stands rather than off the render this handler was built in, so that two
   * controls moved in one breath both survive on screen.
   *
   * `settleAs` names a control whose value arrives many times over — a slider dragged, a name
   * typed a letter at a time — and holds its write back for a moment. Not about quota (`local`
   * has no write rate worth naming, and the whole of the settings is one key) but about the
   * history of changes: a drag would otherwise leave forty writes behind, and the next person
   * reading `chrome.storage` for a bug report would be reading a film strip.
   *
   * What is waiting is kept per control and never thrown away. A single pending write, cancelled
   * by whatever came next, loses the value a user set a fifth of a second ago — and loses it
   * because they touched something else, which is the one thing they cannot connect it to. The
   * edits are functions of what is stored, so they compose in the order they were made.
   *
   * A tab closed inside that fifth of a second still loses the last move, and there is no
   * handler that would save it: a write begun in `pagehide` does not reliably arrive. The answer
   * is that the wait is short, not that something catches it.
   */
  const edit = (change: (current: Settings) => Settings, settleAs?: string) => {
    setSettings((current) => (current ? merge(change(current)) : current))

    if (settleAs === undefined) {
      store(change)
      return
    }

    // A Map keeps the latest move of each control under its own key and keeps the order the
    // controls were first touched in.
    waiting.current.set(settleAs, change)
    clearTimeout(settle.current)
    settle.current = setTimeout(store, SETTLE_MS)
  }

  const preset = presetOf(settings.detection)
  /** What one video of this length costs in memory at the rate this user actually records. */
  const expected = memoryFor(settings.recording.bufferSeconds, rate)
  /** The most the frame will hold across every session in one document. */
  const ceiling = memoryCeilingFor(settings.recording.bufferSeconds)
  /**
   * How much of that length will really be kept, where the ceiling comes first: the setting is
   * sized at an ordinary 1080p, and a stream well above that rate reaches the ceiling before it
   * reaches the length. Zero — the whole of it is held, and there is nothing to warn about.
   *
   * Said rather than hidden, and said in seconds. The frame shortens such a session instead of
   * throwing it away (`SessionStore.dropOverCeiling`), so the recording is real — it is just not
   * as long as the slider, and a slider promising a length nothing will keep is the one thing
   * this row must not do.
   */
  const keptSeconds = expected > ceiling ? (ceiling * 8) / rate : 0

  return (
    <main>
      <header class="page-head">
        <div class="tc-brand">
          <img
            class="tc-brand-mark"
            data-testid="brand-mark"
            src="../assets/tailcut/svg/mark-light.svg"
            alt="tailcut"
          />
          <div>
            <h1>tailcut</h1>
            <p>Settings</p>
          </div>
        </div>
      </header>

      <Group title="Recording">
        <div class="mode-grid">
          {MODES.map((mode) => (
            <label class="row mode" key={mode.value}>
              <input
                type="radio"
                name="mode"
                data-testid={`mode-${mode.value}`}
                checked={settings.recording.mode === mode.value}
                onChange={() =>
                  edit((current) => ({
                    ...current,
                    recording: { ...current.recording, mode: mode.value },
                  }))
                }
              />
              <span>
                <b>{mode.label}</b>
                <em>{mode.note}</em>
              </span>
            </label>
          ))}
        </div>

        <NumberRow
          id="buffer"
          label="Buffer length"
          kind="range"
          limit={LIMITS.bufferSeconds}
          step={15}
          bound={`${formatSeconds(LIMITS.bufferSeconds.min)} to ${formatSeconds(LIMITS.bufferSeconds.max)}`}
          shown={formatSeconds(settings.recording.bufferSeconds)}
          shownId="buffer-value"
          value={settings.recording.bufferSeconds}
          onPick={(bufferSeconds) =>
            edit((current) => ({ ...current, recording: { ...current.recording, bufferSeconds } }), 'buffer')
          }
        />
        <p class="note" data-testid="buffer-cost">
          About {formatBytes(expected)} of memory per video at what you have been recording.
          {keptSeconds > 0 &&
            ` A tab holds ${formatBytes(ceiling)} of that, so about ${formatSeconds(keptSeconds)} will be kept.`}
        </p>

        <HostRows
          allow={settings.recording.allow}
          deny={settings.recording.deny}
          onChange={(allow, deny) =>
            edit((current) => ({ ...current, recording: { ...current.recording, allow, deny } }))
          }
        />
      </Group>

      <Group title="Video detection">
        <p class="note">
          What counts as a video worth recording, rather than a banner or a hover preview. Now:{' '}
          <b data-testid="preset-name">{PRESET_NAMES[preset]}</b>
        </p>
        {(['loose', 'balanced', 'strict'] as const).map((name) => (
          <label class="row" key={name}>
            <input
              type="radio"
              name="preset"
              data-testid={`preset-${name}`}
              checked={preset === name}
              onChange={() => edit((current) => ({ ...current, detection: presetNamed(name) }))}
            />
            <span>{PRESET_NAMES[name]}</span>
          </label>
        ))}

        <Advanced label="Advanced video detection settings">
          <NumberRow
            id="probation"
            label="Probation"
            kind="number"
            limit={LIMITS.gracePeriodSeconds}
            bound={`${LIMITS.gracePeriodSeconds.min} to ${LIMITS.gracePeriodSeconds.max} seconds`}
            shown="seconds of watching before a video is kept"
            value={settings.detection.gracePeriodSeconds}
            onPick={(gracePeriodSeconds) =>
              edit(
                (current) => ({
                  ...current,
                  detection: { ...current.detection, gracePeriodSeconds },
                }),
                'probation',
              )
            }
          />

          <NumberRow
            id="min-width"
            label="Smallest player"
            kind="number"
            limit={LIMITS.minWidthPx}
            bound={`${LIMITS.minWidthPx.min} to ${LIMITS.minWidthPx.max} pixels`}
            shown="pixels wide"
            value={settings.detection.minWidthPx}
            onPick={(minWidthPx) =>
              edit((current) => ({ ...current, detection: { ...current.detection, minWidthPx } }), 'min-width')
            }
          />

          <label class="row">
            <input
              data-testid="record-muted"
              type="checkbox"
              checked={settings.detection.recordMuted}
              onChange={(event) =>
                edit((current) => ({
                  ...current,
                  detection: {
                    ...current.detection,
                    recordMuted: (event.target as HTMLInputElement).checked,
                  },
                }))
              }
            />
            <span>Record silent video</span>
          </label>
        </Advanced>
      </Group>

      <Group title="History">
        <label class="row">
          <input
            data-testid="to-disk"
            type="checkbox"
            checked={settings.history.toDisk}
            onChange={(event) =>
              edit((current) => ({
                ...current,
                history: { ...current.history, toDisk: (event.target as HTMLInputElement).checked },
              }))
            }
          />
          <span>
            <b>Save recordings to disk</b>
            <em>
              Off: recordings live in the tab that made them and are gone when it closes. Nothing
              already saved is removed.
            </em>
          </span>
        </label>

        <NumberRow
          id="keep-days"
          label="Keep for"
          kind="number"
          limit={LIMITS.keepDays}
          bound={`${LIMITS.keepDays.min} to ${LIMITS.keepDays.max} days`}
          shown="days"
          value={settings.history.keepDays}
          onPick={(keepDays) =>
            edit((current) => ({ ...current, history: { ...current.history, keepDays } }), 'keep-days')
          }
        />

        <NumberRow
          id="ceiling"
          label="Disk limit"
          kind="range"
          limit={LIMITS.ceilingBytes}
          step={256 * 1024 * 1024}
          bound={`${formatBytes(LIMITS.ceilingBytes.min)} to ${formatBytes(LIMITS.ceilingBytes.max)}`}
          shown={formatBytes(settings.history.ceilingBytes)}
          shownId="ceiling-value"
          value={settings.history.ceilingBytes}
          onPick={(ceilingBytes) =>
            edit((current) => ({ ...current, history: { ...current.history, ceilingBytes } }), 'ceiling')
          }
        />

        <div class="row">
          <span class="label">In use</span>
          <span class="value" data-testid="volume">
            {volume === null ? '…' : formatBytes(volume)}
          </span>
          {full && (
            // The browser refused a write below the ceiling above, which it is entitled to do:
            // the storage is best-effort. Said here because the alternative is a limit on
            // screen that is not the limit in force and a writer retrying in silence.
            <span class="note full" data-testid="disk-full">
              Disk full — keeping what fits
            </span>
          )}
          {clearRefused && (
            // A wipe that did not happen, said where it was asked for. Drawing a zero over it
            // would report a deletion the disk knows nothing about, and the next reload would
            // put the volume back with no explanation of where it had been.
            <span class="note refused" data-testid="clear-refused">
              Nothing was cleared
            </span>
          )}
          <button
            data-testid="clear"
            onClick={() => {
              void askToClear().then(async (cleared) => {
                setClearRefused(!cleared)
                if (cleared) {
                  setVolume(0)
                  setFull(false)
                  return
                }
                // Refused, and a wipe can stop halfway: what is left is read back rather than
                // guessed at, and the mark of a refused write with it.
                const now = await readTotals().catch(() => null)
                if (!now) return
                setVolume(now.bytes)
                setFull(now.fullAt > 0)
              })
            }}
          >
            Clear
          </button>
        </div>
      </Group>

      <Group title="Export">
        <label class="row">
          <span class="label">Format</span>
          <select
            data-testid="format"
            value={settings.export.format}
            onChange={(event) =>
              edit((current) => ({
                ...current,
                export: {
                  ...current.export,
                  format: (event.target as HTMLSelectElement).value as ExportFormat,
                },
              }))
            }
          >
            <option value="mp4">MP4</option>
            <option value="webp">Animated WebP</option>
          </select>
        </label>

        <Advanced label="Advanced export settings">
          <label class="row">
            <span class="label">File name</span>
            <input
              data-testid="name-template"
              type="text"
              value={settings.export.nameTemplate}
              onInput={(event) =>
                edit(
                  (current) => ({
                    ...current,
                    export: {
                      ...current.export,
                      nameTemplate: (event.target as HTMLInputElement).value,
                    },
                  }),
                  'name-template',
                )
              }
            />
            <span class="value">{'{title} {in} {out} {date} {host}'}</span>
          </label>

          <label class="row">
            <input
              data-testid="ask-where"
              type="checkbox"
              checked={settings.export.askWhere}
              onChange={(event) =>
                edit((current) => ({
                  ...current,
                  export: {
                    ...current.export,
                    askWhere: (event.target as HTMLInputElement).checked,
                  },
                }))
              }
            />
            <span>Ask where to save each clip</span>
          </label>

        </Advanced>
      </Group>

      <div class="reset">
        <button data-testid="reset" onClick={() => edit(() => DEFAULTS)}>
          Reset all settings
        </button>
      </div>
    </main>
  )
}

render(<Options />, document.body)
