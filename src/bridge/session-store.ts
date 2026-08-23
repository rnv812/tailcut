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
  /** источник → ключ сессии, пока вердикт отбора по нему не вынесен */
  private pendingBySource = new Map<string, string>()
  /** сессии, которым вердикт уже дал право на жизнь */
  private confirmed = new Set<string>()
  /** отсеянные источники: их байты не хранятся, пока вердикт не сменится */
  private rejected = new Set<string>()

  /**
   * Разбирает пришедшие байты и сам решает, что это. Хранилище кормится с чужой страницы,
   * поэтому ни один разбор здесь не имеет права упасть: непонятный кусок молча отбрасывается.
   */
  append(input: AppendInput): void {
    // Хук в MAIN world про вердикты не знает и копирует до последнего: отбор живёт здесь.
    // Отказ действует и вперёд, а не только на уже набранное, — иначе баннер, получивший
    // его раньше своего первого сегмента, завёл бы сессию сразу следом.
    if (this.rejected.has(input.sourceId)) return

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

  /**
   * Отсев: источник признан мусорным. Набранное им стирается, если сессию не подтвердили и
   * не набирает её кто-то ещё; подтверждённая переживает отказ — запись просто замирает
   * (пауза, скрытая вкладка, уход элемента с экрана), а накопленное остаётся.
   */
  dropPending(sourceId: string): void {
    this.rejected.add(sourceId)

    const key = this.pendingBySource.get(sourceId)
    this.pendingBySource.delete(sourceId)
    if (!key || this.confirmed.has(key)) return

    this.bySource.delete(sourceId)

    // Ключ сессии считается по адресу страницы и кодекам, так что у баннера и настоящего
    // плеера рядом с ним он вполне может совпасть. Вердикт адресный: стереть сессию по
    // отказу одного источника значило бы убить запись соседнего.
    for (const bound of this.bySource.values()) if (bound === key) return

    this.sessions.delete(key)
  }

  /** Испытательный срок пройден: сессию больше не стирает отказ по её источнику. */
  promotePending(sourceId: string): void {
    this.rejected.delete(sourceId)

    const key = this.pendingBySource.get(sourceId)
    if (!key) return

    this.pendingBySource.delete(sourceId)
    this.confirmed.add(key)
  }

  /** Ожидание после отказа: источник снова пишется, но права на жизнь пока не заработал. */
  resumePending(sourceId: string): void {
    this.rejected.delete(sourceId)
  }

  private openSession(input: AppendInput, info: InitInfo): void {
    const key = sessionKey({
      url: input.url,
      codecs: info.tracks.map((t) => t.codec),
      durationSeconds: Infinity,
    })

    this.bySource.set(input.sourceId, key)
    if (!this.confirmed.has(key)) this.pendingBySource.set(input.sourceId, key)

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
