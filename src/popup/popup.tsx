import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import {
  clearHistory,
  deleteHistory,
  editSession,
  formatBytes,
  formatDuration,
  formatWhen,
  historyRows,
  hostOf,
  listSessions,
  openEditor,
  openHistoryEditor,
  openSettings,
  pageUrl,
  pauseThisTab,
  saveAll,
  setSiteRecorded,
  siteSwitch,
  storageInUse,
  undoDelete,
  type EditResult,
  type HistoryRow,
  type Omission,
  type SaveFailure,
  type SaveResult,
  type SessionList,
  type SiteSwitch,
} from './api'

/** How a session is signed when the page never told its title. */
const UNTITLED = 'Untitled'

/** A page with nothing on it worth recording, or with nothing played on it yet. */
const NOTHING = 'Nothing recorded on this page yet.'

function Header() {
  return (
    <header class="top">
      <div class="tc-brand">
        <img
          class="tc-brand-mark"
          data-testid="brand-mark"
          src="../assets/tailcut/svg/mark-light.svg"
          alt="tailcut"
        />
        <span class="tc-brand-name">tailcut</span>
      </div>
    </header>
  )
}

/**
 * A page playing protected video.
 *
 * Said in as many words, and not left as the same emptiness a page with no video shows. The
 * refusal is deliberate and final — encryption was found in the material itself, everything
 * gathered before it was dropped, and nothing more will be taken in, so "nothing recorded
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
  // A page that plays its sound in an element of its own, where that element could not be used.
  // Said out loud rather than left to be discovered in a player: the clip really is silent, and
  // on this kind of page a silent clip looks like a defect in the saving rather than a page whose
  // sound was somewhere tailcut could not follow.
  sound: 'This page plays its sound in a separate track that tailcut could not read; the clip is silent.',
  rendition: 'Recorded at more than one quality; one is saved.',
  alternate: 'This file has more than one picture or sound track; one of each is saved.',
  gap: 'Recording gaps are joined in the saved clip.',
  // The same page, paired: the track ran out before the picture did, and nothing is looped round
  // to cover the rest. The page played what it played.
  soundShort: 'The separate soundtrack is shorter than the picture; the clip ends in silence.',
}

/**
 * A clip whose sound came from a track playing beside the picture.
 *
 * Not a loss, so not an omission — the length above already counts it — but not the video's own
 * sound either, and the difference is worth a line. On such a page the picture and the sound are
 * two files of different lengths looping on cycles of their own; what goes into the clip
 * is the start of the track, which is where the page itself puts the two together when it loads.
 */
const PAIRED_SOUND = 'Sound here is a separate looping track on this page, taken from its start.'

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

/** How long the undo of a deletion stays on screen. The sweeper waits longer than this. */
const UNDO_MS = 6_000

function History(props: {
  rows: HistoryRow[]
  hide: Set<string>
  onDeleted: (id: string) => void
  onChanged: () => void
}) {
  const [deleted, setDeleted] = useState<Array<{ row: HistoryRow; expiresAt: number }>>([])
  const hiddenIds = new Set(deleted.map((entry) => entry.row.id))
  const shown = props.rows.filter((row) => !props.hide.has(row.key) && !hiddenIds.has(row.id))

  useEffect(() => {
    if (!deleted.length) return
    const nextExpiry = Math.min(...deleted.map((entry) => entry.expiresAt))
    const timer = setTimeout(() => {
      const now = Date.now()
      setDeleted((current) => {
        const expired = current.filter((entry) => entry.expiresAt <= now)
        if (expired.length) {
          for (const entry of expired) props.onDeleted(entry.row.id)
          props.onChanged()
        }
        return current.filter((entry) => entry.expiresAt > now)
      })
    }, Math.max(0, nextExpiry - Date.now()))
    return () => clearTimeout(timer)
  }, [deleted])

  if (!shown.length && !deleted.length) return null

  return (
    <div class="history" data-testid="history">

      {shown.map((row) => (
        <div class="row history-row" data-testid="history-row" key={row.id}>
          <button
            class="history-open"
            data-testid="history-open"
            onClick={() => void openHistoryEditor(row.id)}
          >
            <span class="row-title" data-testid="history-title">
              {row.title || UNTITLED}
            </span>
            {/* Where it came from and what it costs. The weight belongs beside the address rather
                than under the length: the two questions a row answers are "what is this" and
                "what is it taking up", and the second is the one a full disk is made of. */}
            <span class="muted" data-testid="history-host">
              {hostOf(row.url)} · {formatBytes(row.bytes)}
            </span>
            <span class="muted" data-testid="history-length">
              {formatDuration(row.seconds)}
            </span>
            {/* When it was last watched. Without it a history of a feed is a column of
                lengths that look alike, and nothing in it says which recording is today's. */}
            <span class="muted" data-testid="history-when">
              {formatWhen(row.lastSeenAt)}
            </span>
          </button>
          <button
            class="quiet"
            data-testid="history-edit"
            onClick={() => void openHistoryEditor(row.id)}
          >
            Edit
          </button>
          <button
            class="quiet"
            data-testid="history-delete"
            onClick={() => {
              // Marked deleted at once, so the row is out of every list before the user has let
              // go of the button; the files go with the sweeper, and the toast below is the
              // window in which that can be called off.
              setDeleted((current) => [...current, { row, expiresAt: Date.now() + UNDO_MS }])
              void deleteHistory(row.id)
            }}
          >
            Delete
          </button>
        </div>
      ))}

      {deleted.map(({ row }) => (
        <div class="toast" data-testid="undo" role="status" key={row.id}>
          <span>Deleted “{row.title || UNTITLED}”</span>
          <button
            onClick={() => {
              void undoDelete(row.id).then(props.onChanged)
              setDeleted((current) => current.filter((entry) => entry.row.id !== row.id))
            }}
          >
            Undo
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Why the switch for the site is shut.
 *
 * `Off` records nothing anywhere, so there is nothing here to switch — and a switch left
 * live over it writes a list nothing reads and comes back unticked, which is a control answering
 * a press by doing nothing and saying nothing. Unticked and quiet it would also be saying "not
 * this site", which is a different statement and a false one. So it is shut, with the reason and
 * the way out of it: the mode lives on the settings page, one button along this same line.
 */
const RECORDING_OFF = 'Recording is off in Settings — no site is recorded.'

function SiteControl(props: {
  url: string
  site: SiteSwitch
  paused: boolean
  onChanged: () => void
}) {
  const host = hostOf(props.url)

  return (
    <div class="site-control" data-testid="site-control">
      <label class="switch">
        <input
          type="checkbox"
          data-testid="site-toggle"
          checked={props.site.recorded}
          disabled={props.site.off}
          onChange={(event) =>
            void setSiteRecorded(props.url, (event.target as HTMLInputElement).checked).then(
              props.onChanged,
            )
          }
        />
        <span>
          Record <b data-testid="site-name">{host || 'this site'}</b>
        </span>
      </label>

      <button
        class="quiet"
        data-testid="pause-tab"
        onClick={() => void pauseThisTab(!props.paused).then(props.onChanged)}
      >
        {props.paused ? 'Resume on this page' : 'Pause on this page'}
      </button>

      {props.site.off && (
        <div class="muted why" data-testid="site-off">
          {RECORDING_OFF}
        </div>
      )}
    </div>
  )
}

function StorageBar(props: {
  memoryBytes: number
  inUse: { bytes: number; full: boolean }
  hasHistory: boolean
  onCleared: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [clearFailed, setClearFailed] = useState(false)

  const clear = async () => {
    const ok = await clearHistory()
    setConfirming(false)
    setClearFailed(!ok)
    if (ok) props.onCleared()
  }

  return (
    <div class="storage-bar">
      <div class="storage-numbers">
        <span data-testid="memory-in-use">This tab: {formatBytes(props.memoryBytes)} in memory</span>
        <span data-testid="in-use" data-bytes={props.inUse.bytes}>
          <span data-testid="disk-in-use">
            {props.inUse.full
              ? `Disk full: ${formatBytes(props.inUse.bytes)} kept`
              : `History: ${formatBytes(props.inUse.bytes)} on disk`}
          </span>
        </span>
      </div>
      <div class="storage-actions" data-testid="storage-actions">
        {props.hasHistory && !confirming && (
          <button class="quiet danger" data-testid="delete-all" onClick={() => setConfirming(true)}>
            Delete all
          </button>
        )}
        {confirming && (
          <div class="clear-confirm">
            <button class="quiet" onClick={() => setConfirming(false)}>Cancel</button>
            <button class="quiet danger" data-testid="confirm-delete-all" onClick={() => void clear()}>
              Confirm delete all
            </button>
          </div>
        )}
        <button class="quiet" data-testid="open-settings" onClick={() => void openSettings()}>
          Settings
        </button>
      </div>
      {clearFailed && <div class="failed">Could not delete the recordings.</div>}
    </div>
  )
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
  /** What is on disk. Not a session of this tab and not asked of it: the index answers. */
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [inUse, setInUse] = useState({ bytes: 0, full: false })
  /** Where the tab stands, and what the settings make of it. */
  const [url, setUrl] = useState('')
  // Recording until the settings say otherwise, which is the default and what the settings
  // answer for every site the user has not forbidden. The read that settles it is one turn away.
  const [site, setSite] = useState<SiteSwitch>({ recorded: true, off: false })
  /**
   * Bumped by everything that changes what is shown: a pin, a deletion, an undo, the switch of a
   * site, the pause of a page. Nothing is guessed at from what was asked for — the popup reads
   * again, and draws what the index and the frame answered.
   */
  const [revision, setRevision] = useState(0)
  const changed = () => setRevision((turn) => turn + 1)

  useEffect(() => {
    // Four reads, side by side rather than one after another: they answer independently, and the
    // popup is obliged to open instantly. Nothing here computes and nothing walks the disk.
    let current = true
    void listSessions().then((next) => current && setAnswer(next))
    void historyRows().then((next) => current && setRows(next))
    void storageInUse().then((next) => current && setInUse(next))
    void pageUrl().then(async (where) => {
      if (!current) return
      setUrl(where)
      const next = await siteSwitch(where)
      if (current) setSite(next)
    })
    return () => { current = false }
  }, [revision])

  // The tab has not answered yet, and until it has there is nothing to say about the page. What
  // is on disk would be true already — it comes off the index — but a popup that drew its second
  // half first would jump under the hand that opened it.
  if (answer === null) return <div class="pad muted">Loading…</div>

  const sessions = answer.sessions

  /**
   * What is on disk, and the switches for the page above it. The same two whether or not this
   * page is recording: the history is the point of this stage and does not depend on the tab.
   *
   * A session of this tab is left out of the history by its merge key: one video listed in both
   * halves would be one recording pretending to be two, and the two rows would lead to different
   * places — the registry of the frame, and the pieces on disk.
   */
  const siteControl = (
    <SiteControl
      url={url}
      site={site}
      paused={answer.paused === true}
      onChanged={changed}
    />
  )
  const hideHistory = new Set(sessions.map((session) => session.key))
  const visibleHistory = rows.filter((row) => !hideHistory.has(row.key))
  const storage = (
    <StorageBar
      memoryBytes={sessions.reduce((sum, session) => sum + session.bytes, 0)}
      inUse={inUse}
      hasHistory={rows.length > 0 || inUse.bytes > 0}
      onCleared={() => {
        setRows([])
        setInUse({ bytes: 0, full: false })
      }}
    />
  )

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
    return (
      <div>
        <Header />
        {siteControl}
        <div class="pad muted" data-testid="nothing">
          {nothing}
        </div>
        {visibleHistory.length > 0 && (
          <section class="recordings" data-testid="recordings">
            <h2 class="section-heading">Recordings</h2>
            <History
              rows={rows}
              hide={hideHistory}
              onDeleted={(id) => setRows((current) => current.filter((row) => row.id !== id))}
              onChanged={changed}
            />
          </section>
        )}
        {storage}
      </div>
    )
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
      <Header />
      {siteControl}

      <section class="recordings" data-testid="recordings">
        <h2 class="section-heading">Recordings</h2>
      <div class="pad current-recording">
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
        {current.pairedSound && (
          <div class="omits" data-testid="paired-sound">
            {PAIRED_SOUND}
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
        <div class="recent-sessions">
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
      <History
        rows={rows}
        hide={hideHistory}
        onDeleted={(id) => setRows((current) => current.filter((row) => row.id !== id))}
        onChanged={changed}
      />
      </section>
      {storage}
    </div>
  )
}

render(<Popup />, document.body)
