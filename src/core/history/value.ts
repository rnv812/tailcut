/**
 * The order §7.3 states in words, made into a total order over sessions.
 *
 * Words are enough to say which of two obvious cases goes first; they are not enough to answer
 * "which of these forty" without a number, and two places need that answer: the sweeper decides
 * by it what leaves the disk, and the frame decides by it what leaves the memory when the ceiling
 * of §7.2 is reached. One function, so that the two cannot come to disagree about what a
 * recording is worth.
 *
 * Everything here is a weight rather than a rule, with two exceptions that are rules: a pinned
 * session is never evicted, and one the user has taken into the editor outranks anything that
 * was only watched.
 * The weights are not tuned against a corpus — there is none — and they are not meant to be: what
 * they have to get right is the order of §7.3, and the tests state that order case by case.
 */

export interface Valued {
  id: string
  pinned: boolean
  /** When the user last took it into the editor — opened it or cut from it; 0 — never. */
  usedAt: number
  /** When material last arrived, wall clock. */
  lastSeenAt: number
  /** Material of the lead track, media seconds. */
  seconds: number
  sound: boolean
  /** Largest player it was watched in, CSS pixels; 0 — never measured. */
  widthPx: number
  bytes: number
}

/**
 * A session the user has taken into the editor is worth more than any session that was only
 * watched.
 *
 * Deliberately out of reach of the other weights: opening the editor over a recording, and
 * cutting a clip out of it, are the things a user does that say "this one" out loud, and no
 * amount of watching something else should be able to outrank them. It is also what keeps the
 * session somebody is editing right now from being swept out from under them — not a lock, and
 * said as such in the closing section.
 */
export const USED_WEIGHT = 1_000

/** Ten minutes of watching is as much as watching alone can be worth. */
export const WATCH_CAP_SECONDS = 600
export const WATCH_WEIGHT = 40

/** Sound: the difference between a video and a decoration. */
export const SOUND_WEIGHT = 8

/** A player this wide fills a window; wider than that says nothing more. */
export const WIDTH_CAP_PX = 1_280
export const WIDTH_WEIGHT = 8

const HOUR_MS = 3_600_000

/**
 * What this session is worth right now. Higher keeps.
 *
 * The age term is subtracted rather than scaled, so that it can eventually outweigh everything a
 * session earned: a recording nobody has come back to in a fortnight is worth less than one made
 * this morning, whatever either of them holds. A pinned session is outside all of this.
 */
export function valueOf(session: Valued, now: number): number {
  if (session.pinned) return Number.POSITIVE_INFINITY

  const watched = Math.min(session.seconds, WATCH_CAP_SECONDS) / WATCH_CAP_SECONDS
  const width = Math.min(Math.max(session.widthPx, 0), WIDTH_CAP_PX) / WIDTH_CAP_PX
  const age = Math.max(0, now - session.lastSeenAt) / HOUR_MS

  return (
    (session.usedAt > 0 ? USED_WEIGHT : 0) +
    watched * WATCH_WEIGHT +
    (session.sound ? SOUND_WEIGHT : 0) +
    width * WIDTH_WEIGHT -
    age
  )
}

/**
 * The sessions in the order they would be thrown away: the first to go stands first.
 *
 * A total order and not a sort by value alone. Two sessions of one page can be worth exactly the
 * same to the last digit — a feed leaves a row per clip behind — and a comparator that called
 * them equal would let the browser's sort put them in whichever order it liked, so a sweep and
 * the sweep after it could disagree about which of them was still there.
 *
 * The two values are compared and not subtracted, because two pinned sessions subtract into NaN,
 * a sort reads NaN as "these two are equal", and the tie-break below — the whole reason this is
 * an order and not a ranking — would never be reached for the very rows the user cares most about.
 */
export function evictionOrder(sessions: readonly Valued[], now: number): Valued[] {
  return [...sessions].sort((a, b) => {
    const first = valueOf(a, now)
    const second = valueOf(b, now)
    if (first !== second) return first < second ? -1 : 1
    if (a.lastSeenAt !== b.lastSeenAt) return a.lastSeenAt - b.lastSeenAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Enough of the cheapest sessions to free `overBytes`, in the order they should go.
 *
 * The pinned are not offered at all, whatever the shortfall. When what is left is not enough, the
 * answer is short by design: the ceiling is exceeded, the writer is told storage is full and
 * stops for a while (see HistoryWriter), and the user is one who asked for exactly this by
 * pinning more than fits.
 */
export function victimsFor(
  sessions: readonly Valued[],
  now: number,
  overBytes: number,
): Valued[] {
  if (overBytes <= 0) return []

  const taken: Valued[] = []
  let freed = 0

  for (const session of evictionOrder(sessions, now)) {
    if (session.pinned) continue
    taken.push(session)
    freed += session.bytes
    if (freed >= overBytes) break
  }

  return taken
}

/**
 * The sessions that have outlived the keeping (§7.4: seven days by default).
 *
 * Counted from when material last arrived and not from when the session opened: a video watched
 * over three evenings is one session (§6.1), and it is two days old on the third evening rather
 * than nearly a week.
 */
export function expiredBy(
  sessions: readonly Valued[],
  now: number,
  keepDays: number,
): Valued[] {
  const cutoff = now - keepDays * 86_400_000
  return sessions.filter((session) => !session.pinned && session.lastSeenAt < cutoff)
}
