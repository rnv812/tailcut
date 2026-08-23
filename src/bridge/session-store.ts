import { parseInit } from '../core/iso/init'
import { parseFragment } from '../core/iso/fragment'
import { PtsMap } from '../core/timeline/map'
import { sessionKey } from '../core/session-key'
import type { Chunk, InitInfo } from '../shared/types'

export interface Session {
  key: string
  url: string
  title: string
  initBytes: Uint8Array
  info: InitInfo
  map: PtsMap
  createdAt: number
  lastSeenAt: number
}

export interface AppendInput {
  sourceId: string
  url: string
  title: string
  bytes: Uint8Array
  now: number
}

export class SessionStore {
  private sessions = new Map<string, Session>()
  /** какой сессии принадлежит поток от конкретного MediaSource */
  private bySource = new Map<string, string>()

  /**
   * Разбирает пришедшие байты и сам решает, что это. Хранилище кормится с чужой страницы,
   * поэтому ни один разбор здесь не имеет права упасть: непонятный кусок молча отбрасывается.
   */
  append(input: AppendInput): void {
    const info = parseInit(input.bytes)

    if (info) {
      this.openSession(input, info)
      return
    }

    const fragment = parseFragment(input.bytes)
    if (!fragment) return

    // Фрагмент раньше init'а — обычное дело: страница могла начать играть до того, как
    // встал мост. Дописывать его некуда, и это не ошибка.
    const key = this.bySource.get(input.sourceId)
    if (!key) return

    const session = this.sessions.get(key)
    if (!session) return

    // Дорожки в moof помечены trackId из init'а; на однодорожечном потоке плееры
    // изредка ставят там что-то своё, поэтому есть запасной вариант — первая дорожка.
    const track =
      session.info.tracks.find((t) => t.trackId === fragment.trackId) ?? session.info.tracks[0]
    if (!track) return

    // Такты фрагмента переводятся в секунды делением на timescale, и у битого init'а он
    // бывает нулевым. Подставить вместо нуля единицу значило бы выдумать времена (такты
    // ушли бы в секунды один к одному), а посчитать как есть — положить в карту кусок
    // с границами NaN: пустым он не считается, перекрытым тоже, и NaN разошёлся бы
    // оттуда по всей сводке в попапе. Такой фрагмент времени не имеет вовсе.
    if (!(track.timescale > 0)) return

    const start = fragment.baseMediaDecodeTime / track.timescale
    const chunk: Chunk = {
      start,
      end: start + fragment.duration / track.timescale,
      bytes: input.bytes,
    }

    session.map.insert(chunk)
    session.lastSeenAt = input.now
  }

  get(key: string): Session | undefined {
    return this.sessions.get(key)
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  evictAll(windowSeconds: number, currentTime: number): void {
    for (const session of this.sessions.values()) {
      session.map.evict(windowSeconds, currentTime)
    }
  }

  private openSession(input: AppendInput, info: InitInfo): void {
    const key = sessionKey({
      url: input.url,
      codecs: info.tracks.map((t) => t.codec),
      durationSeconds: Infinity,
    })

    this.bySource.set(input.sourceId, key)

    const existing = this.sessions.get(key)
    if (existing) {
      existing.lastSeenAt = input.now
      return
    }

    this.sessions.set(key, {
      key,
      url: input.url,
      title: input.title,
      initBytes: input.bytes,
      info,
      map: new PtsMap(),
      createdAt: input.now,
      lastSeenAt: input.now,
    })
  }
}
