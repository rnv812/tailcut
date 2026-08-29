/**
 * Numbers as a person reads them. Shared, because three surfaces show the same numbers: the popup
 * shows a recording's length and weight, the settings page shows a buffer, a ceiling and the
 * volume in use, and the editor names a clip by its length.
 */

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
