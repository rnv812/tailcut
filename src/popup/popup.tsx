import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import {
  editSession,
  formatBytes,
  formatDuration,
  hostOf,
  listSessions,
  openEditor,
  saveAll,
  type EditResult,
  type Omission,
  type SaveFailure,
  type SaveResult,
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
  alternate: 'This file has more than one picture or sound track; one of each is saved.',
  gap: 'Recording has gaps: the longest piece is saved.',
}

/** Why the editor did not open, in the words the user is shown. */
const EDIT_FAILED: Record<NonNullable<EditResult['reason']>, string> = {
  gone: 'Could not open the editor. The session may be gone from the page.',
  empty: 'There is nothing to edit in this session yet.',
  // The one refusal that belongs to a file rather than to a recording: the editor works from a
  // copy of the material, and this material is on somebody's server. Said in the words of a read
  // that failed, because the video really was watched and there is nothing lost from the page.
  unread: 'Could not read the video file on this page, so there is nothing to edit.',
  storage: 'Could not write the snapshot: the browser refused the storage.',
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

/**
 * A page whose file could not be read.
 *
 * The fourth silence, and it needs a sentence for the same reason the others do. A file is only
 * ever opened after triage has said somebody is really watching it, so this means a video was
 * watched and there is nothing to offer for it: the address has expired, or the host will not
 * answer a ranged read, or the bytes are in neither of the two containers this program reads.
 * "Nothing recorded on this page yet" are the words for a page with no video at all, and over a
 * file just watched to the end they read as a defect.
 *
 * A plain WebM used to be the commonest way to land here — measured live on an imageboard thread
 * — and is not any more: a whole Matroska is now read by ranges like an mp4, VP8 and Vorbis
 * included (src/core/webm/locate.ts, src/core/export/matroska.ts).
 */
const UNREADABLE = 'tailcut could not read the video file on this page, so nothing of it was saved.'

/** The same page, with another file on it that was read: a thread holding an mp4 and a webm. */
const UNREADABLE_BESIDE = 'Another file on this page could not be read and was not saved.'

/**
 * Why no file appeared, in the words the user is shown.
 *
 * One sentence for each reason and not one for all three: answered as a single "could not save",
 * the popup blamed the session for being gone whatever had happened. Measured on a title carrying
 * an invisible U+200E LEFT-TO-RIGHT MARK — Chrome would not take the file name, the session was
 * recording on untouched, and the user was sent looking for a recording that had not been lost.
 */
const SAVE_FAILED: Record<SaveFailure, string> = {
  gone: 'This recording is no longer on the page.',
  empty: 'There is nothing recorded to save yet.',
  refused: 'Chrome would not save the file.',
}

/** A refusal that named no reason: an older bridge, or a tab that closed without answering. */
const SAVE_FAILED_UNKNOWN = 'Could not save this session.'

/** The complaint for one refusal, with whatever Chrome said about it after the sentence. */
function complaintFor(failure: SaveResult): string {
  const said = failure.reason ? SAVE_FAILED[failure.reason] : SAVE_FAILED_UNKNOWN
  return failure.detail ? `${said} ${failure.detail}` : said
}

function Popup() {
  // null — the tab has not answered yet. An answer with no sessions in it differs from that: on
  // that the popup already knows there was nothing to record, and says so in words.
  const [answer, setAnswer] = useState<SessionList | null>(null)
  // The session the user picked out of the list; null — none was picked and the freshest stands.
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // The refusal of the last save, whole: the popup owes the user the reason and not only the
  // fact. null — nothing has been refused since the last time the complaint was cleared.
  const [failure, setFailure] = useState<SaveResult | null>(null)
  const [editing, setEditing] = useState(false)
  const [editFailed, setEditFailed] = useState<NonNullable<EditResult['reason']> | null>(null)

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
    const nothing = answer.encrypted
      ? PROTECTED
      : answer.unreachable
        ? UNREACHABLE
        : answer.unreadableFile
          ? UNREADABLE
          : NOTHING
    return <div class="pad muted">{nothing}</div>
  }

  // The list comes newest first: at the top is what is being watched right now, and that is what
  // the popup opens on. A page has several sessions as a matter of course — a feed of short clips
  // leaves one behind per video — so the rest of them are listed below and can be shown here in
  // its place.
  const current = sessions.find((session) => session.key === pickedKey) ?? sessions[0]!
  // Every other session of the page that the user could actually do something with.
  //
  // A session with no bytes in it is left out. It is not a lie — a save of it answers, truthfully,
  // that there is nothing recorded to save yet — but a row here is an offer to switch to that
  // session, and this one can only lead to 0:00 and a button that refuses. A stream that opened
  // and brought nothing, a second buffer still waiting for its first fragment: both are ordinary,
  // and both stood in "Recent" promising a clip of no length.
  //
  // The block above keeps such a session when it is the freshest one, because up there it is not
  // an offer but the state of the page: something is being recorded and has not come to anything
  // yet, and the button says so in as many words.
  const others = sessions.filter((session) => session !== current && session.bytes > 0)

  // Picking is closed while a save is running, along with the button that started it: the answer
  // of the bridge is about the session that was saved, and switching under it would hang the
  // verdict on a session nobody tried to save.
  const pick = (key: string) => {
    setPickedKey(key)
    // The complaint belongs to the session it was made about — either complaint.
    setFailure(null)
    setEditFailed(null)
  }

  // A code the popup has no words for shows nothing rather than an empty box: the bridge and the
  // popup ship together, but the popup is the one that would be left drawing the gap.
  const omitted = current.omits ? OMITTED[current.omits] : undefined

  const save = async () => {
    setSaving(true)
    setFailure(null)
    const result = await saveAll(current.key)
    setSaving(false)
    setFailure(result.ok ? null : result)
  }

  const edit = async () => {
    setEditing(true)
    setEditFailed(null)
    const result = await editSession(current.key)
    if (result.ok && result.snapshotId) {
      await openEditor(result.snapshotId)
      // The popup closes with the tab in front: leaving it open over a tab the user has just been
      // sent to is a window nobody looks at again.
      window.close()
      return
    }
    setEditing(false)
    setEditFailed(result.reason ?? 'gone')
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
        {answer.unreadableFile && (
          <div class="omits" data-testid="unreadable">
            {UNREADABLE_BESIDE}
          </div>
        )}
        <div class="buttons">
          <button
            class="primary"
            data-testid="save"
            disabled={saving || editing}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save all'}
          </button>
          <button
            class="secondary"
            data-testid="edit"
            disabled={saving || editing}
            onClick={() => void edit()}
          >
            {editing ? 'Freezing…' : 'Edit'}
          </button>
        </div>
        {editFailed && (
          <div class="failed" data-testid="edit-error" role="alert">
            {EDIT_FAILED[editFailed]}
          </div>
        )}
        {failure && (
          <div class="failed" data-testid="error" role="alert">
            {complaintFor(failure)}
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
              disabled={saving || editing}
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
