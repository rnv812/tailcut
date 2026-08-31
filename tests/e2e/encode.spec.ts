import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { videoSampleEntry } from '../../src/core/iso/entry'
import { boxBody, childBoxes, findBox, topLevelBoxes, type Box } from '../../src/core/iso/reader'
import type { TrackKind } from '../../src/shared/types'
import {
  clickEdit,
  collectDownloads,
  exportClipWith,
  launchWithExtension,
  placeCrop,
  probeFile,
  routeLocal,
  serveLocal,
  typeInto,
} from './helpers'

const PLAYER_URL = 'https://tailcut.test/encode'
const FRAME_SECONDS = 0.1

/**
 * YouTube-style AV1 metadata: predicted samples state sample_depends_on but leave the redundant
 * sample_is_non_sync_sample bit clear. The coded bytes are untouched, so a decoder remains the
 * authority on whether the chunk label is truthful.
 */
function av1WithDependencyOnly(file: string): Buffer {
  const bytes = new Uint8Array(readFileSync(file))
  const out = bytes.slice()
  const moof = topLevelBoxes(out).find((box) => box.type === 'moof')!
  const traf = childBoxes(out, moof).find((box) => box.type === 'traf')!
  const tfhd = childBoxes(out, traf).find((box) => box.type === 'tfhd')!
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const body = tfhd.start + tfhd.headerSize
  const flags = view.getUint32(body) & 0x00ffffff

  let field = body + 8
  if (flags & 0x000001) field += 8
  if (flags & 0x000002) field += 4
  if (flags & 0x000008) field += 4
  if (flags & 0x000010) field += 4
  if (!(flags & 0x000020)) throw new Error('the AV1 fixture has no default sample flags')

  const defaults = view.getUint32(field)
  if ((defaults & 0x03000000) !== 0x01000000) {
    throw new Error('the AV1 fixture does not mark its predicted samples as dependent')
  }
  if ((defaults & 0x00010000) === 0) {
    throw new Error('the AV1 fixture already omits its non-sync bit')
  }
  view.setUint32(field, defaults & ~0x00010000)
  return Buffer.from(out)
}

/** An HLS fragment whose container leaves every sample dependency flag unknown. */
function withoutSampleFlags(file: string): Buffer {
  const out = new Uint8Array(readFileSync(file))
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const tfhd = findBox(out, ['moof', 'traf', 'tfhd'])!
  const tfhdWord = tfhd.start + tfhd.headerSize
  const tfhdFlags = view.getUint32(tfhdWord) & 0x00ffffff
  let field = tfhdWord + 8
  if (tfhdFlags & 0x000001) field += 8
  if (tfhdFlags & 0x000002) field += 4
  if (tfhdFlags & 0x000008) field += 4
  if (tfhdFlags & 0x000010) field += 4
  if (tfhdFlags & 0x000020) view.setUint32(field, 0)

  const trun = findBox(out, ['moof', 'traf', 'trun'])!
  const trunWord = trun.start + trun.headerSize
  const trunFlags = view.getUint32(trunWord) & 0x00ffffff
  const count = view.getUint32(trunWord + 4)
  field = trunWord + 8
  if (trunFlags & 0x000001) field += 4
  if (trunFlags & 0x000004) {
    view.setUint32(field, 0)
    field += 4
  }
  const beforeFlags =
    (trunFlags & 0x000100 ? 4 : 0) + (trunFlags & 0x000200 ? 4 : 0)
  const entry =
    beforeFlags +
    (trunFlags & 0x000400 ? 4 : 0) +
    (trunFlags & 0x000800 ? 4 : 0)
  if (trunFlags & 0x000400) {
    for (let i = 0; i < count; i++) view.setUint32(field + i * entry + beforeFlags, 0)
  }

  return Buffer.from(out)
}

interface OpenedClip {
  context: BrowserContext
  editor: Page
}

async function openClip(
  from: string,
  out: string,
  beforeEditor?: (context: BrowserContext) => Promise<void>,
): Promise<OpenedClip> {
  const { context, extensionId } = await launchWithExtension()
  const player = await context.newPage()
  await serveLocal(player, 'minute.html', PLAYER_URL)
  await player.waitForFunction(
    () => (window as unknown as { tc?: { ready?: boolean; failure?: string | null } }).tc?.ready,
  )
  await player.evaluate(() => document.querySelector('video')!.play())
  await player.waitForFunction(() => document.querySelector('video')!.currentTime >= 8)

  await beforeEditor?.(context)
  const { editor } = await clickEdit(context, player, extensionId)
  await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
  await typeInto(editor, 'playhead-field', from)
  await editor.keyboard.press('i')
  await expect(editor.getByTestId('clip')).toHaveCount(1)
  await typeInto(editor, 'out-c1', out)
  return { context, editor }
}

async function splitAt(editor: Page, at: string, clips: number): Promise<void> {
  await typeInto(editor, 'playhead-field', at)
  await editor.keyboard.press('s')
  await expect(editor.getByTestId('clip')).toHaveCount(clips)
}

async function installEncodeCounter(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    let calls = 0
    const encode = VideoEncoder.prototype.encode
    VideoEncoder.prototype.encode = function (frame, options) {
      calls += 1
      return encode.call(this, frame, options)
    }
    Object.defineProperty(window, 'tcEncodeCalls', { get: () => calls })
  })
}

/** Count profile-0 VP9 delta frames the editor labels as decoder entry points. */
async function installVp9KeyAudit(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    let chunks = 0
    let falseKeys = 0
    const decode = VideoDecoder.prototype.decode
    VideoDecoder.prototype.decode = function (chunk) {
      const bytes = new Uint8Array(chunk.byteLength)
      chunk.copyTo(bytes)
      // VP9 starts with the frame marker 10. This fixture is profile 0, where frame_type is the
      // sixth bit. AVC length prefixes and the H.264 output do not match this marker here.
      if ((bytes[0]! & 0xc0) === 0x80) {
        chunks += 1
        if (chunk.type === 'key' && (bytes[0]! & 0x04) !== 0) falseKeys += 1
      }
      return decode.call(this, chunk)
    }
    Object.defineProperty(window, 'tcVp9KeyAudit', {
      get: () => ({ chunks, falseKeys }),
    })
  })
}

/** Record exactly what a clip from a later retained run hands to the real decoder. */
async function installDecoderAudit(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const configurations: Array<{
      codec: string
      codedWidth?: number
      codedHeight?: number
      description: number
    }> = []
    const chunks: Array<{ type: EncodedVideoChunkType; timestamp: number; bytes: number }> = []
    const configure = VideoDecoder.prototype.configure
    const decode = VideoDecoder.prototype.decode

    VideoDecoder.prototype.configure = function (config) {
      const raw = config.description
      configurations.push({
        codec: config.codec,
        ...(config.codedWidth === undefined ? {} : { codedWidth: config.codedWidth }),
        ...(config.codedHeight === undefined ? {} : { codedHeight: config.codedHeight }),
        description: raw ? raw.byteLength : 0,
      })
      return configure.call(this, config)
    }
    VideoDecoder.prototype.decode = function (chunk) {
      chunks.push({ type: chunk.type, timestamp: chunk.timestamp, bytes: chunk.byteLength })
      return decode.call(this, chunk)
    }
    Object.defineProperty(window, 'tcDecoderAudit', {
      get: () => ({ configurations, chunks }),
    })
  })
}

async function refuseAllEncoders(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(VideoEncoder, 'isConfigSupported', {
      configurable: true,
      value: async (config: VideoEncoderConfig): Promise<VideoEncoderSupport> => ({
        supported: false,
        config,
      }),
    })
  })
}

const encodeCalls = (editor: Page): Promise<number> =>
  editor.evaluate(() => (window as unknown as { tcEncodeCalls: number }).tcEncodeCalls)

interface LanePeak {
  copy: number
  encode: number
}

async function observeLanePeaks(editor: Page): Promise<void> {
  await editor.evaluate(() => {
    const state = window as unknown as {
      tcLanePeaks?: Array<{ copy: number; encode: number }>
      tcLaneObserver?: MutationObserver
    }
    state.tcLaneObserver?.disconnect()
    state.tcLanePeaks = []
    const note = () => {
      const peak = { copy: 0, encode: 0 }
      for (const row of document.querySelectorAll<HTMLElement>('.tc-job')) {
        if (row.querySelector('[data-testid="job-state"]')?.textContent !== 'Writing') continue
        const progress = row.querySelector('.muted')?.textContent ?? ''
        if (/frames/.test(progress)) peak.encode += 1
        else peak.copy += 1
      }
      state.tcLanePeaks!.push(peak)
    }
    state.tcLaneObserver = new MutationObserver(note)
    state.tcLaneObserver.observe(document.querySelector('.tc-jobs')!, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    note()
  })
}

async function lanePeaks(editor: Page): Promise<LanePeak> {
  return editor.evaluate(() => {
    const state = window as unknown as {
      tcLanePeaks?: Array<{ copy: number; encode: number }>
      tcLaneObserver?: MutationObserver
    }
    state.tcLaneObserver?.disconnect()
    return (state.tcLanePeaks ?? []).reduce(
      (peak, one) => ({ copy: Math.max(peak.copy, one.copy), encode: Math.max(peak.encode, one.encode) }),
      { copy: 0, encode: 0 },
    )
  })
}

function measuredPsnr(cropped: string, original: string, comparison: string): number {
  const run = spawnSync(
    'ffmpeg',
    [
      '-v', 'info',
      '-i', cropped,
      '-i', original,
      '-filter_complex', comparison,
      '-f', 'null', '-',
    ],
    { encoding: 'utf8' },
  )
  expect(run.error).toBeUndefined()
  expect(run.status, run.stderr).toBe(0)
  const matches = [...run.stderr.matchAll(/average:([0-9.]+)/g)]
  expect(matches, `ffmpeg did not report PSNR:\n${run.stderr}`).not.toHaveLength(0)
  return Number(matches.at(-1)![1])
}

function promisedFrames(progress: string[]): number {
  const totals = progress.flatMap((line) => {
    const match = line.match(/\d+ of (\d+) frames/)
    return match ? [Number(match[1])] : []
  })
  expect(totals, 'the queue never stated its frame total').not.toHaveLength(0)
  expect(new Set(totals).size, 'the queue changed its frame total during one job').toBe(1)
  return totals[0]!
}

function colourSignal(file: string): Record<string, string> {
  const run = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=color_primaries,color_transfer,color_space,color_range',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )
  expect(run.error).toBeUndefined()
  expect(run.status, run.stderr).toBe(0)
  return (JSON.parse(run.stdout) as { streams: Array<Record<string, string>> }).streams[0]!
}

function child(data: Uint8Array, parent: Box, type: string): Box | undefined {
  return childBoxes(data, parent).find((box) => box.type === type)
}

function trackKind(data: Uint8Array, track: Box): TrackKind | null {
  const mdia = child(data, track, 'mdia')
  const handler = mdia && child(data, mdia, 'hdlr')
  if (!handler) return null
  const body = boxBody(data, handler)
  const name = String.fromCharCode(body[8]!, body[9]!, body[10]!, body[11]!)
  return name === 'vide' ? 'video' : name === 'soun' ? 'audio' : null
}

function editLists(data: Uint8Array): Map<TrackKind, boolean> {
  const moov = topLevelBoxes(data).find((box) => box.type === 'moov')
  expect(moov, 'the saved MP4 has no movie box').toBeDefined()
  const edits = new Map<TrackKind, boolean>()
  for (const track of childBoxes(data, moov!).filter((box) => box.type === 'trak')) {
    const kind = trackKind(data, track)
    if (!kind) continue
    const edts = child(data, track, 'edts')
    edits.set(kind, edts !== undefined && child(data, edts, 'elst') !== undefined)
  }
  return edits
}

function packetPts(file: string): number[] {
  const run = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_packets',
      '-show_entries', 'packet=pts_time',
      '-of', 'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  )
  expect(run.error).toBeUndefined()
  expect(run.status, run.stderr).toBe(0)
  return run.stdout.split('\n').map(Number).filter(Number.isFinite)
}

function streamStarts(file: string): Map<TrackKind, number> {
  const run = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,start_time',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  )
  expect(run.error).toBeUndefined()
  expect(run.status, run.stderr).toBe(0)
  const streams = (JSON.parse(run.stdout) as {
    streams: Array<{ codec_type: TrackKind; start_time: string }>
  }).streams
  return new Map(streams.map((stream) => [stream.codec_type, Number(stream.start_time)]))
}

async function timingOf(from: string, out: string): Promise<{ firstVideoPts: number; skew: number }> {
  const { context, editor } = await openClip(from, out)
  try {
    const saved = await exportClipWith(editor, { mode: 'optimize' })
    const firstVideoPts = packetPts(saved.file)[0]!
    const starts = streamStarts(saved.file)
    return {
      firstVideoPts,
      skew: Math.abs(starts.get('video')! - starts.get('audio')!),
    }
  } finally {
    await context.close()
  }
}

async function cropShownBy(editor: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return editor.getByTestId('crop-box').evaluate((box) => {
    const element = box as HTMLElement
    const source = { width: 256, height: 144 }
    const fromPercent = (value: string, extent: number): number =>
      Math.round((Number.parseFloat(value) * extent) / 100)
    return {
      x: fromPercent(element.style.left, source.width),
      y: fromPercent(element.style.top, source.height),
      width: fromPercent(element.style.width, source.width),
      height: fromPercent(element.style.height, source.height),
    }
  })
}

test('sends an uncropped Optimize clip through the frame path', async () => {
  test.setTimeout(180_000)
  const { context, editor } = await openClip('00:00:00:00', '00:00:02:00')

  try {
    const saved = await exportClipWith(editor, { mode: 'optimize' })
    expect(saved.progress, 'Optimize never reported work in frames').not.toHaveLength(0)

    const file = probeFile(saved.file)
    expect(file.streams.map((stream) => [stream.codec_type, stream.codec_name])).toEqual([
      ['video', 'h264'],
      ['audio', 'aac'],
    ])
    expect(file.streams[0]).toMatchObject({ width: 256, height: 144 })
  } finally {
    await context.close()
  }
})

test('decodes AV1 when dependency metadata omits the non-sync bit', async () => {
  test.setTimeout(180_000)
  const { context, extensionId } = await launchWithExtension()
  const player = await context.newPage()

  try {
    await routeLocal(player, 'codecs.html', PLAYER_URL)
    let rewrittenChunks = 0
    await player.route('**/fixtures/av1/chunk-stream0-*.m4s', async (route) => {
      const name = new URL(route.request().url()).pathname.replace('/fixtures/', '')
      rewrittenChunks += 1
      await route.fulfill({
        body: av1WithDependencyOnly(`tests/fixtures/${name}`),
        contentType: 'video/mp4',
      })
    })

    const feed = [{
      mime: 'video/mp4; codecs="av01.0.00M.08"',
      init: '/fixtures/av1/init-stream0.m4s',
      chunks: [1, 2, 3].map((n) => `/fixtures/av1/chunk-stream0-0000${n}.m4s`),
    }]
    await player.goto(`${PLAYER_URL}#${encodeURIComponent(JSON.stringify(feed))}`)
    await player.waitForFunction(() => (window as unknown as { allAppended?: boolean }).allAppended)
    expect(rewrittenChunks).toBe(3)
    await player.evaluate(() => document.querySelector('video')!.play())
    await player.waitForTimeout(7_000)

    const { editor } = await clickEdit(context, player, extensionId)
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
    await typeInto(editor, 'playhead-field', '00:00:01:05')
    await editor.keyboard.press('i')

    const saved = await exportClipWith(editor, { mode: 'optimize' })
    expect(saved.progress, 'AV1 never reached the decoder and encoder').not.toHaveLength(0)
    expect(probeFile(saved.file).streams[0]!.codec_name).toBe('h264')
  } finally {
    await context.close()
  }
})

test('decodes VP9 when HLS metadata leaves every sample dependency unknown', async () => {
  test.setTimeout(180_000)
  const { context, extensionId } = await launchWithExtension()
  await installVp9KeyAudit(context)
  const player = await context.newPage()

  try {
    await routeLocal(player, 'codecs.html', PLAYER_URL)
    let rewrittenChunks = 0
    await player.route('**/fixtures/vp9/chunk-stream0-*.m4s', async (route) => {
      const name = new URL(route.request().url()).pathname.replace('/fixtures/', '')
      rewrittenChunks += 1
      await route.fulfill({
        body: withoutSampleFlags(`tests/fixtures/${name}`),
        contentType: 'video/mp4',
      })
    })

    const feed = [{
      mime: 'video/mp4; codecs="vp09.00.20.08"',
      init: '/fixtures/vp9/init-stream0.m4s',
      chunks: [1, 2].map((n) => `/fixtures/vp9/chunk-stream0-0000${n}.m4s`),
    }]
    await player.goto(`${PLAYER_URL}#${encodeURIComponent(JSON.stringify(feed))}`)
    await player.waitForFunction(() => (window as unknown as { allAppended?: boolean }).allAppended)
    expect(rewrittenChunks).toBe(2)
    await player.evaluate(() => document.querySelector('video')!.play())
    await player.waitForTimeout(7_000)

    const { editor } = await clickEdit(context, player, extensionId)
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
    await typeInto(editor, 'playhead-field', '00:00:01:00')
    await editor.keyboard.press('i')

    const saved = await exportClipWith(editor, { mode: 'optimize' })
    expect(saved.progress, 'VP9 never reached the decoder and encoder').not.toHaveLength(0)
    const audit = await editor.evaluate(() =>
      (window as unknown as { tcVp9KeyAudit: { chunks: number; falseKeys: number } }).tcVp9KeyAudit,
    )
    expect(audit.chunks, 'the VP9 fixture never reached VideoDecoder').toBeGreaterThan(0)
    expect(audit.falseKeys, 'a VP9 delta frame was mislabeled as a decoder entry point').toBe(0)
    expect(probeFile(saved.file).streams[0]!.codec_name).toBe('h264')
  } finally {
    await context.close()
  }
})

test('encodes a clip entirely inside the retained run after a media gap', async () => {
  test.setTimeout(180_000)
  const { context, extensionId } = await launchWithExtension()
  await installDecoderAudit(context)
  const player = await context.newPage()

  try {
    await routeLocal(player, 'codecs.html', PLAYER_URL)
    const feed = [
      {
        mime: 'video/mp4; codecs="avc1.4d400d"',
        init: '/fixtures/h264/init-stream0.m4s',
        // Segment two is absent. Segment three is a separately decodable retained run.
        chunks: [1, 3].map((n) => `/fixtures/h264/chunk-stream0-0000${n}.m4s`),
      },
      {
        mime: 'audio/mp4; codecs="mp4a.40.2"',
        init: '/fixtures/h264/init-stream1.m4s',
        chunks: [1, 3, 4].map((n) => `/fixtures/h264/chunk-stream1-0000${n}.m4s`),
      },
    ]
    await player.goto(`${PLAYER_URL}#${encodeURIComponent(JSON.stringify(feed))}`)
    await player.waitForFunction(() => (window as unknown as { allAppended?: boolean }).allAppended)
    await player.evaluate(() => {
      const video = document.querySelector('video')!
      video.currentTime = 4.25
      return video.play()
    })
    await player.waitForFunction(() => document.querySelector('video')!.currentTime >= 5.5)

    const { editor } = await clickEdit(context, player, extensionId)
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
    await typeInto(editor, 'playhead-field', '00:00:04:06')
    await editor.keyboard.press('i')
    await typeInto(editor, 'out-c1', '00:00:05:12')

    const saved = await exportClipWith(editor, {
      mode: 'optimize',
      beforeExport: async (page) => {
        await expect(page.getByTestId('cost-c1')).toContainText('Re-encoded as')
      },
    })
    const audit = await editor.evaluate(() =>
      (window as unknown as {
        tcDecoderAudit: {
          configurations: Array<{
            codec: string
            codedWidth?: number
            codedHeight?: number
            description: number
          }>
          chunks: Array<{ type: EncodedVideoChunkType; timestamp: number; bytes: number }>
        }
      }).tcDecoderAudit,
    )

    expect(audit.configurations).toEqual([
      { codec: 'avc1.4d400d', codedWidth: 320, codedHeight: 240, description: 40 },
    ])
    expect(audit.chunks.length, 'the later retained run never reached VideoDecoder').toBeGreaterThan(0)
    expect(audit.chunks[0]).toMatchObject({ type: 'key' })
    expect(audit.chunks[0]!.bytes).toBeGreaterThan(0)
    expect(audit.chunks.every((chunk) => Number.isSafeInteger(chunk.timestamp))).toBe(true)
    // Source run three begins four seconds into the session. Decoder transport is rebased onto
    // the planned clip, so neither the gap nor its absolute session time reaches WebCodecs.
    expect(Math.max(...audit.chunks.map((chunk) => chunk.timestamp))).toBeLessThan(2_000_000)
    expect(probeFile(saved.file).streams.map((stream) => stream.codec_name)).toEqual(['h264', 'aac'])
  } finally {
    await context.close()
  }
})

test('cuts the selected pixels instead of scaling the whole picture into the crop', async () => {
  test.setTimeout(240_000)
  const { context, editor } = await openClip('00:00:02:00', '00:00:04:00')

  try {
    const original = await exportClipWith(editor, { mode: 'original' })
    const cropped = await exportClipWith(editor, {
      crop: { x: 48, y: 28, width: 160, height: 90 },
    })
    await expect(editor.getByTestId('crop-geometry')).toHaveText('160 × 90')

    const file = probeFile(cropped.file)
    const video = file.streams.find((stream) => stream.codec_type === 'video')!
    expect(video).toMatchObject({ codec_name: 'h264', width: 160, height: 90 })
    expect(file.streams.find((stream) => stream.codec_type === 'audio')?.codec_name).toBe('aac')
    expect(Number(video.nb_read_frames)).toBe(promisedFrames(cropped.progress))
    expect(Number(file.format.duration)).toBeCloseTo(2, 1)

    const cut = measuredPsnr(
      cropped.file,
      original.file,
      '[1:v]crop=160:90:48:28[cut];[0:v][cut]psnr',
    )
    const scaled = measuredPsnr(
      cropped.file,
      original.file,
      '[1:v]scale=160:90[squash];[0:v][squash]psnr',
    )
    console.log(`crop PSNR: cut=${cut.toFixed(3)} dB, scaled=${scaled.toFixed(3)} dB`)
    expect(
      cut - scaled,
      `crop ${cut.toFixed(3)} dB, scaled whole frame ${scaled.toFixed(3)} dB`,
    ).toBeGreaterThan(20)

    const bytes = new Uint8Array(readFileSync(cropped.file))
    expect(videoSampleEntry(bytes)?.children.has('colr')).toBe(true)
    expect(colourSignal(cropped.file)).toMatchObject({
      color_primaries: 'bt709',
      color_transfer: 'bt709',
      color_space: 'bt709',
      color_range: 'tv',
    })
    expect(editLists(bytes)).toEqual(new Map<TrackKind, boolean>([
      ['video', false],
      ['audio', true],
    ]))
  } finally {
    await context.close()
  }
})

test('starts encoded picture at zero and in step with sound at and between keyframes', async () => {
  test.setTimeout(300_000)
  const keyframe = await timingOf('00:00:02:00', '00:00:04:00')
  const midGroup = await timingOf('00:00:03:00', '00:00:05:00')

  expect({ keyframe: keyframe.firstVideoPts, midGroup: midGroup.firstVideoPts }).toEqual({
    keyframe: 0,
    midGroup: 0,
  })
  expect(keyframe.skew).toBeLessThan(FRAME_SECONDS)
  expect(midGroup.skew).toBeLessThan(FRAME_SECONDS)
})

test('normalizes an odd pointer crop before constructing real video frames', async () => {
  test.setTimeout(180_000)
  const { context, editor } = await openClip('00:00:02:00', '00:00:04:00')

  try {
    const saved = await exportClipWith(editor, {
      crop: { x: 7, y: 5, width: 121, height: 65 },
      timeoutMs: 20_000,
    })
    await expect(editor.getByTestId('crop-geometry')).toHaveText('120 × 64')
    expect(await cropShownBy(editor)).toEqual({ x: 6, y: 4, width: 120, height: 64 })
    expect(probeFile(saved.file).streams.find((stream) => stream.codec_type === 'video')).toMatchObject({
      width: 120,
      height: 64,
    })
    await expect(editor.getByTestId('job-state').last()).toHaveText('Saved')
  } finally {
    await context.close()
  }
})

test('cancels the real encoder after Writing while a copy beside it still saves', async () => {
  test.setTimeout(180_000)
  const { context, editor } = await openClip(
    '00:00:00:00',
    '00:00:20:00',
    installEncodeCounter,
  )

  try {
    await splitAt(editor, '00:00:02:00', 2)
    await editor.getByTestId('mode-c2').selectOption('optimize')
    await expect(editor.getByTestId('export')).toBeEnabled()

    let downloads = 0
    editor.on('download', () => {
      downloads += 1
    })
    await editor.getByTestId('export').click()

    const encodeRow = editor.getByTestId('job').nth(1)
    await expect(encodeRow.getByTestId('job-state')).toHaveText('Writing')
    await expect.poll(() => encodeCalls(editor)).toBeGreaterThan(0)
    await encodeRow.getByRole('button', { name: 'Cancel' }).click()
    await expect(encodeRow.getByTestId('job-state')).toHaveText('Cancelled')
    const stoppedAt = await encodeCalls(editor)

    await editor.waitForTimeout(750)
    expect(await encodeCalls(editor)).toBe(stoppedAt)
    await expect(editor.getByTestId('job').first().getByTestId('job-state')).toHaveText('Saved')
    await expect.poll(() => downloads).toBe(1)
    await editor.waitForTimeout(2_000)
    expect(downloads, 'the cancelled encode downloaded a late file').toBe(1)
  } finally {
    await context.close()
  }
})

test('runs three copies beside one encode without either lane blocking the other', async () => {
  test.setTimeout(240_000)
  const { context, editor } = await openClip('00:00:00:00', '00:00:06:00')

  try {
    await splitAt(editor, '00:00:01:00', 2)
    await splitAt(editor, '00:00:02:00', 3)
    await splitAt(editor, '00:00:03:00', 4)
    await splitAt(editor, '00:00:04:00', 5)
    await splitAt(editor, '00:00:05:00', 6)
    await editor.getByTestId('clip-go-c5').click()
    await expect(editor.getByTestId('mode-c5')).toBeVisible()
    await editor.getByTestId('mode-c5').selectOption('optimize')
    await editor.getByTestId('clip-go-c6').click()
    await expect(editor.getByTestId('mode-c6')).toBeVisible()
    await editor.getByTestId('mode-c6').selectOption('optimize')
    await expect(editor.getByTestId('export')).toBeEnabled()

    await observeLanePeaks(editor)
    await collectDownloads(editor, 6, () => editor.getByTestId('export').click(), 180_000)
    await expect(editor.getByTestId('job')).toHaveCount(6)
    await expect(editor.getByTestId('job-state')).toHaveText(Array(6).fill('Saved'))

    expect(await lanePeaks(editor)).toEqual({ copy: 3, encode: 1 })
  } finally {
    await context.close()
  }
})

test('drops an unsupported crop and copies without asking the encoder again', async () => {
  test.setTimeout(180_000)
  const { context, editor } = await openClip(
    '00:00:00:00',
    '00:00:02:00',
    refuseAllEncoders,
  )

  try {
    await placeCrop(editor, { x: 48, y: 28, width: 160, height: 90 })
    await expect(editor.getByTestId('crop-geometry')).toHaveText('160 × 90')
    await expect(editor.getByTestId('cost-c1')).toContainText(
      'no encoder for 160 × 90 at 10 fps',
    )

    await editor.getByTestId('drop-crop-c1').click()
    await expect(editor.getByTestId('crop-geometry')).toHaveText('256 × 144')
    await expect(editor.getByTestId('mode-c1')).toHaveValue('original')
    await expect(editor.getByTestId('cost-c1')).toContainText('Copied from the recording as it is')

    const saved = await exportClipWith(editor, { timeoutMs: 60_000 })
    expect(probeFile(saved.file).streams.map((stream) => stream.codec_name)).toEqual(['h264', 'aac'])
  } finally {
    await context.close()
  }
})
