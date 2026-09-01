import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import {
  clickEdit,
  collectDownloads,
  decodeFile,
  frameByIndex,
  frameTimes,
  playInBrowser,
  probeFile,
  recordPlayer,
  typeInto,
} from './helpers'

const HOST_URL = 'https://tailcut.test/editor-host'

/** The fixture the page plays: 24 frames a second, a key frame every second, 320×240. */
const FPS = 24
const FRAME = 1 / FPS

/**
 * The material as it really is — all three segments, including the one the page never appended.
 *
 * This is the yardstick for frame accuracy: what the editor calls second 1.5 of the session has
 * to be the frame ffmpeg finds at second 1.5 here. An arbitrary start is encoded for portable
 * playback, so comparison below allows compression noise but not a neighbouring frame.
 */
function reference(): string {
  const parts = [
    'init-stream0.m4s',
    'chunk-stream0-00001.m4s',
    'chunk-stream0-00002.m4s',
    'chunk-stream0-00003.m4s',
  ].map((name) => readFileSync(`tests/fixtures/h264/${name}`))

  mkdirSync('tests/tmp', { recursive: true })
  const file = 'tests/tmp/editor-source.mp4'
  writeFileSync(file, Buffer.concat(parts))
  return file
}

/** The widest step between one frame and the next: a hole left in the file shows up here. */
function widestStep(times: number[]): number {
  let widest = 0
  for (let i = 1; i < times.length; i++) widest = Math.max(widest, times[i]! - times[i - 1]!)
  return widest
}

function meanDifference(left: Buffer, right: Buffer): number {
  expect(left.byteLength).toBe(right.byteLength)
  let total = 0
  for (let at = 0; at < left.byteLength; at++) total += Math.abs(left[at]! - right[at]!)
  return total / left.byteLength
}

test('cuts two clips, one of them across a hole, and writes both to disk', async () => {
  // Six browsers' worth of work: recording, the editor, two exports and two playbacks.
  test.setTimeout(240_000)

  const { context, player, extensionId } = await recordPlayer('editor-host.html', HOST_URL)

  try {
    expect(await player.evaluate(() => (window as unknown as { tc: { failure: string | null } }).tc.failure)).toBeNull()

    const { editor } = await clickEdit(context, player, extensionId)

    // What the editor made of the recording: two runs of picture with one hole between them.
    // One hole, not two: both tracks stopped for it, and gaps are counted on the picture.
    await expect(editor.getByTestId('gaps')).toHaveText('1 gap')
    await expect(editor.getByTestId('frame-count')).toHaveText('96')
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
    // Nothing to export yet, so the button is disabled instead of writing an empty file.
    await expect(editor.getByTestId('export-selected')).toBeDisabled()
    await expect(editor.getByTestId('export-all')).toBeDisabled()

    // One clip from half a second to four and a half — across the hole — and then a cut through
    // it at a second and a half. Two clips, and not a pixel of the timeline touched: the second
    // one cannot be started with I while the first is selected, and a split says the same thing.
    await typeInto(editor, 'playhead-field', '00:00:00:12')
    await editor.keyboard.press('i')
    await expect(editor.getByTestId('clip')).toHaveCount(1)
    // There is something to write now, and the material has finished indexing.
    await expect(editor.getByTestId('export-selected')).toBeEnabled()
    await expect(editor.getByTestId('export-all')).toBeEnabled()

    // Out at four and a half — on the far side of the hole. The handle goes there because the
    // quality never changed: a hole breaks a run but not a quality zone, and export collapses it
    // out of the file. Were it a quality change instead, the box would stop at
    // the boundary and stay there, with the inspector saying which quality is on the other side.
    await typeInto(editor, 'out-c1', '00:00:04:12')
    await expect(editor.getByTestId('out-c1')).toHaveValue('00:00:04:12')

    await typeInto(editor, 'playhead-field', '00:00:01:12')
    await editor.keyboard.press('s')
    await expect(editor.getByTestId('clip')).toHaveCount(2)
    await expect(editor.getByTestId('out-c1')).toHaveValue('00:00:01:12')
    await expect(editor.getByTestId('in-c2')).toHaveValue('00:00:01:12')
    await expect(editor.getByTestId('out-c2')).toHaveValue('00:00:04:12')

    const files = await collectDownloads(editor, 2, () => editor.getByTestId('export-all').click())

    await expect(editor.getByTestId('job')).toHaveCount(2)
    await expect(editor.getByTestId('job-state').first()).toHaveText('Saved')
    await expect(editor.getByTestId('job-state').last()).toHaveText('Saved')

    expect(files.map((one) => one.name.endsWith('.mp4'))).toEqual([true, true])
    // Each name combines the page title with its clip's start timecode, so the names differ.
    expect(new Set(files.map((one) => one.name)).size).toBe(2)
    for (const one of files) expect(one.name).toContain('test player with a hole')

    // Sorted by name, not taken in the order they landed: both clips are exported at once
    // (`PARALLEL` is 3) and nothing orders the two downloads. Each name carries the clip's start
    // timecode: the left half keeps «… 00.00», the right
    // half is named at the cut and gets «… 00.01» — so sorting by name puts the clip that lies
    // inside the run first, which is what the two lines below assume.
    const [inside, across] = [...files].sort((a, b) => a.name.localeCompare(b.name)).map((one) => one.file)
    const source = reference()

    /**
     * The frame of the recording that stands at `at` seconds of the session.
     *
     * Named by a second, because a second is what was typed into the editor; **fetched by
     * number**, because a second is not a way to name a frame to ffmpeg. `frameByPlaying(source,
     * at)` answers a different question — what is on screen at that instant — and at a frame
     * boundary the two answers differ by a whole frame. Half a frame is for `currentTime` and
     * for nothing else; here the second is converted directly to a frame number.
     */
    const sourceFrame = (at: number): Buffer => frameByIndex(source, Math.round(at * FPS))
    const expectFrame = (file: string, index: number, at: number): void => {
      const actual = frameByIndex(file, index)
      const wanted = meanDifference(actual, sourceFrame(at))
      const neighbour = Math.min(
        meanDifference(actual, sourceFrame(at - FRAME)),
        meanDifference(actual, sourceFrame(at + FRAME)),
      )
      expect(
        wanted,
        `frame ${index}: wanted ${wanted.toFixed(3)}, neighbour ${neighbour.toFixed(3)}`,
      ).toBeLessThan(neighbour)
      expect(wanted, `frame ${index} differs by ${wanted.toFixed(3)} channels`).toBeLessThan(15)
    }

    // The clip that lies wholly inside the first run: a second of picture asked for, and its
    // first frame is the frame the user pointed at and not the key frame before it.
    //
    // Twenty-five frames, not twenty-four, and the number is **arithmetic and not a
    // measurement**: the export plan over this fixture keeps 37 samples,
    // hides 7168 ticks behind the edit list and leaves 12800, which is 25 frames of 512 and
    // 1.0417 s. The twenty-fifth is the frame past the out point that reordering drags in, the
    // known reordering limit rather than an unexplained surplus. If export stops dragging it in,
    // this number becomes 24 and the two lines under it stay true: the file is as long as the
    // frames in it, and its first frame is the frame that was asked for.
    const first = probeFile(inside!)
    expect(first.streams.map((stream) => stream.codec_type)).toEqual(['video', 'audio'])
    expect(Number(first.streams[0]!.nb_read_frames)).toBe(25)

    const inner = frameTimes(inside!, 'v')
    expect(inner).toHaveLength(25)
    expect(widestStep(inner)).toBeCloseTo(FRAME, 3)
    expect(Number(first.format.duration)).toBeCloseTo(inner[inner.length - 1]! + FRAME, 2)

    // Frames 12, 35 and 36 of the recording. Checked against the fixture with ffmpeg before it
    // was written down: `eq(n,12)` is the frame the recording shows at second 0.5.
    expectFrame(inside!, 0, 0.5)
    expectFrame(inside!, 23, 0.5 + 23 * FRAME)
    // The one frame past the out point, named rather than left to be discovered.
    expectFrame(inside!, 24, 1.5)

    // The clip across the hole: twelve frames from before it, fourteen from after, and no two
    // seconds of hole between them. The two tracks were pulled back by the smaller of the two
    // holes (1.9969 against 2.000), so the seam frame lasts 38 ticks — three milliseconds —
    // longer than the rest, an accepted seam residue well under one frame.
    //
    // Arithmetic again: 38 samples, 13862 ticks, 26 frames, 1.1281 s. Two frames past the second
    // that was asked for, and both are accounted for — the frame *at* the out point, which decode
    // order sweeps in ahead of the last frame before it, and the frame past it. One frame of the
    // recording is missing from the file's tail for the same reason: it is composed after the out
    // point and decoded after the last frame that is kept, so nothing references it and it does
    // not come. That is the two-frame step at the very end, and it is the only step over one.
    const second = probeFile(across!)
    expect(second.streams.map((stream) => stream.codec_type)).toEqual(['video', 'audio'])
    expect(Number(second.streams[0]!.nb_read_frames)).toBe(26)

    const picture = frameTimes(across!, 'v')
    const sound = frameTimes(across!, 'a')
    expect(picture).toHaveLength(26)
    expect(sound.length).toBeGreaterThan(0)
    expect(Number(second.format.duration)).toBeCloseTo(picture[picture.length - 1]! + FRAME, 2)

    // The invariants that outlive the counts. The seam is under a frame and a half — the two
    // seconds that were cut out are gone, not shortened — and the only wider step is the one
    // frame of tail described above.
    expect(widestStep(picture.slice(0, -1))).toBeLessThan(1.5 * FRAME)
    expect(widestStep(picture.slice(0, -1))).toBeGreaterThan(FRAME)
    expect(widestStep(picture)).toBeLessThanOrEqual(2 * FRAME + 0.001)
    expect(widestStep(sound)).toBeLessThan(0.05)
    expect(sound.at(-1)).toBeGreaterThan(0.9)

    // Frames 36 and 47 of the recording — the last twelve before the hole.
    expectFrame(across!, 0, 1.5)
    expectFrame(across!, 11, 1.5 + 11 * FRAME)
    // The other side of the seam: frame twelve of the clip is second four of the recording, which
    // is frame 96 — the hole is gone and the numbers on the two sides of it are two seconds apart.
    expectFrame(across!, 12, 4)
    expectFrame(across!, 23, 4 + 11 * FRAME)
    // And the frame at the out point itself — frame 108 — which is where the extra two came from.
    expectFrame(across!, 24, 4.5)

    // Read through by a decoder and not only by a parser: material described wrongly gets past
    // the headers and past a frame count, and turns into words on stderr only here.
    decodeFile(inside!)
    decodeFile(across!)

    // And the last word belongs to a browser, which is where the files are going to be opened.
    const played = await playInBrowser(across!)
    expect(played.error).toBeNull()
    expect(played.ended, 'the clip did not play through to the end').toBe(true)
    expect([played.frameWidth, played.frameHeight]).toEqual([320, 240])
    expect(played.frameColours, 'the browser drew a blank frame').toBeGreaterThan(1)
    expect(played.audioBytes, 'the browser decoded no sound at all').toBeGreaterThan(0)
  } finally {
    await context.close()
  }
})

test('takes a clip back and puts it back with the keyboard alone', async () => {
  test.setTimeout(120_000)

  const { context, player, extensionId } = await recordPlayer('editor-host.html', HOST_URL)

  try {
    const { editor } = await clickEdit(context, player, extensionId)
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)

    // The same three edits as above: mark, stretch across the hole, cut in two.
    await typeInto(editor, 'playhead-field', '00:00:00:12')
    await editor.keyboard.press('i')
    await typeInto(editor, 'out-c1', '00:00:04:12')
    await typeInto(editor, 'playhead-field', '00:00:01:12')
    await editor.keyboard.press('s')
    await expect(editor.getByTestId('clip')).toHaveCount(2)

    // Three edits, three presses, back to the empty timeline — through the real store, the real
    // keyboard and real components, which reducer unit tests cannot cover.
    await editor.keyboard.press('Control+z')
    await expect(editor.getByTestId('clip')).toHaveCount(1)
    await expect(editor.getByTestId('out-c1')).toHaveValue('00:00:04:12')

    // The middle press, and the reason there are three of them. What it takes back is the typed
    // trim, and the clip goes back to what I made of it: half a second to the end of the run it
    // began in. Without this line two presses and three would both end on an empty timeline, and
    // a typed trim that recorded no step of its own would pass the whole test.
    await editor.keyboard.press('Control+z')
    await expect(editor.getByTestId('clip')).toHaveCount(1)
    await expect(editor.getByTestId('out-c1')).toHaveValue('00:00:02:00')

    await editor.keyboard.press('Control+z')
    await expect(editor.getByTestId('no-clips')).toBeVisible()

    for (let i = 0; i < 3; i++) await editor.keyboard.press('Control+Shift+z')
    await expect(editor.getByTestId('clip')).toHaveCount(2)
    await expect(editor.getByTestId('out-c2')).toHaveValue('00:00:04:12')
  } finally {
    await context.close()
  }
})
