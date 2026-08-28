/** What a timecode counts at when the material does not say: PAL, and an arbitrary choice. */
const FALLBACK_RATE = 25

/**
 * Frames a second as a timecode counts them: whole, and never zero.
 *
 * 24000/1001 material is counted at 24 and 30000/1001 at 30 — non-drop, the way every editor
 * shows it. The alternative is a frame field that runs to 23 on one second and 24 on the next.
 */
export function timecodeRate(fps: number): number {
  return Number.isFinite(fps) && fps >= 1 ? Math.round(fps) : FALLBACK_RATE
}

export function formatTimecode(seconds: number, fps: number): string {
  const rate = timecodeRate(fps)
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const whole = Math.floor(total)
  const frame = Math.min(rate - 1, Math.floor((total - whole) * rate))

  const two = (value: number): string => String(value).padStart(2, '0')
  return `${two(Math.floor(whole / 3600))}:${two(Math.floor(whole / 60) % 60)}:${two(whole % 60)}:${two(frame)}`
}

const NUMBER = /^\d+(\.\d+)?$/

/**
 * A time typed by hand. Four shapes, because four are what people type: the full timecode of the
 * readout, minutes and seconds, a bare number of seconds, and the same with an `s` after it.
 *
 * null and not zero on anything else: the field feeds the playhead, and a mistyped character that
 * silently meant the beginning of the recording is worse than a field that refuses to move.
 */
export function parseTimecode(text: string, fps: number): number | null {
  const rate = timecodeRate(fps)
  const trimmed = text.trim().replace(/\s*s$/i, '').trim()
  if (!trimmed) return null

  const parts = trimmed.split(':')
  if (parts.length > 4 || !parts.every((part) => NUMBER.test(part))) return null

  const numbers = parts.map(Number)
  if (numbers.some((value) => !Number.isFinite(value))) return null

  // One number is seconds, fraction and all — the quickest thing to type and unambiguous.
  if (numbers.length === 1) return numbers[0]!

  // Once there is a colon every field is whole. The sub-second unit of a timecode is the frame,
  // so «1:23.5» would be two ways of saying the same thing inside one string, and neither of them
  // is what the readout above the field shows.
  if (numbers.some((value) => !Number.isInteger(value))) return null

  if (numbers.length === 4) {
    const [hours, minutes, seconds, frame] = numbers as [number, number, number, number]
    if (frame >= rate) return null
    if (minutes > 59 || seconds > 59) return null
    return hours * 3600 + minutes * 60 + seconds + frame / rate
  }

  if (numbers.length === 3) {
    const [hours, minutes, seconds] = numbers as [number, number, number]
    if (minutes > 59 || seconds > 59) return null
    return hours * 3600 + minutes * 60 + seconds
  }

  // Minutes are bounded here as well: an hour typed as «60:00» is a slip of the finger, and
  // reading it as one would move the playhead somewhere nobody asked for.
  const [minutes, seconds] = numbers as [number, number]
  if (minutes > 59 || seconds > 59) return null
  return minutes * 60 + seconds
}
