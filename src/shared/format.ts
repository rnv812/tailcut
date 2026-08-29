/**
 * Numbers as a person reads them, and the one address they read beside those. Shared, because
 * three surfaces show the same things: the popup shows a recording's length, weight and site, the
 * settings page shows a buffer, a ceiling and the volume in use, and the editor names a clip by
 * its length and by the site it was watched on.
 */

/**
 * The page address in a form fit for the line under a title, and for the `{host}` of a name
 * template; an address that is not one — the empty string.
 *
 * Here rather than beside either caller, and that was learnt the hard way: the popup had it and
 * the editor grew a second copy of the same four lines, in a file that cannot import the popup's
 * (that one drags `chrome` in with it). Two copies of "what is the host of this" is how two
 * surfaces come to disagree about a port number.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** A length in seconds as m:ss, and as h:mm:ss once there is an hour of it. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** The same length said in words, for a control that sets it: "3 min", "45 s", "1 h 30 min". */
export function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total} s`
  const minutes = Math.round(total / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/**
 * A weight in bytes, in the unit it is said in: kilobytes below a megabyte, megabytes below a
 * gigabyte, gigabytes above.
 *
 * Powers of 1024 and named as such: this is disk, the ceiling of §7.4 is written as 4 GB meaning
 * 4 GiB, and a page that showed 4.29 GB for it would be answering a question nobody asked.
 */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes)
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** The months, short, in the language of this program: a date is a string and not a locale here. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A day and a night in milliseconds: the border where the count of hours stops being readable. */
const DAY_MS = 86_400_000

/**
 * When something happened, as a person says it: "just now", "45 min ago", "3 h ago", "Yesterday",
 * "3 days ago", "22 Aug", "31 Dec 2025".
 *
 * §9.2 asks for the recent sessions with their time, and the reason is the list itself: three rows
 * of a feed are three lengths that look alike, and the moment is what tells this afternoon's
 * recording from last month's. Elapsed time up to a week, because that is the question near the
 * present — "was this today?" — and a calendar date beyond it, because past a week nobody counts
 * in days.
 *
 * The clock is a parameter with a default rather than a call inside: a row is drawn against the
 * moment it is drawn at, and a caller that has one already must not get a second reading.
 */
export function formatWhen(at: number, now = Date.now()): string {
  // A row with no moment written in it: nothing at all, rather than a day in 1970.
  if (!Number.isFinite(at) || at <= 0) return ''

  // A clock that moved backwards under a row already written — the machine woke up and corrected
  // itself, the row came off a profile carried over. It happened, and not in the future.
  const ago = Math.max(0, now - at)
  if (ago < 60_000) return 'just now'
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`
  if (ago < DAY_MS) return `${Math.floor(ago / 3_600_000)} h ago`

  const days = Math.floor(ago / DAY_MS)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`

  const day = new Date(at)
  const date = `${day.getDate()} ${MONTHS[day.getMonth()]}`
  // The year only where it differs: "31 Dec" of a year ago reads as the December still to come.
  return day.getFullYear() === new Date(now).getFullYear() ? date : `${date} ${day.getFullYear()}`
}
