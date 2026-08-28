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
    /** The shape of the picture as the reader worked it out. Absent on a sound track. */
    sample_aspect_ratio?: string
    display_aspect_ratio?: string
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
      'format=duration:stream=codec_type,codec_name,start_time,duration,nb_read_frames,' +
        'sample_aspect_ratio,display_aspect_ratio',
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

/**
 * Things ffmpeg says about a file that is nevertheless correct, each with the reason it is not a
 * defect. Anything it says that is not on this list is.
 *
 * The list is short on purpose and every line of it is argued: a decoder that is allowed to
 * complain freely stops being an assertion at all. Three entries so far, and the first is the one
 * this list exists for.
 *
 * `Duplicated SDTP atom` — a sample-dependency table in the traf of a fragment. It is legal
 * there (14496-12 §8.6.4), rutube's packager writes one into every fragment it sends, and the
 * fragmented writer copies fragments whole and byte for byte. ffmpeg keeps one such table per
 * stream and says this when a second arrives; the samples are described by the trun either way,
 * the file decodes from end to end, and every frame comes out. Measured on every rutube save.
 *
 * No file the program writes draws it any more: since Task 17 a save is assembled by the
 * progressive writer, which reads the samples out and states tables of its own, and the whole
 * paragraph below about the cost of dropping the box is why that writer exists rather than a
 * surgery on somebody else's fragments. The line stays named here because the fragmented writer
 * stays in the tree as the bench the new one is measured against (tests/core/mux.test.ts).
 *
 * The alternative was to drop the box while repacking. It was weighed and refused. A fragment
 * moves through the muxer untouched, which is the property the whole design rests on — nothing
 * of a foreign packager's material is rewritten — and taking a box out of a traf would end that:
 * the traf and the moof would have to be resized and every trun's data_offset patched, because
 * it addresses the samples from the start of the moof and the mdat would have moved. That is
 * arithmetic over somebody else's container on the save path, run over every fragment of every
 * file, to remove a box that is telling the truth. And it would throw away what the box says —
 * which frames may be discarded, which are depended upon — that the source file carried and a
 * player is entitled to read.
 *
 * `Increasing reorder buffer to N` — the h264 decoder found the stream reordering more pictures
 * than it had allowed for and grew its buffer once, at the start. It is a fact about the coded
 * frames and not about the container: an encoder that writes no `bitstream_restriction_flag` in
 * the VUI of its SPS declares no `num_reorder_frames`, so ffmpeg starts at its own guess and
 * corrects it on the first out-of-order picture. Our muxer copies coded frames byte for byte and
 * never touches an SPS.
 *
 * Proved rather than reasoned. The picture track of a rutube save was written out as a bare
 * Annex-B elementary stream — no mp4 around it at all, `-c copy -bsf:v h264_mp4toannexb -f h264`
 * — and decoding that drew the very same line. Whatever the message is about, it is not about
 * how the samples were wrapped. Measured on the same file: 1822 frames of picture and 3272 of
 * sound all decoded, ffprobe silent, both exit codes zero.
 *
 * Why our file draws it where ffmpeg's own remux of it does not: ours is fragmented, and a
 * fragmented file states its composition offsets in each trun instead of in one `ctts`. There is
 * no table for the demuxer to read the reordering depth out of ahead of the first frame, so the
 * decoder learns it by decoding. The offsets themselves are right — the presentation times come
 * out reordered against the decode times, frame for frame, in both files.
 *
 * `Last message repeated N times` — ffmpeg folds a line it has just printed rather than printing
 * it again. It says nothing of its own; whatever was folded stands on its own line above and is
 * judged there.
 */
const BENIGN: Array<{ line: RegExp; why: string }> = [
  { line: /Duplicated SDTP atom/, why: 'a legal sample-dependency table in a copied fragment' },
  {
    line: /Increasing reorder buffer to \d+/,
    why: 'an SPS that declares no reordering depth, in coded frames we copy untouched',
  },
  { line: /Last message repeated \d+ times/, why: 'ffmpeg folding a line it has already printed' },
]

/**
 * The lines of a decode that are not accounted for: empty when ffmpeg said nothing that matters.
 *
 * What a caller wants to know is whether the file is wrong, and an empty stderr answers that only
 * as long as no correct file makes ffmpeg speak. One does — see BENIGN — and a suite that
 * insisted on silence would fail over a box that is telling the truth.
 */
export function unexpectedWarnings(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !BENIGN.some((benign) => benign.line.test(line)))
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
