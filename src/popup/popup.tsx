import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import {
  formatBytes,
  formatDuration,
  hostOf,
  listSessions,
  saveAll,
  type Omission,
  type SessionList,
} from './api'

/** How a session is signed when the page never told its title. */
const UNTITLED = 'Untitled'

/** A page with nothing on it worth recording, or with nothing played on it yet. */
const NOTHING = 'Nothing recorded on this page yet.'

/**
 * A page playing protected video.
 *
 * Said in as many words, and not left as the same emptiness a page with no video shows. The
 * refusal is deliberate and final — encryption was found in the material itself, everything
 * gathered before it was dropped, and nothing more will be taken in (§5.4) — so "nothing recorded
 * yet" would promise a wait that never ends and make a decision look like a defect. The survey
 * found exactly that on every protected page it opened: a refusal indistinguishable from a
 * failure.
 */
const PROTECTED =
  'This page plays protected video, which tailcut does not record. Nothing of it was kept.'

/**
 * What the file will be missing, in the words the user is shown.
 *
 * The length above this line is already the length of the file and not of the recording, so the
 * line does not correct a number — it says why the number is smaller than the time spent
 * watching. One line and one loss: several can hold at once and the bridge sends the heaviest,
 * because a popup that explains itself in three lines has stopped being a popup.
 */
const OMITTED: Record<Omission, string> = {
  track: 'One track is in a format tailcut cannot save.',
  rendition: 'Recorded at more than one quality; one is saved.',
  gap: 'Recording has gaps: the longest piece is saved.',
}

/**
 * A page whose player tailcut could not reach.
 *
 * Its video is played out of a worker the extension was not allowed to wrap, so not one byte of
 * it ever passed through the recording: no later moment will change that, and there is nothing
 * for the user to wait for. Said in as many words, because the alternative is a popup that shows
 * nothing at all and looks broken instead of honest.
 */
const UNREACHABLE = 'tailcut cannot reach the player on this page, so nothing of it was recorded.'

/** The same page, with something else on it that was recorded. */
const UNREACHABLE_BESIDE = 'Another player on this page is out of reach and was not recorded.'

function Popup() {
  // null — the tab has not answered yet. An answer with no sessions in it differs from that: on
  // that the popup already knows there was nothing to record, and says so in words.
  const [answer, setAnswer] = useState<SessionList | null>(null)
  // The session the user picked out of the list; null — none was picked and the freshest stands.
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    listSessions().then(setAnswer)
  }, [])

  if (answer === null) return <div class="pad muted">Loading…</div>

  const sessions = answer.sessions
  if (!sessions.length) {
    // Three different silences, and the difference is the whole point: a page with nothing worth
    // recording on it, a page whose player never reached the extension at all, and a page that
    // may not be recorded. Protection comes first of the three because it is the reason for the
    // other two wherever it holds: a protected page keeps nothing, whatever else is true of it.
    const nothing = answer.encrypted ? PROTECTED : answer.unreachable ? UNREACHABLE : NOTHING
    return <div class="pad muted">{nothing}</div>
  }

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

  // A code the popup has no words for shows nothing rather than an empty box: the bridge and the
  // popup ship together, but the popup is the one that would be left drawing the gap.
  const omitted = current.omits ? OMITTED[current.omits] : undefined

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
        </div>
        {omitted && (
          <div class="omits" data-testid="omits">
            {omitted}
          </div>
        )}
        {answer.unreachable && (
          <div class="omits" data-testid="unreachable">
            {UNREACHABLE_BESIDE}
          </div>
        )}
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
