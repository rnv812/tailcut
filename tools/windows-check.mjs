/**
 * The Windows hardware leg cannot be a Playwright project in WSL:
 *
 * - the Windows launch loses Playwright's fd 3/4 control pipe, so this attaches over CDP;
 * - Chrome stable 137+ ignores command-line extension loading, so Chrome for Testing is required;
 * - Chrome for Testing and stable expose different hardware codec matrices, so stable remains a
 *   separate manual check;
 * - an attached context has no acceptDownloads setting, so Browser.setDownloadBehavior must name
 *   a native Windows path that WSL reads back through /mnt/c.
 *
 * Browser.close is sent over CDP and the exact Windows PID and port are observed afterwards.
 * `browser.close()` would only detach and leave the browser behind.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build as esbuild } from 'esbuild'
import { chromium } from '@playwright/test'

const execFile = promisify(execFileCallback)

const MATRIX_GEOMETRIES = [
  { width: 640, height: 360, framerate: 30 },
  { width: 640, height: 360, framerate: 60 },
  { width: 1280, height: 720, framerate: 30 },
  { width: 1280, height: 720, framerate: 60 },
  { width: 1920, height: 1080, framerate: 30 },
  { width: 1920, height: 1080, framerate: 60 },
  { width: 3840, height: 2160, framerate: 30 },
  { width: 3840, height: 2160, framerate: 60 },
]

/** Converts a WSL-mounted drive path to the native path Chrome receives. */
export function toWindowsPath(input) {
  if (/^(?:\\\\|\/\/)/.test(input)) {
    throw new Error('UNC paths cannot be used to load a Chrome extension.')
  }

  const matched = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(input)
  if (!matched) throw new Error('Expected a path below /mnt/<drive>/.')

  const drive = matched[1].toUpperCase()
  const rest = matched[2] ?? ''
  return `${drive}:\\${rest.replaceAll('/', '\\')}`
}

const windowsPath = (value) => value.replaceAll('/', '\\').replace(/\\+$/, '')

/** Refuses any work root broader than one uniquely named run below Temp/tailcut. */
export function assertSafeRunRoot(runRoot, tempRoot) {
  const run = windowsPath(runRoot)
  const temp = windowsPath(tempRoot)
  const prefix = `${temp}\\tailcut\\`

  if (!run.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error('The run root must be a unique directory below Windows Temp\\tailcut.')
  }

  const unique = run.slice(prefix.length)
  if (!unique || unique.includes('\\') || unique === '.' || unique === '..') {
    throw new Error('The run root must name one unique run, not a broad Temp root.')
  }
}

/** Builds the matrix from the actual ladder supplied by the codec bundle. */
export function probeMatrix(ladder) {
  return MATRIX_GEOMETRIES.flatMap((geometry) =>
    ladder(geometry, { codec: 'hevc', quality: 'high' }).map((rung) => ({
      ...geometry,
      kind: rung.choice.kind,
      config: rung.config,
    })),
  )
}

/** Loads ladderFor through the bundler seam before asking it for any configuration. */
export async function probeMatrixFromBundle(bundle) {
  const ladder = await bundle({
    module: fileURLToPath(new URL('../src/core/encode/codec.ts', import.meta.url)),
    export: 'ladderFor',
  })
  return probeMatrix(ladder)
}

/** Bundles the production ladder into a script that an extension page can execute. */
export async function buildLadderBundle(build = esbuild) {
  const codec = fileURLToPath(new URL('../src/core/encode/codec.ts', import.meta.url))
  const result = await build({
    stdin: {
      contents: "import { ladderFor } from './codec.ts'\nglobalThis.tailcutLadderFor = ladderFor",
      loader: 'ts',
      resolveDir: dirname(codec),
      sourcefile: 'windows-check-ladder.ts',
    },
    bundle: true,
    format: 'iife',
    metafile: true,
    platform: 'browser',
    target: 'chrome120',
    write: false,
  })
  const output = result.outputFiles?.[0]
  if (!output) throw new Error('esbuild produced no codec ladder script.')
  return {
    inputs: Object.keys(result.metafile?.inputs ?? {}),
    script: output.text,
  }
}

/** A deterministic minute suitable for a hardware encode smoke run. */
export function generateMinuteCommand(output) {
  return [
    'ffmpeg',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1920x1080:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=48000',
    '-t',
    '60',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-movflags',
    '+faststart',
    output,
  ]
}

export function ffprobeCommand(input) {
  return ['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', input]
}

export function ffprobeExportCommand(input) {
  return [
    'ffprobe',
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-show_packets',
    '-of',
    'json',
    input,
  ]
}

export function ffmpegDecodeCommand(input) {
  return ['ffmpeg', '-v', 'error', '-i', input, '-f', 'null', '-']
}

/** Holds an input to the geometry and duration its label promises. */
export function validateInput(kind, probe, decode) {
  if (decode.status !== 0) throw new Error('The input failed a full ffmpeg decode.')

  const video = probe.streams.find((stream) => stream.type === 'video')
  if (!video) throw new Error('The input has no video stream.')

  const expected = kind === '4k'
    ? { width: 3840, height: 2160, seconds: 10 }
    : { width: 1920, height: 1080, seconds: 60 }

  if (video.width !== expected.width || video.height !== expected.height) {
    throw new Error(`The ${kind} input must be exactly ${expected.width} x ${expected.height}.`)
  }
  if (probe.duration < expected.seconds) {
    throw new Error(`The ${kind} input must contain at least ${expected.seconds} seconds.`)
  }
  if (!probe.streams.some((stream) => stream.type === 'audio')) {
    throw new Error(`The ${kind} input must contain audio sound.`)
  }
  if (kind === '4k' && Math.abs((video.fps ?? 0) - 30) > 0.001) {
    throw new Error('The 4K input must be exactly 30 fps.')
  }
}

const rangeFailure = (size) => ({
  status: 416,
  headers: {
    'accept-ranges': 'bytes',
    'content-range': `bytes */${size}`,
    'content-length': '0',
  },
  body: new Uint8Array(),
})

/** Computes one HTTP response without binding a port or reading a file. */
export function rangedResponse(bytes, range) {
  const size = bytes.byteLength
  if (range === undefined) {
    return {
      status: 200,
      headers: { 'accept-ranges': 'bytes', 'content-length': String(size) },
      body: bytes,
    }
  }

  const matched = /^bytes=(\d+)-(\d*)$/.exec(range)
  if (!matched) return rangeFailure(size)

  const from = Number(matched[1])
  const to = matched[2] === '' ? size - 1 : Math.min(Number(matched[2]), size - 1)
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= size || to < from) {
    return rangeFailure(size)
  }

  const body = bytes.slice(from, to + 1)
  return {
    status: 206,
    headers: {
      'accept-ranges': 'bytes',
      'content-range': `bytes ${from}-${to}/${size}`,
      'content-length': String(body.byteLength),
    },
    body,
  }
}

const byteRange = (range, size) => {
  if (range === undefined) return null
  const matched = /^bytes=(\d+)-(\d*)$/.exec(range)
  if (!matched) return false
  const from = Number(matched[1])
  const to = matched[2] === '' ? size - 1 : Math.min(Number(matched[2]), size - 1)
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= size || to < from) {
    return false
  }
  return { from, to }
}

/** Serves only named media files and streams byte ranges from disk. */
export async function createMediaServer(files, options = {}) {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  const artifacts = new Map()
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${host}`)
      const player = /^\/player\/([^/]+)$/.exec(url.pathname)
      if (player && request.method === 'GET') {
        const key = decodeURIComponent(player[1])
        if (!files[key]) {
          response.writeHead(404).end()
          return
        }
        const body = Buffer.from(`<!doctype html>
<meta charset="utf-8">
<title>tailcut Windows check</title>
<style>html,body{margin:0;background:#111}video{display:block;width:min(100vw,1920px);height:auto}</style>
<video controls muted playsinline src="/media/${encodeURIComponent(key)}"></video>`)
        response.writeHead(200, {
          'content-length': String(body.byteLength),
          'content-type': 'text/html; charset=utf-8',
        }).end(body)
        return
      }

      const media = /^\/media\/([^/]+)$/.exec(url.pathname)
      const artifact = /^\/artifact\/([^/]+)$/.exec(url.pathname)
      const key = media?.[1] ?? artifact?.[1]
      const file = media
        ? files[decodeURIComponent(key)]
        : artifact
          ? artifacts.get(decodeURIComponent(key))
          : undefined
      if (!file || request.method !== 'GET') {
        response.writeHead(404).end()
        return
      }

      const { size } = await stat(file)
      const requested = byteRange(request.headers.range, size)
      if (requested === false) {
        response.writeHead(416, {
          'accept-ranges': 'bytes',
          'access-control-allow-origin': '*',
          'content-range': `bytes */${size}`,
          'content-length': '0',
        }).end()
        return
      }

      if (requested === null) {
        response.writeHead(200, {
          'accept-ranges': 'bytes',
          'access-control-allow-origin': '*',
          'content-length': String(size),
          'content-type': artifact ? 'image/webp' : 'video/mp4',
        })
        createReadStream(file).on('error', (error) => response.destroy(error)).pipe(response)
        return
      }

      response.writeHead(206, {
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
        'content-range': `bytes ${requested.from}-${requested.to}/${size}`,
        'content-length': String(requested.to - requested.from + 1),
        'content-type': artifact ? 'image/webp' : 'video/mp4',
      })
      createReadStream(file, { start: requested.from, end: requested.to })
        .on('error', (error) => response.destroy(error))
        .pipe(response)
    } catch (error) {
      response.destroy(error)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('The ranged media server has no TCP address.')
  }
  return {
    origin: `http://${host}:${address.port}`,
    exposeArtifact(key, file) {
      if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new Error('Artifact keys must be path-safe.')
      artifacts.set(key, file)
      return `http://${host}:${address.port}/artifact/${encodeURIComponent(key)}`
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

/** The four arguments without which the attached Chrome run is not the requested run. */
export function chromeLaunchArgs(options) {
  return [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.profileWindows}`,
    `--disable-extensions-except=${options.extensionWindows}`,
    `--load-extension=${options.extensionWindows}`,
  ]
}

export async function closeAttachedBrowser(cdp, _browser) {
  await cdp.send('Browser.close')
}

/** Owns only the server and process created for this run. */
export async function startBrowserSession(options, dependencies) {
  if (!(await dependencies.portIsFree(options.port))) {
    throw new Error(`CDP port ${options.port} is occupied.`)
  }

  let server
  let process
  try {
    server = await dependencies.openServer(options)
    process = await dependencies.spawn(options.chrome, chromeLaunchArgs(options))
    const attached = await dependencies.attach(options.port)
    let closed = false

    return {
      ...attached,
      async close() {
        if (closed) return
        closed = true
        let failure
        try {
          await closeAttachedBrowser(attached.cdp, attached.browser)
        } catch (error) {
          failure = error
        }
        if (!failure && process?.pid !== undefined && dependencies.waitForExit) {
          try {
            if (!(await dependencies.waitForExit(process.pid, options.port))) {
              failure = new Error(`Windows Chrome PID ${process.pid} did not exit after Browser.close.`)
            }
          } catch (error) {
            failure = error
          }
        }
        if (failure && process?.pid !== undefined && dependencies.kill) {
          try {
            await dependencies.kill(process.pid)
          } catch (killError) {
            failure = new AggregateError(
              [failure, killError],
              `Browser.close failed and killing Windows PID ${process.pid} also failed.`,
            )
          }
        }
        try {
          await server.close()
        } catch (serverError) {
          failure = failure
            ? new AggregateError([failure, serverError], 'Closing the browser and its server failed.')
            : serverError
        }
        if (failure) throw failure
      },
    }
  } catch (error) {
    if (process?.pid !== undefined && dependencies.kill) await dependencies.kill(process.pid)
    if (server) await server.close()
    throw error
  }
}

/** Advances by the media element's current time and never by its buffered range. */
export async function driveWatchedMedia(media, options) {
  const rate = Math.min(8, Math.max(1, options.targetSeconds / 7))
  await media.setPlaybackRate(rate)
  await media.play()

  if (await media.currentTime() >= options.targetSeconds) return
  for (let poll = 0; poll < options.maxPolls; poll += 1) {
    await media.waitFrame()
    if (await media.currentTime() >= options.targetSeconds) return
  }

  throw new Error(`Playback did not reach ${options.targetSeconds} seconds of watched media time.`)
}

export function assertWatchedOut(outSeconds) {
  if (outSeconds < 59) throw new Error('The editor Out field must reach at least 59 seconds.')
}

/** Places a per-run nonce into a copy without changing the source manifest object. */
export function stampExtensionIdentity(manifest, nonce) {
  return {
    ...manifest,
    background: manifest.background ? { ...manifest.background } : manifest.background,
    tailcut_run_nonce: nonce,
  }
}

export function verifyExtensionIdentity(candidates, expected) {
  const matches = candidates.filter((candidate) => {
    let workerPath
    try {
      workerPath = new URL(candidate.workerUrl).pathname
    } catch {
      return false
    }
    return workerPath === expected.workerPath &&
      candidate.name === expected.name &&
      candidate.version === expected.version &&
      candidate.nonce === expected.nonce
  })

  if (matches.length !== 1) {
    throw new Error('Could not establish the exact extension identity for this run.')
  }
  return matches[0]
}

export function downloadBehavior(downloadPath) {
  if (!/^[a-zA-Z]:\\/.test(downloadPath)) {
    throw new Error('The browser download directory must be a native Windows path.')
  }
  return { behavior: 'allow', downloadPath, eventsEnabled: true }
}

export async function enableDownloads(cdp, downloadPath) {
  await cdp.send('Browser.setDownloadBehavior', downloadBehavior(downloadPath))
}

/** Resolves only after Chrome names a download and completes that same guid. */
export async function waitForDownload(events, deadline, options = {}) {
  const iterator = events[Symbol.asyncIterator]()
  const expired = Promise.resolve(deadline).then(
    () => { throw new Error('Download deadline expired.') },
    (error) => { throw error },
  )
  let begun

  while (true) {
    const next = await Promise.race([iterator.next(), expired])
    if (next.done) throw new Error('The download event stream ended before completion.')
    const event = next.value

    if (event.method === 'Browser.downloadWillBegin' && begun === undefined &&
        (options.expectedUrl === undefined || event.params.url === options.expectedUrl)) {
      begun = {
        guid: event.params.guid,
        suggestedFilename: event.params.suggestedFilename,
      }
      if (event.params.url !== undefined) begun.url = event.params.url
      continue
    }

    if (event.method !== 'Browser.downloadProgress' || event.params.guid !== begun?.guid) continue
    if (event.params.state === 'completed') {
      return event.params.filePath === undefined
        ? begun
        : { ...begun, filePath: event.params.filePath }
    }
    if (event.params.state === 'canceled') throw new Error('Chrome canceled the download.')
  }
}

/** Accepts only a browser-reported artifact immediately below this run's download directory. */
export function completedDownloadPath(downloadRoot, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Chrome completed the download without a file path.')
  }
  const root = resolve(fromWindowsPath(downloadRoot))
  const artifact = resolve(fromWindowsPath(filePath))
  if (dirname(artifact) !== root) {
    throw new Error('The completed artifact must be a direct child of the run download directory.')
  }
  return artifact
}

/** Ties Chrome's DownloadItem back to the exact call made by this Tailcut extension page. */
export function verifyDownloadIdentity(item, expected) {
  if (!item || item.id !== expected.downloadId || item.url !== expected.url ||
      item.state !== 'complete' || item.byExtensionId !== expected.extensionId) {
    throw new Error('The completed download does not have the expected Tailcut identity.')
  }
  return item
}

/** Confirms both browser APIs named the same non-empty native artifact and records its size. */
export async function inspectDownloadedArtifact(downloadRoot, cdpPath, itemPath, readStat = stat) {
  const path = completedDownloadPath(downloadRoot, cdpPath)
  const chromePath = completedDownloadPath(downloadRoot, itemPath)
  if (path !== chromePath) {
    throw new Error('CDP and chrome.downloads reported different artifact paths.')
  }
  const facts = await readStat(path)
  if (!Number.isSafeInteger(facts.size) || facts.size <= 0) {
    throw new Error('The completed download must contain a non-empty artifact.')
  }
  return { path, bytes: facts.size }
}

/** The three mandatory artifacts and the optional 4K hardware check. */
export function exportPlan(hasFourK) {
  return [
    {
      id: 'hevc-1080',
      required: true,
      format: 'mp4',
      mode: 'optimize',
      codec: 'hevc',
      width: 1920,
      height: 1080,
      duration: 60,
      expectedChoice: 'HEVC in hardware',
    },
    {
      id: 'crop-128x64',
      required: true,
      format: 'mp4',
      mode: 'optimize',
      codec: 'hevc',
      crop: { width: 128, height: 64 },
      duration: 60,
      expectedChoice: 'H.264 in software',
    },
    {
      id: 'webp-10s',
      required: true,
      format: 'webp',
      mode: 'optimize',
      duration: 10,
    },
    hasFourK
      ? {
          id: 'h264-4k',
          required: true,
          format: 'mp4',
          mode: 'optimize',
          codec: 'h264',
          width: 3840,
          height: 2160,
          duration: 10,
          expectedChoice: 'H.264 in hardware',
        }
      : {
          id: 'h264-4k',
          required: false,
          status: 'skipped',
          format: 'mp4',
          mode: 'optimize',
          codec: 'h264',
        },
  ]
}

/** The forced setting applied before an editor opens for that input. */
export function codecForEditor(kind) {
  const id = kind === '4k' ? 'h264-4k' : 'hevc-1080'
  const codec = exportPlan(kind === '4k').find((item) => item.id === id)?.codec
  if (codec !== 'hevc' && codec !== 'h264') {
    throw new Error(`The ${kind} editor has no forced codec in the export plan.`)
  }
  return codec
}

export function countBFrames(packets) {
  return packets.filter((packet) => Math.abs(packet.pts - packet.dts) > 1e-9).length
}

/** Turns ffprobe's raw stream and packet JSON into the export facts the oracle consumes. */
export function exportProbeFacts(probe) {
  const video = probe.streams.find((stream) => stream.codec_type === 'video')
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio')
  if (!video) throw new Error('ffprobe found no video stream in the export.')
  const packetsFor = (stream) => probe.packets
    .filter((packet) => packet.stream_index === stream.index)
    .map((packet) => ({ pts: Number(packet.pts_time), dts: Number(packet.dts_time) }))
  const packets = packetsFor(video)
  if (!packets.length || packets.some((packet) => !Number.isFinite(packet.pts) || !Number.isFinite(packet.dts))) {
    throw new Error('ffprobe returned no usable video packet timestamps.')
  }
  const audioPackets = audio ? packetsFor(audio) : []
  if (audio && (
    !audioPackets.length ||
    audioPackets.some((packet) => !Number.isFinite(packet.pts) || !Number.isFinite(packet.dts))
  )) {
    throw new Error('ffprobe returned no finite audio packet timing.')
  }
  const videoPts = [...new Set(packets.map((packet) => packet.pts))].sort((a, b) => a - b)
  const fps = rational(video.avg_frame_rate || video.r_frame_rate)
  const frameDuration = Number.isFinite(fps) && fps > 0
    ? 1 / fps
    : videoPts.slice(1).reduce((minimum, pts, index) => {
        const difference = pts - videoPts[index]
        return difference > 0 ? Math.min(minimum, difference) : minimum
      }, Number.POSITIVE_INFINITY)
  if (!Number.isFinite(frameDuration) || frameDuration <= 0) {
    throw new Error('ffprobe returned no finite video frame duration.')
  }
  const videoStart = videoPts[0]
  const audioStart = audio ? Math.min(...audioPackets.map((packet) => packet.pts)) : undefined
  return {
    width: video.width,
    height: video.height,
    duration: Number(probe.format.duration),
    hasAudio: audio !== undefined,
    codec: video.codec_name,
    level: video.level,
    firstVideoPts: videoStart,
    videoStart,
    audioStart,
    frameDuration,
    bFrames: countBFrames(packets),
  }
}

const requireChoice = (plan, probe) => {
  if (plan.expectedChoice && probe.selectedChoice !== plan.expectedChoice) {
    throw new Error(`Expected ${plan.expectedChoice}, got ${probe.selectedChoice}.`)
  }
}

const requireMp4 = (probe, { width, height, seconds, codec }) => {
  if (probe.width !== width || probe.height !== height) {
    throw new Error(`The export must be exactly ${width} x ${height}.`)
  }
  if (!String(probe.codec).toLowerCase().includes(codec)) {
    throw new Error(`The export must use ${codec.toUpperCase()}.`)
  }
  if (probe.duration < seconds) throw new Error(`The export must contain at least ${seconds} seconds.`)
  if (!probe.hasAudio) throw new Error('The MP4 export must contain audio sound.')
  if (!probe.decoded) throw new Error('The export failed a full decode.')
  if (Math.abs(probe.firstVideoPts) > 1e-6) throw new Error('The first video PTS must be zero.')
  const frameDuration = probe.frameDuration ?? 1 / 30
  if (!Number.isFinite(probe.videoStart) || !Number.isFinite(probe.audioStart) ||
      !Number.isFinite(frameDuration) || frameDuration <= 0) {
    throw new Error('The A/V start and frame duration must be finite.')
  }
  if (Math.abs(probe.videoStart - probe.audioStart) >= frameDuration) {
    throw new Error('The A/V start must differ by less than one frame.')
  }
}

export async function validateExport(plan, probe, dependencies) {
  if (plan.id === 'webp-10s') {
    const decoded = await dependencies.decodeWebp(probe.bytes)
    if (decoded.frames <= 1) throw new Error('The WebP must contain an animation, not one frame.')
    if (Math.abs(decoded.durationMs - 10_000) > 100) {
      throw new Error('The WebP animation must last 10 seconds (10,000 ms).')
    }
    return
  }

  requireChoice(plan, probe)
  if (plan.id === 'hevc-1080') {
    requireMp4(probe, { width: 1920, height: 1080, seconds: 60, codec: 'hevc' })
    return
  }
  if (plan.id === 'crop-128x64') {
    requireMp4(probe, { width: 128, height: 64, seconds: 60, codec: 'h264' })
    return
  }
  if (plan.id === 'h264-4k') {
    requireMp4(probe, { width: 3840, height: 2160, seconds: 10, codec: 'h264' })
    if (probe.level !== 51) throw new Error('The 4K H.264 export must use computed level 5.1.')
    return
  }
  throw new Error(`Unknown export oracle: ${plan.id}`)
}

/** Runs sequentially so every completed artifact reaches the partial report before a failure. */
export async function runExports(plan, dependencies) {
  const report = { status: 'running', exports: [] }
  let exitCode = 0

  try {
    for (const item of plan) {
      if (item.status === 'skipped') {
        report.exports.push(item)
        await dependencies.writeReport(report)
        continue
      }

      try {
        report.exports.push(await dependencies.exportOne(item))
        await dependencies.writeReport(report)
      } catch (error) {
        report.status = 'failed'
        report.exports.push({ id: item.id, status: 'failed', error: String(error) })
        exitCode = 1
        await dependencies.writeReport(report)
        break
      }
    }

    if (exitCode === 0) {
      report.status = 'passed'
      await dependencies.writeReport(report)
    }
    return { exitCode, report }
  } finally {
    await dependencies.closeBrowser()
  }
}

const valueAfter = (args, flag, fallback) => {
  const at = args.indexOf(flag)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback
}

const dryRunLines = (args) => {
  const chrome = valueAfter(args, '--chrome', '<Chrome for Testing path>')
  const dist = valueAfter(args, '--dist', 'dist')
  const media = valueAfter(args, '--media-1080', '<generated 1080p minute>')
  const work = valueAfter(args, '--work-root', '<Windows Temp>/tailcut/<unique-run>')
  const port = valueAfter(args, '--port', '9222')
  return [
    `Chrome for Testing: ${chrome}`,
    `Copy dist from ${dist} into ${work}/ext and stamp the run identity.`,
    `Use --media-1080 ${media}, or generate a 60-second 1080p H.264/AAC minute.`,
    `Serve the player and media through ranged HTTP with exact Range responses.`,
    `Refuse an occupied CDP port ${port}, then attach to Chrome.`,
    'Probe 24 real codec-ladder configurations.',
    'Export forced HEVC at 1080p, then verify HEVC in hardware.',
    'Export the exact 128 x 64 crop through H.264 in software.',
    'Export and decode an animated WebP lasting 10 seconds.',
    'Keep downloads under the run directory and inspect every completed file.',
    'Write a partial JSON report after every phase.',
    'Close the attached browser with Browser.close and close the ranged HTTP server.',
  ]
}

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const defaultWindowsPaths = () => {
  const user = process.env.USER || 'nikita'
  const tempWsl = `/mnt/c/Users/${user}/AppData/Local/Temp`
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  return {
    chrome: `${tempWsl}/tailcut-probe/cft/chrome-win64/chrome.exe`,
    tempWsl,
    windowsTemp: toWindowsPath(tempWsl),
    workRoot: `${tempWsl}/tailcut/${runId}`,
  }
}

const liveOptions = (args, defaults) => {
  const workRoot = valueAfter(args, '--work-root', defaults.workRoot).replace(/\/$/, '')
  const suppliedMedia = valueAfter(args, '--media-1080', undefined)
  return {
    chrome: valueAfter(args, '--chrome', defaults.chrome),
    dist: valueAfter(args, '--dist', defaults.dist ?? `${repositoryRoot}/dist`),
    media1080: suppliedMedia ?? `${workRoot}/media/minute.mp4`,
    generate1080: suppliedMedia === undefined,
    media4k: valueAfter(args, '--media-4k', undefined),
    workRoot,
    windowsTemp: defaults.windowsTemp,
    port: Number(valueAfter(args, '--port', '9222')),
  }
}

const assertMatrix = (rows) => {
  if (rows.length !== 24) throw new Error(`The codec matrix returned ${rows.length} rows, not 24.`)
  const kinds = new Set(rows.map((row) => row.kind))
  for (const required of ['hevc-hw', 'h264-hw', 'h264-sw']) {
    if (!kinds.has(required)) throw new Error(`The codec matrix omitted ${required}.`)
  }
}

const commandResult = async (command) => {
  try {
    const result = await execFile(command[0], command.slice(1), {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return { status: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      status: typeof error?.code === 'number' ? error.code : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
    }
  }
}

const rational = (value) => {
  const [left, right] = String(value ?? '').split('/').map(Number)
  return Number.isFinite(left) && Number.isFinite(right) && right !== 0 ? left / right : Number(value)
}

const probeInputFile = async (input) => {
  const result = await commandResult(ffprobeCommand(input))
  if (result.status !== 0) throw new Error(`ffprobe refused ${input}: ${result.stderr.trim()}`)
  const raw = JSON.parse(result.stdout)
  return {
    duration: Number(raw.format?.duration),
    streams: raw.streams.map((stream) => stream.codec_type === 'video'
      ? {
          type: 'video',
          width: stream.width,
          height: stream.height,
          fps: rational(stream.avg_frame_rate || stream.r_frame_rate),
        }
      : { type: stream.codec_type }),
  }
}

const portIsFree = (port) => new Promise((resolve, reject) => {
  // Do not prove this with a temporary listen. Under mirrored WSL networking that bind is gone
  // from Linux before Windows releases the same port, so Chrome starts immediately afterwards and
  // cannot open DevTools. A connect observes both hosts without taking ownership of the port.
  const probe = connectSocket({ host: '127.0.0.1', port })
  probe.once('connect', () => {
    probe.destroy()
    resolve(false)
  })
  probe.once('error', (error) => {
    probe.destroy()
    if (error?.code === 'ECONNREFUSED') resolve(true)
    else reject(error)
  })
})

const powershellQuote = (value) => `'${String(value).replaceAll("'", "''")}'`

const launchChrome = async (chrome, args) => {
  const complete = [
    ...args,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-allow-origins=*',
    'about:blank',
  ]
  // Start-Process gives back the Windows PID. A WSL child_process PID belongs to the interop shim;
  // killing it after a failed attach leaves the real Chrome and all of its children behind.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$arguments = @(${complete.map(powershellQuote).join(', ')})`,
    `$browser = Start-Process -FilePath ${powershellQuote(toWindowsPath(chrome))} -ArgumentList $arguments -PassThru`,
    '$browser.Id',
  ].join('; ')
  const result = await commandResult([
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
  if (result.status !== 0) throw new Error(`Starting Chrome for Testing failed: ${result.stderr.trim()}`)
  const pid = Number(result.stdout.trim().split(/\s+/).at(-1))
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Chrome returned an invalid Windows PID: ${result.stdout}`)
  return { pid }
}

const attachChrome = async (port) => {
  const address = `http://127.0.0.1:${port}`
  // Playwright's CDP bootstrap is an HTTP request. This machine has a loopback proxy and a
  // wildcard `127.*` exclusion that curl understands but Playwright's proxy matcher does not.
  // Name the two loopback hosts exactly or the request goes to the proxy and answers 502 while
  // the real Chrome is listening beside it.
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const entries = new Set((process.env[name] ?? '').split(',').filter(Boolean))
    entries.add('127.0.0.1')
    entries.add('localhost')
    process.env[name] = [...entries].join(',')
  }
  const deadline = Date.now() + 30_000
  let last
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(address)
      const context = browser.contexts()[0]
      if (!context) throw new Error('Chrome exposed no default browser context.')
      const cdp = await browser.newBrowserCDPSession()
      return { browser, context, cdp }
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`CDP did not answer on ${address}: ${String(last)}`)
}

const startLiveBrowser = (options) => startBrowserSession(options, {
  portIsFree,
  openServer: async () => ({ close: async () => undefined }),
  spawn: launchChrome,
  attach: attachChrome,
  waitForExit: async (pid, port) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const processResult = await commandResult([
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }`,
      ])
      if (processResult.status === 0 && await portIsFree(port)) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  },
  kill: async (pid) => {
    const result = await commandResult(['taskkill.exe', '/PID', String(pid), '/T', '/F'])
    if (result.status !== 0) {
      throw new Error(`Killing Windows Chrome PID ${pid} failed: ${result.stderr.trim()}`)
    }
  },
})

const extensionCandidates = async (session) => {
  let workers = session.context.serviceWorkers()
  if (!workers.length) {
    await session.context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => undefined)
    workers = session.context.serviceWorkers()
  }

  return Promise.all(workers.map(async (worker) => {
    let manifest = {}
    let nonce = null
    try {
      manifest = await worker.evaluate(() => chrome.runtime.getManifest())
      nonce = await worker.evaluate(async () => {
        const response = await fetch(chrome.runtime.getURL('windows-check-nonce.json'), {
          cache: 'no-store',
        })
        if (!response.ok) return null
        return (await response.json()).nonce ?? null
      })
    } catch {
      // A component extension is still a candidate, but one that cannot prove this run's nonce.
    }
    const url = new URL(worker.url())
    return {
      workerUrl: worker.url(),
      extensionId: url.hostname,
      name: manifest.name,
      version: manifest.version,
      nonce,
    }
  }))
}

const setExportSettings = async (session, codec) => {
  const page = await session.context.newPage()
  try {
    await page.goto(`chrome-extension://${session.identity.extensionId}/options/options.html`)
    await page.evaluate(async (selectedCodec) => {
      const { writeSettings } = await import('/shared/settings-store.js')
      await writeSettings((current) => ({
        ...current,
        export: {
          ...current.export,
          format: 'mp4',
          codec: selectedCodec,
          quality: 'high',
          askWhere: false,
        },
      }))
    }, codec)
  } finally {
    await page.close()
  }
}

const playWatchedMedia = async (kind, mediaUrl, session) => {
  const key = kind === '1080' ? 'minute.mp4' : '4k.mp4'
  const player = await session.context.newPage()
  await player.goto(`${session.mediaServer.origin}/player/${encodeURIComponent(key)}`)
  await player.waitForFunction(() => {
    const video = document.querySelector('video')
    return video && Number.isFinite(video.duration) && video.readyState >= 1
  }, undefined, { timeout: 30_000 })
  const duration = await player.locator('video').evaluate((video) => video.duration)
  const target = kind === '1080' ? Math.min(59.5, duration) : Math.min(9.5, duration)
  const video = player.locator('video')
  await driveWatchedMedia({
    setPlaybackRate: (rate) => video.evaluate((element, value) => {
      element.muted = true
      element.playbackRate = value
    }, rate),
    play: () => video.evaluate((element) => element.play()),
    currentTime: () => video.evaluate((element) => element.currentTime),
    waitFrame: () => player.waitForTimeout(100),
  }, { targetSeconds: target, maxPolls: 450 })
  await player.waitForTimeout(500)
  session.players ??= {}
  session.players[kind] = player
}

const secondsOfTimecode = (value, fps = 30) => {
  const matched = /^(\d+):(\d+):(\d+):(\d+)$/.exec(value.trim())
  if (!matched) throw new Error(`The editor returned an invalid timecode: ${value}`)
  return Number(matched[1]) * 3600 + Number(matched[2]) * 60 + Number(matched[3]) + Number(matched[4]) / fps
}

const openEditor = async (kind, session) => {
  await setExportSettings(session, codecForEditor(kind))
  const player = session.players?.[kind]
  if (!player) throw new Error(`No watched ${kind} player is available.`)

  const popup = await session.context.newPage()
  await player.bringToFront()
  await popup.goto(`chrome-extension://${session.identity.extensionId}/popup/popup.html`)
  await popup.getByTestId('duration').waitFor({ state: 'visible', timeout: 15_000 })
  const opened = session.context.waitForEvent('page')
  await popup.getByTestId('edit').click()
  const editor = await opened
  await editor.waitForLoadState('domcontentloaded')
  await editor.waitForFunction(
    () => (document.querySelector('video')?.readyState ?? 0) >= 2,
    undefined,
    { timeout: 60_000 },
  )
  await popup.close().catch(() => undefined)

  const playhead = editor.getByTestId('playhead-field')
  await playhead.fill('00:00:00:00')
  await playhead.press('Enter')
  await editor.keyboard.press('i')
  await editor.getByTestId('clip').waitFor({ state: 'visible' })
  session.editors ??= {}
  session.editors[kind] = editor
  return editor
}

const readEditorOut = async (kind, session) => {
  const editor = await openEditor(kind, session)
  return secondsOfTimecode(await editor.getByTestId('out-c1').inputValue())
}

const probeCodecMatrix = async (session) => {
  const page = session.editors?.['1080'] ?? await session.context.newPage()
  const scriptUrl = `chrome-extension://${session.identity.extensionId}/windows-check-ladder.js`
  await page.addScriptTag({ url: scriptUrl })
  return page.evaluate(async (geometries) => {
    const ladder = globalThis.tailcutLadderFor
    if (typeof ladder !== 'function') throw new Error('The bundled codec ladder did not load.')
    const rows = []
    for (const geometry of geometries) {
      for (const rung of ladder(geometry, { codec: 'hevc', quality: 'high' })) {
        const answer = await VideoEncoder.isConfigSupported(rung.config)
        rows.push({
          ...geometry,
          kind: rung.choice.kind,
          config: answer.config ?? rung.config,
          supported: answer.supported,
        })
      }
    }
    return rows
  }, MATRIX_GEOMETRIES)
}

const dragCrop = async (editor, width, height) => {
  const reset = editor.getByTestId('crop-reset')
  if (await reset.isEnabled()) await reset.click()
  const text = (await editor.getByTestId('crop-geometry').textContent())?.trim() ?? ''
  const matched = /^(\d+)\s*×\s*(\d+)$/.exec(text)
  if (!matched) throw new Error(`The editor did not state its source geometry: ${text}`)
  const sourceWidth = Number(matched[1])
  const sourceHeight = Number(matched[2])
  const host = await editor.getByTestId('crop-host').boundingBox()
  const handle = await editor.getByTestId('crop-handle-se').boundingBox()
  if (!host || !handle) throw new Error('The crop control is not laid out.')
  const scale = host.width / sourceWidth
  const startX = handle.x + handle.width / 2
  const startY = handle.y + handle.height / 2
  await editor.mouse.move(startX, startY)
  await editor.mouse.down()
  await editor.mouse.move(startX + (width - sourceWidth) * scale, startY + (height - sourceHeight) * scale)
  await editor.mouse.up()
  const expected = `${width} × ${height}`
  await editor.waitForFunction(
    (value) => document.querySelector('[data-testid="crop-geometry"]')?.textContent?.trim() === value,
    expected,
  )
}

const editorFor = (item, session) => {
  const kind = item.id === 'h264-4k' ? '4k' : '1080'
  const editor = session.editors?.[kind]
  if (!editor) throw new Error(`No editor exists for ${item.id}.`)
  return editor
}

const configureExport = async (item, session) => {
  const editor = editorFor(item, session)
  const reset = editor.getByTestId('crop-reset')
  if (await reset.isEnabled()) await reset.click()

  await editor.getByTestId('name-c1').fill(`windows-${item.id}-${randomUUID().slice(0, 8)}`)
  if (item.id === 'webp-10s') {
    const out = editor.getByTestId('out-c1')
    await out.fill('00:00:10:00')
    await out.press('Enter')
    await editor.getByTestId('format-c1').selectOption('webp')
  } else {
    await editor.getByTestId('format-c1').selectOption('mp4')
    await editor.getByTestId('mode-c1').selectOption('optimize')
    if (item.id === 'crop-128x64') await dragCrop(editor, 128, 64)
  }
  await editor.getByTestId('export').waitFor({ state: 'visible' })
  await editor.waitForFunction(() => {
    const button = document.querySelector('[data-testid="export"]')
    return button instanceof HTMLButtonElement && !button.disabled
  }, undefined, { timeout: 30_000 })
  session.currentEditor = editor
}

const readInspectorChoice = async (item, session) => {
  const text = (await editorFor(item, session).getByTestId('cost-c1').textContent()) ?? ''
  for (const choice of ['HEVC in hardware', 'H.264 in hardware', 'H.264 in software']) {
    if (text.includes(choice)) return choice
  }
  throw new Error(`The inspector did not name an encoding rung: ${text.trim()}`)
}

export const armDownloadCapture = async (editor) => {
  const index = await editor.evaluate(() => {
    const scope = globalThis
    const state = scope.tcWindowsDownloadCapture ??= { calls: [], wrapped: false }
    if (!state.wrapped) {
      state.wrapped = true
      const downloads = chrome.downloads
      const real = downloads.download.bind(downloads)
      downloads.download = (options, callback) => {
        const call = {
          url: options.url,
          requestedFilename: options.filename,
          downloadId: null,
        }
        state.calls.push(call)
        return real(options, (id) => {
          call.downloadId = id ?? null
          callback?.(id)
        })
      }
    }
    return state.calls.length
  })
  const expected = editor.waitForFunction((callIndex) => {
    const call = globalThis.tcWindowsDownloadCapture?.calls[callIndex]
    return Number.isSafeInteger(call?.downloadId) ? call : undefined
  }, index, { timeout: 30_000 }).then((handle) => handle.jsonValue())
  return { expected }
}

export const completedDownload = async (session, expectedDownload, deadlineMs = 180_000) => {
  const queued = []
  const readers = []
  const push = (event) => {
    const reader = readers.shift()
    if (reader) reader({ value: event, done: false })
    else queued.push(event)
  }
  const onBegin = (params) => push({ method: 'Browser.downloadWillBegin', params })
  const onProgress = (params) => push({ method: 'Browser.downloadProgress', params })
  const events = {
    [Symbol.asyncIterator]() {
      return {
        next: () => queued.length
          ? Promise.resolve({ value: queued.shift(), done: false })
          : new Promise((resolve) => readers.push(resolve)),
      }
    },
  }
  let rejectDeadline
  const deadline = new Promise((_resolve, reject) => {
    rejectDeadline = reject
  })
  const timer = setTimeout(
    () => rejectDeadline(new Error('The Chrome download did not complete before its deadline.')),
    deadlineMs,
  )
  session.cdp.on('Browser.downloadWillBegin', onBegin)
  session.cdp.on('Browser.downloadProgress', onProgress)
  try {
    const expected = await Promise.race([expectedDownload, deadline])
    return {
      ...await waitForDownload(events, deadline, { expectedUrl: expected.url }),
      ...expected,
    }
  } finally {
    clearTimeout(timer)
    session.cdp.off('Browser.downloadWillBegin', onBegin)
    session.cdp.off('Browser.downloadProgress', onProgress)
  }
}

const fromWindowsPath = (value) => {
  const matched = /^([a-zA-Z]):\\(.*)$/.exec(value)
  if (!matched) return value
  return `/mnt/${matched[1].toLowerCase()}/${matched[2].replaceAll('\\', '/')}`
}

const clickExport = async (item, session) => {
  const editor = editorFor(item, session)
  const capture = await armDownloadCapture(editor)
  session.pendingDownload = completedDownload(session, capture.expected)
  session.pendingJob = await editor.getByTestId('job').count()
  session.exportStartedAt = Date.now()
  await editor.getByTestId('export').click()
}

const waitForCompletedDownload = async (_item, session) => {
  const download = await session.pendingDownload
  const editor = session.currentEditor
  await editor.waitForFunction(
    (index) => document.querySelectorAll('[data-testid="job-state"]')[index]?.textContent?.trim() === 'Saved',
    session.pendingJob,
    { timeout: 180_000 },
  )
  const items = await editor.evaluate(
    (downloadId) => chrome.downloads.search({ id: downloadId }),
    download.downloadId,
  )
  const item = verifyDownloadIdentity(items[0], {
    downloadId: download.downloadId,
    url: download.url,
    extensionId: session.identity.extensionId,
  })
  const artifact = await inspectDownloadedArtifact(
    session.downloadRoot,
    download.filePath,
    item.filename,
  )
  return {
    ...download,
    requestedFilename: download.requestedFilename,
    ...artifact,
    elapsedMs: Date.now() - session.exportStartedAt,
  }
}

const rawExportProbe = async (_item, artifact) => {
  const result = await commandResult(ffprobeExportCommand(artifact))
  if (result.status !== 0) throw new Error(`ffprobe refused ${artifact}: ${result.stderr.trim()}`)
  return JSON.parse(result.stdout)
}

export const decodeWebp = async (artifact, session) => {
  const token = `webp-${randomUUID()}`
  const url = session.mediaServer.exposeArtifact(token, artifact)
  return session.currentEditor.evaluate(async (source) => {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`Reading the WebP answered ${response.status}.`)
    const decoder = new ImageDecoder({
      data: await response.arrayBuffer(),
      type: 'image/webp',
      preferAnimation: true,
    })
    let frames = 0
    let durationUs = 0
    try {
      await decoder.tracks.ready
      const track = decoder.tracks.selectedTrack
      if (!track) throw new Error('The WebP has no selected image track.')
      for (let index = 0; index < track.frameCount; index += 1) {
        const decoded = await decoder.decode({ frameIndex: index, completeFramesOnly: true })
        try {
          if (!decoded.complete || decoded.image.duration === null) {
            throw new Error(`WebP frame ${index} is incomplete or has no duration.`)
          }
          durationUs += decoded.image.duration
          frames += 1
        } finally {
          decoded.image.close()
        }
      }
    } finally {
      decoder.close()
    }
    return { durationMs: durationUs / 1_000, frames }
  }, url)
}

/** Real effects used by the CLI. Kept behind this factory so --dry-run never touches them. */
export function liveDependencies(print = console.log) {
  return {
    print,
    nonce: () => randomUUID(),
    async prepareRun(options) {
      await mkdir(dirname(options.workRoot), { recursive: true })
      await mkdir(options.workRoot)
      await Promise.all([
        mkdir(`${options.workRoot}/profile`),
        mkdir(`${options.workRoot}/downloads`),
        mkdir(`${options.workRoot}/media`),
      ])
      await Promise.all([stat(options.chrome), stat(options.dist)])
    },
    async generateInput(output) {
      const result = await commandResult(generateMinuteCommand(output))
      if (result.status !== 0) throw new Error(`Generating the 1080p minute failed: ${result.stderr.trim()}`)
    },
    probeInput: async (_kind, input) => probeInputFile(input),
    decodeInput: async (_kind, input) => commandResult(ffmpegDecodeCommand(input)),
    copyExtension: async (source, target) => cp(source, target, { recursive: true, errorOnExist: true, force: false }),
    async stampCopiedExtension(target, nonce) {
      const manifestPath = join(target, 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      await writeFile(manifestPath, `${JSON.stringify(stampExtensionIdentity(manifest, nonce), null, 2)}\n`)
      await writeFile(join(target, 'windows-check-nonce.json'), `${JSON.stringify({ nonce })}\n`)
      const ladder = await buildLadderBundle()
      await writeFile(join(target, 'windows-check-ladder.js'), ladder.script)
      return {
        workerPath: `/${manifest.background.service_worker}`,
        name: manifest.name,
        version: manifest.version,
        nonce,
      }
    },
    createMediaServer: (files) => createMediaServer(files),
    async startBrowserSession(options) {
      const session = await startLiveBrowser(options)
      session.downloadRoot = fromWindowsPath(options.profileWindows.replace(/\\profile$/, '\\downloads'))
      return session
    },
    extensionCandidates,
    playWatchedMedia,
    readEditorOut,
    probeCodecMatrix,
    async enableDownloads(downloadPath, session) {
      await enableDownloads(session.cdp, downloadPath)
      session.downloadRoot = fromWindowsPath(downloadPath)
    },
    configureExport,
    readInspectorChoice,
    clickExport,
    waitForCompletedDownload,
    probeExport: rawExportProbe,
    decodeExport: async (_item, artifact) => commandResult(ffmpegDecodeCommand(artifact)),
    readArtifact: async (_item, artifact) => artifact,
    decodeWebp,
    async writeReport(report) {
      await writeFile(report.paths.report, `${JSON.stringify(report, null, 2)}\n`)
      print(`[${report.phase}] ${report.status}`)
    },
  }
}

/** Runs the tested phase order over injected effects; the CLI supplies their real implementations. */
export async function runWindowsCheck(args, dependencies = {}) {
  if (args.includes('--dry-run')) {
    for (const line of dryRunLines(args)) dependencies.print?.(line)
    return { exitCode: 0 }
  }

  let options
  try {
    const defaults = dependencies.defaultPaths?.() ?? defaultWindowsPaths()
    options = liveOptions(args, defaults)
  } catch (error) {
    return { exitCode: 1, error: String(error) }
  }

  const report = {
    schemaVersion: 1,
    status: 'running',
    phase: 'start',
    invocation: {
      args: [...args],
      generated1080: options.generate1080,
    },
    inputs: {},
    exports: [],
    paths: {
      workRoot: options.workRoot,
      report: `${options.workRoot}/report.json`,
      downloads: `${options.workRoot}/downloads`,
    },
  }
  let server
  let session
  let currentExport
  const persist = async (phase) => {
    report.phase = phase
    await dependencies.writeReport(report)
  }
  const closeOwners = async () => {
    let failure
    const ownedSession = session
    const ownedServer = server
    session = undefined
    server = undefined
    try {
      if (ownedSession) await ownedSession.close()
    } catch (error) {
      failure = error
    }
    try {
      if (ownedServer) await ownedServer.close()
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'Closing the browser and media server failed.')
        : error
    }
    if (failure) throw failure
  }
  const completeExport = (record) => {
    const running = report.exports.findIndex(
      (item) => item.id === record.id && item.status === 'running',
    )
    if (running === -1) report.exports.push(record)
    else report.exports[running] = record
  }

  try {
    assertSafeRunRoot(toWindowsPath(options.workRoot), options.windowsTemp)
    if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new Error(`Invalid CDP port: ${options.port}.`)
    }
    await dependencies.prepareRun?.(options)
    if (options.generate1080) await dependencies.generateInput(options.media1080)

    const input1080 = await dependencies.probeInput('1080', options.media1080)
    const decode1080 = await dependencies.decodeInput('1080', options.media1080)
    validateInput('1080', input1080, decode1080)
    report.inputs['1080'] = { path: options.media1080, probe: input1080 }

    if (options.media4k) {
      const input4k = await dependencies.probeInput('4k', options.media4k)
      const decode4k = await dependencies.decodeInput('4k', options.media4k)
      validateInput('4k', input4k, decode4k)
      report.inputs['4k'] = { path: options.media4k, probe: input4k }
    }
    await persist('inputs')

    const extensionRoot = `${options.workRoot}/ext`
    await dependencies.copyExtension(options.dist, extensionRoot)
    const expectedIdentity = await dependencies.stampCopiedExtension(
      extensionRoot,
      dependencies.nonce(),
    )
    report.extension = { root: extensionRoot, expected: expectedIdentity }
    await persist('extension')

    const mediaFiles = { 'minute.mp4': options.media1080 }
    if (options.media4k) mediaFiles['4k.mp4'] = options.media4k
    server = await dependencies.createMediaServer(mediaFiles)
    session = await dependencies.startBrowserSession({
      chrome: options.chrome,
      port: options.port,
      profileWindows: toWindowsPath(`${options.workRoot}/profile`),
      extensionWindows: toWindowsPath(extensionRoot),
    })
    session.mediaServer = server

    const candidates = await dependencies.extensionCandidates(session)
    report.identity = verifyExtensionIdentity(candidates, expectedIdentity)
    session.identity = report.identity
    await persist('identity')

    await dependencies.playWatchedMedia('1080', `${server.origin}/media/minute.mp4`, session)
    const out1080 = await dependencies.readEditorOut('1080', session)
    assertWatchedOut(out1080)
    report.capture1080 = { outSeconds: out1080 }
    await persist('capture-1080')

    if (options.media4k) {
      await dependencies.playWatchedMedia('4k', `${server.origin}/media/4k.mp4`, session)
      const out4k = await dependencies.readEditorOut('4k', session)
      if (out4k < 9) throw new Error('The 4K editor Out field must reach at least 9 seconds.')
      report.capture4k = { outSeconds: out4k }
      await persist('capture-4k')
    }

    const matrix = await dependencies.probeCodecMatrix(session)
    assertMatrix(matrix)
    report.matrix = { rows: matrix }
    await persist('matrix')

    const downloadWindows = toWindowsPath(`${options.workRoot}/downloads`)
    await dependencies.enableDownloads(downloadWindows, session)
    report.downloads = { path: downloadWindows }
    await persist('downloads')

    for (const item of exportPlan(Boolean(options.media4k))) {
      if (item.status === 'skipped') {
        report.exports.push(item)
        await persist(`export-${item.id}`)
        continue
      }

      currentExport = { id: item.id }
      await dependencies.configureExport(item, session)
      const selectedChoice = item.expectedChoice
        ? await dependencies.readInspectorChoice(item, session)
        : undefined
      currentExport.selectedChoice = selectedChoice
      if (item.expectedChoice && selectedChoice !== item.expectedChoice) {
        throw new Error(`Expected ${item.expectedChoice}, got ${selectedChoice}.`)
      }
      if (selectedChoice !== undefined) {
        report.exports.push({ id: item.id, status: 'running', selectedChoice })
        await persist(`export-${item.id}-running`)
      }

      await dependencies.clickExport(item, session)
      const download = await dependencies.waitForCompletedDownload(item, session)
      if (item.id === 'webp-10s') {
        const bytes = await dependencies.readArtifact(item, download.path)
        const decoded = await dependencies.decodeWebp(bytes, session)
        await validateExport(item, { bytes }, { decodeWebp: async () => decoded })
        completeExport({
          id: item.id,
          status: 'passed',
          download,
          durationMs: decoded.durationMs,
          frames: decoded.frames,
        })
      } else {
        const rawProbe = await dependencies.probeExport(item, download.path)
        const decode = await dependencies.decodeExport(item, download.path)
        const facts = {
          ...exportProbeFacts(rawProbe),
          selectedChoice,
          decoded: decode.status === 0,
        }
        await validateExport(item, facts, dependencies)
        completeExport({ id: item.id, status: 'passed', download, selectedChoice, ...facts })
      }
      currentExport = undefined
      await persist(`export-${item.id}`)
    }

    await closeOwners()
    report.status = 'passed'
    await persist('complete')
    return { exitCode: 0, report }
  } catch (error) {
    try {
      await closeOwners()
    } catch (cleanupError) {
      error = error === cleanupError
        ? cleanupError
        : new AggregateError([error, cleanupError], 'The Windows check and its cleanup both failed.')
    }
    report.status = 'failed'
    if (currentExport) {
      const failed = {
        id: currentExport.id,
        status: 'failed',
        ...(currentExport.selectedChoice === undefined
          ? {}
          : { selectedChoice: currentExport.selectedChoice }),
        error: String(error),
      }
      const running = report.exports.findIndex(
        (item) => item.id === currentExport.id && item.status === 'running',
      )
      if (running === -1) report.exports.push(failed)
      else report.exports[running] = failed
    }
    report.error = { message: error instanceof Error ? error.message : String(error) }
    try {
      await persist('failed')
    } catch {
      // The primary failure still belongs in the returned report when persisting it also fails.
    }
    return { exitCode: 1, report }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2)
  const dependencies = args.includes('--dry-run') ? { print: console.log } : liveDependencies(console.log)
  const result = await runWindowsCheck(args, dependencies)
  if (result.exitCode !== 0) console.error(result.report?.error?.message ?? result.error ?? 'Windows check failed.')
  process.exitCode = result.exitCode
}
