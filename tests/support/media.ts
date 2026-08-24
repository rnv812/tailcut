import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

/** Where a test drops a file for ffmpeg to read. The directory is ignored by git. */
export function writeTemp(name: string, bytes: Uint8Array): string {
  mkdirSync('tests/tmp', { recursive: true })
  const file = `tests/tmp/${name}`
  writeFileSync(file, bytes)
  return file
}

export interface Probed {
  format: { duration: string }
  streams: Array<{
    codec_type: string
    codec_name: string
    start_time: string
    duration: string
    nb_read_frames: string
  }>
}

export interface ProbeResult {
  status: number | null
  /** Complaints of the reader. A file whose boxes lie about its samples complains here and
   *  still exits zero, so an empty string is part of what a caller checks. */
  stderr: string
  probed: Probed | null
}

/**
 * Reads a file back through ffprobe, frame by frame.
 *
 * -count_frames drives it through every packet instead of the headers alone: material laid out
 * wrongly inside mdat leaves the boxes intact and shows up only when the frames are decoded.
 */
export function probeFile(file: string): ProbeResult {
  const run = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-count_frames',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,start_time,duration,nb_read_frames',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )

  return {
    status: run.status,
    stderr: run.stderr ?? '',
    probed: run.status === 0 ? (JSON.parse(run.stdout) as Probed) : null,
  }
}

/** Presentation times of every frame of one stream, in ascending order. */
export function frameTimes(file: string, stream: 'v' | 'a'): number[] {
  const run = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', stream,
      '-show_entries', 'frame=best_effort_timestamp_time',
      '-of', 'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  )

  return (run.stdout ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.length > 0)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
}

/** Decodes the whole file and hands back what ffmpeg said about it, which should be nothing. */
export function decodeWarnings(file: string): string {
  const run = spawnSync('ffmpeg', ['-v', 'warning', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8',
  })
  return run.stderr ?? ''
}

function rawFrame(args: string[]): Buffer {
  const run = spawnSync('ffmpeg', args, { maxBuffer: 128 * 1024 * 1024 })
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr.toString()}`)
  return run.stdout
}

/**
 * Frame number `index` of the picture, as raw RGB, reached by decoding from the first frame.
 *
 * By number and not by time, because that is the question a cut is judged by: the clip is right
 * when its first frame is the frame the user pointed at, whatever time either file gives it.
 */
export function frameAt(file: string, index: number): Buffer {
  return rawFrame([
    '-v', 'error',
    '-i', file,
    '-vf', `select='eq(n\\,${index})'`,
    '-vsync', '0',
    '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ])
}

/**
 * The frame shown at `at` seconds, reached by seeking — which is to say, by the sync sample
 * table and nothing else. Compared against frameAt, this is what proves the stss right.
 */
export function frameBySeeking(file: string, at: number): Buffer {
  return rawFrame([
    '-v', 'error',
    '-ss', String(at),
    '-i', file,
    '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ])
}

/** The same frame reached by playing up to that instant. */
export function frameByPlaying(file: string, at: number): Buffer {
  return rawFrame([
    '-v', 'error',
    '-i', file,
    '-vf', `select='gte(t\\,${at})'`,
    '-vsync', '0',
    '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ])
}
