import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import {
  formatBytes,
  formatDuration,
  hostOf,
  listSessions,
  saveAll,
  type SessionSummary,
} from './api'

/** How a session is signed when the page never told its title. */
const UNTITLED = 'Untitled'

function Popup() {
  // null — the tab has not answered yet. An empty array differs from it: on that the popup
  // already knows there was nothing to record, and says so in words.
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  // The session the user picked out of the list; null — none was picked and the freshest stands.
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    listSessions().then(setSessions)
  }, [])

  if (sessions === null) return <div class="pad muted">Loading…</div>
  if (!sessions.length) return <div class="pad muted">Nothing recorded on this page yet.</div>

  // The list comes newest first: at the top is what is being watched right now, and that is what
  // the popup opens on. A page has several sessions as a matter of course — a feed of short clips
  // leaves one behind per video — so the rest of them are listed below and can be shown here in
  // its place.
  const current = sessions.find((session) => session.key === pickedKey) ?? sessions[0]!
  const others = sessions.filter((session) => session !== current)

  // Picking is closed while a save is running, along with the button that started it: the answer
  // of the bridge is about the session that was saved, and switching under it would hang the
  // verdict on a session nobody tried to save.
  const pick = (key: string) => {
    setPickedKey(key)
    // The complaint belongs to the session it was made about.
    setFailed(false)
  }

  const save = async () => {
    setSaving(true)
    setFailed(false)
    const result = await saveAll(current.key)
    setSaving(false)
    setFailed(!result.ok)
  }

  return (
    <div>
      <header class="top">
        <b>tailcut</b>
      </header>

      <div class="pad">
        <div class="title" data-testid="title">
          {current.title || UNTITLED}
        </div>
        <div class="muted host" data-testid="host">
          {hostOf(current.url)}
        </div>
        <div class="meta">
          <span data-testid="duration">{formatDuration(current.duration)}</span>
          <span class="muted" data-testid="bytes">
            {formatBytes(current.bytes)}
          </span>
          {current.runs > 1 && (
            <span class="muted" data-testid="runs">
              {current.runs} runs
            </span>
          )}
        </div>
        <button class="primary" data-testid="save" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save all'}
        </button>
        {failed && (
          <div class="failed" data-testid="error" role="alert">
            Could not save this session. It may be gone from the page.
          </div>
        )}
      </div>

      {others.length > 0 && (
        <div class="recent" data-testid="recent">
          <div class="muted label">Recent</div>
          {others.map((session) => (
            <button
              key={session.key}
              class="row"
              data-testid="session"
              disabled={saving}
              onClick={() => pick(session.key)}
            >
              <span class="row-title">{session.title || UNTITLED}</span>
              <span class="muted">{formatDuration(session.duration)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

render(<Popup />, document.body)
