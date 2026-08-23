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

function Popup() {
  // null — ответа вкладки ещё нет. Пустой массив от него отличается: на нём попап уже знает,
  // что записывать было нечего, и говорит это словами.
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)

  useEffect(() => {
    listSessions().then(setSessions)
  }, [])

  if (sessions === null) return <div class="pad muted">Loading…</div>
  if (!sessions.length) return <div class="pad muted">Nothing recorded on this page yet.</div>

  // Список приходит от свежих к старым: сверху то, что смотрят прямо сейчас. История и выбор
  // между сессиями — следующие этапы; здесь показывается текущая.
  const current = sessions[0]!

  return (
    <div>
      <header class="top">
        <b>tailcut</b>
      </header>

      <div class="pad">
        <div class="title" data-testid="title">
          {current.title || 'Untitled'}
        </div>
        <div class="muted host" data-testid="host">
          {hostOf(current.url)}
        </div>
        <div class="meta">
          <span data-testid="duration">{formatDuration(current.duration)}</span>
          <span class="muted">{formatBytes(current.bytes)}</span>
          {current.runs > 1 && <span class="muted">{current.runs} runs</span>}
        </div>
        <button class="primary" onClick={() => void saveAll(current.key)}>
          Save all
        </button>
      </div>
    </div>
  )
}

render(<Popup />, document.body)
